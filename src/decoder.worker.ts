import { crc32, FountainEquationSolver, MAX_BLOCK_COUNT, MAX_EQUATION_DEGREE, MAX_FILE_BYTES, readU16, readU32 } from './aztec';
import { decodeOpticalFrameDetailed, trackBullseye } from './image-decoder';
import type { DecoderTrace, FrameCorners, PixelImage } from './image-decoder';
import { deleteReceivedPackets, loadReceivedPackets, saveReceivedPacket } from './packet-store';
import type { ReconstructionRequest, ReconstructionResponse } from './reconstruction-protocol';
import type { WorkerDiagnostics, WorkerRequest, WorkerResponse } from './worker-protocol';

let lastSession: number | null = null;
let decodedCount = 0;
let running = false;
let completionSent = false;
let reconstructionStarted = false;
let reconstructionWorker: Worker | null = null;
let blockCount = 0;
let blockSize = 0;
let totalBytes = 0;
let metadata: { name: string; type: string; hash: string; compression: 'gzip' | null; originalSize: number | null } | null = null;
let targetMatrixSize = 63;
let lastCorners: FrameCorners | null = null;
let lastFinderCorners: FrameCorners | null = null;
let lastImage: PixelImage | null = null;
let lastLocatorDetected = false;
let trackedImageSize: [number, number] | null = null;
let trackingMisses = 0;
let trackingFrames = 0;
let latestTrace: DecoderTrace | null = null;
const diagnosticCounts: WorkerDiagnostics = {
  frames: 0,
  pixels: 0,
  packets: 0,
  invalidPackets: 0,
  candidatesDetected: 0,
  validGeometry: 0,
  orientationsFound: 0,
  gridsSampled: 0,
  headerValidations: 0,
  crcPasses: 0,
  rejectedCandidates: 0,
  rejectedPackets: 0,
  uniqueBlocks: 0,
  lastPacketId: null,
  lastDetectionTimestamp: null,
  trackingState: 'SEARCHING',
  verification: 'WAITING',
  latestError: null,
};
const receivedFrames = new Set<number>();
let solver: FountainEquationSolver | null = null;
let hydratedSession: number | null = null;
let packetSaveQueue = Promise.resolve();

function postWorkerMessage(message: WorkerResponse, transfer?: Transferable[]): void {
  (self as unknown as { postMessage(value: WorkerResponse, transfer?: Transferable[]): void }).postMessage(message, transfer);
}

function reportDiagnostic(trace: DecoderTrace): void {
  const { packet: _packet, ...visibleTrace } = trace;
  postWorkerMessage({ type: 'diagnostic', trace: visibleTrace, counts: { ...diagnosticCounts } });
}

function resetDiagnostics(): void {
  diagnosticCounts.frames = 0;
  diagnosticCounts.pixels = 0;
  diagnosticCounts.packets = 0;
  diagnosticCounts.invalidPackets = 0;
  diagnosticCounts.candidatesDetected = 0;
  diagnosticCounts.validGeometry = 0;
  diagnosticCounts.orientationsFound = 0;
  diagnosticCounts.gridsSampled = 0;
  diagnosticCounts.headerValidations = 0;
  diagnosticCounts.crcPasses = 0;
  diagnosticCounts.rejectedCandidates = 0;
  diagnosticCounts.rejectedPackets = 0;
  diagnosticCounts.uniqueBlocks = 0;
  diagnosticCounts.lastPacketId = null;
  diagnosticCounts.lastDetectionTimestamp = null;
  diagnosticCounts.trackingState = 'SEARCHING';
  diagnosticCounts.verification = 'WAITING';
  diagnosticCounts.latestError = null;
}

function updateTracking(trace: DecoderTrace): void {
  const validTrack = trace.geometryCandidates > 0 && trace.orientationFound;
  if (trace.candidateCount === 0) {
    if (trace.trackedCandidate && validTrack) {
      trackingMisses = 0;
      trackingFrames += 1;
      diagnosticCounts.trackingState = trackingFrames < 3 ? 'LOCKED' : 'TRACKING';
      rememberCorners(trace);
      return;
    }
    trackingMisses += 1;
    trackingFrames = 0;
    if (!lastCorners || trackingMisses > 4) {
      lastCorners = null;
      lastFinderCorners = null;
      lastImage = null;
      lastLocatorDetected = false;
      trackedImageSize = null;
      diagnosticCounts.trackingState = 'SEARCHING';
    } else {
      diagnosticCounts.trackingState = trackingMisses === 1 ? 'TRACKING_LOST' : 'REACQUIRING';
    }
    return;
  }

  const wasReacquiring = trackingMisses > 0;
  trackingMisses = 0;
  if (!trace.geometryCandidates) {
    trackingFrames = 0;
    diagnosticCounts.trackingState = 'CANDIDATE_FOUND';
    return;
  }
  if (!trace.orientationFound) {
    trackingFrames = 0;
    diagnosticCounts.trackingState = 'GEOMETRY_VALIDATED';
    return;
  }

  trackingFrames += 1;
  if (wasReacquiring) {
    trackingFrames = 1;
    diagnosticCounts.trackingState = 'REACQUIRING';
  } else {
    diagnosticCounts.trackingState = trackingFrames < 3 ? 'LOCKED' : 'TRACKING';
  }
  rememberCorners(trace);
}

