#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const portalRoot = path.resolve(scriptDir, '..');
const helperPath = process.env.WEAVE_WINDOW_CAPTURE_HELPER ||
  path.join(portalRoot, 'native/window-capture-sck/.build/release/weave-window-capture-sck');

if (process.platform !== 'darwin') {
  console.log('SKIP ScreenCaptureKit window capture smoke: macOS only.');
  process.exit(0);
}

if (!fs.existsSync(helperPath)) {
  console.error(`FAIL ScreenCaptureKit window capture smoke: helper not found at ${helperPath}`);
  console.error(`Run: swift build --package-path ${path.join(portalRoot, 'native/window-capture-sck')} -c release`);
  process.exit(1);
}

const child = spawn(helperPath, [], {
  cwd: portalRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 0;
let stdoutBuffer = Buffer.alloc(0);
let stderr = '';
const pending = new Map();
const events = [];

const shutdown = () => {
  child.stdin.write(`${JSON.stringify({ id: 'smoke_shutdown', type: 'shutdown' })}\n`);
  setTimeout(() => child.kill('SIGTERM'), 500).unref();
};

const request = (type, fields = {}, timeoutMs = 12_000) => new Promise((resolve, reject) => {
  const id = `smoke_${++nextId}`;
  const timeout = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`helper timed out: ${type}`));
  }, timeoutMs);
  pending.set(id, { resolve, reject, timeout });
  child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
});

const waitFrames = (count, timeoutMs = 12_000) => new Promise((resolve, reject) => {
  const startedAt = Date.now();
  const interval = setInterval(() => {
    const frames = events.filter((event) => event.header?.type === 'frame' && event.payload?.length > 0);
    if (frames.length >= count) {
      clearInterval(interval);
      resolve(frames.slice(0, count));
      return;
    }
    if (Date.now() - startedAt > timeoutMs) {
      clearInterval(interval);
      reject(new Error(`timed out waiting for ${count} frame(s); received ${frames.length}`));
    }
  }, 25);
});

const handleMessage = (header, payload) => {
  if (typeof header.id === 'string' && pending.has(header.id)) {
    const pendingRequest = pending.get(header.id);
    pending.delete(header.id);
    clearTimeout(pendingRequest.timeout);
    if (header.ok === false) {
      pendingRequest.reject(new Error(typeof header.error === 'string' ? header.error : JSON.stringify(header.error)));
    } else {
      pendingRequest.resolve(header);
    }
    return;
  }
  events.push({ header, payload });
};

child.stdout.on('data', (chunk) => {
  stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
  while (stdoutBuffer.length >= 8) {
    const jsonLength = stdoutBuffer.readUInt32LE(0);
    const payloadLength = stdoutBuffer.readUInt32LE(4);
    const totalLength = 8 + jsonLength + payloadLength;
    if (stdoutBuffer.length < totalLength) return;
    const json = stdoutBuffer.subarray(8, 8 + jsonLength).toString('utf8');
    const payload = stdoutBuffer.subarray(8 + jsonLength, totalLength);
    stdoutBuffer = stdoutBuffer.subarray(totalLength);
    handleMessage(JSON.parse(json), Buffer.from(payload));
  }
});

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

child.on('error', (error) => {
  console.error(`FAIL ScreenCaptureKit window capture smoke: ${error.message}`);
  process.exit(1);
});

try {
  const list = await request('windows.list');
  const source = Array.isArray(list.windows) ? list.windows[0] : undefined;
  if (!source?.id) throw new Error('No capturable ScreenCaptureKit window source was found.');

  await request('capture.start', {
    sessionId: `smoke_${Date.now()}`,
    windowId: source.id,
    maxFrameRate: 20,
    maxDimension: 1280,
    quality: 0.65,
  });
  const frames = await waitFrames(5);
  await request('capture.stop').catch(() => undefined);
  const first = frames[0].header;
  console.log(`PASS ScreenCaptureKit window capture smoke: ${source.appName ? `${source.appName} - ` : ''}${source.title ?? source.id} ${first.width}x${first.height}`);
} catch (error) {
  console.error(`FAIL ScreenCaptureKit window capture smoke: ${error instanceof Error ? error.message : String(error)}`);
  if (stderr.trim()) console.error(stderr.trim());
  process.exitCode = 1;
} finally {
  shutdown();
}
