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
const appPath = process.env.WEAVE_WINDOW_HOST_APP ||
  path.join(portalRoot, 'window-host-electron/main.cjs');

if (process.platform !== 'darwin') {
  console.log('SKIP Electron window host smoke: macOS only.');
  process.exit(0);
}

const child = spawn(electronPath, [appPath], {
  cwd: repoRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
const events = [];
const lines = readline.createInterface({ input: child.stdout });

const cleanup = () => {
  child.stdin.end(`${JSON.stringify({ id: 'smoke_shutdown', type: 'shutdown' })}\n`);
  setTimeout(() => child.kill('SIGTERM'), 500).unref();
};

const timeout = setTimeout(() => {
  cleanup();
  console.error('FAIL Electron window host smoke: timed out.');
  if (stderr.trim()) console.error(stderr.trim());
  process.exit(1);
}, 15_000);

child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

child.on('error', (error) => {
  clearTimeout(timeout);
  console.error(`FAIL Electron window host smoke: ${error.message}`);
  process.exit(1);
});

lines.on('line', (line) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    events.push({ line });
    return;
  }
  events.push(event);
  if (event.id !== 'smoke_windows') return;

  clearTimeout(timeout);
  cleanup();

  if (event.ok !== true || !Array.isArray(event.windows)) {
    console.error('FAIL Electron window host smoke: windows.list returned invalid response.');
    console.error(JSON.stringify(event));
    if (stderr.trim()) console.error(stderr.trim());
    process.exit(1);
  }

  console.log(`PASS Electron window host smoke: ${event.windows.length} window source(s).`);
});

child.stdin.write(`${JSON.stringify({ id: 'smoke_windows', type: 'windows.list' })}\n`);
