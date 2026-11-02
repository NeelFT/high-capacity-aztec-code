import assert from 'node:assert/strict';
import test from 'node:test';

import { COLORS, colorSymbolMask, createAztecLayout, crc32, decode3BitPacket, decode3BitPayload, drawAztecFrame, encode3BitPayload, EVEN_FINDER_SIZE, FINDER_RING_THICKNESS, FINDER_SIZE, FountainEquationSolver, LOCATOR_COLOR, MAX_FILE_BYTES, MODULE_PIXELS, prepareAztecTransfer, QUIET_ZONE_MODULES, renderAztecFrameMatrix, sha256Hex, solveFountainEquations } from './aztec.ts';
import { decodeOpticalFrame, decodeOpticalFrameDetailed, trackBullseye } from './image-decoder.ts';
import { decompressGzip } from './compression.ts';
import type { PixelImage } from './image-decoder.ts';

function makePayload(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 37 + seed) & 0xff;
  }
  return bytes;
}

function makePseudoRandomPayload(length: number, seed: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function addCameraBlurAndColorCast(image: PixelImage): PixelImage {
  const data = new Uint8ClampedArray(image.data.length);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const channels = [0, 0, 0];
      let samples = 0;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const sampleX = Math.max(0, Math.min(image.width - 1, x + offsetX));
          const sampleY = Math.max(0, Math.min(image.height - 1, y + offsetY));
          const sampleOffset = (sampleY * image.width + sampleX) * 4;
          for (let channel = 0; channel < 3; channel += 1) channels[channel] += image.data[sampleOffset + channel];
          samples += 1;
        }
      }
      const offset = (y * image.width + x) * 4;
      const gains = [0.88, 0.96, 1.04];
      const offsets = [8, 3, 2];
      for (let channel = 0; channel < 3; channel += 1) {
        const noise = ((x * 17 + y * 31 + channel * 11) % 7) - 3;
        data[offset + channel] = Math.max(0, Math.min(255, channels[channel] / samples * gains[channel] + offsets[channel] + noise));
      }
      data[offset + 3] = 255;
    }
  }
  return { width: image.width, height: image.height, data };
}

function makeRenderedImage(
  packet: Uint8Array,
  matrixSize: number,
  includeLocator = true,
  perimeterColor: '#000000' | '#FFFFFF' = '#FFFFFF',
  perimeterWidth = 1,
): PixelImage {
  const layout = createAztecLayout(matrixSize, perimeterColor, perimeterWidth);
  const matrix = renderAztecFrameMatrix(packet, matrixSize, perimeterColor, perimeterWidth);
  const modulePixels = 6;
  const width = layout.frameSize;
  const data = new Uint8ClampedArray(width * width * 4);
  data.fill(255);
  const rgb = COLORS.map((color) => [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ]);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const matrixX = Math.floor((x - layout.matrixOffset) / modulePixels);
      const matrixY = Math.floor((y - layout.matrixOffset) / modulePixels);
      if (matrixX < 0 || matrixX >= matrixSize || matrixY < 0 || matrixY >= matrixSize) continue;
      const color = rgb[matrix[matrixY * matrixSize + matrixX]];
      const offset = (y * width + x) * 4;
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = 255;
    }
  }
  if (includeLocator) {
    const locatorInset = layout.matrixOffset - modulePixels;
    const locatorEnd = width - locatorInset;
    const [red, green, blue] = [
      parseInt(LOCATOR_COLOR.slice(1, 3), 16),
      parseInt(LOCATOR_COLOR.slice(3, 5), 16),
      parseInt(LOCATOR_COLOR.slice(5, 7), 16),
    ];
    for (let y = locatorInset; y < locatorEnd; y += 1) {
      for (let x = locatorInset; x < locatorEnd; x += 1) {
        if (x >= locatorInset + modulePixels && x < locatorEnd - modulePixels &&
          y >= locatorInset + modulePixels && y < locatorEnd - modulePixels) continue;
        const offset = (y * width + x) * 4;
        data[offset] = red;
        data[offset + 1] = green;
        data[offset + 2] = blue;
        data[offset + 3] = 255;
      }
    }
  }
  return { width, height: width, data };
}

function scaleBrightness(image: PixelImage, multiplier: number): PixelImage {
  const data = new Uint8ClampedArray(image.data);
  for (let index = 0; index < data.length; index += 4) {
    data[index] = Math.min(255, data[index] * multiplier);
    data[index + 1] = Math.min(255, data[index + 1] * multiplier);
    data[index + 2] = Math.min(255, data[index + 2] * multiplier);
  }
  return { width: image.width, height: image.height, data };
}

function addDarkCameraBackground(image: PixelImage, size: number): PixelImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index += 1) data[index * 4 + 3] = 255;
  const left = Math.floor((size - image.width) / 2);
  const top = Math.floor((size - image.height) / 2);
  for (let y = 0; y < image.height; y += 1) {
    const sourceStart = y * image.width * 4;
    const targetStart = ((top + y) * size + left) * 4;
    data.set(image.data.subarray(sourceStart, sourceStart + image.width * 4), targetStart);
  }
  return { width: size, height: size, data };
}

