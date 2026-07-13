import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { PortalBinaryTransfers } from './binary-transfers.ts';

const sha256 = async (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

Deno.test('Portal binary uploads are bound to their declared purpose', async () => {
  const transfers = new PortalBinaryTransfers();
  const bytes = new TextEncoder().encode('hello');
  const digest = await sha256(bytes);
  transfers.begin({
    transferId: 'upload-1',
    direction: 'upload',
    purpose: 'workspaceFile.write',
    sizeBytes: bytes.byteLength,
    sha256: digest,
    chunkBytes: 256 * 1024,
    windowSize: 8,
  });
  transfers.chunk({ transferId: 'upload-1', index: 0, data: btoa('hello') });
  await transfers.complete({
    transferId: 'upload-1',
    chunks: 1,
    sha256: digest,
  });
  await assertRejects(
    async () => transfers.consume('upload-1', 'workspaceFile.upload'),
    Error,
    'Binary upload purpose must be workspaceFile.upload.',
  );
  assertEquals(
    new TextDecoder().decode(
      transfers.consume('upload-1', 'workspaceFile.write'),
    ),
    'hello',
  );
});
