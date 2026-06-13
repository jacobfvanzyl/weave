#!/usr/bin/env node

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const portalRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(portalRoot, '..');

const electronPath = process.env.WEAVE_WINDOW_HOST_ELECTRON ||
  path.join(repoRoot, 'desktop/node_modules/.bin/electron');
const hostAppPath = process.env.WEAVE_WINDOW_HOST_APP ||
  path.join(portalRoot, 'window-host-electron/main.cjs');
const answererAppPath = path.join(portalRoot, 'window-host-electron/answerer.cjs');

if (process.platform !== 'darwin') {
  console.log('SKIP Electron window host session smoke: macOS only.');
  process.exit(0);
}

const createJsonProcess = (name, command, args) => {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  const events = [];
  let nextId = 0;
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  child.on('error', (error) => {
    for (const pendingRequest of pending.values()) pendingRequest.reject(error);
    pending.clear();
  });
  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      events.push({ line });
      return;
    }
    if (typeof message.id === 'string' && pending.has(message.id)) {
      const pendingRequest = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(pendingRequest.timeout);
      if (message.ok === false) {
        pendingRequest.reject(new Error(typeof message.error === 'string' ? message.error : JSON.stringify(message.error)));
      } else {
        pendingRequest.resolve(message);
      }
      return;
    }
    events.push(message);
  });

  const request = (type, fields = {}, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const id = `${name}_${++nextId}`;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${name} timed out: ${type}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timeout });
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
  });

  const waitEvent = (predicate, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      const index = events.findIndex(predicate);
      if (index >= 0) {
        clearInterval(interval);
        resolve(events.splice(index, 1)[0]);
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`${name} event timed out.`));
      }
    }, 25);
  });

  const shutdown = async () => {
    await request('shutdown', {}, 1_000).catch(() => undefined);
    child.kill('SIGTERM');
  };

  return { request, waitEvent, shutdown, stderr: () => stderr };
};

const stripTrailingSdpTerminator = (description) => ({
  ...description,
  sdp: typeof description?.sdp === 'string' ? description.sdp.replace(/(?:\r\n|\n)+$/, '') : description?.sdp,
});

const host = createJsonProcess('host', electronPath, [hostAppPath]);
const answerer = createJsonProcess('answerer', electronPath, [answererAppPath]);

try {
  const list = await host.request('windows.list');
  const source = Array.isArray(list.windows) ? list.windows[0] : undefined;
  if (!source?.id) throw new Error('No capturable Electron window source was found.');

  const sessionId = `smoke_${Date.now()}`;
  await host.request('session.start', { sessionId, windowId: source.id, iceServers: [] });
  const offerEvent = await host.waitEvent(
    (event) => event.type === 'session.event' && event.sessionId === sessionId && event.event?.type === 'offer',
  );

  const answerResponse = await answerer.request('answer.create', {
    offer: offerEvent.event.offer,
    sanitizeOffer: true,
  });
  await host.request('session.answer', { sessionId, answer: stripTrailingSdpTerminator(answerResponse.answer) });
  await host.waitEvent(
    (event) => event.type === 'session.event' && event.sessionId === sessionId && event.event?.type === 'started',
    3_000,
  );
  await host.request('session.stop', { sessionId }).catch(() => undefined);
  console.log(`PASS Electron window host session smoke: ${source.title ?? source.id}`);
} catch (error) {
  console.error(`FAIL Electron window host session smoke: ${error instanceof Error ? error.message : String(error)}`);
  const hostStderr = host.stderr().trim();
  const answererStderr = answerer.stderr().trim();
  if (hostStderr) console.error(hostStderr);
  if (answererStderr) console.error(answererStderr);
  process.exitCode = 1;
} finally {
  await answerer.shutdown();
  await host.shutdown();
}
