#!/usr/bin/env bun
// Exercises the real owner, Unix IPC and CDP WebSocket lifecycle using a child process.
import { join } from 'node:path';
const directory = process.argv.find(value => value.startsWith('--user-data-dir='))?.split('=').slice(1).join('=');
if (!directory) throw new Error('Missing fixture profile');
const startedAt = Date.now();
let value = await Bun.file(join(directory, 'fixture-state')).text().catch(() => '');
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request, server) { if (server.upgrade(request)) return; return new Response('', { status: 400 }); },
  websocket: {
    async message(socket, raw) {
      const message = JSON.parse(String(raw));
      let result: object = {};
      if (message.method === 'Browser.getVersion') result = { product: 'Chromium/fixture' };
      else if (message.method === 'Fixture.set') { value = message.params.value; await Bun.write(join(directory, 'fixture-state'), value); }
      else if (message.method === 'Fixture.read') result = { value, elapsed: Date.now() - startedAt, pid: process.pid };
      else if (message.method === 'Fixture.event') socket.send(JSON.stringify({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'fixture' } }, sessionId: message.sessionId }));
      else if (message.method === 'Fixture.fail') { socket.send(JSON.stringify({ id: message.id, error: { code: -1, message: 'Fixture error' } })); return; }
      else if (message.method === 'Fixture.disconnect') { socket.close(); return; }
      socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === 'Browser.close') setTimeout(() => { server.stop(true); process.exit(0); }, 10);
    },
  },
});
await Bun.write(join(directory, 'DevToolsActivePort'), `${server.port}\n/devtools/browser/fixture\n`);
