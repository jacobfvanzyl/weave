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
const smokeCodec = (process.env.WEAVE_WINDOW_STREAM_SMOKE_CODEC || process.env.WEAVE_WINDOW_STREAM_CODEC || 'hevc')
  .toLowerCase();
const smokeColorMode =
  (process.env.WEAVE_WINDOW_STREAM_SMOKE_COLOR_MODE || process.env.WEAVE_WINDOW_STREAM_COLOR_MODE ||
    'srgb-video-range').toLowerCase();
const electronPath = process.env.WEAVE_WINDOW_HOST_ELECTRON ||
  path.join(repoRoot, 'desktop/node_modules/.bin/electron');
const answererAppPath = path.join(portalRoot, 'window-host-electron/answerer.cjs');

if (process.platform !== 'darwin') {
  console.log('SKIP native window stream smoke: macOS only.');
  process.exit(0);
}

if (!fs.existsSync(hostPath)) {
  console.error(`FAIL native window stream smoke: host not found at ${hostPath}`);
  console.error(
    `Run: cmake -S ${path.join(portalRoot, 'native/window-stream-native')} -B ${
      path.join(portalRoot, 'native/window-stream-native/build')
    } -DCMAKE_BUILD_TYPE=Release`,
  );
  console.error(`Then: cmake --build ${path.join(portalRoot, 'native/window-stream-native/build')} --config Release`);
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
      if (predicate(events[index])) {
        drained.push(events.splice(index, 1)[0]);
      } else {
        index += 1;
      }
    }
    return drained;
  };

  const shutdown = async () => {
    await request('shutdown', {}, 1_000).catch(() => undefined);
    child.kill('SIGTERM');
  };

  return { request, waitEvent, drainEvents, shutdown, stderr: () => stderr };
};

const host = createJsonProcess('native_host', hostPath, []);
const answerer = createJsonProcess('answerer', electronPath, [answererAppPath]);
let candidateForwarder;

try {
  const probe = await host.request('codec.probe');
  const codecs = Array.isArray(probe.codecs) ? probe.codecs : [];
  const h264 = codecs.find((codec) => codec.codec === 'h264');
  if (!h264?.defaultAvailable) throw new Error('Native codec probe did not report H.264 support.');
  const selectedProbe = codecs.find((codec) => codec.codec === smokeCodec);
  if (!selectedProbe) throw new Error(`Native codec probe did not report ${smokeCodec}.`);
  if (smokeCodec === 'av1' && !selectedProbe.hardwareRequiredAvailable) {
    console.log(`PASS native window stream smoke: AV1 unavailable as expected (${selectedProbe.hardwareRequiredStatus}).`);
  } else {
    if (!selectedProbe.hardwareRequiredAvailable && !selectedProbe.defaultAvailable) {
      throw new Error(
        `Native codec probe reports ${smokeCodec} unavailable: hardware=${selectedProbe.hardwareRequiredStatus} default=${selectedProbe.defaultStatus}`,
      );
    }

    const list = await host.request('windows.list');
    const source = Array.isArray(list.windows) ? list.windows[0] : undefined;
    if (!source?.id) throw new Error('No capturable ScreenCaptureKit window source was found.');

    const sessionId = `native_smoke_${Date.now()}`;
    await host.request('session.start', {
      sessionId,
      windowId: source.id,
      iceServers: [],
      maxFrameRate: 60,
      maxDimension: 1280,
      codec: smokeCodec,
      colorMode: smokeColorMode,
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
      (event) =>
        event.type === 'session.event' && event.sessionId === sessionId && event.event?.type === 'control-open',
      10_000,
    );
    await answerer.request('control.send', {
      sessionId,
      message: {
        type: 'resize',
        viewportWidth: 640,
        viewportHeight: 360,
        deviceScaleFactor: 1,
      },
    });
    const statsEvent = await host.waitEvent(
      (event) => event.type === 'session.event' && event.sessionId === sessionId && event.event?.type === 'stats',
      5_000,
    );
    const stats = statsEvent.event.stats ?? {};
    const expectedPixelFormat = smokeColorMode.endsWith('video-range') ? '420v' : '420f';
    if (stats.colorMode !== smokeColorMode) {
      throw new Error(`Expected stats.colorMode=${smokeColorMode}, got ${stats.colorMode}`);
    }
    if (stats.pixelFormat !== expectedPixelFormat) {
      throw new Error(`Expected stats.pixelFormat=${expectedPixelFormat}, got ${stats.pixelFormat}`);
    }
    if (typeof stats.repeatedFrames !== 'number' || typeof stats.repeatedFps !== 'number') {
      throw new Error('Expected idle repeat frame stats.');
    }
    if (stats.controlDelivery !== 'focus-hid' || typeof stats.controlMessages !== 'number') {
      throw new Error('Expected native control stats.');
    }
    if (stats.controlMessages < 1) {
      throw new Error('Expected native host to receive a control data channel message.');
    }
    clearInterval(candidateForwarder);

    await host.request('session.stop', { sessionId }).catch(() => undefined);
    await answerer.request('session.close', { sessionId }).catch(() => undefined);
    console.log(
      `PASS native window stream smoke: codec=${smokeCodec} ${
        source.appName ? `${source.appName} - ` : ''
      }${source.title ?? source.id}`,
    );
  }
} catch (error) {
  console.error(`FAIL native window stream smoke: ${error instanceof Error ? error.message : String(error)}`);
  const hostStderr = host.stderr().trim();
  const answererStderr = answerer.stderr().trim();
  if (hostStderr) console.error(hostStderr);
  if (answererStderr) console.error(answererStderr);
  process.exitCode = 1;
} finally {
  if (candidateForwarder) clearInterval(candidateForwarder);
  await answerer.shutdown();
  await host.shutdown();
}