function makeOpticalFrame(
  packet: Uint8Array,
  matrixSize: number,
  rotation = 0,
  imageSize = 720,
  includeLocator = true,
  perimeterColor: '#000000' | '#FFFFFF' = '#FFFFFF',
  perimeterWidth = 1,
): PixelImage {
  const sourceImage = makeRenderedImage(packet, matrixSize, includeLocator, perimeterColor, perimeterWidth);
  const sourceSize = sourceImage.width;
  const source = sourceImage.data;
  const width = imageSize;
  const height = imageSize;
  const scale = imageSize / 720;
  const output = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    output[index * 4] = 255;
    output[index * 4 + 1] = 255;
    output[index * 4 + 2] = 255;
    output[index * 4 + 3] = 255;
  }
  const quad = [
    { x: 65, y: 60 },
    { x: 645, y: 78 },
    { x: 640, y: 640 },
    { x: 75, y: 630 },
  ].map(({ x, y }) => ({ x: x * scale, y: y * scale }));
  const targets = [
    { x: 0, y: 0 },
    { x: sourceSize, y: 0 },
    { x: sourceSize, y: sourceSize },
    { x: 0, y: sourceSize },
  ];
  const equations: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = quad[index];
    const { x: targetX, y: targetY } = targets[index];
    equations.push([x, y, 1, 0, 0, 0, -targetX * x, -targetX * y, targetX]);
    equations.push([0, 0, 0, x, y, 1, -targetY * x, -targetY * y, targetY]);
  }
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(equations[row][column]) > Math.abs(equations[pivot][column])) pivot = row;
    }
    [equations[column], equations[pivot]] = [equations[pivot], equations[column]];
    const divisor = equations[column][column];
    for (let entry = column; entry <= 8; entry += 1) equations[column][entry] /= divisor;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = equations[row][column];
      for (let entry = column; entry <= 8; entry += 1) equations[row][entry] -= factor * equations[column][entry];
    }
  }
  const [a, b, c, d, e, f, g, h] = equations.map((row) => row[8]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const denominator = g * x + h * y + 1;
      const u = (a * x + b * y + c) / denominator / sourceSize;
      const v = (d * x + e * y + f) / denominator / sourceSize;
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      let sourceX = Math.floor(u * sourceSize);
      let sourceY = Math.floor(v * sourceSize);
      if (rotation === 1) [sourceX, sourceY] = [Math.floor(v * sourceSize), Math.floor((1 - u) * sourceSize)];
      if (rotation === 2) [sourceX, sourceY] = [Math.floor((1 - u) * sourceSize), Math.floor((1 - v) * sourceSize)];
      if (rotation === 3) [sourceX, sourceY] = [Math.floor((1 - v) * sourceSize), Math.floor(u * sourceSize)];
      sourceX = Math.max(0, Math.min(sourceSize - 1, sourceX));
      sourceY = Math.max(0, Math.min(sourceSize - 1, sourceY));
      const sourceOffset = (sourceY * sourceSize + sourceX) * 4;
      const targetOffset = (y * width + x) * 4;
      output.set(source.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return { width, height, data: output };
}

function makeTransparentExterior(image: PixelImage): PixelImage {
  const data = new Uint8ClampedArray(image.data);
  const visited = new Uint8Array(image.width * image.height);
  const queue = new Int32Array(image.width * image.height);
  let head = 0;
  let tail = 0;
  const addIfExteriorWhite = (x: number, y: number): void => {
    if (x < 0 || x >= image.width || y < 0 || y >= image.height) return;
    const index = y * image.width + x;
    if (visited[index]) return;
    const offset = index * 4;
    if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255 || data[offset + 3] === 0) return;
    visited[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < image.width; x += 1) {
    addIfExteriorWhite(x, 0);
    addIfExteriorWhite(x, image.height - 1);
  }
  for (let y = 0; y < image.height; y += 1) {
    addIfExteriorWhite(0, y);
    addIfExteriorWhite(image.width - 1, y);
  }
  while (head < tail) {
    const index = queue[head++];
    const x = index % image.width;
    const y = Math.floor(index / image.width);
    const offset = index * 4;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    data[offset + 3] = 0;
    addIfExteriorWhite(x - 1, y);
    addIfExteriorWhite(x + 1, y);
    addIfExteriorWhite(x, y - 1);
    addIfExteriorWhite(x, y + 1);
  }
  return { width: image.width, height: image.height, data };
}

function translateImage(image: PixelImage, dx: number, dy: number): PixelImage {
  const data = new Uint8ClampedArray(image.width * image.height * 4);
  for (let index = 0; index < image.width * image.height; index += 1) {
    data[index * 4] = 255;
    data[index * 4 + 1] = 255;
    data[index * 4 + 2] = 255;
    data[index * 4 + 3] = 255;
  }
  for (let y = 0; y < image.height; y += 1) {
    const targetY = y + dy;
    if (targetY < 0 || targetY >= image.height) continue;
    for (let x = 0; x < image.width; x += 1) {
      const targetX = x + dx;
      if (targetX < 0 || targetX >= image.width) continue;
      const sourceOffset = (y * image.width + x) * 4;
      const targetOffset = (targetY * image.width + targetX) * 4;
      data.set(image.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
    }
  }
  return { width: image.width, height: image.height, data };
}

function rotateImage(image: PixelImage, degrees: number): PixelImage {
  const size = Math.ceil(Math.max(image.width, image.height) * 1.5);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    data[index * 4] = 255;
    data[index * 4 + 1] = 255;
    data[index * 4 + 2] = 255;
    data[index * 4 + 3] = 255;
  }
  const center = size / 2;
  const imageCenterX = image.width / 2;
  const imageCenterY = image.height / 2;
  const angle = degrees * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const relativeX = x - center;
      const relativeY = y - center;
      const sourceX = Math.round(cosine * relativeX + sine * relativeY + imageCenterX);
      const sourceY = Math.round(-sine * relativeX + cosine * relativeY + imageCenterY);
      if (sourceX < 0 || sourceX >= image.width || sourceY < 0 || sourceY >= image.height) continue;
      const sourceOffset = (sourceY * image.width + sourceX) * 4;
      data.set(image.data.subarray(sourceOffset, sourceOffset + 4), (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

function makeLegacyRenderedImage(packet: Uint8Array, matrixSize: number): PixelImage {
  const image = makeRenderedImage(packet, matrixSize, true, '#000000', 3);
  const data = new Uint8ClampedArray(image.data);
  const layout = createAztecLayout(matrixSize, '#000000', 3);
  const symbols = encode3BitPayload(packet);
  const frameId = new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true);
  const rgb = COLORS.map((color) => [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ]);
  for (let index = 0; index < layout.dataCoordinates.length; index += 1) {
    let colorIndex = symbols[index] ?? 0;
    if (index >= symbols.length) {
      let state = (frameId ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
      state = (Math.imul(state ^ (state >>> 16), 0x45d9f3b) + 0x27100001) >>> 0;
      state ^= state >>> 13;
      colorIndex = state & 0x7;
    }
    colorIndex = (colorIndex ^ colorSymbolMask(index)) & 0x7;
    const [moduleX, moduleY] = layout.dataCoordinates[index];
    const [red, green, blue] = rgb[colorIndex];
    for (let y = 0; y < MODULE_PIXELS; y += 1) {
      for (let x = 0; x < MODULE_PIXELS; x += 1) {
        const pixelX = layout.matrixOffset + moduleX * MODULE_PIXELS + x;
        const pixelY = layout.matrixOffset + moduleY * MODULE_PIXELS + y;
        const offset = (pixelY * image.width + pixelX) * 4;
        data[offset] = red;
        data[offset + 1] = green;
        data[offset + 2] = blue;
        data[offset + 3] = 255;
      }
    }
  }
  return { width: image.width, height: image.height, data };
}

function assertBalancedDataPalette(matrix: Uint8Array, layout: ReturnType<typeof createAztecLayout>, context: string): void {
  const counts = new Uint16Array(COLORS.length);
  for (const [x, y] of layout.dataCoordinates) counts[matrix[y * layout.targetMatrixSize + x]] += 1;
  assert.equal(counts.filter((count) => count > 0).length, COLORS.length, `${context}: all palette colors must appear`);
  const spread = Math.max(...counts) - Math.min(...counts);
  const maxSpread = Math.ceil(layout.dataCoordinates.length / COLORS.length * 0.4);
  assert.ok(spread <= maxSpread, `${context}: color count spread ${spread} exceeds ${maxSpread}`);
}

test('transparent exterior pixels do not change frame detection', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(80, 19)], 'transparent-test.bin'), 32);
  const image = makeOpticalFrame(transfer.packets[0], 32);
  const opaque = decodeOpticalFrameDetailed(image, 32);
  const transparent = decodeOpticalFrameDetailed(makeTransparentExterior(image), 32);
  assert.equal(opaque.status, 'packet-decoded', opaque.reason);
  assert.equal(transparent.status, 'packet-decoded', transparent.reason);
  assert.equal(transparent.candidateCount, opaque.candidateCount);
  assert.deepStrictEqual(transparent.packet, opaque.packet);
});

test('receiver still accepts frames from older senders with an orange locator border', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(80, 72)], 'legacy-orange-boundary.bin'), 32);
  const image = makeOpticalFrame(transfer.packets[0], 32, 0, 360, true);
  const result = decodeOpticalFrameDetailed(image, 32);
  assert.equal(result.status, 'packet-decoded', result.reason);
  assert.equal(result.locatorDetected, true);
  assert.deepStrictEqual(result.packet, transfer.packets[0]);
});

