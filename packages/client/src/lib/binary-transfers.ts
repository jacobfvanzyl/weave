import {
  type BinaryTransferDescriptor,
  type JsonObject,
  WEAVE_RPC_BINARY_CHUNK_BYTES,
  WEAVE_RPC_BINARY_WINDOW_SIZE,
} from '@weave/protocol';
import { rpcRequest } from './mastra-client';

const maxCachedAttachmentUrls = 64;
const attachmentUrls = new Map<string, string>();

const sha256 = async (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
};

const toBase64 = (bytes: Uint8Array) => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (value: string) => {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

const batches = function* <T>(items: T[], size: number) {
  for (let offset = 0; offset < items.length; offset += size) yield items.slice(offset, offset + size);
};

export const uploadBinaryTransfer = async (input: {
  bytes: Uint8Array;
  purpose: string;
  mimeType?: string;
  metadata?: JsonObject;
}) => {
  const transferId = `upload_${crypto.randomUUID()}`;
  const digest = await sha256(input.bytes);
  const descriptor: BinaryTransferDescriptor = {
    transferId,
    direction: 'upload',
    purpose: input.purpose,
    sizeBytes: input.bytes.byteLength,
    sha256: digest,
    mimeType: input.mimeType,
    chunkBytes: WEAVE_RPC_BINARY_CHUNK_BYTES,
    windowSize: WEAVE_RPC_BINARY_WINDOW_SIZE,
    metadata: input.metadata,
  };
  await rpcRequest('binary.begin', descriptor);
  const chunkCount = Math.ceil(input.bytes.byteLength / WEAVE_RPC_BINARY_CHUNK_BYTES);
  const indices = Array.from({ length: chunkCount }, (_, index) => index);
  try {
    for (const window of batches(indices, WEAVE_RPC_BINARY_WINDOW_SIZE)) {
      await Promise.all(window.map(index => {
        const start = index * WEAVE_RPC_BINARY_CHUNK_BYTES;
        return rpcRequest('binary.chunk', {
          transferId,
          index,
          data: toBase64(input.bytes.subarray(start, start + WEAVE_RPC_BINARY_CHUNK_BYTES)),
        });
      }));
    }
    await rpcRequest('binary.complete', { transferId, chunks: chunkCount, sha256: digest });
    return descriptor;
  } catch (error) {
    void rpcRequest('binary.abort', { transferId, reason: error instanceof Error ? error.message : String(error) })
      .catch(() => undefined);
    throw error;
  }
};

export const downloadBinaryTransfer = async (descriptor: BinaryTransferDescriptor) => {
  const chunkCount = Math.ceil(descriptor.sizeBytes / WEAVE_RPC_BINARY_CHUNK_BYTES);
  const indices = Array.from({ length: chunkCount }, (_, index) => index);
  const chunks = new Map<number, Uint8Array>();
  try {
    for (const window of batches(indices, WEAVE_RPC_BINARY_WINDOW_SIZE)) {
      const results = await Promise.all(window.map(index => rpcRequest(
        'binary.chunk',
        { transferId: descriptor.transferId, index },
      )));
      for (const result of results) {
        if (!('data' in result)) throw new Error('Binary download returned an upload acknowledgement.');
        chunks.set(result.index, fromBase64(result.data));
      }
    }
    const bytes = new Uint8Array(descriptor.sizeBytes);
    let offset = 0;
    for (let index = 0; index < chunkCount; index += 1) {
      const chunk = chunks.get(index);
      if (!chunk) throw new Error(`Binary transfer is missing chunk ${index}.`);
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = await sha256(bytes);
    if (digest !== descriptor.sha256.toLowerCase()) throw new Error('Binary transfer checksum mismatch.');
    await rpcRequest('binary.complete', { transferId: descriptor.transferId, chunks: chunkCount, sha256: digest });
    return bytes;
  } catch (error) {
    void rpcRequest('binary.abort', {
      transferId: descriptor.transferId,
      reason: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    throw error;
  }
};

export const uploadImageAttachment = async (file: File, mimeType: string, threadId?: string) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const transfer = await uploadBinaryTransfer({
    bytes,
    purpose: 'attachment.image',
    mimeType,
    metadata: { originalName: file.name || 'image', ...(threadId ? { threadId } : {}) },
  });
  return await rpcRequest(
    'attachment.put',
    {
      transferId: transfer.transferId,
      mimeType,
      originalName: file.name || 'image',
      threadId,
    },
  );
};

const attachmentIdFromReference = (reference: string) => {
  const path = reference.startsWith('http') ? new URL(reference).pathname : reference;
  const match = /^\/attachments\/([^/?#]+)$/.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
};

export const getAttachmentObjectUrl = async (reference: string) => {
  const attachmentId = attachmentIdFromReference(reference);
  if (!attachmentId) return reference;
  const cached = attachmentUrls.get(attachmentId);
  if (cached) return cached;
  const result = await rpcRequest('attachment.read', { attachmentId });
  const bytes = await downloadBinaryTransfer(result.transfer);
  const url = URL.createObjectURL(new Blob([bytes], { type: result.attachment.mimeType }));
  attachmentUrls.set(attachmentId, url);
  while (attachmentUrls.size > maxCachedAttachmentUrls) {
    const oldest = attachmentUrls.entries().next().value as [string, string] | undefined;
    if (!oldest) break;
    attachmentUrls.delete(oldest[0]);
    URL.revokeObjectURL(oldest[1]);
  }
  return url;
};

export const clearAttachmentObjectUrlCache = () => {
  for (const url of attachmentUrls.values()) URL.revokeObjectURL(url);
  attachmentUrls.clear();
};
