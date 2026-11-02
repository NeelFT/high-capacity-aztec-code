import { COLORS, colorSymbolMask, createAztecLayout, decode3BitPacketDetailed, decode3BitPayload, HEADER_BYTES, readU32 } from './aztec.ts';
import type { PacketDecodeResult } from './aztec.ts';
import type { AztecLayout } from './aztec.ts';

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface FramePoint {
  x: number;
  y: number;
}

export type FrameCorners = [FramePoint, FramePoint, FramePoint, FramePoint];

const LEGACY_PERIMETER_WIDTH = 3;

export interface BullseyeTrack {
  corners: FrameCorners;
  finderCorners: FrameCorners;
  score: number;
}

export interface DecoderTrace {
  status: 'candidate-not-found' | 'geometry-failed' | 'orientation-failed' | 'grid-sampling-failed' | 'colour-recognition-failed' | 'header-invalid' | 'crc-failed' | 'packet-decoded';
  candidateCount: number;
  imageWidth: number;
  imageHeight: number;
  geometryCandidates: number;
  orientationFound: boolean;
  gridSampled: boolean;
  recognizedModules: number;
  totalModules: number;
  candidateConfidence: number | null;
  colourConfidence: number | null;
  finderCenter: FramePoint | null;
  finderCorners: FrameCorners | null;
  finderSizeModules: number | null;
  trackedCandidate: boolean;
  headerValid: boolean | null;
  crcValid: boolean | null;
  corners: FrameCorners | null;
  gridLines: Array<[FramePoint, FramePoint]>;
  packet: Uint8Array | null;
  reason: string;
  locatorDetected: boolean;
}

type Transform = (x: number, y: number) => FramePoint;
type LabColor = [number, number, number];

const paletteRgb = COLORS.map((color) => [
  parseInt(color.slice(1, 3), 16),
  parseInt(color.slice(3, 5), 16),
  parseInt(color.slice(5, 7), 16),
]);

function isDarkPixel(image: PixelImage, x: number, y: number, threshold: number): boolean {
  const offset = (y * image.width + x) * 4;
  const alpha = image.data[offset + 3] / 255;
  const red = image.data[offset] * alpha + 255 * (1 - alpha);
  const green = image.data[offset + 1] * alpha + 255 * (1 - alpha);
  const blue = image.data[offset + 2] * alpha + 255 * (1 - alpha);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue <= threshold;
}

function isLocatorPixel(image: PixelImage, x: number, y: number): boolean {
  const offset = (y * image.width + x) * 4;
  const alpha = image.data[offset + 3] / 255;
  const red = image.data[offset] * alpha + 255 * (1 - alpha);
  const green = image.data[offset + 1] * alpha + 255 * (1 - alpha);
  const blue = image.data[offset + 2] * alpha + 255 * (1 - alpha);
  return red > 35 && red - green > 10 && green - blue > 8 && red > green * 1.1 && green > blue * 1.1;
}

function sampleLuminance(image: PixelImage, point: FramePoint): number {
  const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y)));
  const offset = (y * image.width + x) * 4;
  const alpha = image.data[offset + 3] / 255;
  const red = image.data[offset] * alpha + 255 * (1 - alpha);
  const green = image.data[offset + 1] * alpha + 255 * (1 - alpha);
  const blue = image.data[offset + 2] * alpha + 255 * (1 - alpha);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function interpolateCorners(corners: FrameCorners, u: number, v: number): FramePoint {
  const [topLeft, topRight, bottomRight, bottomLeft] = corners;
  return {
    x: (1 - u) * (1 - v) * topLeft.x + u * (1 - v) * topRight.x + u * v * bottomRight.x + (1 - u) * v * bottomLeft.x,
    y: (1 - u) * (1 - v) * topLeft.y + u * (1 - v) * topRight.y + u * v * bottomRight.y + (1 - u) * v * bottomLeft.y,
  };
}