test('small image translations preserve detected frame corner accuracy', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(80, 23)], 'translation-test.bin'), 32);
  const image = makeOpticalFrame(transfer.packets[0], 32);
  const baseline = decodeOpticalFrameDetailed(image, 32);
  const dx = 4;
  const dy = 3;
  const shifted = decodeOpticalFrameDetailed(translateImage(image, dx, dy), 32);
  assert.equal(baseline.status, 'packet-decoded', baseline.reason);
  assert.equal(shifted.status, 'packet-decoded', shifted.reason);
  assert.ok(baseline.candidateCount > 0);
  assert.ok(shifted.candidateCount > 0);
  assert.ok(baseline.corners && shifted.corners);
  let minimumMaximumError = Infinity;
  for (let shift = 0; shift < 4; shift += 1) {
    let maximumError = 0;
    for (let index = 0; index < 4; index += 1) {
      const expected = baseline.corners[index];
      const actual = shifted.corners[(index + shift) % 4];
      maximumError = Math.max(maximumError, Math.hypot(actual.x - expected.x - dx, actual.y - expected.y - dy));
    }
    minimumMaximumError = Math.min(minimumMaximumError, maximumError);
  }
  assert.ok(minimumMaximumError <= 2, `translated corners drifted by ${minimumMaximumError.toFixed(2)} pixels`);
});

test('bullseye tracking keeps the QR anchored as the camera image moves', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(80, 29)], 'bullseye-track.bin'), 32);
  const image = makeOpticalFrame(transfer.packets[0], 32);
  const baseline = decodeOpticalFrameDetailed(image, 32);
  assert.equal(baseline.status, 'packet-decoded', baseline.reason);
  assert.ok(baseline.corners && baseline.finderCorners);

  const dx = 44;
  const dy = -28;
  const movedImage = translateImage(image, dx, dy);
  const tracked = trackBullseye(movedImage, image, baseline.corners, baseline.finderCorners);
  assert.ok(tracked, 'bullseye should remain trackable after camera movement');
  assert.ok(tracked.score > 0.9, `bullseye match confidence was only ${tracked.score}`);
  const trackedFinderCenter = tracked.finderCorners.reduce(
    (center, point) => ({ x: center.x + point.x / 4, y: center.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  const baselineFinderCenter = baseline.finderCorners.reduce(
    (center, point) => ({ x: center.x + point.x / 4, y: center.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  assert.ok(Math.abs(trackedFinderCenter.x - baselineFinderCenter.x - dx) <= 2,
    `bullseye x shift was ${trackedFinderCenter.x - baselineFinderCenter.x}; center ${baselineFinderCenter.x} to ${trackedFinderCenter.x}`);
  assert.ok(Math.abs(trackedFinderCenter.y - baselineFinderCenter.y - dy) <= 2,
    `bullseye y shift was ${trackedFinderCenter.y - baselineFinderCenter.y}`);
  for (let index = 0; index < baseline.corners.length; index += 1) {
    assert.ok(Math.abs(tracked.corners[index].x - baseline.corners[index].x - dx) <= 8,
      `corner ${index} x shift was ${tracked.corners[index].x - baseline.corners[index].x}`);
    assert.ok(Math.abs(tracked.corners[index].y - baseline.corners[index].y - dy) <= 8,
      `corner ${index} y shift was ${tracked.corners[index].y - baseline.corners[index].y}`);
  }
  const decoded = decodeOpticalFrameDetailed(movedImage, 32, tracked.corners, baseline.locatorDetected);
  assert.equal(decoded.status, 'packet-decoded', decoded.reason);
  assert.deepStrictEqual(decoded.packet, transfer.packets[0]);
});

test('receiver reacquires the frame when tracked corners no longer decode it', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(80, 31)], 'reacquire-test.bin'), 32);
  const image = makeOpticalFrame(transfer.packets[0], 32);
  const baseline = decodeOpticalFrameDetailed(image, 32);
  assert.equal(baseline.status, 'packet-decoded', baseline.reason);
  assert.equal(baseline.locatorDetected, true, 'the orange frame marker should locate generated frames');
  assert.ok(baseline.corners);
  const shiftedImage = translateImage(image, 4, 3);
  const staleCorners = baseline.corners.map(({ x, y }) => ({ x: x + 12, y: y + 9 })) as typeof baseline.corners;
  const reacquired = decodeOpticalFrameDetailed(shiftedImage, 32, staleCorners, baseline.locatorDetected);
  assert.equal(reacquired.status, 'packet-decoded', reacquired.reason);
  assert.equal(reacquired.locatorDetected, true);
  assert.deepStrictEqual(reacquired.packet, transfer.packets[0]);
  assert.ok(reacquired.candidateCount > 0, 'a failed tracked decode must trigger full candidate search');
});

test('receiver falls back to the dark boundary when no locator border is present', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(8, 71)], 'x'), 32);
  const unmarkedImage = makeOpticalFrame(transfer.packets[0], 63, 0, 720, false, '#000000', 3);
  const result = decodeOpticalFrameDetailed(unmarkedImage, 63);
  assert.equal(result.status, 'packet-decoded', result.reason);
  assert.equal(result.locatorDetected, false);
  assert.deepStrictEqual(result.packet, transfer.packets[0]);
});

test('3-bit payload round trips for all final alignments', () => {
  for (let length = 0; length <= 64; length += 1) {
    const bytes = makePayload(length, 17 + length);
    const encoded = encode3BitPayload(bytes);
    const decoded = decode3BitPayload(encoded, bytes.length * 8);
    assert.deepStrictEqual(decoded, bytes, `round-trip failed for payload length=${length}`);
  }

  for (const headByte of [0x00, 0x01, 0x80, 0xff, 0xaa, 0x55]) {
    const payload = new Uint8Array([headByte]);
    const encoded = encode3BitPayload(payload);
    const decoded = decode3BitPayload(encoded, payload.length * 8);
    assert.deepStrictEqual(decoded, payload, 'single-byte payload should survive a 1-bit or 2-bit tail');
  }

  const shortPayloads = [
    new Uint8Array([0x00, 0x00]),
    new Uint8Array([0x01, 0x80]),
    new Uint8Array([0xff, 0xff]),
    new Uint8Array([0x80, 0x01, 0x40]),
  ];

  for (const payload of shortPayloads) {
    const encoded = encode3BitPayload(payload);
    const decoded = decode3BitPayload(encoded, payload.length * 8);
    assert.deepStrictEqual(decoded, payload, 'short payloads should keep their trailing bits');
  }
});

test('CRC32 is stable and detects tampering', () => {
  const payload = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
  const checksum = crc32(payload);
  assert.equal(typeof checksum, 'number');
  assert.equal(crc32(payload), checksum);
  const tampered = new Uint8Array(payload);
  tampered[0] ^= 0x80;
  assert.notEqual(crc32(tampered), checksum);
});

