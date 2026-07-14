import {
  binaryChunkParamsSchema,
  binaryCompleteParamsSchema,
  binaryTransferDescriptorSchema,
  type BinaryTransferDescriptor,
  WEAVE_RPC_BINARY_CHUNK_BYTES,
} from '@weave/protocol';
import { RpcApplicationError } from '@weave/protocol/peer';
import { rpcErrorCode } from '@weave/protocol';
import type { RpcSession } from './router.ts';

const maxAttachmentBytes = 10 * 1024 * 1024;
const maxTransferBytes = 64 * 1024 * 1024;

type UploadTransfer = {
  descriptor: BinaryTransferDescriptor;
  connectionId: string;
  chunks: Map<number, Uint8Array>;
  completed?: Uint8Array;
};

type DownloadTransfer = {
  descriptor: BinaryTransferDescriptor;
  connectionId: string;
  bytes: Uint8Array;
};

const invalid = (message: string, code: number = rpcErrorCode.invalidParams): never => {
  throw new RpcApplicationError(code, message, { code: 'INVALID_PARAMS' });
};

const fromBase64 = (value: string) => {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    return invalid('Binary chunk data is not valid base64.');
  }
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
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
};

export class BinaryTransferRegistry {
  private readonly uploads = new Map<string, UploadTransfer>();
  private readonly downloads = new Map<string, DownloadTransfer>();
  private readonly observedConnections = new Set<string>();

  beginUpload(raw: unknown, session: RpcSession) {
    this.observe(session);
    const parsed = binaryTransferDescriptorSchema.safeParse(raw);
    if (!parsed.success || parsed.data.direction !== 'upload') invalid('Invalid binary upload descriptor.');
    const descriptor = parsed.data!;
    const domainLimit = descriptor.purpose === 'attachment.image' ? maxAttachmentBytes : maxTransferBytes;
    if (descriptor.sizeBytes > domainLimit) invalid(`Binary transfer exceeds the ${domainLimit} byte limit.`);
    if (this.uploads.has(descriptor.transferId) || this.downloads.has(descriptor.transferId)) {
      invalid('Binary transfer id is already in use.', rpcErrorCode.conflict);
    }
    this.uploads.set(descriptor.transferId, {
      descriptor,
      connectionId: session.connectionId,
      chunks: new Map(),
    });
    return { transferId: descriptor.transferId, accepted: true };
  }

  chunk(raw: unknown, session: RpcSession) {
    const hasData = Boolean(raw && typeof raw === 'object' && typeof (raw as { data?: unknown }).data === 'string');
    return hasData ? this.putChunk(raw, session) : this.readChunk(raw, session);
  }

  complete(raw: unknown, session: RpcSession) {
    const transferId = raw && typeof raw === 'object' && typeof (raw as { transferId?: unknown }).transferId === 'string'
      ? (raw as { transferId: string }).transferId
      : invalid('transferId is required.');
    return this.uploads.has(transferId)
      ? this.completeUpload(raw, session)
      : this.completeDownload(raw, session);
  }

  putChunk(raw: unknown, session: RpcSession) {
    const parsed = binaryChunkParamsSchema.safeParse(raw);
    if (!parsed.success) invalid('Invalid binary chunk.');
    const input = parsed.data!;
    const upload = this.requireUpload(input.transferId, session);
    if (upload.completed) invalid('Binary transfer is already complete.', rpcErrorCode.conflict);
    const bytes = fromBase64(input.data);
    if (bytes.byteLength > WEAVE_RPC_BINARY_CHUNK_BYTES) invalid('Binary chunk exceeds 256 KiB.');
    const totalChunks = Math.ceil(upload.descriptor.sizeBytes / WEAVE_RPC_BINARY_CHUNK_BYTES);
    if (input.index >= totalChunks && !(totalChunks === 0 && input.index === 0)) {
      invalid('Binary chunk index is out of range.');
    }
    upload.chunks.set(input.index, bytes);
    let throughIndex = -1;
    while (upload.chunks.has(throughIndex + 1)) throughIndex += 1;
    return { transferId: input.transferId, throughIndex };
  }

