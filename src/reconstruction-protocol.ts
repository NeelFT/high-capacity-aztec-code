export type ReconstructionMetadata = {
  name: string;
  type: string;
  hash: string;
  compression: 'gzip' | null;
  originalSize: number | null;
};

export type ReconstructionRequest = {
  type: 'reconstruct';
  blocks: Array<{ index: number; data: Uint8Array }>;
  blockCount: number;
  blockSize: number;
  totalBytes: number;
  metadata: ReconstructionMetadata;
};

export type ReconstructionResponse =
  | { type: 'complete'; bytes: Uint8Array }
  | { type: 'error'; message: string };