function rememberCorners(trace: DecoderTrace): void {
  if (!trace.corners) return;
  if (lastCorners && trackedImageSize?.[0] === trace.imageWidth && trackedImageSize[1] === trace.imageHeight) {
    const maxDistance = Math.min(trace.imageWidth, trace.imageHeight) * 0.2;
    if (trace.corners.every((point, index) =>
      Math.hypot(point.x - lastCorners![index].x, point.y - lastCorners![index].y) <= maxDistance)) {
      lastCorners = trace.corners.map((point, index) => ({
        x: lastCorners![index].x * 0.65 + point.x * 0.35,
        y: lastCorners![index].y * 0.65 + point.y * 0.35,
      })) as FrameCorners;
    } else {
      lastCorners = trace.corners;
    }
  } else {
    lastCorners = trace.corners;
  }
  lastLocatorDetected = trace.locatorDetected;
  if (trace.finderCorners) lastFinderCorners = trace.finderCorners;
  trackedImageSize = [trace.imageWidth, trace.imageHeight];
}

function updateTrace(trace: DecoderTrace): void {
  if (trace.candidateCount > 0) diagnosticCounts.candidatesDetected += trace.candidateCount;
  if (trace.geometryCandidates > 0) diagnosticCounts.validGeometry += trace.geometryCandidates;
  if (trace.orientationFound) {
    diagnosticCounts.orientationsFound += 1;
    if (!trace.trackedCandidate) diagnosticCounts.lastDetectionTimestamp = Date.now();
  }
  if (trace.gridSampled) diagnosticCounts.gridsSampled += 1;
  if (trace.headerValid === true) diagnosticCounts.headerValidations += 1;
  if (trace.crcValid === true) diagnosticCounts.crcPasses += 1;
  if (trace.status !== 'packet-decoded') {
    diagnosticCounts.invalidPackets += 1;
    if (trace.candidateCount > 0) diagnosticCounts.rejectedCandidates += trace.candidateCount;
    diagnosticCounts.latestError = trace.reason;
  }
}

function rejectPacket(trace: DecoderTrace, reason: string, headerValid = false): void {
  trace.status = 'header-invalid';
  trace.headerValid = headerValid;
  trace.reason = reason;
  diagnosticCounts.rejectedPackets += 1;
  diagnosticCounts.latestError = reason;
  reportDiagnostic(trace);
}

function parsePacket(packet: Uint8Array): { frameId: number; session: number; total: number; count: number; size: number; indices: number[]; data: Uint8Array; metadata: Uint8Array } | null {
  if (packet.length < 29) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const checksumOffset = packet.length - 4;
  if (readU32(view, checksumOffset) !== crc32(packet.subarray(0, checksumOffset))) return null;
  const frameId = readU32(view, 0);
  const total = readU32(view, 4);
  const session = readU32(view, 12);
  const count = readU16(view, 16);
  const size = readU16(view, 18);
  const degree = packet[20];
  if (!count || count > MAX_BLOCK_COUNT || !size || total > MAX_FILE_BYTES || degree < 1 || degree > count || degree > MAX_EQUATION_DEGREE) return null;
  if (total === 0 ? count !== 1 : count !== Math.ceil(total / size) || total > count * size || total <= (count - 1) * size) return null;

  const indices: number[] = [];
  let offset = 21;
  for (let index = 0; index < degree; index += 1) {
    if (offset + 2 > checksumOffset) return null;
    const blockIndex = readU16(view, offset);
    if (blockIndex >= count || (index > 0 && blockIndex <= indices[index - 1])) return null;
    indices.push(blockIndex);
    offset += 2;
  }
  if (offset >= checksumOffset) return null;
  const metadataLength = packet[offset++];
  if (metadataLength > checksumOffset - offset - size) return null;
  if (offset + metadataLength + size !== checksumOffset) return null;
  return {
    frameId,
    session,
    total,
    count,
    size,
    indices,
    metadata: packet.slice(offset, offset + metadataLength),
    data: packet.slice(offset + metadataLength, checksumOffset),
  };
}

