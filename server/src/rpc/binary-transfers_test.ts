import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { RpcPeer, type RpcSocket } from '@weave/protocol/peer';
import { WEAVE_RPC_BINARY_CHUNK_BYTES } from '@weave/protocol';
import { createOwnerRequestContext } from '../owner/context.ts';
import type { RpcSession } from './router.ts';
import { BinaryTransferRegistry } from './binary-transfers.ts';

class NullSocket implements RpcSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  send(_data: string) {}
  close(_code?: number, _reason?: string) {}
}

const session = (connectionId: string) => {
  const lifetime = new AbortController();
  return {
    lifetime,
    value: {
      role: 'client',
      connectionId,
      peer: new RpcPeer(new NullSocket()),
      ownerContext: createOwnerRequestContext({ id: 'owner', name: 'Owner', role: 'owner' }),
      clientId: `client_${connectionId}`,
      capabilities: [],
      lifetimeSignal: lifetime.signal,
    } as RpcSession,
  };
};

const digest = async (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const result = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(result)].map(value => value.toString(16).padStart(2, '0')).join('');
};

const base64 = (bytes: Uint8Array) => {
  let result = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(result);
};

Deno.test('binary uploads accept out-of-order window chunks and validate their checksum', async () => {
  const registry = new BinaryTransferRegistry();
  const owner = session('one');
  const bytes = new Uint8Array(WEAVE_RPC_BINARY_CHUNK_BYTES + 3);
  bytes.fill(7);
  const sha256 = await digest(bytes);
  registry.beginUpload({
    transferId: 'upload', direction: 'upload', purpose: 'workspaceFile.upload',
    sizeBytes: bytes.byteLength, sha256,
  }, owner.value);

  assertEquals(registry.putChunk({
    transferId: 'upload', index: 1, data: base64(bytes.subarray(WEAVE_RPC_BINARY_CHUNK_BYTES)),
  }, owner.value), { transferId: 'upload', throughIndex: -1 });
  assertEquals(registry.putChunk({
    transferId: 'upload', index: 0, data: base64(bytes.subarray(0, WEAVE_RPC_BINARY_CHUNK_BYTES)),
  }, owner.value), { transferId: 'upload', throughIndex: 1 });
  await registry.completeUpload({ transferId: 'upload', chunks: 2, sha256 }, owner.value);
  assertEquals(registry.consumeUpload('upload', owner.value).bytes, bytes);
});

Deno.test('binary uploads reject incomplete and checksum-mismatched transfers', async () => {
  const registry = new BinaryTransferRegistry();
  const owner = session('one');
  const bytes = new Uint8Array([1, 2, 3]);
  const sha256 = await digest(bytes);
  registry.beginUpload({ transferId: 'incomplete', direction: 'upload', purpose: 'test', sizeBytes: 3, sha256 }, owner.value);
  await assertRejects(
    () => registry.completeUpload({ transferId: 'incomplete', chunks: 1, sha256 }, owner.value),
    Error,
    'incomplete',
  );
  registry.beginUpload({ transferId: 'bad', direction: 'upload', purpose: 'test', sizeBytes: 3, sha256 }, owner.value);
  registry.putChunk({ transferId: 'bad', index: 0, data: base64(bytes) }, owner.value);
  await assertRejects(
    () => registry.completeUpload({ transferId: 'bad', chunks: 1, sha256: '0'.repeat(64) }, owner.value),
    Error,
    'checksum mismatch',
  );
});

Deno.test('binary transfers are connection-scoped and expire with their connection', async () => {
  const registry = new BinaryTransferRegistry();
  const owner = session('one');
  const other = session('two');
  const emptyDigest = await digest(new Uint8Array());
  registry.beginUpload({
    transferId: 'scoped', direction: 'upload', purpose: 'test', sizeBytes: 0, sha256: emptyDigest,
  }, owner.value);
  await assertRejects(
    async () => registry.consumeUpload('scoped', other.value),
    Error,
    'not found',
  );
  owner.lifetime.abort();
  await assertRejects(
    async () => registry.consumeUpload('scoped', owner.value),
    Error,
    'not found',
  );
});

Deno.test('binary attachment uploads preserve the 10 MiB domain limit', async () => {
  const registry = new BinaryTransferRegistry();
  const owner = session('one');
  await assertRejects(async () => registry.beginUpload({
    transferId: 'large', direction: 'upload', purpose: 'attachment.image',
    sizeBytes: 10 * 1024 * 1024 + 1, sha256: '0'.repeat(64),
  }, owner.value), Error, 'exceeds');
});
