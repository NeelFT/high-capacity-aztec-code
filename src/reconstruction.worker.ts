import { MAX_FILE_BYTES, sha256Hex } from './aztec';
import { decompressGzip } from './compression';
import type { ReconstructionRequest, ReconstructionResponse } from './reconstruction-protocol';

function postResponse(message: ReconstructionResponse, transfer?: Transferable[]): void {
  (self as unknown as { postMessage(value: ReconstructionResponse, transfer?: Transferable[]): void }).postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<ReconstructionRequest>) => {
  if (event.data.type !== 'reconstruct') return;
  const { blocks, blockCount, blockSize, totalBytes, metadata } = event.data;
  try {
    const encodedBytes = new Uint8Array(totalBytes);
    for (const { index, data } of blocks) {
      if (!Number.isInteger(index) || index < 0 || index >= blockCount || data.length !== blockSize) {
        throw new Error('Reconstructed file contains an invalid data block.');
      }
      const start = index * blockSize;
      encodedBytes.set(data.subarray(0, Math.min(blockSize, encodedBytes.length - start)), start);
    }

    let bytes = encodedBytes;
    if (metadata.compression === 'gzip') {
      if (metadata.originalSize === null) throw new Error('Compressed transfer is missing its original size.');
      const decompressed = await decompressGzip(encodedBytes, metadata.originalSize);
      if (decompressed.byteLength !== metadata.originalSize || decompressed.byteLength > MAX_FILE_BYTES) {
        throw new Error('Compressed transfer size does not match its validated metadata.');
      }
      bytes = new Uint8Array(decompressed.byteLength);
      bytes.set(decompressed);
    }

    if (await sha256Hex(bytes) !== metadata.hash) {
      throw new Error('Transfer integrity failure: reconstructed file hash mismatch.');
    }

    postResponse({ type: 'complete', bytes }, [bytes.buffer]);
  } catch (error) {
    postResponse({
      type: 'error',
      message: error instanceof Error ? error.message : 'File reconstruction failed.',
    });
  }
};
