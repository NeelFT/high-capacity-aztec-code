import type { DecoderTrace } from './image-decoder';

export type WorkerRequest =
  | { type: 'start'; targetMatrixSize: number }
  | { type: 'frame'; pixels: ImageData }
  | { type: 'stop' };

export type WorkerDiagnostics = {
  frames: number;
  pixels: number;
  packets: number;
  invalidPackets: number;
  candidatesDetected: number;
  validGeometry: number;
  orientationsFound: number;
  gridsSampled: number;
  headerValidations: number;
  crcPasses: number;
  rejectedCandidates: number;
  rejectedPackets: number;
  uniqueBlocks: number;
  lastPacketId: number | null;
  lastDetectionTimestamp: number | null;
  trackingState: 'SEARCHING' | 'CANDIDATE_FOUND' | 'GEOMETRY_VALIDATED' | 'LOCKED' | 'TRACKING' | 'TRACKING_LOST' | 'REACQUIRING';
  verification: 'WAITING' | 'IN_PROGRESS' | 'VERIFIED' | 'FAILED';
  latestError: string | null;
};

export type WorkerResponse =
  | { type: 'packet'; frameId: number; session: number; decodedCount: number; blockCount: number; solved: number; name?: string }
  | { type: 'frameDone'; timestamp: number; counts: WorkerDiagnostics }
  | { type: 'diagnostic'; trace: Omit<DecoderTrace, 'packet'>; counts: WorkerDiagnostics }
  | { type: 'complete'; bytes: Uint8Array; name: string; mime: string; expectedHash: string; verified: true; unique: number; solved: number; blockCount: number }
  | { type: 'error'; message: string };
