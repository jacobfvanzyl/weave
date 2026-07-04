#!/usr/bin/env node

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const sourceDistPath = path.join(desktopRoot, 'node_modules', 'electron', 'dist');
const signedDistPath = path.join(desktopRoot, '.electron-signed-dev');
const appPath = path.join(signedDistPath, 'Electron.app');
const infoPlistPath = path.join(appPath, 'Contents', 'Info.plist');
const osxSignBinPath = path.join(desktopRoot, 'node_modules', '@electron', 'osx-sign', 'bin', 'electron-osx-sign.js');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: desktopRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'pipe',
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `${command} ${args.join(' ')} failed.`);
  }
  return result.stdout?.trim() ?? '';
};

const findSigningIdentity = () => {
  if (process.env.WEAVE_DESKTOP_CODESIGN_IDENTITY?.trim()) {
    return process.env.WEAVE_DESKTOP_CODESIGN_IDENTITY.trim();
  }

  const identities = run('security', ['find-identity', '-p', 'codesigning', '-v'])
    .split('\n')
    .map(line => line.match(/"([^"]+)"/)?.[1])
    .filter(Boolean);

  return identities.find(identity => identity.startsWith('Developer ID Application:'))
    ?? identities.find(identity => identity.startsWith('Apple Development:'));
};

if (process.platform !== 'darwin') {
  console.log('Signed Electron dev runtime is only needed on macOS.');
  process.exit(0);
}

if (!existsSync(sourceDistPath)) {
  throw new Error('Electron dist was not found. Run npm install in desktop/ first.');
}

const identity = findSigningIdentity();
if (!identity) {
  throw new Error('No Apple code signing identity was found. Set WEAVE_DESKTOP_CODESIGN_IDENTITY or install an Apple Development certificate.');
}

const signingEnv = { ...process.env };
if (!signingEnv.DEBUG && process.env.WEAVE_DESKTOP_CODESIGN_DEBUG === '1') {
  signingEnv.DEBUG = 'electron-osx-sign*';
}

console.log(`Preparing signed Electron dev runtime with identity: ${identity}`);
await rm(signedDistPath, { force: true, recursive: true });
run('ditto', [sourceDistPath, signedDistPath], { stdio: 'inherit' });

run('plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.veezee.weave.dev', infoPlistPath]);
run('plutil', ['-replace', 'CFBundleName', '-string', 'Weave', infoPlistPath]);
run('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Weave Dev', infoPlistPath]);
run(process.execPath, [
  osxSignBinPath,
  appPath,
  `--identity=${identity}`,
  '--platform=darwin',
  '--type=development',
  '--no-pre-auto-entitlements',
  '--no-pre-embed-provisioning-profile',
  '--no-strictVerify',
  '--ignore=^.*(\\.pak|\\.bin|\\.dat)$|^.*\\/Versions\\/Current\\/.*$',
], {
  env: signingEnv,
  stdio: 'inherit',
});
run('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
console.log(`Signed Electron dev runtime is ready at ${signedDistPath}`);