test('packet decoding ignores padded color modules and preserves the exact packet bytes', async () => {
  const file = new File([new Uint8Array([0x12, 0x34, 0x56, 0x78])], 'packet.bin');
  const transfer = await prepareAztecTransfer(file, 63);
  const packet = transfer.packets[0];
  const symbols = encode3BitPayload(packet);
  const capacity = createAztecLayout(63).dataCoordinates.length;
  const paddedSymbols = new Uint8Array(capacity);
  for (let index = 0; index < paddedSymbols.length; index += 1) {
    paddedSymbols[index] = ((symbols[index] ?? 0) ^ colorSymbolMask(index)) & 0x7;
  }

  const nonBlackPadding = paddedSymbols.slice(symbols.length).filter((symbol) => symbol !== 0).length;
  assert.ok(nonBlackPadding > (paddedSymbols.length - symbols.length) * 0.7, 'zero-filled packet padding should render as a varied color pattern');
  const decodedSymbols = paddedSymbols.map((symbol, index) => symbol ^ colorSymbolMask(index));
  assert.deepStrictEqual(decode3BitPacket(decodedSymbols), packet);
  paddedSymbols[0] ^= 1;
  const corruptedSymbols = paddedSymbols.map((symbol, index) => symbol ^ colorSymbolMask(index));
  assert.equal(decode3BitPacket(corruptedSymbols), null, 'a corrupted packet must fail its CRC');
});

test('renderer redraws every module and changes frame-dependent padding', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(200, 19)], 'render.bin'), 63);
  const firstPacket = transfer.packets[0];
  const nextPacket = transfer.packets[1];
  const size = transfer.targetMatrixSize;
  const layout = createAztecLayout(size);
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => context,
  } as unknown as HTMLCanvasElement;
  let fillStyle = '';
  let extraColorFills = 0;
  let draws = new Map<number, string>();
  const context = {
    clearRect: () => { draws = new Map<number, string>(); },
    fillRect: (x: number, y: number, width: number, height: number) => {
      if (width !== 6 || height !== 6) {
        if (fillStyle !== '#FFFFFF') extraColorFills += 1;
        return;
      }
      assert.equal(width, 6);
      assert.equal(height, 6);
      draws.set(((y - layout.matrixOffset) / 6) * size + (x - layout.matrixOffset) / 6, fillStyle);
    },
    set fillStyle(value: string) { fillStyle = value; },
    get fillStyle() { return fillStyle; },
  } as unknown as CanvasRenderingContext2D;

  const first = drawAztecFrame(firstPacket, canvas, size);
  const firstMatrix = renderAztecFrameMatrix(firstPacket, size);
  assert.equal(extraColorFills, 4, 'new frames should paint a clear orange locator border around the quiet zone');
  assert.equal(first.width, (size + 2) * 6 + 4);
  assert.equal(first.height, (size + 2) * 6 + 4);
  assert.equal(draws.size, size * size, 'every matrix module, including corners, must be redrawn');
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      assert.equal(draws.get(y * size + x), COLORS[firstMatrix[y * size + x]]);
    }
  }
  assert.equal(firstMatrix[0], 7);
  assert.equal(firstMatrix[size - 1], 7);
  assert.equal(firstMatrix[(size - 1) * size], 7);
  assert.equal(firstMatrix[size * size - 1], 7);

  const second = drawAztecFrame(nextPacket, canvas, size);
  const secondMatrix = renderAztecFrameMatrix(nextPacket, size);
  assert.equal(extraColorFills, 8, 'successive frames should redraw the orange locator border');
  assert.equal(draws.size, size * size, 'the next frame must also redraw the complete matrix');
  assert.ok(second.changedModules > size * size * 0.2, 'a new frame must replace stale symbols across the data region');
  assert.equal(second.totalModules, size * size);
  assert.notDeepEqual(firstMatrix, secondMatrix);
});

test('32x32 frames balance and spatially mix all eight colors in unused modules', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(200, 47)], 'color-mix.bin'), 32);
  const layout = createAztecLayout(32);
  for (const [frameIndex, packet] of transfer.packets.entries()) {
    const matrix = renderAztecFrameMatrix(packet, 32);
    assertBalancedDataPalette(matrix, layout, `frame ${frameIndex}`);
  }

  const packet = transfer.packets[1];
  assert.ok(packet, 'test transfer should include a second frame');
  const symbols = encode3BitPayload(packet);
  const matrix = renderAztecFrameMatrix(packet, 32);
  const padding = layout.dataCoordinates
    .slice(symbols.length)
    .map(([x, y]) => matrix[y * 32 + x]);
  assert.ok(padding.length >= 64, 'repair frame should leave enough padding to check its color pattern');
  const repeatedEveryEight = padding.slice(8).filter((color, index) => color === padding[index]).length;
  assert.ok(
    repeatedEveryEight < (padding.length - 8) * 0.4,
    `padding retained a repeating palette cycle (${repeatedEveryEight}/${padding.length - 8} colors matched at an eight-module interval)`,
  );
});

test('32x32 and 63x63 layouts share a centered fixed-size finder and disjoint data geometry', () => {
  for (const size of [32, 63]) {
    const layout = createAztecLayout(size);
    assert.equal(layout.finderSize, size % 2 === 0 ? EVEN_FINDER_SIZE : FINDER_SIZE);
    assert.equal(layout.finderSize, size === 32 ? 8 : 9);
    assert.equal(layout.finderCenter, size / 2);
    assert.equal(layout.finderStart, (size - layout.finderSize) / 2);
    assert.equal(layout.matrixOffset, QUIET_ZONE_MODULES * MODULE_PIXELS + 2);
    assert.equal(layout.frameSize, (size + QUIET_ZONE_MODULES * 2) * MODULE_PIXELS + 4);
    for (let index = 0; index < size; index += 1) {
      assert.equal(layout.grid[0][index], '#FFFFFF');
      assert.equal(layout.grid[size - 1][index], '#FFFFFF');
      assert.equal(layout.grid[index][0], '#FFFFFF');
      assert.equal(layout.grid[index][size - 1], '#FFFFFF');
    }

    const data = new Set(layout.dataCoordinates.map(([x, y]) => `${x},${y}`));
    assert.ok(data.has('3,1'), 'the internal white border should be one module thick');
    for (const structural of layout.alignmentCoordinates) assert.equal(data.has(structural), false);
    for (let ring = 0; ring < Math.ceil(layout.finderSize / 2); ring += 1) {
      const expected = Math.floor(ring / FINDER_RING_THICKNESS) % 2 === 0 ? '#000000' : '#FFFFFF';
      const near: number = layout.finderStart + ring;
      const far: number = layout.finderStart + layout.finderSize - 1 - ring;
      const ringCorners: Array<[number, number]> = [[near, near], [far, near], [far, far], [near, far]];
      for (const [x, y] of ringCorners) {
        assert.equal(layout.grid[y][x], expected);
      }
    }
    for (let y = Math.floor(layout.finderCenter) - 1; y <= Math.floor(layout.finderCenter); y += 1) {
      for (let x = Math.floor(layout.finderCenter) - 1; x <= Math.floor(layout.finderCenter); x += 1) {
        const centerRing: number = Math.floor(Math.min(
          x - layout.finderStart,
          y - layout.finderStart,
          layout.finderStart + layout.finderSize - 1 - x,
          layout.finderStart + layout.finderSize - 1 - y,
        ) / FINDER_RING_THICKNESS) % 2;
        assert.equal(layout.grid[y][x], centerRing === 0 ? '#000000' : '#FFFFFF');
      }
    }
    const matrix = renderAztecFrameMatrix(new Uint8Array([0]), size);
    const nextMatrix = renderAztecFrameMatrix(new Uint8Array([1]), size);
    assert.equal(new Set(matrix).size, COLORS.length, 'the matrix must preserve all eight encoding colours');
    for (let y = layout.finderStart; y < layout.finderStart + layout.finderSize; y += 1) {
      for (let x = layout.finderStart; x < layout.finderStart + layout.finderSize; x += 1) {
        assert.equal(matrix[y * size + x], nextMatrix[y * size + x], 'finder geometry must not vary between frames');
      }
    }
  }
});

