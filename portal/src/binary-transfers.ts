import {
  binaryChunkParamsSchema,
  binaryCompleteParamsSchema,
  type BinaryTransferDescriptor,
  binaryTransferDescriptorSchema,
  WEAVE_RPC_BINARY_CHUNK_BYTES,
} from '@weave/protocol';

const maxTransferBytes = 64 * 1024 * 1024;

const fromBase64 = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const sha256 = async (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

export class PortalBinaryTransfers {
  private readonly uploads = new Map<string, {
    descriptor: BinaryTransferDescriptor;
    chunks: Map<number, Uint8Array>;
    completed?: Uint8Array;
  }>();
  private readonly downloads = new Map<
    string,
    { descriptor: BinaryTransferDescriptor; bytes: Uint8Array }
  >();

  begin(raw: unknown) {
    const descriptor = binaryTransferDescriptorSchema.parse(raw);
    if (descriptor.direction !== 'upload') {
      throw new Error(
        'Portal only accepts upload descriptors from the server.',
      );
    }
    if (descriptor.sizeBytes > maxTransferBytes) {
      throw new Error('Binary transfer exceeds Portal limits.');
    }
    if (
      this.uploads.has(descriptor.transferId) ||
      this.downloads.has(descriptor.transferId)
    ) {
      throw new Error('Binary transfer id is already in use.');
    }
    this.uploads.set(descriptor.transferId, { descriptor, chunks: new Map() });
    return { transferId: descriptor.transferId, accepted: true as const };
  }

  chunk(raw: unknown) {
    const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    if (typeof record.data === 'string') {
      const chunk = binaryChunkParamsSchema.parse(raw);
      const upload = this.uploads.get(chunk.transferId);
      if (!upload || upload.completed) {
        throw new Error('Binary upload was not found.');
      }
      const bytes = fromBase64(chunk.data);
      if (bytes.byteLength > WEAVE_RPC_BINARY_CHUNK_BYTES) {
        throw new Error('Binary chunk exceeds 256 KiB.');
      }
      upload.chunks.set(chunk.index, bytes);
      let throughIndex = -1;
      while (upload.chunks.has(throughIndex + 1)) throughIndex += 1;
      return { transferId: chunk.transferId, throughIndex };
    }

    const transferId = typeof record.transferId === 'string' ? record.transferId : undefined;
    const index = Number.isSafeInteger(record.index) ? Number(record.index) : undefined;
    if (!transferId || index === undefined || index < 0) {
      throw new Error('transferId and index are required.');
    }
    const download = this.downloads.get(transferId);
    if (!download) throw new Error('Binary download was not found.');
    const start = index * WEAVE_RPC_BINARY_CHUNK_BYTES;
    if (start >= download.bytes.byteLength && download.bytes.byteLength !== 0) {
      throw new Error('Chunk index is out of range.');
    }
    return {
      transferId,
      index,
      data: toBase64(
        download.bytes.subarray(start, start + WEAVE_RPC_BINARY_CHUNK_BYTES),
      ),
    };
  }

  async complete(raw: unknown) {
    const input = binaryCompleteParamsSchema.parse(raw);
    const upload = this.uploads.get(input.transferId);
    if (upload) {
      const expectedChunks = Math.ceil(
        upload.descriptor.sizeBytes / WEAVE_RPC_BINARY_CHUNK_BYTES,
      );
      if (
        input.chunks !== expectedChunks || upload.chunks.size !== expectedChunks
      ) throw new Error('Binary upload is incomplete.');
      const bytes = new Uint8Array(upload.descriptor.sizeBytes);
      let offset = 0;
      for (let index = 0; index < expectedChunks; index += 1) {
        const chunk = upload.chunks.get(index);
        if (!chunk) throw new Error(`Binary upload is missing chunk ${index}.`);
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const digest = await sha256(bytes);
      if (
        digest !== input.sha256.toLowerCase() ||
        digest !== upload.descriptor.sha256.toLowerCase()
      ) {
        this.uploads.delete(input.transferId);
        throw new Error('Binary upload checksum mismatch.');
      }
      upload.completed = bytes;
      upload.chunks.clear();
      return {
        transferId: input.transferId,
        sizeBytes: bytes.byteLength,
        sha256: digest,
      };
    }

    const download = this.downloads.get(input.transferId);
    if (!download) throw new Error('Binary transfer was not found.');
    if (
      input.sha256.toLowerCase() !== download.descriptor.sha256.toLowerCase()
    ) {
      throw new Error('Binary download checksum mismatch.');
    }
    this.downloads.delete(input.transferId);
    return { ok: true as const };
  }

  consume(transferId: string, expectedPurpose?: string) {
    const upload = this.uploads.get(transferId);
    if (!upload?.completed) throw new Error('Binary upload has not completed.');
    if (expectedPurpose && upload.descriptor.purpose !== expectedPurpose) {
      throw new Error(`Binary upload purpose must be ${expectedPurpose}.`);
    }
    this.uploads.delete(transferId);
    return upload.completed;
  }

  consumeBase64(transferId: string) {
    return toBase64(this.consume(transferId));
  }

  toBase64(bytes: Uint8Array) {
    return toBase64(bytes);
  }

  async createDownload(bytes: Uint8Array, purpose: string, mimeType?: string) {
    const descriptor: BinaryTransferDescriptor = {
      transferId: `portal_download_${crypto.randomUUID()}`,
      direction: 'download',
      purpose,
      sizeBytes: bytes.byteLength,
      sha256: await sha256(bytes),
      mimeType,
      chunkBytes: WEAVE_RPC_BINARY_CHUNK_BYTES,
      windowSize: 8,
    };
    this.downloads.set(descriptor.transferId, { descriptor, bytes });
    return descriptor;
  }

  abort(raw: unknown) {
    const transferId = raw && typeof raw === 'object' &&
        typeof (raw as { transferId?: unknown }).transferId === 'string'
      ? (raw as { transferId: string }).transferId
      : undefined;
    if (transferId) {
      this.uploads.delete(transferId);
      this.downloads.delete(transferId);
    }
    return { ok: true as const };
  }

  clear() {
    this.uploads.clear();
    this.downloads.clear();
  }
}