export function trackBullseye(
  image: PixelImage,
  previousImage: PixelImage,
  previousCorners: FrameCorners,
  previousFinderCorners: FrameCorners,
): BullseyeTrack | null {
  if (image.width !== previousImage.width || image.height !== previousImage.height) return null;
  const template: number[] = [];
  const templatePoints: Array<[number, number]> = [];
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      const u = (column + 0.5) / 16;
      const v = (row + 0.5) / 16;
      template.push(sampleLuminance(previousImage, interpolateCorners(previousFinderCorners, u, v)));
      templatePoints.push([u, v]);
    }
  }
  const templateMean = template.reduce((sum, value) => sum + value, 0) / template.length;
  const templateEnergy = template.reduce((sum, value) => sum + (value - templateMean) ** 2, 0);
  if (templateEnergy < 1) return null;
  const allSamples = templatePoints.map((_, index) => index);
  const coarseSamples = templatePoints
    .map((_, index) => index)
    .filter((index) => Math.floor(index / 16) % 2 === 0 && index % 2 === 0);
  const sampleStats = [coarseSamples, allSamples].map((indexes) => {
    const mean = indexes.reduce((sum, index) => sum + template[index], 0) / indexes.length;
    const energy = indexes.reduce((sum, index) => sum + (template[index] - mean) ** 2, 0);
    return { indexes, mean, energy };
  });

  const anchor = interpolateCorners(previousFinderCorners, 0.5, 0.5);
  const anchorCorners = previousFinderCorners.map((point) => ({
    x: point.x - anchor.x,
    y: point.y - anchor.y,
  })) as FrameCorners;
  const maxShift = Math.max(12, Math.round(Math.min(image.width, image.height) * 0.25));
  const coarseOffsets: number[] = [];
  for (let offset = -maxShift; offset <= maxShift; offset += 8) coarseOffsets.push(offset);
  const coarseScales = [0.8, 1, 1.2];
  const coarseAngles = [-10, 0, 10].map((degrees) => degrees * Math.PI / 180);
  let best: { x: number; y: number; scale: number; angle: number; score: number } | null = null;

  const scoreCandidate = (x: number, y: number, scale: number, angle: number, stats: typeof sampleStats[number]): number => {
    const cosine = Math.cos(angle) * scale;
    const sine = Math.sin(angle) * scale;
    let valueSum = 0;
    const values = new Array<number>(stats.indexes.length);
    for (let sampleIndex = 0; sampleIndex < stats.indexes.length; sampleIndex += 1) {
      const templateIndex = stats.indexes[sampleIndex];
      const [u, v] = templatePoints[templateIndex];
      const point = interpolateCorners(anchorCorners, u, v);
      const value = sampleLuminance(image, {
        x: anchor.x + x + cosine * point.x - sine * point.y,
        y: anchor.y + y + sine * point.x + cosine * point.y,
      });
      values[sampleIndex] = value;
      valueSum += value;
    }
    const mean = valueSum / values.length;
    let covariance = 0;
    let energy = 0;
    for (let index = 0; index < values.length; index += 1) {
      const centered = values[index] - mean;
      covariance += centered * (template[stats.indexes[index]] - stats.mean);
      energy += centered * centered;
    }
    return energy < 1 ? -1 : covariance / Math.sqrt(energy * stats.energy);
  };

  for (const y of coarseOffsets) {
    for (const x of coarseOffsets) {
      for (const scale of coarseScales) {
        for (const angle of coarseAngles) {
          const score = scoreCandidate(x, y, scale, angle, sampleStats[0]);
          if (!best || score > best.score) best = { x, y, scale, angle, score };
        }
      }
    }
  }
  if (!best || best.score < 0.55) return null;

  best.score = scoreCandidate(best.x, best.y, best.scale, best.angle, sampleStats[1]);
  const coarseBest = best;
  for (let y = coarseBest.y - 5; y <= coarseBest.y + 5; y += 1) {
    for (let x = coarseBest.x - 5; x <= coarseBest.x + 5; x += 1) {
      const scales = new Set([1, coarseBest.scale * 0.96, coarseBest.scale * 1.04]);
      const angles = new Set([0, coarseBest.angle - 5 * Math.PI / 180, coarseBest.angle + 5 * Math.PI / 180]);
      for (const scale of scales) {
        for (const angle of angles) {
          const score = scoreCandidate(x, y, scale, angle, sampleStats[1]);
          if (score > best.score) best = { x, y, scale, angle, score };
        }
      }
    }
  }
  if (best.score < 0.7) return null;

  const cosine = Math.cos(best.angle) * best.scale;
  const sine = Math.sin(best.angle) * best.scale;
  const transform = (point: FramePoint): FramePoint => {
    const relativeX = point.x - anchor.x;
    const relativeY = point.y - anchor.y;
    return {
      x: anchor.x + best.x + cosine * relativeX - sine * relativeY,
      y: anchor.y + best.y + sine * relativeX + cosine * relativeY,
    };
  };
  return {
    corners: previousCorners.map(transform) as FrameCorners,
    finderCorners: previousFinderCorners.map(transform) as FrameCorners,
    score: best.score,
  };
}