function parseMetadata(value: Uint8Array): { name: string; type: string; hash: string; compression: 'gzip' | null; originalSize: number | null } | null {
  if (value.length < 4) return null;
  let compression: 'gzip' | null;
  let originalSize: number | null;
  let nameLengthOffset: number;
  let nameOffset: number;
  let typeLengthOffset: number;
  let hashStart: number;
  let hash: string;
  if (value[0] === 3) {
    const flags = value[1];
    if (flags & ~1) return null;
    compression = flags & 1 ? 'gzip' : null;
    if (compression && value.length < 6) return null;
    originalSize = compression
      ? new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(2, true)
      : null;
    nameLengthOffset = compression ? 6 : 2;
    if (nameLengthOffset >= value.length) return null;
    const nameLength = value[nameLengthOffset];
    nameOffset = nameLengthOffset + 1;
    typeLengthOffset = nameOffset + nameLength;
    if (nameLength > 120 || typeLengthOffset >= value.length) return null;
    const typeLength = value[typeLengthOffset];
    hashStart = typeLengthOffset + 1 + typeLength;
    if (typeLength > 120 || hashStart + 32 !== value.length) return null;
    hash = Array.from(value.subarray(hashStart), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } else if (value[0] === 1 || value[0] === 2) {
    const compressed = value[0] === 2;
    if (compressed && (value.length < 10 || value[1] !== 1)) return null;
    compression = compressed ? 'gzip' : null;
    originalSize = compressed
      ? new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(2, true)
      : null;
    nameLengthOffset = compressed ? 6 : 1;
    if (nameLengthOffset >= value.length) return null;
    const nameLength = value[nameLengthOffset];
    nameOffset = nameLengthOffset + 1;
    typeLengthOffset = nameOffset + nameLength;
    if (nameLength > 120 || typeLengthOffset >= value.length) return null;
    const typeLength = value[typeLengthOffset];
    const hashLengthOffset = typeLengthOffset + 1 + typeLength;
    if (typeLength > 120 || hashLengthOffset + 1 >= value.length) return null;
    const hashLength = value[hashLengthOffset];
    hashStart = hashLengthOffset + 1;
    if (hashLength !== 64 || hashStart + hashLength !== value.length) return null;
    try {
      hash = new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(hashStart));
    } catch {
      return null;
    }
  } else {
    return null;
  }
  const nameLength = value[nameLengthOffset];
  if (nameLength > 120) return null;
  const typeLength = value[typeLengthOffset];
  if (typeLength > 120) return null;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const name = decoder.decode(value.subarray(nameOffset, typeLengthOffset));
    const type = decoder.decode(value.subarray(typeLengthOffset + 1, hashStart - (value[0] === 3 ? 0 : 1)));
    if (!/^[\da-f]{64}$/i.test(hash)) return null;
    return { name, type, hash, compression, originalSize };
  } catch {
    return null;
  }
}

function acceptPacket(parsed: NonNullable<ReturnType<typeof parsePacket>>, trace: DecoderTrace): boolean {
  if (parsed.session !== lastSession) {
    rejectPacket(trace, 'Packet belongs to a different transfer session.', true);
    return false;
  }
  if (parsed.count !== blockCount && blockCount !== 0) {
    rejectPacket(trace, 'Packet block count does not match the active transfer.', true);
    return false;
  }
  if (parsed.size !== blockSize && blockSize !== 0) {
    rejectPacket(trace, 'Packet block size does not match the active transfer.', true);
    return false;
  }
  if (parsed.total !== totalBytes && blockCount !== 0) {
    rejectPacket(trace, 'Packet file size does not match the active transfer.', true);
    return false;
  }
  if (blockCount === 0) {
    blockCount = parsed.count;
    blockSize = parsed.size;
    totalBytes = parsed.total;
  }
  if (parsed.metadata[0] === 1 || parsed.metadata[0] === 2 || parsed.metadata[0] === 3) {
    const parsedMetadata = parseMetadata(parsed.metadata);
    if (!parsedMetadata ||
      (parsedMetadata.compression === 'gzip' &&
        (parsedMetadata.originalSize === null || parsedMetadata.originalSize <= parsed.total || parsedMetadata.originalSize > MAX_FILE_BYTES))) {
      rejectPacket(trace, 'Transfer metadata is malformed, unsupported, or contains an invalid name, MIME type, size, or SHA-256 digest.', true);
      return false;
    }
    metadata = parsedMetadata;
  } else if (parsed.metadata.length !== 1 || parsed.metadata[0] !== 0) {
    rejectPacket(trace, 'Packet metadata flag or length is invalid.', true);
    return false;
  }
  if (!solver) solver = new FountainEquationSolver(blockCount, blockSize);
  if (receivedFrames.has(parsed.frameId)) return false;
  if (!solver.addEquation(parsed.indices, parsed.data)) {
    rejectPacket(trace, 'Fountain equation conflicts with already received packet data.', true);
    return false;
  }
  receivedFrames.add(parsed.frameId);
  decodedCount += 1;
  diagnosticCounts.packets += 1;
  diagnosticCounts.lastPacketId = parsed.frameId;
  diagnosticCounts.uniqueBlocks = solver.solved.size;
  diagnosticCounts.verification = 'IN_PROGRESS';
  return true;
}