  async completeUpload(raw: unknown, session: RpcSession) {
    const parsed = binaryCompleteParamsSchema.safeParse(raw);
    if (!parsed.success) invalid('Invalid binary completion request.');
    const input = parsed.data!;
    const upload = this.requireUpload(input.transferId, session);
    const expectedChunks = Math.ceil(upload.descriptor.sizeBytes / WEAVE_RPC_BINARY_CHUNK_BYTES);
    if (input.chunks !== expectedChunks || upload.chunks.size !== expectedChunks) {
      invalid('Binary transfer is incomplete.', rpcErrorCode.conflict);
    }
    const bytes = new Uint8Array(upload.descriptor.sizeBytes);
    let offset = 0;
    for (let index = 0; index < expectedChunks; index += 1) {
      const chunk = upload.chunks.get(index);
      if (!chunk) {
        throw new RpcApplicationError(rpcErrorCode.conflict, `Binary transfer is missing chunk ${index}.`, {
          code: 'CONFLICT',
        });
      }
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (offset !== upload.descriptor.sizeBytes) invalid('Binary transfer size does not match its descriptor.');
    const digest = await sha256(bytes);
    if (digest !== upload.descriptor.sha256.toLowerCase() || digest !== input.sha256.toLowerCase()) {
      this.uploads.delete(input.transferId);
      invalid('Binary transfer checksum mismatch.', rpcErrorCode.conflict);
    }
    upload.completed = bytes;
    upload.chunks.clear();
    return { transferId: input.transferId, sizeBytes: bytes.byteLength, sha256: digest };
  }

  consumeUpload(transferId: string, session: RpcSession) {
    const upload = this.requireUpload(transferId, session);
    const bytes = upload.completed;
    if (!bytes) {
      throw new RpcApplicationError(rpcErrorCode.conflict, 'Binary transfer has not completed.', {
        code: 'CONFLICT',
      });
    }
    this.uploads.delete(transferId);
    return { descriptor: upload.descriptor, bytes };
  }

  async createDownload(input: {
    session: RpcSession;
    purpose: string;
    bytes: Uint8Array;
    mimeType?: string;
    metadata?: Record<string, unknown>;
  }) {
    this.observe(input.session);
    const transferId = `download_${crypto.randomUUID()}`;
    const descriptor: BinaryTransferDescriptor = {
      transferId,
      direction: 'download',
      purpose: input.purpose,
      sizeBytes: input.bytes.byteLength,
      sha256: await sha256(input.bytes),
      mimeType: input.mimeType,
      chunkBytes: WEAVE_RPC_BINARY_CHUNK_BYTES,
      windowSize: 8,
      metadata: input.metadata,
    };
    this.downloads.set(transferId, {
      descriptor,
      connectionId: input.session.connectionId,
      bytes: input.bytes,
    });
    return descriptor;
  }

  readChunk(raw: unknown, session: RpcSession) {
    const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const transferId = typeof record.transferId === 'string' ? record.transferId : invalid('transferId is required.');
    const index = Number.isSafeInteger(record.index) && Number(record.index) >= 0
      ? Number(record.index)
      : invalid('index is required.');
    const download = this.requireDownload(transferId, session);
    const start = index * WEAVE_RPC_BINARY_CHUNK_BYTES;
    if (start >= download.bytes.byteLength && download.bytes.byteLength !== 0) invalid('Binary chunk index is out of range.');
    const bytes = download.bytes.subarray(start, Math.min(start + WEAVE_RPC_BINARY_CHUNK_BYTES, download.bytes.byteLength));
    return { transferId, index, data: toBase64(bytes) };
  }

  completeDownload(raw: unknown, session: RpcSession) {
    const parsed = binaryCompleteParamsSchema.safeParse(raw);
    if (!parsed.success) invalid('Invalid binary completion request.');
    const input = parsed.data!;
    const download = this.requireDownload(input.transferId, session);
    if (input.sha256.toLowerCase() !== download.descriptor.sha256.toLowerCase()) {
      invalid('Binary transfer checksum mismatch.', rpcErrorCode.conflict);
    }
    this.downloads.delete(input.transferId);
    return { ok: true };
  }

  abort(raw: unknown, session: RpcSession) {
    const transferId = raw && typeof raw === 'object' && typeof (raw as { transferId?: unknown }).transferId === 'string'
      ? (raw as { transferId: string }).transferId
      : invalid('transferId is required.');
    const upload = this.uploads.get(transferId);
    const download = this.downloads.get(transferId);
    if (upload?.connectionId === session.connectionId) this.uploads.delete(transferId);
    if (download?.connectionId === session.connectionId) this.downloads.delete(transferId);
    return { ok: true };
  }

  private observe(session: RpcSession) {
    if (this.observedConnections.has(session.connectionId)) return;
    this.observedConnections.add(session.connectionId);
    session.lifetimeSignal.addEventListener('abort', () => {
      this.observedConnections.delete(session.connectionId);
      for (const [id, transfer] of this.uploads) if (transfer.connectionId === session.connectionId) this.uploads.delete(id);
      for (const [id, transfer] of this.downloads) if (transfer.connectionId === session.connectionId) this.downloads.delete(id);
    }, { once: true });
  }

  private requireUpload(transferId: string, session: RpcSession): UploadTransfer {
    const transfer = this.uploads.get(transferId);
    if (!transfer || transfer.connectionId !== session.connectionId) {
      throw new RpcApplicationError(rpcErrorCode.notFound, 'Binary upload was not found.', { code: 'NOT_FOUND' });
    }
    return transfer;
  }

  private requireDownload(transferId: string, session: RpcSession): DownloadTransfer {
    const transfer = this.downloads.get(transferId);
    if (!transfer || transfer.connectionId !== session.connectionId) {
      throw new RpcApplicationError(rpcErrorCode.notFound, 'Binary download was not found.', { code: 'NOT_FOUND' });
    }
    return transfer;
  }
}