test('32x32 and compact 24x24 frames carry and decode valid packets', async () => {
  const file = new File([new TextEncoder().encode('HCAC test')], 'hcac-self-test.txt', { type: 'text/plain' });
  const transfer = await prepareAztecTransfer(file, 32);
  const layout = createAztecLayout(32);
  assert.equal(transfer.targetMatrixSize, 32);
  assert.equal(transfer.blockCount, 1, 'the 32x32 decoder self-test must fit in one frame');
  assert.equal(createAztecLayout(32).frameSize, 208);
  assert.equal(renderAztecFrameMatrix(transfer.packets[0], 32).length, 32 * 32);
  for (const packet of transfer.packets) {
    const matrix = renderAztecFrameMatrix(packet, 32);
    assertBalancedDataPalette(matrix, layout, `32x32 packet ${new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true)}`);
    const trace = decodeOpticalFrameDetailed(makeRenderedImage(packet, 32), 32);
    assert.equal(trace.status, 'packet-decoded', trace.reason);
    assert.equal(trace.locatorDetected, true);
    assert.deepStrictEqual(trace.packet, packet);
  }
  assert.ok(transfer.blockSize > 0);

  assert.equal(Math.floor(createAztecLayout(24).dataCoordinates.length * 3 / 8), 139);
  const compactTransfer = await prepareAztecTransfer(file, 24);
  assert.ok(compactTransfer.blockCount > 0, 'the 24x24 frame should fit the short test transfer');
  const compactTrace = decodeOpticalFrameDetailed(makeRenderedImage(compactTransfer.packets[0], 24), 24);
  assert.equal(compactTrace.status, 'packet-decoded', compactTrace.reason);
  assert.deepStrictEqual(compactTrace.packet, compactTransfer.packets[0]);
});

test('receiver uses CRC-backed color recovery for ambiguous module samples', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(100, 91)], 'ambiguous-color.bin'), 32);
  const packet = transfer.packets[0];
  const layout = createAztecLayout(32);
  const matrix = renderAztecFrameMatrix(packet, 32);
  const image = makeRenderedImage(packet, 32);
  const [x, y] = layout.dataCoordinates[42];
  const sourceIndex = matrix[y * 32 + x];
  const sourceRgb = [1, 3, 5].map((offset) => parseInt(COLORS[sourceIndex].slice(offset, offset + 2), 16));
  let alternateRgb: number[] = [];
  let nearestDistance = Infinity;
  for (let color = 0; color < COLORS.length; color += 1) {
    if (color === sourceIndex) continue;
    const candidate = [1, 3, 5].map((offset) => parseInt(COLORS[color].slice(offset, offset + 2), 16));
    const distance = Math.hypot(candidate[0] - sourceRgb[0], candidate[1] - sourceRgb[1], candidate[2] - sourceRgb[2]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      alternateRgb = candidate;
    }
  }
  for (let pixelY = layout.matrixOffset + y * MODULE_PIXELS; pixelY < layout.matrixOffset + (y + 1) * MODULE_PIXELS; pixelY += 1) {
    for (let pixelX = layout.matrixOffset + x * MODULE_PIXELS; pixelX < layout.matrixOffset + (x + 1) * MODULE_PIXELS; pixelX += 1) {
      const offset = (pixelY * image.width + pixelX) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        image.data[offset + channel] = Math.round((sourceRgb[channel] + alternateRgb[channel]) / 2);
      }
    }
  }
  const result = decodeOpticalFrameDetailed(image, 32);
  assert.equal(result.status, 'packet-decoded', `${result.reason}; confidence=${result.colourConfidence}; finder=${result.candidateConfidence}; corners=${JSON.stringify(result.corners)}`);
  assert.deepStrictEqual(result.packet, packet);
});

test('receiver corrects three low-confidence module colors when CRC validates the packet', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(100, 92)], 'three-color-errors.bin'), 32);
  const packet = transfer.packets[0];
  const layout = createAztecLayout(32);
  const matrix = renderAztecFrameMatrix(packet, 32);
  const image = makeRenderedImage(packet, 32);
  const palette = COLORS.map((color) => [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16)));
  for (const index of [31, 83, 147]) {
    const [x, y] = layout.dataCoordinates[index];
    const sourceIndex = matrix[y * 32 + x];
    const source = palette[sourceIndex];
    let alternate = 0;
    let nearestDistance = Infinity;
    for (let color = 0; color < palette.length; color += 1) {
      if (color === sourceIndex) continue;
      const candidate = palette[color];
      const distance = Math.hypot(candidate[0] - source[0], candidate[1] - source[1], candidate[2] - source[2]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        alternate = color;
      }
    }
    const alternateRgb = palette[alternate];
    for (let pixelY = layout.matrixOffset + y * MODULE_PIXELS; pixelY < layout.matrixOffset + (y + 1) * MODULE_PIXELS; pixelY += 1) {
      for (let pixelX = layout.matrixOffset + x * MODULE_PIXELS; pixelX < layout.matrixOffset + (x + 1) * MODULE_PIXELS; pixelX += 1) {
        const offset = (pixelY * image.width + pixelX) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          image.data[offset + channel] = Math.round(source[channel] * 0.5 + alternateRgb[channel] * 0.5);
        }
      }
    }
  }
  const result = decodeOpticalFrameDetailed(image, 32);
  assert.equal(result.status, 'packet-decoded', `${result.reason}; confidence=${result.colourConfidence}; finder=${result.candidateConfidence}`);
  assert.deepStrictEqual(result.packet, packet);
});

test('receiver decodes lower-resolution camera frames with blur, noise, and color cast', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(96, 95)], 'camera-noise.bin'), 32);
  const image = addCameraBlurAndColorCast(makeOpticalFrame(transfer.packets[0], 32, 0, 360));
  const result = decodeOpticalFrameDetailed(image, 32);
  assert.equal(result.status, 'packet-decoded', `${result.reason}; confidence=${result.colourConfidence}; finder=${result.candidateConfidence}; corners=${JSON.stringify(result.corners)}`);
  assert.equal(result.locatorDetected, true);
  assert.deepStrictEqual(result.packet, transfer.packets[0]);
});