async function restorePacketsForSession(session: number, trace: DecoderTrace): Promise<void> {
  const savedPackets = await loadReceivedPackets(session);
  for (const saved of savedPackets) {
    const parsed = parsePacket(saved.packet);
    if (!parsed || parsed.session !== session || parsed.frameId !== saved.frameId) {
      diagnosticCounts.latestError = `Saved packet ${saved.frameId} failed validation and was ignored.`;
      continue;
    }
    acceptPacket(parsed, trace);
  }
}

function resetSession(value: number): void {
  reconstructionWorker?.terminate();
  reconstructionWorker = null;
  lastSession = value;
  decodedCount = 0;
  blockCount = 0;
  blockSize = 0;
  totalBytes = 0;
  completionSent = false;
  reconstructionStarted = false;
  metadata = null;
  receivedFrames.clear();
  solver = null;
  hydratedSession = null;
}

async function completeIfSolved(): Promise<void> {
  const solved = solver?.solved;
  if (completionSent || reconstructionStarted || !metadata || !solver || !solved || solved.size < blockCount) return;
  for (let index = 0; index < blockCount; index += 1) {
    if (!solved.has(index)) return;
  }
  reconstructionStarted = true;
  const activeMetadata = metadata;
  const activeSession = lastSession ?? 0;
  const activeDecodedCount = decodedCount;
  const blocks = Array.from(solved, ([index, data]) => ({ index, data: data.slice() }));
  const request: ReconstructionRequest = {
    type: 'reconstruct',
    blocks,
    blockCount,
    blockSize,
    totalBytes,
    metadata: activeMetadata,
  };
  let worker: Worker;
  try {
    worker = new Worker(new URL('./reconstruction.worker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    reconstructionStarted = false;
    const message = error instanceof Error ? `Could not start file reconstruction: ${error.message}` : 'Could not start file reconstruction.';
    completionSent = true;
    diagnosticCounts.verification = 'FAILED';
    diagnosticCounts.latestError = message;
    if (latestTrace) reportDiagnostic(latestTrace);
    postWorkerMessage({ type: 'error', message });
    return;
  }
  reconstructionWorker = worker;
  const failReconstruction = (message: string): void => {
    if (reconstructionWorker !== worker) return;
    reconstructionWorker = null;
    worker.terminate();
    completionSent = true;
    diagnosticCounts.verification = 'FAILED';
    diagnosticCounts.latestError = message;
    if (latestTrace) reportDiagnostic(latestTrace);
    postWorkerMessage({ type: 'error', message });
  };
  worker.onmessage = async (event: MessageEvent<ReconstructionResponse>) => {
    if (reconstructionWorker !== worker) return;
    const response = event.data;
    if (response.type === 'error') {
      failReconstruction(response.message);
      return;
    }
    reconstructionWorker = null;
    worker.terminate();
    completionSent = true;
    diagnosticCounts.verification = 'VERIFIED';
    try {
      await packetSaveQueue;
      await deleteReceivedPackets(activeSession);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown IndexedDB error.';
      diagnosticCounts.latestError = `File verified, but saved packet cleanup failed: ${reason}`;
    }
    if (lastSession !== activeSession) return;
    if (latestTrace) reportDiagnostic(latestTrace);
    postWorkerMessage({
      type: 'complete',
      bytes: response.bytes,
      name: activeMetadata.name,
      mime: activeMetadata.type,
      expectedHash: activeMetadata.hash,
      verified: true,
      unique: activeDecodedCount,
      solved: blockCount,
      blockCount,
    }, [response.bytes.buffer]);
    running = false;
  };
  worker.onerror = (event: ErrorEvent) => {
    failReconstruction(`File reconstruction worker failed: ${event.message || 'Unknown worker error.'}`);
  };
  try {
    worker.postMessage(request, blocks.map(({ data }) => data.buffer));
  } catch (error) {
    failReconstruction(error instanceof Error ? `Could not send file blocks for reconstruction: ${error.message}` : 'Could not send file blocks for reconstruction.');
  }
}

async function publish(image: PixelImage): Promise<void> {
  diagnosticCounts.frames += 1;
  diagnosticCounts.pixels += image.width * image.height;
  if (completionSent) return;
  if (trackedImageSize && (trackedImageSize[0] !== image.width || trackedImageSize[1] !== image.height)) {
    lastCorners = null;
    lastLocatorDetected = false;
    trackedImageSize = null;
    trackingMisses = 0;
    trackingFrames = 0;
  }
  const trackedCorners = trackingMisses < 3 ? lastCorners : null;
  const bullseyeTrack = lastImage && lastFinderCorners && trackedCorners
    ? trackBullseye(image, lastImage, trackedCorners, lastFinderCorners)
    : null;
  const anchorCorners = bullseyeTrack?.corners ?? trackedCorners;
  const trace = decodeOpticalFrameDetailed(image, targetMatrixSize, anchorCorners, lastLocatorDetected);
  if (bullseyeTrack && trace.trackedCandidate) trace.finderCorners = bullseyeTrack.finderCorners;
  latestTrace = trace;
  updateTracking(trace);
  if (trace.corners && trace.finderCorners && trace.orientationFound) {
    lastImage = { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
  } else if (trackingMisses > 0) {
    lastImage = null;
  }
  updateTrace(trace);
  if (!trace.packet) {
    reportDiagnostic(trace);
    return;
  }
  const parsed = parsePacket(trace.packet);
  if (!parsed) {
    rejectPacket(trace, 'Decoded packet failed structural header validation (size, block count, indices, or payload length).', true);
    return;
  }

  if (lastSession !== null && parsed.session !== lastSession) resetSession(parsed.session);
  if (lastSession === null) resetSession(parsed.session);
  if (hydratedSession !== parsed.session) {
    hydratedSession = parsed.session;
    try {
      await restorePacketsForSession(parsed.session, trace);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown IndexedDB error.';
      diagnosticCounts.latestError = `Could not restore saved packets; current live scan can still continue: ${reason}`;
    }
  }
  const accepted = acceptPacket(parsed, trace);
  if (!accepted && receivedFrames.has(parsed.frameId)) {
    reportDiagnostic(trace);
    return;
  }
  if (!accepted) return;
  const savedPacket = trace.packet.slice();
  packetSaveQueue = packetSaveQueue.then(async () => {
    try {
      await saveReceivedPacket(parsed.session, parsed.frameId, savedPacket);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown IndexedDB error.';
      diagnosticCounts.latestError = `Packet accepted for this scan but could not be saved for later: ${reason}`;
      if (latestTrace) reportDiagnostic(latestTrace);
    }
  });
  reportDiagnostic(trace);
  await completeIfSolved();
  const activeSolver = solver;
  if (!activeSolver) throw new Error('The receiver lost its fountain solver after accepting a packet.');
  diagnosticCounts.uniqueBlocks = activeSolver.solved.size;
  postWorkerMessage({
    type: 'packet',
    frameId: parsed.frameId,
    session: parsed.session,
    decodedCount,
    blockCount,
    solved: activeSolver.solved.size,
    name: metadata?.name,
  });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type === 'stop') {
    running = false;
    resetSession(0);
    lastSession = null;
    lastCorners = null;
    lastFinderCorners = null;
    lastImage = null;
    lastLocatorDetected = false;
    trackedImageSize = null;
    trackingMisses = 0;
    trackingFrames = 0;
    return;
  }
  if (event.data.type === 'start') {
    targetMatrixSize = event.data.targetMatrixSize;
    resetSession(0);
    lastSession = null;
    lastCorners = null;
    lastFinderCorners = null;
    lastImage = null;
    lastLocatorDetected = false;
    trackedImageSize = null;
    trackingMisses = 0;
    trackingFrames = 0;
    latestTrace = null;
    resetDiagnostics();
    running = true;
    return;
  }
  if (event.data.type === 'frame' && event.data.pixels && running) {
    try {
      await publish(event.data.pixels);
    } catch (error) {
      postWorkerMessage({ type: 'error', message: error instanceof Error ? error.message : 'Camera frame processing failed.' });
    } finally {
      postWorkerMessage({ type: 'frameDone', timestamp: performance.now(), counts: { ...diagnosticCounts } });
    }
  }
};