interface FrameCandidate {
  corners: FrameCorners;
  boundaryOffset: number;
}

function cross(origin: FramePoint, first: FramePoint, second: FramePoint): number {
  return (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
}

function quadrilateralFromHull(points: FramePoint[]): FrameCorners | null {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: FramePoint[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: FramePoint[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  if (hull.length < 4) return null;

  let first = 0;
  let opposite = 1;
  let maximumDistance = 0;
  for (let left = 0; left < hull.length; left += 1) {
    for (let right = left + 1; right < hull.length; right += 1) {
      const dx = hull[left].x - hull[right].x;
      const dy = hull[left].y - hull[right].y;
      const distance = dx * dx + dy * dy;
      if (distance > maximumDistance) {
        first = left;
        opposite = right;
        maximumDistance = distance;
      }
    }
  }
  if (maximumDistance === 0) return null;

  const start = hull[first];
  const end = hull[opposite];
  const lineLength = Math.sqrt(maximumDistance);
  const farthestOnArc = (from: number, to: number, direction: 1 | -1): number => {
    let bestIndex = -1;
    let bestDistance = 0;
    for (let index = (from + direction + hull.length) % hull.length; index !== to; index = (index + direction + hull.length) % hull.length) {
      const distance = Math.abs(cross(start, end, hull[index])) / lineLength;
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  };
  const firstArc = farthestOnArc(first, opposite, 1);
  const secondArc = farthestOnArc(opposite, first, 1);
  if (firstArc < 0 || secondArc < 0) return null;
  return [start, hull[firstArc], end, hull[secondArc]];
}

function findMaskComponents(image: PixelImage, mask: Uint8Array, step: number, boundaryOffset: number): Array<FrameCandidate & { score: number }> {
  const columns = Math.ceil(image.width / step);
  const rows = Math.ceil(image.height / step);
  const pixelCount = columns * rows;
  const queue = new Int32Array(pixelCount);
  const candidates: Array<FrameCandidate & { score: number }> = [];
  for (let start = 0; start < pixelCount; start += 1) {
    if (!mask[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    mask[start] = 0;
    let count = 0;
    let minX = columns;
    let maxX = -1;
    let minY = rows;
    let maxY = -1;
    let minSum = Infinity;
    let maxSum = -Infinity;
    let minDifference = Infinity;
    let maxDifference = -Infinity;
    let topLeft: FramePoint | null = null;
    let topRight: FramePoint | null = null;
    let bottomRight: FramePoint | null = null;
    let bottomLeft: FramePoint | null = null;
    const componentPoints: FramePoint[] = [];
    while (head < tail) {
      const current = queue[head++];
      const x = current % columns;
      const y = Math.floor(current / columns);
      count += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const point = { x: Math.min(image.width - 1, x * step), y: Math.min(image.height - 1, y * step) };
      componentPoints.push(point);
      const sum = x + y;
      const difference = x - y;
      if (sum < minSum) { minSum = sum; topLeft = point; }
      if (difference > maxDifference) { maxDifference = difference; topRight = point; }
      if (sum > maxSum) { maxSum = sum; bottomRight = point; }
      if (difference < minDifference) { minDifference = difference; bottomLeft = point; }
      const left = current - 1;
      if (x > 0 && mask[left]) {
        mask[left] = 0;
        queue[tail++] = left;
      }
      const right = current + 1;
      if (x + 1 < columns && mask[right]) {
        mask[right] = 0;
        queue[tail++] = right;
      }
      const above = current - columns;
      if (y > 0 && mask[above]) {
        mask[above] = 0;
        queue[tail++] = above;
      }
      const below = current + columns;
      if (y + 1 < rows && mask[below]) {
        mask[below] = 0;
        queue[tail++] = below;
      }
    }
    if (!topLeft || !topRight || !bottomRight || !bottomLeft) continue;
    const width = (maxX - minX + 1) * step;
    const height = (maxY - minY + 1) * step;
    const areaRatio = width * height / (image.width * image.height);
    const aspectRatio = width / Math.max(1, height);
    if (Math.min(width, height) < Math.min(image.width, image.height) * 0.02 ||
      areaRatio < 0.005 || areaRatio > 0.98 ||
      aspectRatio < 0.2 || aspectRatio > 5) continue;
    let corners: FrameCorners = [topLeft, topRight, bottomRight, bottomLeft];
    const minimumEdge = Math.min(...corners.map((point, index) => {
      const next = corners[(index + 1) % corners.length];
      return Math.hypot(point.x - next.x, point.y - next.y);
    }));
    if (minimumEdge < Math.min(image.width, image.height) * 0.12) {
      corners = quadrilateralFromHull(componentPoints) ?? corners;
    }
    const density = count / Math.max(1, width * height / (step * step));
    candidates.push({
      corners,
      boundaryOffset,
      score: areaRatio * (1 - Math.min(1, density)),
    });
  }
  return candidates;
}

function findFrameCandidates(image: PixelImage): FrameCandidate[] {
  const step = Math.max(1, Math.floor(Math.min(image.width, image.height) / 480));
  const columns = Math.ceil(image.width / step);
  const rows = Math.ceil(image.height / step);
  const darkMask = new Uint8Array(columns * rows);
  const locatorMask = new Uint8Array(columns * rows);
  let maximumLuminance = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const sourceX = Math.min(image.width - 1, x * step);
      const sourceY = Math.min(image.height - 1, y * step);
      const offset = (sourceY * image.width + sourceX) * 4;
      const alpha = image.data[offset + 3] / 255;
      const red = image.data[offset] * alpha + 255 * (1 - alpha);
      const green = image.data[offset + 1] * alpha + 255 * (1 - alpha);
      const blue = image.data[offset + 2] * alpha + 255 * (1 - alpha);
      maximumLuminance = Math.max(maximumLuminance, 0.2126 * red + 0.7152 * green + 0.0722 * blue);
    }
  }
  const darkThreshold = Math.min(150, Math.max(55, maximumLuminance * 0.58));
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const sourceX = Math.min(image.width - 1, x * step);
      const sourceY = Math.min(image.height - 1, y * step);
      const index = y * columns + x;
      if (isDarkPixel(image, sourceX, sourceY, darkThreshold)) darkMask[index] = 1;
      if (isLocatorPixel(image, sourceX, sourceY)) locatorMask[index] = 1;
    }
  }
  const candidates = [
    ...findMaskComponents(image, locatorMask, step, 1),
    ...findMaskComponents(image, darkMask, step, 0),
  ];
  return candidates.sort((a, b) => b.score - a.score).slice(0, 8);
}

function validateFrameGeometry(image: PixelImage, corners: FrameCorners, locatorDetected: boolean): string | null {
  const minDimension = Math.min(image.width, image.height);
  for (let index = 0; index < corners.length; index += 1) {
    const current = corners[index];
    const next = corners[(index + 1) % corners.length];
    if (!Number.isFinite(current.x) || !Number.isFinite(current.y) || current.x < 0 || current.y < 0 || current.x >= image.width || current.y >= image.height) {
      return 'Candidate corners fall outside the camera image.';
    }
    if (Math.hypot(current.x - next.x, current.y - next.y) < minDimension * 0.12) {
      return 'Candidate is too small or degenerate to contain a matrix.';
    }
  }
  const area = Math.abs(corners.reduce((sum, point, index) => {
    const next = corners[(index + 1) % corners.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0)) / 2;
  if (area < image.width * image.height * 0.08) return 'Candidate covers less than 8% of the camera image.';
  const maximumAreaRatio = locatorDetected ? 0.98 : 0.92;
  if (area > image.width * image.height * maximumAreaRatio) {
    return `Candidate fills more than ${maximumAreaRatio * 100}% of the camera image; the full matrix boundary is not isolated.`;
  }
  const centerX = corners.reduce((sum, point) => sum + point.x, 0) / 4;
  const centerY = corners.reduce((sum, point) => sum + point.y, 0) / 4;
  if (Math.abs(centerX - image.width / 2) > image.width * 0.35 || Math.abs(centerY - image.height / 2) > image.height * 0.35) {
    return 'Candidate is too far from the center of the camera image.';
  }
  let crossSign = 0;
  for (let index = 0; index < corners.length; index += 1) {
    const current = corners[index];
    const next = corners[(index + 1) % corners.length];
    const after = corners[(index + 2) % corners.length];
    const cross = (next.x - current.x) * (after.y - next.y) - (next.y - current.y) * (after.x - next.x);
    if (Math.abs(cross) < 1e-6) return 'Candidate edges do not define a stable quadrilateral.';
    if (crossSign !== 0 && Math.sign(cross) !== crossSign) return 'Candidate corners do not form a convex quadrilateral.';
    crossSign = Math.sign(cross);
  }
  return null;
}

function createTransform(corners: FrameCorners, size: number, boundaryOffset = 0): Transform | null {
  const start = -boundaryOffset;
  const end = size + boundaryOffset;
  const destinations = [
    { x: start, y: start },
    { x: end, y: start },
    { x: end, y: end },
    { x: start, y: end },
  ];
  const matrix: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = destinations[index];
    const { x: sourceX, y: sourceY } = corners[index];
    matrix.push([x, y, 1, 0, 0, 0, -sourceX * x, -sourceX * y, sourceX]);
    matrix.push([0, 0, 0, x, y, 1, -sourceY * x, -sourceY * y, sourceY]);
  }

  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
    }
    if (Math.abs(matrix[pivot][column]) < 1e-10) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
    const divisor = matrix[column][column];
    for (let entry = column; entry <= 8; entry += 1) matrix[column][entry] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = matrix[row][column];
      for (let entry = column; entry <= 8; entry += 1) matrix[row][entry] -= factor * matrix[column][entry];
    }
  }

  const [a, b, c, d, e, f, g, h] = matrix.map((row) => row[8]);
  return (x, y) => {
    const denominator = g * x + h * y + 1;
    return {
      x: (a * x + b * y + c) / denominator,
      y: (d * x + e * y + f) / denominator,
    };
  };
}