test('actual sender render decodes in the receiver pipeline at varied brightness', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(128, 77)], 'self-test.bin'), 63);
  const image = makeRenderedImage(transfer.packets[0], transfer.targetMatrixSize);
  const layout = createAztecLayout(transfer.targetMatrixSize);
  for (const packet of transfer.packets) {
    const matrix = renderAztecFrameMatrix(packet, transfer.targetMatrixSize);
    assertBalancedDataPalette(matrix, layout, `${transfer.targetMatrixSize}x${transfer.targetMatrixSize} packet ${new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint32(0, true)}`);
  }
  for (const brightness of [0.7, 1, 1.15]) {
    const trace = decodeOpticalFrameDetailed(scaleBrightness(image, brightness), transfer.targetMatrixSize);
    assert.equal(trace.status, 'packet-decoded', `decoder failed at brightness multiplier ${brightness}: ${trace.reason}`);
    assert.equal(trace.geometryCandidates, 1);
    assert.equal(trace.orientationFound, true);
    assert.equal(trace.gridSampled, true);
    assert.equal(trace.recognizedModules, trace.totalModules);
    assert.equal(trace.headerValid, true);
    assert.equal(trace.crcValid, true);
    assert.deepStrictEqual(trace.packet, transfer.packets[0]);
  }
  const dimLocator = decodeOpticalFrameDetailed(scaleBrightness(image, 0.3), transfer.targetMatrixSize);
  assert.equal(dimLocator.status, 'packet-decoded', dimLocator.reason);
  assert.equal(dimLocator.locatorDetected, true, 'the orange marker should remain detectable under reduced brightness');
  const firstDetection = decodeOpticalFrameDetailed(image, transfer.targetMatrixSize);
  assert.equal(firstDetection.status, 'packet-decoded');
  assert.equal(firstDetection.finderSizeModules, createAztecLayout(transfer.targetMatrixSize).finderSize);
  const trackedFrame = decodeOpticalFrameDetailed(image, transfer.targetMatrixSize, firstDetection.corners, firstDetection.locatorDetected);
  assert.equal(trackedFrame.status, 'packet-decoded', trackedFrame.reason);
  assert.equal(trackedFrame.locatorDetected, true);
  assert.equal(trackedFrame.trackedCandidate, true);
  assert.equal(trackedFrame.candidateCount, 0, 'tracked reads must not inflate newly detected candidate counts');
  const legacyTransfer = await prepareAztecTransfer(new File([makePayload(8, 77)], 'x'), 32);
  const legacyFrame = decodeOpticalFrameDetailed(makeLegacyRenderedImage(legacyTransfer.packets[0], 63), 63);
  assert.equal(legacyFrame.status, 'packet-decoded', `legacy color mapping failed: ${legacyFrame.reason}`);
  assert.deepStrictEqual(legacyFrame.packet, legacyTransfer.packets[0]);
  const corruptedPacket = transfer.packets[0].slice();
  corruptedPacket[corruptedPacket.length - 5] ^= 0x80;
  corruptedPacket[corruptedPacket.length - 9] ^= 0x35;
  corruptedPacket[corruptedPacket.length - 13] ^= 0xa2;
  const trackedCrcFailure = decodeOpticalFrameDetailed(
    makeRenderedImage(corruptedPacket, transfer.targetMatrixSize),
    transfer.targetMatrixSize,
    firstDetection.corners,
    firstDetection.locatorDetected,
  );
  assert.equal(trackedCrcFailure.status, 'crc-failed', trackedCrcFailure.reason);
  assert.equal(trackedCrcFailure.trackedCandidate, true);
  assert.equal(trackedCrcFailure.candidateCount, 0);
  const darkRoomTrace = decodeOpticalFrameDetailed(addDarkCameraBackground(image, 720), transfer.targetMatrixSize);
  assert.equal(darkRoomTrace.status, 'packet-decoded', `quiet zone should separate the matrix from a dark screen background: ${darkRoomTrace.reason}`);
  assert.deepStrictEqual(darkRoomTrace.packet, transfer.packets[0]);
});

test('receiver diagnostics distinguish absent candidates, bad geometry, and CRC failures', async () => {
  const size = 240;
  const white = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    white[index * 4] = 255;
    white[index * 4 + 1] = 255;
    white[index * 4 + 2] = 255;
    white[index * 4 + 3] = 255;
  }
  const noCandidate = decodeOpticalFrameDetailed({ width: size, height: size, data: white }, 63);
  assert.equal(noCandidate.status, 'candidate-not-found');
  assert.match(noCandidate.reason, /No orange locator border or dark frame boundary/);
  const trackedOnly = decodeOpticalFrameDetailed({ width: size, height: size, data: white }, 63, [
    { x: 40, y: 40 },
    { x: 200, y: 40 },
    { x: 200, y: 200 },
    { x: 40, y: 200 },
  ]);
  assert.equal(trackedOnly.candidateCount, 0, 'tracked coordinates must not be reported as a newly detected candidate');
  assert.equal(trackedOnly.trackedCandidate, true);

  for (let y = 70; y < 130; y += 1) {
    for (let x = 70; x < 130; x += 1) {
      const offset = (y * size + x) * 4;
      white[offset] = 0;
      white[offset + 1] = 0;
      white[offset + 2] = 0;
    }
  }
  const badGeometry = decodeOpticalFrameDetailed({ width: size, height: size, data: white }, 63);
  assert.equal(badGeometry.status, 'geometry-failed');
  assert.match(badGeometry.reason, /covers less than 8%/);

  const transfer = await prepareAztecTransfer(new File([makePayload(32, 90)], 'crc.bin'), 63);
  const corrupted = transfer.packets[0].slice();
  corrupted[corrupted.length - 5] ^= 0x80;
  const crcTrace = decodeOpticalFrameDetailed(makeRenderedImage(corrupted, 63), 63);
  assert.equal(crcTrace.status, 'crc-failed');
  assert.equal(crcTrace.headerValid, true);
  assert.equal(crcTrace.crcValid, false);
  assert.match(crcTrace.reason, /CRC32/);
});

test('empty files and UTF-8 filenames retain valid packet metadata', async () => {
  const file = new File([], '資料-🧪.bin', { type: 'application/octet-stream' });
  const transfer = await prepareAztecTransfer(file, 63);
  assert.equal(transfer.totalBytes, 0);
  assert.equal(transfer.blockCount, 1);
  const packet = transfer.packets[0];
  const degree = packet[20];
  const metadataOffset = 21 + degree * 2;
  const metadataLength = packet[metadataOffset];
  const metadata = packet.subarray(metadataOffset + 1, metadataOffset + 1 + metadataLength);
  const nameLength = metadata[2];
  assert.equal(new TextDecoder().decode(metadata.subarray(3, 3 + nameLength)), file.name);

  const solver = new FountainEquationSolver(transfer.blockCount, transfer.blockSize);
  const payloadOffset = metadataOffset + 1 + metadataLength;
  assert.equal(solver.addEquation([0], packet.subarray(payloadOffset, payloadOffset + transfer.blockSize)), true);
  assert.equal(solver.solved.size, 1);
  assert.ok(solver.solved.get(0)?.every((value) => value === 0));
});

test('file metadata exceeding protocol limits is rejected instead of truncated', async () => {
  const file = new File([], `${'a'.repeat(118)}🧪.bin`);
  await assert.rejects(prepareAztecTransfer(file, 63), /File name exceeds the 120-byte transfer limit/);
  const typedFile = new File([], 'file.bin', { type: 'a'.repeat(121) });
  await assert.rejects(prepareAztecTransfer(typedFile, 63), /File type exceeds the 120-byte transfer limit/);
});

test('incremental fountain solver handles out-of-order and repeated equations', () => {
  const solver = new FountainEquationSolver(2, 2);
  assert.equal(solver.addEquation([0, 1], new Uint8Array([0x13, 0x37])), true);
  assert.equal(solver.addEquation([0], new Uint8Array([0x12, 0x34])), true);
  assert.deepStrictEqual(solver.solved.get(1), new Uint8Array([0x01, 0x03]));
  assert.equal(solver.addEquation([0], new Uint8Array([0x12, 0x34])), true, 'an identical duplicate should be harmless');
  assert.equal(solver.addEquation([0], new Uint8Array([0x99, 0x99])), false, 'a conflicting duplicate must be rejected');
  assert.equal(solver.addEquation([0, 0], new Uint8Array([0, 0])), false, 'duplicate block indices must be rejected');
});

