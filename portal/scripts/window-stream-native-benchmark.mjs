#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const portalRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(portalRoot, '..');

const hostPath = process.env.WEAVE_WINDOW_STREAM_HOST ||
  path.join(portalRoot, 'native/window-stream-native/build/weave-window-stream-native');
const electronPath = process.env.WEAVE_WINDOW_STREAM_TEST_ELECTRON ||
  path.join(repoRoot, 'desktop/node_modules/.bin/electron');
const answererAppPath = path.join(portalRoot, 'window-host-electron/answerer.cjs');
const benchmarkSourceAppPath = path.join(portalRoot, 'window-host-electron/benchmark-source.cjs');
const durationMs = Math.max(5, Number(process.env.WEAVE_WINDOW_STREAM_BENCHMARK_SECONDS || 30)) * 1000;
const minFps = Number(process.env.WEAVE_WINDOW_STREAM_BENCHMARK_MIN_FPS || 55);
const maxDropRatio = Number(process.env.WEAVE_WINDOW_STREAM_BENCHMARK_MAX_DROP_RATIO || 0.05);
const useExistingSource = process.env.WEAVE_WINDOW_STREAM_BENCHMARK_SOURCE === 'existing';

if (process.platform !== 'darwin') {
  console.log('SKIP native window stream benchmark: macOS only.');
  process.exit(0);
}

if (!fs.existsSync(hostPath)) {
  console.error(`FAIL native window stream benchmark: host not found at ${hostPath}`);
  process.exit(1);
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
        pendingRequest.reject(
          new Error(typeof message.error === 'string' ? message.error : JSON.stringify(message.error)),
        );
      } else {
        pendingRequest.resolve(message);
      }
      return;
    }
    events.push(message);
  });

  const request = (type, fields = {}, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const id = `${name}_${++nextId}`;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${name} timed out: ${type}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });

  const waitEvent = (predicate, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
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

  const drainEvents = (predicate) => {
    const drained = [];
    for (let index = 0; index < events.length;) {
      if (predicate(events[index])) drained.push(events.splice(index, 1)[0]);
      else index += 1;
    }
    return drained;
  };

  const shutdown = async () => {
    await request('shutdown', {}, 1_000).catch(() => undefined);
    child.kill('SIGTERM');
  };

  return { request, waitEvent, drainEvents, shutdown, stderr: () => stderr };
};

const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const host = createJsonProcess('native_host', hostPath, []);
const answerer = createJsonProcess('answerer', electronPath, [answererAppPath]);
const benchmarkSource = useExistingSource
  ? undefined
  : createJsonProcess('benchmark_source', electronPath, [benchmarkSourceAppPath]);
let candidateForwarder;

try {
  let benchmarkSourceTitle;
  if (benchmarkSource) {
    const ready = await benchmarkSource.waitEvent(
      (event) => event.type === 'ready' && typeof event.title === 'string',
      10_000,
    );
    benchmarkSourceTitle = ready.title;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  let source;
  for (let attempt = 0; attempt < 20 && !source; attempt += 1) {
    const list = await host.request('windows.list');
    const windows = Array.isArray(list.windows) ? list.windows : [];
    source = benchmarkSourceTitle
      ? windows.find((window) => String(window.title || '').includes(benchmarkSourceTitle))
      : windows[0];
    if (!source) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!source?.id) throw new Error('No capturable ScreenCaptureKit window source was found.');

  const sessionId = `native_benchmark_${Date.now()}`;
  await host.request('session.start', {
    sessionId,
    windowId: source.id,
    iceServers: [],
    maxFrameRate: 60,
    maxDimension: 1920,
  });

  const offerEvent = await host.waitEvent(
    (event) => event.type === 'session.event' && event.sessionId === sessionId && event.event?.type === 'offer',
  );

  const forwardHostCandidates = async () => {
    const candidates = host.drainEvents(
      (event) =>
        event.type === 'session.event' && event.sessionId === sessionId && event.event?.type === 'ice-candidate',
    );
    for (const event of candidates) {
      await answerer.request('candidate.add', { sessionId, candidate: event.event.candidate }, 2_000).catch(() =>
        undefined
      );
    }
  };

  await forwardHostCandidates();
  const answerResponse = await answerer.request('answer.create', {
    sessionId,
    offer: offerEvent.event.offer,
    sanitizeOffer: true,
  });
  candidateForwarder = setInterval(() => {
    void forwardHostCandidates();
  }, 25);

  await host.request('session.answer', { sessionId, answer: answerResponse.answer });
  await host.waitEvent(
    (event) => event.type === 'session.event' && event.sessionId === sessionId && event.event?.type === 'started',
    10_000,
  );
  await answerer.waitEvent(
    (event) => event.type === 'session.event' && event.sessionId === sessionId && event.event?.type === 'control-open',
    10_000,
  );

  const stats = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const drained = host.drainEvents(
      (event) => event.type === 'session.event' && event.sessionId === sessionId && event.event?.type === 'stats',
    );
    for (const event of drained) stats.push(event.event.stats);
  }

  const sendFps = average(stats.map((item) => Number(item.sendFps || 0)));
  const captureFps = average(stats.map((item) => Number(item.captureFps || 0)));
  const droppedFps = average(stats.map((item) => Number(item.droppedFps || 0)));
  const dropRatio = droppedFps / Math.max(1, captureFps + droppedFps);
  const encodeP95Ms = average(stats.map((item) => Number(item.encodeP95Ms || 0)));

  await host.request('session.stop', { sessionId }).catch(() => undefined);
  await answerer.request('session.close', { sessionId }).catch(() => undefined);

  if (sendFps < minFps) {
    throw new Error(
      `average send FPS ${sendFps.toFixed(1)} below ${minFps}; benchmark requires an actively changing source window`,
    );
  }
  if (dropRatio > maxDropRatio) {
    throw new Error(`drop ratio ${(dropRatio * 100).toFixed(1)}% above ${(maxDropRatio * 100).toFixed(1)}%`);
  }

  console.log(
    `PASS native window stream benchmark: send=${sendFps.toFixed(1)}fps capture=${captureFps.toFixed(1)}fps drop=${
      (dropRatio * 100).toFixed(1)
    }% encodeP95=${encodeP95Ms.toFixed(2)}ms source=${source.title ?? source.id}`,
  );
} catch (error) {
  console.error(`FAIL native window stream benchmark: ${error instanceof Error ? error.message : String(error)}`);
  const hostStderr = host.stderr().trim();
  const answererStderr = answerer.stderr().trim();
  if (hostStderr) console.error(hostStderr);
  if (answererStderr) console.error(answererStderr);
  process.exitCode = 1;
} finally {
  if (candidateForwarder) clearInterval(candidateForwarder);
  if (benchmarkSource) await benchmarkSource.shutdown();
  await answerer.shutdown();
  await host.shutdown();
}