function averageColor(image: PixelImage, transform: Transform, cellX: number, cellY: number): [number, number, number] {
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  const offsets = [0.3, 0.4, 0.5, 0.6, 0.7];
  for (const offsetY of offsets) {
    for (const offsetX of offsets) {
      const point = transform(cellX + offsetX, cellY + offsetY);
      const x = Math.max(0, Math.min(image.width - 1, Math.round(point.x)));
      const y = Math.max(0, Math.min(image.height - 1, Math.round(point.y)));
      const offset = (y * image.width + x) * 4;
      const alpha = image.data[offset + 3] / 255;
      red.push(image.data[offset] * alpha + 255 * (1 - alpha));
      green.push(image.data[offset + 1] * alpha + 255 * (1 - alpha));
      blue.push(image.data[offset + 2] * alpha + 255 * (1 - alpha));
    }
  }
  const median = (channel: number[]): number => {
    channel.sort((a, b) => a - b);
    return channel[Math.floor(channel.length / 2)];
  };
  return [median(red), median(green), median(blue)];
}

function rgbToLab([red, green, blue]: [number, number, number]): LabColor {
  const linearize = (value: number): number => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const r = linearize(red);
  const g = linearize(green);
  const b = linearize(blue);
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const transform = (value: number): number => value > 0.008856451679 ? Math.cbrt(value) : 7.787037037 * value + 16 / 116;
  const fx = transform(x);
  const fy = transform(y);
  const fz = transform(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function nearestPaletteColor(color: [number, number, number], referenceLabs: LabColor[]): {
  index: number;
  alternatives: Array<{ index: number; margin: number }>;
  nearest: number;
  margin: number;
} {
  const sampleLab = rgbToLab(color);
  const ranked: Array<{ index: number; distance: number }> = [];
  for (let index = 0; index < referenceLabs.length; index += 1) {
    const reference = referenceLabs[index];
    const distance = Math.hypot(sampleLab[0] - reference[0], sampleLab[1] - reference[1], sampleLab[2] - reference[2]);
    ranked.push({ index, distance });
  }
  ranked.sort((a, b) => a.distance - b.distance);
  const nearest = ranked[0];
  const secondNearest = ranked[1];
  return {
    index: nearest.index,
    alternatives: ranked.slice(1, 4).map(({ index, distance }) => ({ index, margin: distance - nearest.distance })),
    nearest: nearest.distance,
    margin: secondNearest.distance - nearest.distance,
  };
}

function decodeWithSupportedMasks(symbols: Uint8Array): PacketDecodeResult {
  const fixedHeaderSymbols = Math.ceil(HEADER_BYTES * 8 / 3);
  const legacySymbols = symbols.map((symbol, index) => symbol ^ colorSymbolMask(index));
  const legacyDecoded = decode3BitPacketDetailed(legacySymbols);
  if (legacyDecoded.status === 'decoded' || symbols.length < fixedHeaderSymbols) return legacyDecoded;
  const fixedHeader = decode3BitPayload(legacySymbols.subarray(0, fixedHeaderSymbols), HEADER_BYTES * 8);
  const maskSeed = readU32(new DataView(fixedHeader.buffer, fixedHeader.byteOffset, fixedHeader.byteLength), 8);
  const seededSymbols = symbols.map((symbol, index) =>
    symbol ^ colorSymbolMask(index, index < fixedHeaderSymbols ? 0 : maskSeed));
  const seededDecoded = decode3BitPacketDetailed(seededSymbols);
  const statusRank = { 'header-invalid': 0, 'crc-failed': 1, decoded: 2 } as const;
  return statusRank[seededDecoded.status] > statusRank[legacyDecoded.status] ? seededDecoded : legacyDecoded;
}

function recoverColorErrors(symbols: Uint8Array, alternatives: Array<{ index: number; symbol: number; margin: number }>): PacketDecodeResult {
  const initial = decodeWithSupportedMasks(symbols);
  if (initial.status === 'decoded') return initial;
  const rankedAlternatives = alternatives.sort((a, b) => a.margin - b.margin);
  const likely: typeof rankedAlternatives = [];
  const seenModules = new Set<number>();
  for (const alternative of rankedAlternatives) {
    if (seenModules.has(alternative.index)) continue;
    seenModules.add(alternative.index);
    likely.push(alternative);
    if (likely.length === 192) break;
  }
  const singleCandidates = rankedAlternatives.slice(0, 256);
  for (const candidate of singleCandidates) {
    const original = symbols[candidate.index];
    symbols[candidate.index] = candidate.symbol;
    const decoded = decodeWithSupportedMasks(symbols);
    symbols[candidate.index] = original;
    if (decoded.status === 'decoded') return decoded;
  }
  const pairCandidates = likely.slice(0, 48);
  for (let first = 0; first < pairCandidates.length; first += 1) {
    const firstCandidate = pairCandidates[first];
    const firstOriginal = symbols[firstCandidate.index];
    symbols[firstCandidate.index] = firstCandidate.symbol;
    for (let second = first + 1; second < pairCandidates.length; second += 1) {
      const secondCandidate = pairCandidates[second];
      if (secondCandidate.index === firstCandidate.index) continue;
      const secondOriginal = symbols[secondCandidate.index];
      symbols[secondCandidate.index] = secondCandidate.symbol;
      const decoded = decodeWithSupportedMasks(symbols);
      symbols[secondCandidate.index] = secondOriginal;
      if (decoded.status === 'decoded') {
        symbols[firstCandidate.index] = firstOriginal;
        return decoded;
      }
    }
    symbols[firstCandidate.index] = firstOriginal;
  }
  const tripleCandidates = likely.slice(0, 18);
  for (let first = 0; first < tripleCandidates.length; first += 1) {
    const firstCandidate = tripleCandidates[first];
    const firstOriginal = symbols[firstCandidate.index];
    symbols[firstCandidate.index] = firstCandidate.symbol;
    for (let second = first + 1; second < tripleCandidates.length; second += 1) {
      const secondCandidate = tripleCandidates[second];
      if (secondCandidate.index === firstCandidate.index) continue;
      const secondOriginal = symbols[secondCandidate.index];
      symbols[secondCandidate.index] = secondCandidate.symbol;
      for (let third = second + 1; third < tripleCandidates.length; third += 1) {
        const thirdCandidate = tripleCandidates[third];
        if (thirdCandidate.index === firstCandidate.index || thirdCandidate.index === secondCandidate.index) continue;
        const thirdOriginal = symbols[thirdCandidate.index];
        symbols[thirdCandidate.index] = thirdCandidate.symbol;
        const decoded = decodeWithSupportedMasks(symbols);
        symbols[thirdCandidate.index] = thirdOriginal;
        if (decoded.status === 'decoded') {
          symbols[secondCandidate.index] = secondOriginal;
          symbols[firstCandidate.index] = firstOriginal;
          return decoded;
        }
      }
      symbols[secondCandidate.index] = secondOriginal;
    }
    symbols[firstCandidate.index] = firstOriginal;
  }
  return initial;
}

function makeGridLines(transform: Transform, size: number): Array<[FramePoint, FramePoint]> {
  const lines: Array<[FramePoint, FramePoint]> = [];
  for (let division = 0; division <= 8; division += 1) {
    const position = size * division / 8;
    lines.push([transform(position, 0), transform(position, size)]);
    lines.push([transform(0, position), transform(size, position)]);
  }
  return lines;
}

function candidateOrientations(candidate: FrameCorners): FrameCorners[] {
  const orientations: FrameCorners[] = [];
  for (const direction of [1, -1]) {
    for (let start = 0; start < 4; start += 1) {
      orientations.push(Array.from({ length: 4 }, (_, offset) => candidate[(start + direction * offset + 8) % 4]) as FrameCorners);
    }
  }
  return orientations;
}

function decodeCandidate(image: PixelImage, layout: AztecLayout, corners: FrameCorners, boundaryOffset = 0): DecoderTrace {
  const base: DecoderTrace = {
    status: 'geometry-failed',
    candidateCount: 1,
    imageWidth: image.width,
    imageHeight: image.height,
    geometryCandidates: 0,
    orientationFound: false,
    gridSampled: false,
    recognizedModules: 0,
    totalModules: layout.dataCoordinates.length,
    candidateConfidence: null,
    colourConfidence: null,
    finderCenter: null,
    finderCorners: null,
    finderSizeModules: null,
    trackedCandidate: false,
    headerValid: null,
    crcValid: null,
    corners,
    gridLines: [],
    packet: null,
    reason: '',
    locatorDetected: boundaryOffset > 0,
  };
  const geometryError = validateFrameGeometry(image, corners, boundaryOffset > 0);
  if (geometryError) {
    base.reason = geometryError;
    return base;
  }
  const transform = createTransform(corners, layout.targetMatrixSize, boundaryOffset);
  if (!transform) {
    base.reason = 'Perspective transform could not be calculated from the candidate corners.';
    return base;
  }
  base.geometryCandidates = 1;
  base.gridLines = makeGridLines(transform, layout.targetMatrixSize);
  const finderEnd = layout.finderStart + layout.finderSize;
  base.finderCenter = transform(layout.finderCenter + 0.5, layout.finderCenter + 0.5);
  base.finderCorners = [
    transform(layout.finderStart, layout.finderStart),
    transform(finderEnd, layout.finderStart),
    transform(finderEnd, finderEnd),
    transform(layout.finderStart, finderEnd),
  ];
  base.finderSizeModules = layout.finderSize;
  const references = paletteRgb.map((_, index) => averageColor(image, transform, index + 3, 3));
  const referenceLabs = references.map((reference) => rgbToLab(reference));
  const structural = [...layout.alignmentCoordinates];
  let matched = 0;
  for (const coordinate of structural) {
    const [x, y] = coordinate.split(',').map(Number);
    const expectedColor = layout.grid[y][x];
    if (!expectedColor) continue;
    const expectedIndex = COLORS.indexOf(expectedColor as typeof COLORS[number]);
    if (expectedIndex < 0) continue;
    const classified = nearestPaletteColor(averageColor(image, transform, x, y), referenceLabs);
    if (classified.index === expectedIndex && classified.nearest < 55 && classified.margin > 2) matched += 1;
  }
  const structuralRatio = structural.length === 0 ? 0 : matched / structural.length;
  base.candidateConfidence = structuralRatio * 100;
  if (structuralRatio < 0.68) {
    base.status = 'orientation-failed';
    base.reason = `Finder/alignment markers matched ${matched} of ${structural.length} (${(structuralRatio * 100).toFixed(1)}%); 68% is required.`;
    base.colourConfidence = structuralRatio * 100;
    return base;
  }
  base.orientationFound = true;

  const symbols = new Uint8Array(layout.dataCoordinates.length);
  const alternatives: Array<{ index: number; symbol: number; margin: number }> = [];
  let recognizedModules = 0;
  let totalMargin = 0;
  for (let index = 0; index < layout.dataCoordinates.length; index += 1) {
    const [x, y] = layout.dataCoordinates[index];
    const classified = nearestPaletteColor(averageColor(image, transform, x, y), referenceLabs);
    totalMargin += Math.max(0, classified.margin);
    recognizedModules += 1;
    for (const alternative of classified.alternatives) {
      alternatives.push({ index, symbol: alternative.index, margin: alternative.margin });
    }
    symbols[index] = classified.index;
  }
  base.gridSampled = true;
  base.recognizedModules = recognizedModules;
  base.colourConfidence = totalMargin / Math.max(1, layout.dataCoordinates.length);
  const decoded = recoverColorErrors(symbols, alternatives);
  base.headerValid = decoded.headerValid;
  base.crcValid = decoded.crcValid;
  base.packet = decoded.packet;
  base.status = decoded.status === 'crc-failed' ? 'crc-failed' : decoded.status === 'header-invalid' ? 'header-invalid' : 'packet-decoded';
  base.reason = decoded.reason ?? 'Packet decoded and CRC32 verified.';
  return base;
}

export interface OpticalFrameResult {
  packet: Uint8Array;
  corners: FrameCorners;
}

export function decodeOpticalFrameDetailed(
  image: PixelImage,
  targetMatrixSize: number,
  trackedCorners?: FrameCorners | null,
  trackedLocator = false,
): DecoderTrace {
  const layout = createAztecLayout(targetMatrixSize);
  const legacyLayout = createAztecLayout(targetMatrixSize, '#000000', LEGACY_PERIMETER_WIDTH);
  let trackedTrace: DecoderTrace | null = null;
  if (trackedCorners) {
    trackedTrace = decodeCandidate(image, trackedLocator ? layout : legacyLayout, trackedCorners, trackedLocator ? 1 : 0);
    trackedTrace.trackedCandidate = true;
    trackedTrace.candidateCount = 0;
    if (trackedTrace.status === 'packet-decoded') return trackedTrace;
    if (trackedLocator) {
      const legacyTrace = decodeCandidate(image, legacyLayout, trackedCorners, 1);
      legacyTrace.trackedCandidate = true;
      legacyTrace.candidateCount = 0;
      if (legacyTrace.status === 'packet-decoded') return legacyTrace;
      if (legacyTrace.geometryCandidates > trackedTrace.geometryCandidates ||
        (legacyTrace.orientationFound && !trackedTrace.orientationFound) ||
        (legacyTrace.gridSampled && !trackedTrace.gridSampled) ||
        legacyTrace.recognizedModules > trackedTrace.recognizedModules) trackedTrace = legacyTrace;
    }
  }
  const detectedCandidates = findFrameCandidates(image);
  const candidates = detectedCandidates.map((candidate) => ({ ...candidate, tracked: false }));
  if (trackedCorners && !detectedCandidates.some((candidate) => candidate.corners.every((point, index) =>
    Math.hypot(point.x - trackedCorners[index].x, point.y - trackedCorners[index].y) < 1))) {
    candidates.push({ corners: trackedCorners, boundaryOffset: trackedLocator ? 1 : 0, tracked: true });
  }
  if (candidates.length === 0) {
    return {
      status: 'candidate-not-found',
      candidateCount: 0,
      imageWidth: image.width,
      imageHeight: image.height,
      geometryCandidates: 0,
      orientationFound: false,
      gridSampled: false,
      recognizedModules: 0,
      totalModules: layout.dataCoordinates.length,
      candidateConfidence: null,
      colourConfidence: null,
      finderCenter: null,
      finderCorners: null,
      finderSizeModules: null,
      trackedCandidate: false,
      headerValid: null,
      crcValid: null,
      corners: null,
      gridLines: [],
      packet: null,
      reason: 'No orange locator border or dark frame boundary was found in the camera image.',
      locatorDetected: false,
    };
  }
  const candidateCount = detectedCandidates.length;
  let best: DecoderTrace | null = trackedTrace;
  for (const candidate of candidates) {
    const candidateLayouts = candidate.boundaryOffset > 0 ? [layout, legacyLayout] : [legacyLayout];
    for (const candidateLayout of candidateLayouts) {
      for (const corners of candidateOrientations(candidate.corners)) {
        const trace = decodeCandidate(image, candidateLayout, corners, candidate.boundaryOffset);
        trace.candidateCount = candidateCount;
        trace.trackedCandidate = candidate.tracked;
        if (!best || trace.geometryCandidates > best.geometryCandidates ||
          (trace.orientationFound && !best.orientationFound) ||
          (trace.gridSampled && !best.gridSampled) ||
          trace.recognizedModules > best.recognizedModules) {
          best = trace;
        }
        if (trace.status === 'packet-decoded') return trace;
      }
    }
  }
  if (best) return best;
  return {
    status: 'candidate-not-found',
    candidateCount: 0,
    imageWidth: image.width,
    imageHeight: image.height,
    geometryCandidates: 0,
    orientationFound: false,
    gridSampled: false,
    recognizedModules: 0,
    totalModules: layout.dataCoordinates.length,
    candidateConfidence: null,
    colourConfidence: null,
    finderCenter: null,
    finderCorners: null,
    finderSizeModules: null,
    trackedCandidate: false,
    headerValid: null,
    crcValid: null,
    corners: null,
    gridLines: [],
    packet: null,
    reason: 'No valid matrix orientation was found.',
    locatorDetected: false,
  };
}

export function decodeOpticalFrame(
  image: PixelImage,
  targetMatrixSize: number,
  trackedCorners?: FrameCorners | null,
  trackedLocator = false,
): (OpticalFrameResult & { trace?: DecoderTrace }) | null {
  const trace = decodeOpticalFrameDetailed(image, targetMatrixSize, trackedCorners, trackedLocator);
  if (!trace.packet || !trace.corners) return null;
  return { packet: trace.packet, corners: trace.corners, trace };
}