test('32x32 transfer can recover when the first QR is missing', async () => {
  const source = makePseudoRandomPayload(512, 83);
  const transfer = await prepareAztecTransfer(new File([source], 'reverse-order.bin', { type: 'application/octet-stream' }), 32);
  assert.ok(transfer.blockCount > 1);
  const solver = new FountainEquationSolver(transfer.blockCount, transfer.blockSize);
  let transferMetadata: Uint8Array | null = null;
  for (const packet of [...transfer.packets].reverse()) {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const frameId = view.getUint32(0, true);
    const degree = packet[20];
    let offset = 21;
    const indices: number[] = [];
    for (let index = 0; index < degree; index += 1) {
      indices.push(view.getUint16(offset, true));
      offset += 2;
    }
    const metadataLength = packet[offset++];
    const packetMetadata = packet.subarray(offset, offset + metadataLength);
    assert.ok(metadataLength > 1, `frame ${frameId} should include complete transfer metadata`);
    if (transferMetadata) {
      assert.deepStrictEqual(packetMetadata, transferMetadata, `frame ${frameId} should repeat transfer metadata`);
    } else {
      transferMetadata = packetMetadata.slice();
    }
    offset += metadataLength;
    if (frameId === 0) continue;
    assert.equal(solver.addEquation(indices, packet.subarray(offset, offset + transfer.blockSize)), true);
  }
  assert.equal(solver.solved.size, transfer.blockCount);
  const reconstructed = new Uint8Array(transfer.encodedBytes);
  for (let index = 0; index < transfer.blockCount; index += 1) {
    const block = solver.solved.get(index);
    assert.ok(block, `missing source block ${index}`);
    reconstructed.set(block.subarray(0, Math.min(block.length, reconstructed.length - index * transfer.blockSize)), index * transfer.blockSize);
  }
  assert.deepStrictEqual(
    transfer.compressed ? await decompressGzip(reconstructed, source.length) : reconstructed,
    source,
  );
});

test('gzip compression reduces frame count and receiver restores the original file bytes', async () => {
  const source = new TextEncoder().encode('The same repeated text is highly compressible. '.repeat(4000));
  const transfer = await prepareAztecTransfer(new File([source], 'compressed.txt', { type: 'text/plain' }), 32);
  assert.equal(transfer.compressed, true);
  assert.ok(transfer.encodedBytes < source.length / 10, 'repetitive input should compress substantially');
  assert.ok(transfer.blockCount < Math.ceil(source.length / transfer.blockSize) / 5, 'compression should substantially reduce source blocks');
  const uncompressedBlocks = Math.ceil(source.length / transfer.blockSize);
  const uncompressedFrames = uncompressedBlocks + Math.ceil(uncompressedBlocks * 1.5);
  assert.ok(transfer.frameCount < uncompressedFrames, 'compression should reduce the number of frames sent');

  const packet = transfer.packets[0];
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  assert.equal(view.getUint32(4, true), transfer.encodedBytes, 'packet header must advertise compressed length');
  const metadataOffset = 21 + packet[20] * 2;
  const metadataLength = packet[metadataOffset];
  const metadata = packet.subarray(metadataOffset + 1, metadataOffset + 1 + metadataLength);
  assert.equal(metadata[0], 3, 'compressed transfer metadata must use the compact format');
  assert.equal(metadata[1], 1, 'metadata must identify gzip compression');
  assert.equal(new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength).getUint32(2, true), source.length);
  assert.equal(metadata.length, 2 + 4 + 1 + new TextEncoder().encode('compressed.txt').length +
    1 + new TextEncoder().encode('text/plain').length + 32, 'metadata should store the SHA-256 digest in binary');

  const solver = new FountainEquationSolver(transfer.blockCount, transfer.blockSize);
  for (const sourcePacket of transfer.packets.slice(0, transfer.blockCount)) {
    const sourceView = new DataView(sourcePacket.buffer, sourcePacket.byteOffset, sourcePacket.byteLength);
    const degree = sourcePacket[20];
    let offset = 21 + degree * 2;
    const metadataBytes = sourcePacket[offset++];
    offset += metadataBytes;
    assert.equal(solver.addEquation([sourceView.getUint16(21, true)], sourcePacket.subarray(offset, offset + transfer.blockSize)), true);
  }
  const encoded = new Uint8Array(transfer.encodedBytes);
  for (let index = 0; index < transfer.blockCount; index += 1) {
    const block = solver.solved.get(index);
    assert.ok(block, `missing compressed source block ${index}`);
    encoded.set(block.subarray(0, Math.min(block.length, encoded.length - index * transfer.blockSize)), index * transfer.blockSize);
  }
  const restored = await decompressGzip(encoded, source.length);
  assert.deepStrictEqual(restored, source);
  assert.equal(await sha256Hex(restored), await sha256Hex(source));
  await assert.rejects(decompressGzip(encoded, source.length - 1), /exceeds its .* size limit/);

  const noise = makePseudoRandomPayload(512, 0x71a4c3);
  const uncompressed = await prepareAztecTransfer(new File([noise], 'noise.bin'), 32);
  assert.equal(uncompressed.compressed, false, 'incompressible files should not gain a gzip header');
  assert.equal(uncompressed.encodedBytes, noise.length);
  const plainPacket = uncompressed.packets[0];
  const plainOffset = 21 + plainPacket[20] * 2;
  const plainMetadataLength = plainPacket[plainOffset];
  const plainMetadata = plainPacket.subarray(plainOffset + 1, plainOffset + 1 + plainMetadataLength);
  assert.equal(plainMetadata[0], 3, 'uncompressed transfers should use compact metadata');
  assert.equal(plainMetadata[1], 0, 'uncompressed compact metadata should not set encoding flags');
  const plainNameLength = plainMetadata[2];
  const plainTypeLengthOffset = 3 + plainNameLength;
  const plainTypeLength = plainMetadata[plainTypeLengthOffset];
  assert.equal(plainMetadata.length, 2 + 1 + plainNameLength + 1 + plainTypeLength + 32);
  assert.equal(plainMetadata.length, 1 + 1 + plainNameLength + 1 + plainTypeLength + 1 + 64 - 32,
    'binary SHA-256 metadata should save 32 bytes versus hexadecimal');
  const capacity = Math.floor(createAztecLayout(32).dataCoordinates.length * 3 / 8);
  const legacyMetadataLength = 1 + 1 + plainNameLength + 1 + plainTypeLength + 1 + 64;
  const legacyBlockSize = Math.min(capacity - 26 - 24 * 2 - 1, capacity - 26 - 24 * 2 - legacyMetadataLength);
  const legacyBlockCount = Math.ceil(noise.length / legacyBlockSize);
  assert.ok(uncompressed.blockSize > legacyBlockSize, 'compact metadata should free first-packet capacity for file data');
  assert.ok(uncompressed.frameCount < legacyBlockCount + Math.ceil(legacyBlockCount * 1.5),
    'compact metadata should reduce the total frames for this 32x32 transfer');
});

test('matrix and file size limits reject unsupported input', async () => {
  assert.throws(() => createAztecLayout(30), /24, 32, or an odd integer from 31 through 999/);
  assert.throws(() => createAztecLayout(26), /24, 32, or an odd integer from 31 through 999/);
  assert.throws(() => createAztecLayout(1001), /24, 32, or an odd integer from 31 through 999/);
  await assert.rejects(prepareAztecTransfer(new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'too-large.bin'), 63), /larger than 16 MiB/);
  await assert.rejects(prepareAztecTransfer(new File([], 'too-small-matrix.bin'), 24), /cannot fit a safe fountain packet/);
});

