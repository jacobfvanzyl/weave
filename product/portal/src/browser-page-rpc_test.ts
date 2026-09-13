import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { Portal } from './portal.ts';
import { startPortalServer } from './server.ts';
import { generatePortalKey, RpcSocket, type PortalCredentialSigner } from '../scripts/rpc-client.ts';
import { PORTAL_PAIR_REQUEST_TYPE, PORTAL_AUTHENTICATED_TYPE, PORTAL_WEBSOCKET_PROTOCOL, PORTAL_BROWSER_RFB_PATH, portalAuthChallengePayload } from '@weave/product-protocol';
import { browserPageBackend } from './test-fixtures/browser-page-backend.ts';

const wait = async (condition: () => boolean) => {
  const until = Date.now() + 7000;
  while (!condition()) { if (Date.now() >= until) throw new Error('Browser RPC condition timed out'); await Bun.sleep(10); }
};
async function display(url: string, signer: PortalCredentialSigner, ticket: string) {
  const socket = new WebSocket(url, PORTAL_WEBSOCKET_PROTOCOL); socket.binaryType = 'arraybuffer';
  const chunks: Uint8Array[] = [];
  let ready = false, closed = false;
  const opening = new Promise<void>((resolve, reject) => {
    socket.onerror = () => reject(new Error('Browser socket failed'));
    socket.onclose = () => { closed = true; if (!ready) reject(new Error('Browser socket rejected')); };
    socket.onmessage = async event => {
      if (typeof event.data !== 'string') { chunks.push(new Uint8Array(event.data)); return; }
      const message = JSON.parse(event.data);
      if (message.type === 'weave.portal.auth.challenge') {
        if (message.audience !== PORTAL_BROWSER_RFB_PATH) { reject(new Error('Wrong browser audience')); socket.close(); return; }
        socket.send(JSON.stringify({ type: 'weave.portal.auth.response', credentialId: signer.credentialId, signature: await signer.sign(portalAuthChallengePayload(message)) }));
      } else if (message.type === PORTAL_AUTHENTICATED_TYPE) socket.send(JSON.stringify({ type: 'browser.rfb.bind', ticket }));
      else if (message.type === 'browser.rfb.ready') { ready = true; resolve(); }
    };
  });
  await opening;
  return { socket, chunks, get closed() { return closed; } };
}

test('authenticated binary RFB uses a single-use ticket and ends on RPC loss or revocation', async () => {
  const state = await mkdtemp('/tmp/weave-page-rpc-'), path = join(state, 'rfb.sock');
  const connections = new Set<Socket>();
  const rfb = createServer(socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); socket.on('data', bytes => socket.write(bytes)); socket.write('RFB 003.008\n'); });
  await new Promise<void>(resolve => rfb.listen(path, resolve)); await chmod(path, 0o600);
  const fake = browserPageBackend(path);
  const portal = await Portal.open({ stateDirectory: state, listen: { hostname: '127.0.0.1', port: 0 }, displayName: 'Page RPC test', allowedOrigins: [], executionContexts: [], agents: [] }, { terminalBackend: false, browserBackend: fake.backend });
  const server = startPortalServer(portal), sockets: RpcSocket[] = [], displays: WebSocket[] = [];
  const connect = async () => {
    const key = await generatePortalKey();
    const paired = await portal.security.redeemPairing({ type: PORTAL_PAIR_REQUEST_TYPE, token: await portal.security.createPairingToken(60000, { actions: ['portal.inspect', 'browser.profile.control'], browserProfileIds: [fake.page.profileId], executionContextIds: [], agentIds: [] }), label: 'Page fixture', publicKey: key.publicKey });
    const signer = { ...key, credentialId: paired.principal.credentialId };
    const rpc = await RpcSocket.open(`ws://127.0.0.1:${server.addr.port}/rpc`, signer); sockets.push(rpc);
    return { signer, rpc };
  };
  const attach = async (rpc: RpcSocket) => rpc.request('browser.page.view.attach', { profileId: fake.page.profileId, pageId: fake.page.pageId, generation: fake.page.generation!, mode: 'control' }) as Promise<{ viewId: string; ticket: string }>;
  const url = `ws://127.0.0.1:${server.addr.port}${PORTAL_BROWSER_RFB_PATH}`;
  try {
    const a = await connect(), b = await connect();
    const capabilities = (await a.rpc.request('portal.capabilities', {}) as any).capabilities;
    expect(capabilities).toContain('browser.pages.v1');
    expect(capabilities).not.toContain('browser.stream.v1');
    const view = await attach(a.rpc);
    await expect(display(url, b.signer, view.ticket)).rejects.toThrow('rejected');
    const stream = await display(url, a.signer, view.ticket); displays.push(stream.socket);
    await wait(() => stream.chunks.length > 0);
    expect(new TextDecoder().decode(stream.chunks[0])).toBe('RFB 003.008\n');
    const raw = new Uint8Array([0, 255, 128, 33]); stream.socket.send(raw);
    await wait(() => stream.chunks.length > 1); expect(stream.chunks[1]).toEqual(raw);
    await expect(display(url, a.signer, view.ticket)).rejects.toThrow('rejected');
    a.rpc.close(); await wait(() => stream.closed); await wait(() => connections.size === 0);
    expect(fake.page.available).toBe(true);
    const oversizedView = await attach(b.rpc), oversized = await display(url, b.signer, oversizedView.ticket); displays.push(oversized.socket);
    oversized.socket.send(new Uint8Array(65537)); await wait(() => oversized.closed);
    expect(fake.page.available).toBe(true);
    const second = await attach(b.rpc), revoked = await display(url, b.signer, second.ticket); displays.push(revoked.socket);
    await portal.security.revokeCredential(b.signer.credentialId);
    await wait(() => revoked.closed); expect(fake.page.available).toBe(true);
  } finally {
    displays.forEach(socket => socket.close()); sockets.forEach(socket => socket.close());
    await server.shutdown(); await portal.close();
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => rfb.close(() => resolve())); await rm(state, { recursive: true, force: true });
  }
}, 15000);
