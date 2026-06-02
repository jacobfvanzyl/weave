#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';

const mobileRoot = fileURLToPath(new URL('..', import.meta.url));
const binExtension = process.platform === 'win32' ? '.cmd' : '';
const viteBin = path.join(mobileRoot, 'node_modules', '.bin', `vite${binExtension}`);
const capBin = path.join(mobileRoot, 'node_modules', '.bin', `cap${binExtension}`);

const args = process.argv.slice(2);

const readOption = name => {
  const equalsPrefix = `--${name}=`;
  const equalsValue = args.find(arg => arg.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);

  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return args[index + 1];
};

const hasFlag = name => args.includes(`--${name}`);

const printHelp = () => {
  console.log(`Usage: npm run dev -- [options]

Starts Vite and launches the iOS simulator with Capacitor live reload.

Options:
  --target <udid>         Use a specific simulator UDID.
  --target-name <name>    Use a specific simulator name.
  --host <host>           Hostname used by the simulator WebView. Default: localhost.
  --bind-host <host>      Host Vite binds to. Default: 0.0.0.0.
  --port <port>           Vite/live-reload port. Default: 5174.
  --https                 Ask Capacitor to use https for live reload.
  --configuration <name>  iOS build configuration passed to Capacitor.
  --help                  Show this help.

Environment:
  WEAVE_IOS_TARGET        Same as --target.
  WEAVE_IOS_TARGET_NAME   Same as --target-name.
  WEAVE_MOBILE_DEV_HOST   Same as --host.
  WEAVE_MOBILE_DEV_PORT   Same as --port.
`);
};

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

const liveReloadHost = readOption('host') ?? process.env.WEAVE_MOBILE_DEV_HOST ?? 'localhost';
const bindHost = readOption('bind-host') ?? process.env.WEAVE_MOBILE_DEV_BIND_HOST ?? '0.0.0.0';
const port = Number(readOption('port') ?? process.env.WEAVE_MOBILE_DEV_PORT ?? 5174);
const configuration = readOption('configuration');
const explicitTarget = readOption('target') ?? process.env.WEAVE_IOS_TARGET;
const explicitTargetName = readOption('target-name') ?? process.env.WEAVE_IOS_TARGET_NAME;
const useHttps = hasFlag('https');

if (!Number.isInteger(port) || port <= 0) {
  console.error(`[mobile dev] Invalid port: ${port}`);
  process.exit(1);
}

const log = message => console.log(`[mobile dev] ${message}`);

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const requestUrl = async url =>
  new Promise(resolve => {
    const request = http.get(url, response => {
      response.resume();
      response.on('end', () => resolve(true));
    });

    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });

const waitForHttp = async (url, timeoutMs, isChildRunning) => {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await requestUrl(url)) return true;
    if (isChildRunning && !isChildRunning()) return false;
    await delay(250);
  }

  return false;
};

const runCapture = (command, commandArgs, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: mobileRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${code}\n${stderr}`));
    });
  });

const listAvailableIpadSimulators = async () => {
  const { stdout } = await runCapture('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
  const parsed = JSON.parse(stdout);
  return Object.values(parsed.devices ?? {})
    .flat()
    .filter(device => device?.isAvailable && typeof device.name === 'string' && device.name.includes('iPad'));
};

const selectIpadSimulator = async () => {
  const devices = await listAvailableIpadSimulators();
  if (devices.length === 0) {
    throw new Error('No available iPad simulator found. Open Xcode once or create an iPad simulator, then retry.');
  }

  return (
    devices.find(device => device.state === 'Booted') ??
    devices.find(device => device.name.includes('iPad Air 11-inch')) ??
    devices[0]
  );
};

const bootSimulator = async simulator => {
  if (simulator.state === 'Booted') return;

  log(`Booting ${simulator.name} (${simulator.udid})`);
  await runCapture('xcrun', ['simctl', 'boot', simulator.udid]);
};

const openSimulatorApp = () => {
  if (process.platform !== 'darwin') return;
  const child = spawn('open', ['-a', 'Simulator'], {
    cwd: mobileRoot,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
};

const startVite = async () => {
  const localUrl = `http://localhost:${port}`;
  if (await requestUrl(localUrl)) {
    log(`Reusing existing Vite server on ${localUrl}`);
    return undefined;
  }

  log(`Starting Vite on ${localUrl}`);
  const child = spawn(viteBin, ['--host', bindHost, '--port', String(port), '--strictPort'], {
    cwd: mobileRoot,
    stdio: 'inherit',
  });
  let running = true;

  child.on('close', code => {
    running = false;
    if (code !== 0) {
      console.error(`[mobile dev] Vite exited with code ${code}`);
    }
  });

  const ready = await waitForHttp(localUrl, 30_000, () => running);
  if (!ready) {
    child.kill('SIGTERM');
    throw new Error(`Vite did not become ready on ${localUrl}`);
  }

  return child;
};

const runCapacitor = target => {
  const capArgs = ['run', 'ios', '--live-reload', '--host', liveReloadHost, '--port', String(port)];

  if (useHttps) capArgs.push('--https');
  if (configuration) capArgs.push('--configuration', configuration);
  if (explicitTargetName) capArgs.push('--target-name', explicitTargetName);
  else if (target) capArgs.push('--target', target);

  log(`Launching iOS with live reload at ${useHttps ? 'https' : 'http'}://${liveReloadHost}:${port}`);
  return spawn(capBin, capArgs, {
    cwd: mobileRoot,
    stdio: 'inherit',
  });
};

let viteProcess;
let capProcess;
let shuttingDown = false;

const shutdown = signal => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Stopping dev session${signal ? ` (${signal})` : ''}`);
  capProcess?.kill('SIGTERM');
  viteProcess?.kill('SIGTERM');
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  let selectedTarget;

  if (!explicitTarget && !explicitTargetName) {
    const simulator = await selectIpadSimulator();
    selectedTarget = simulator.udid;
    await bootSimulator(simulator);
    openSimulatorApp();
    log(`Using ${simulator.name} (${simulator.udid})`);
  } else if (explicitTarget) {
    selectedTarget = explicitTarget;
    openSimulatorApp();
    log(`Using simulator target ${explicitTarget}`);
  } else {
    openSimulatorApp();
    log(`Using simulator name "${explicitTargetName}"`);
  }

  viteProcess = await startVite();
  capProcess = runCapacitor(selectedTarget);

  capProcess.on('close', code => {
    if (shuttingDown) process.exit(0);
    if (code !== 0) {
      viteProcess?.kill('SIGTERM');
      process.exit(code ?? 1);
    }

    log('Capacitor launch finished. Vite is still running; press Ctrl-C to stop.');
  });
} catch (error) {
  viteProcess?.kill('SIGTERM');
  console.error(`[mobile dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