test('32x32 and 63x63 camera frames rectify perspective and identify quarter-turn orientation', async () => {
  const file = new File([new Uint8Array([0x12, 0x34, 0x56, 0x78, 0x90])], 'camera.bin');
  for (const matrixSize of [32, 63]) {
    const transfer = await prepareAztecTransfer(file, matrixSize);
    const packet = transfer.packets[0];
    for (const imageSize of [360, 720]) {
      for (const rotation of [0, 1, 2, 3]) {
        const image = makeOpticalFrame(packet, matrixSize, rotation, imageSize);
        const decoded = decodeOpticalFrame(image, matrixSize);
        if (!decoded) throw new Error(`Failed to decode ${matrixSize}x${matrixSize} perspective frame at ${imageSize}px and ${rotation * 90} degrees: ${decodeOpticalFrameDetailed(image, matrixSize).reason}`);
        assert.equal(decoded.trace?.locatorDetected, true);
        assert.deepStrictEqual(decoded.packet, packet, `packet mismatch for ${matrixSize}x${matrixSize} at ${imageSize}px and ${rotation * 90} degrees`);
      }
    }
  }
});

test('receiver decodes frames rotated to arbitrary angles', async () => {
  const transfer = await prepareAztecTransfer(new File([makePayload(96, 123)], 'angled-frame.bin'), 32);
  for (const angle of [15, 33, 45, 72, 123, 177]) {
    const rotated = rotateImage(makeOpticalFrame(transfer.packets[0], 32), angle);
    const trace = decodeOpticalFrameDetailed(rotated, 32);
    assert.equal(trace.status, 'packet-decoded', `${angle} degree rotation: ${trace.reason}; candidates=${trace.candidateCount}; corners=${JSON.stringify(trace.corners)}`);
    assert.deepStrictEqual(trace.packet, transfer.packets[0], `${angle} degree rotation returned different data`);
  }
});

test('SHA-256 digest is deterministic and hex-encoded', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const digest = await sha256Hex(bytes);
  assert.equal(digest.length, 64);
  assert.equal(await sha256Hex(bytes), digest);
  assert.notEqual(digest, '');
});

test('valid optical packet reaches reconstruction and verifies the complete file hash', async () => {
  const source = makePayload(64, 33);
  const file = new File([source], 'verified.bin', { type: 'application/octet-stream' });
  const transfer = await prepareAztecTransfer(file, 63);
  const trace = decodeOpticalFrameDetailed(makeRenderedImage(transfer.packets[0], 63), 63);
  assert.equal(trace.status, 'packet-decoded');
  assert.ok(trace.packet);
  const packet = trace.packet;
  const degree = packet[20];
  let offset = 21 + degree * 2;
  const metadataLength = packet[offset++];
  const metadata = packet.subarray(offset, offset + metadataLength);
  assert.equal(metadata[0], 3);
  const compressed = metadata[1] === 1;
  const nameLengthOffset = compressed ? 6 : 2;
  const nameLength = metadata[nameLengthOffset];
  const typeLengthOffset = nameLengthOffset + 1 + nameLength;
  const typeLength = metadata[typeLengthOffset];
  const hashStart = typeLengthOffset + 1 + typeLength;
  const expectedHash = Array.from(metadata.subarray(hashStart), (byte) => byte.toString(16).padStart(2, '0')).join('');
  offset += metadataLength;
  const payload = packet.subarray(offset, offset + transfer.blockSize);
  const solver = new FountainEquationSolver(transfer.blockCount, transfer.blockSize);
  assert.equal(solver.addEquation([0], payload), true);
  const reconstructed = solver.solved.get(0)?.subarray(0, source.length);
  assert.deepStrictEqual(reconstructed, source);
  assert.equal(await sha256Hex(reconstructed ?? new Uint8Array()), expectedHash);
});

test('fountain packets recover files through realistic packet-loss patterns', async () => {
  const payload = makePseudoRandomPayload(1_000_000, 0x51f15e);
  const file = new File([payload], 'fountain.bin', { type: 'application/octet-stream' });
  const transfer = await prepareAztecTransfer(file, 95);
  assert.ok(transfer.blockCount > 1, 'expected multi-block file for a meaningful fountain recovery test');

  const scenarios = [
    { lossRate: 0, pattern: 'random' },
    { lossRate: 0.05, pattern: 'random' },
    { lossRate: 0.1, pattern: 'random' },
    { lossRate: 0.15, pattern: 'random' },
    { lossRate: 0.2, pattern: 'random' },
    { lossRate: 0.15, pattern: 'burst' },
  ] as const;

  for (const { lossRate, pattern } of scenarios) {
    const packetCount = transfer.packets.length;
    const dropped = new Set<number>();
    const random = (seed: number): number => {
      const x = Math.sin(seed * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };
    for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
      let shouldDrop = false;
      if (pattern === 'burst') {
        const burstStart = Math.floor(packetCount * 0.3);
        const burstLength = Math.max(1, Math.floor(packetCount * 0.18));
        shouldDrop = packetIndex >= burstStart && packetIndex < burstStart + burstLength && random(packetIndex + 1) < lossRate;
      } else {
        shouldDrop = random(packetIndex + 1 + lossRate * 1000) < lossRate;
      }
      if (shouldDrop) dropped.add(packetIndex);
    }

    const equations = new Map<number, { indices: number[]; data: Uint8Array }>();
    const solver = new FountainEquationSolver(transfer.blockCount, transfer.blockSize);
    for (let packetIndex = 0; packetIndex < packetCount; packetIndex += 1) {
      if (dropped.has(packetIndex)) continue;
      const packet = transfer.packets[packetIndex];
      const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
      const frameId = view.getUint32(0, true);
      const blockCount = view.getUint16(16, true);
      const blockSize = view.getUint16(18, true);
      let offset = 21;
      const indices: number[] = [];
      const degree = packet[20];
      for (let index = 0; index < degree; index += 1) {
        indices.push(view.getUint16(offset, true));
        offset += 2;
      }
      const metadataLength = packet[offset++] ?? 0;
      offset += metadataLength;
      const payload = packet.subarray(offset, offset + blockSize);
      equations.set(frameId, { indices, data: payload });
      assert.equal(solver.addEquation(indices, payload), true, `equation ${frameId} was rejected`);
    }

    const solved = solver.solved;
    assert.ok(solved.size >= transfer.blockCount, `recovery failed at ${lossRate * 100}% ${pattern} loss`);
    const recovered = new Uint8Array(transfer.encodedBytes);
    for (let blockIndex = 0; blockIndex < transfer.blockCount; blockIndex += 1) {
      const block = solved.get(blockIndex);
      if (!block) throw new Error(`Missing block ${blockIndex} after ${lossRate * 100}% ${pattern} loss.`);
      const start = blockIndex * transfer.blockSize;
      recovered.set(block.subarray(0, Math.min(block.length, recovered.length - start)), start);
    }
    const restored = transfer.compressed ? await decompressGzip(recovered, payload.length) : recovered;
    assert.deepStrictEqual(restored, payload, `recovered payload mismatch at ${lossRate * 100}% ${pattern} loss`);
    if (lossRate === 0 && pattern === 'random') {
      const batchSolved = new Map<number, Uint8Array>();
      solveFountainEquations(equations, batchSolved);
      assert.deepStrictEqual(batchSolved, solved, 'batch and incremental fountain solvers should agree');
    }
  }
});
