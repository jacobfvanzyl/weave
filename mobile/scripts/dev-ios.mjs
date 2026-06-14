#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import path from 'node:path';

const mobileRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const binExtension = process.platform === 'win32' ? '.cmd' : '';
const viteBin = path.join(mobileRoot, 'node_modules', '.bin', `vite${binExtension}`);
const capBin = path.join(mobileRoot, 'node_modules', '.bin', `cap${binExtension}`);
const DEFAULT_MASTRA_PORT = 4111;

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

Starts Vite and launches iOS with Capacitor live reload.
Defaults to a physically connected iPad/iPhone when available, then falls back to an iPad simulator.

Options:
  --target <udid>         Use a specific iOS target UDID. Does not open Simulator.
  --target-name <name>    Use a specific simulator name.
  --host <host>           Hostname used by the iOS WebView. Default: auto-detected
                           LAN IP for physical devices, localhost for simulators.
  --server-url <url>      Weave server URL injected into the mobile dev app.
                           Default: http://<physical-host>:4111 or http://localhost:4111.
  --bind-host <host>      Host Vite binds to. Default: 0.0.0.0.
  --port <port>           Vite/live-reload port. Default: 5174.
  --simulator             Skip physical-device auto-detection and use a simulator.
  --https                 Ask Capacitor to use https for live reload.
  --configuration <name>  iOS build configuration passed to Capacitor.
  --help                  Show this help.

Environment:
  WEAVE_IOS_TARGET        Same as --target.
  WEAVE_IOS_TARGET_NAME   Same as --target-name.
  WEAVE_MOBILE_DEV_HOST   Same as --host.
  WEAVE_MOBILE_DEV_PORT   Same as --port.
  WEAVE_MOBILE_DEV_SERVER_URL
                           Same as --server-url.
  WEAVE_AUTH_TOKEN        Injected into the dev app when set.
  WEAVE_AUTH_TOKENS       First token is injected when WEAVE_AUTH_TOKEN is unset.
`);
};

if (hasFlag('help')) {
  printHelp();
  process.exit(0);
}

const explicitLiveReloadHost = readOption('host') ?? process.env.WEAVE_MOBILE_DEV_HOST;
const explicitServerUrl = readOption('server-url') ?? process.env.WEAVE_MOBILE_DEV_SERVER_URL;
let liveReloadHost = explicitLiveReloadHost ?? 'localhost';
let devServerUrl = explicitServerUrl ?? `http://localhost:${DEFAULT_MASTRA_PORT}`;
const bindHost = readOption('bind-host') ?? process.env.WEAVE_MOBILE_DEV_BIND_HOST ?? '0.0.0.0';
const port = Number(readOption('port') ?? process.env.WEAVE_MOBILE_DEV_PORT ?? 5174);
const configuration = readOption('configuration');
const explicitTarget = readOption('target') ?? process.env.WEAVE_IOS_TARGET;
const explicitTargetName = readOption('target-name') ?? process.env.WEAVE_IOS_TARGET_NAME;
const forceSimulator = hasFlag('simulator');
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

const isUsableIpv4 = address =>
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)
  && !address.startsWith('127.')
  && !address.startsWith('169.254.');

const isLikelyLocalNetworkInterface = name =>
  typeof name === 'string' && !/^(lo|utun|bridge|awdl|llw|gif|stf)/.test(name);

const hasProtocol = value => /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value);

const normalizeDevServerUrl = input => {
  const trimmed = input?.trim();
  if (!trimmed) throw new Error('Weave server URL must not be empty.');

  const url = new URL(hasProtocol(trimmed) ? trimmed : `http://${trimmed}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Weave server URL must use http or https.');
  }

  if (url.username || url.password) {
    throw new Error('Weave server URL must not include credentials.');
  }

  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
};

const setDevServerUrlFromHost = host => {
  if (explicitServerUrl) return;
  devServerUrl = normalizeDevServerUrl(`http://${host}:${DEFAULT_MASTRA_PORT}`);
};

const stripEnvQuotes = value => {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
};

const parseEnvText = text => {
  const env = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const unexported = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const equalsIndex = unexported.indexOf('=');
    if (equalsIndex <= 0) continue;

    const key = unexported.slice(0, equalsIndex).trim();
    const value = unexported.slice(equalsIndex + 1);
    if (!key) continue;
    env[key] = stripEnvQuotes(value);
  }

  return env;
};

const firstTokenFromAuthTokens = rawTokens => {
  if (!rawTokens?.trim()) return undefined;

  try {
    const parsed = JSON.parse(rawTokens);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return Object.keys(parsed).find(token => Boolean(token.trim()));
  } catch {
    return undefined;
  }
};

const trimToken = value => {
  const trimmed = value?.trim();
  return trimmed || undefined;
};

const getAuthTokenFromEnv = env =>
  trimToken(env.WEAVE_AUTH_TOKEN) ?? firstTokenFromAuthTokens(env.WEAVE_AUTH_TOKENS);

const readServerEnv = async () => {
  try {
    return parseEnvText(await readFile(path.join(repoRoot, 'server', '.env'), 'utf8'));
  } catch {
    return {};
  }
};

const resolveDevAuthToken = async () =>
  getAuthTokenFromEnv(process.env) ?? getAuthTokenFromEnv(await readServerEnv());

const listPhysicalIosDevices = async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'weave-devicectl-'));
  const jsonPath = path.join(tempDir, 'devices.json');

  try {
    await runCapture('xcrun', [
      'devicectl',
      'list',
      'devices',
      '--timeout',
      '5',
      '--json-output',
      jsonPath,
    ]);

    const parsed = JSON.parse(await readFile(jsonPath, 'utf8'));
    return (parsed.result?.devices ?? [])
      .filter(device => {
        const hardware = device.hardwareProperties ?? {};
        const connection = device.connectionProperties ?? {};
        const properties = device.deviceProperties ?? {};

        return hardware.reality === 'physical'
          && hardware.platform === 'iOS'
          && connection.transportType === 'wired'
          && connection.pairingState === 'paired'
          && properties.developerModeStatus !== 'disabled'
          && typeof (hardware.udid ?? device.identifier) === 'string';
      })
      .map(device => ({
        name: device.deviceProperties?.name
          ?? device.hardwareProperties?.marketingName
          ?? device.hardwareProperties?.deviceType
          ?? 'iOS device',
        target: device.hardwareProperties?.udid ?? device.identifier,
        deviceType: device.hardwareProperties?.deviceType ?? 'iOS',
        transportType: device.connectionProperties?.transportType ?? 'unknown',
      }));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
};

const selectPhysicalIosDevice = async () => {
  const devices = await listPhysicalIosDevices();
  return devices.find(device => device.deviceType === 'iPad') ?? devices[0];
};

const findPhysicalIosDeviceByTarget = async target => {
  const devices = await listPhysicalIosDevices();
  return devices.find(device => device.target === target);
};

const getDefaultRouteInterface = async () => {
  if (process.platform !== 'darwin') return undefined;

  try {
    const { stdout } = await runCapture('route', ['-n', 'get', 'default']);
    return stdout.match(/interface:\s*(\S+)/)?.[1];
  } catch {
    return undefined;
  }
};

const getInterfaceIpv4 = async interfaceName => {
  if (!interfaceName || process.platform !== 'darwin') return undefined;

  try {
    const { stdout } = await runCapture('ipconfig', ['getifaddr', interfaceName]);
    const address = stdout.trim();
    return isUsableIpv4(address) ? address : undefined;
  } catch {
    return undefined;
  }
};

const detectLocalNetworkHost = async () => {
  const defaultInterface = await getDefaultRouteInterface();
  const defaultInterfaceAddress = isLikelyLocalNetworkInterface(defaultInterface)
    ? await getInterfaceIpv4(defaultInterface)
    : undefined;
  if (defaultInterfaceAddress) return { address: defaultInterfaceAddress, source: defaultInterface };

  const interfaces = networkInterfaces();
  const candidates = Object.entries(interfaces)
    .flatMap(([name, addresses]) =>
      (addresses ?? []).map(address => ({ name, address })),
    )
    .filter(({ name, address }) =>
      isLikelyLocalNetworkInterface(name)
      && address.family === 'IPv4'
      && !address.internal
      && isUsableIpv4(address.address),
    );

  const privateCandidate = candidates.find(({ address }) =>
    address.address.startsWith('10.')
    || address.address.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(address.address),
  );
  const candidate = privateCandidate ?? candidates[0];
  if (candidate) return { address: candidate.address.address, source: candidate.name };

  return undefined;
};

const configurePhysicalDeviceHost = async device => {
  if (explicitLiveReloadHost) {
    setDevServerUrlFromHost(liveReloadHost);
    return;
  }

  const host = await detectLocalNetworkHost();
  if (!host) {
    throw new Error(`Could not determine a LAN IP address for ${device.name}. Pass --host <mac-lan-ip> explicitly.`);
  }

  liveReloadHost = host.address;
  setDevServerUrlFromHost(host.address);
  log(`Using ${liveReloadHost} from ${host.source} for physical-device live reload`);
};

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

const startVite = async devEnv => {
  const localUrl = `http://localhost:${port}`;
  if (await requestUrl(localUrl)) {
    log(`Reusing existing Vite server on ${localUrl}`);
    log('Existing Vite env cannot be changed; restart it if connection defaults look stale.');
    return undefined;
  }

  log(`Starting Vite on ${localUrl}`);
  const child = spawn(viteBin, ['--host', bindHost, '--port', String(port), '--strictPort'], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      ...devEnv,
    },
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
  devServerUrl = normalizeDevServerUrl(devServerUrl);
  let selectedTarget;

  if (explicitTarget) {
    selectedTarget = explicitTarget;
    let device;

    try {
      device = forceSimulator ? undefined : await findPhysicalIosDeviceByTarget(explicitTarget);
    } catch (error) {
      log(`Physical-device lookup failed for ${explicitTarget}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (device) {
      await configurePhysicalDeviceHost(device);
      log(`Using physical ${device.deviceType} "${device.name}" (${device.target}) over ${device.transportType}`);
    } else {
      log(`Using iOS target ${explicitTarget}`);
    }
  } else if (explicitTargetName) {
    openSimulatorApp();
    log(`Using simulator name "${explicitTargetName}"`);
  } else {
    let physicalDevice;

    if (!forceSimulator) {
      try {
        physicalDevice = await selectPhysicalIosDevice();
      } catch (error) {
        log(`Could not inspect physical iOS devices; falling back to simulator: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (physicalDevice) {
      selectedTarget = physicalDevice.target;
      await configurePhysicalDeviceHost(physicalDevice);
      log(`Using physical ${physicalDevice.deviceType} "${physicalDevice.name}" (${physicalDevice.target}) over ${physicalDevice.transportType}`);
    } else {
      if (!forceSimulator) log('No connected physical iOS device found; using an iPad simulator');

      const simulator = await selectIpadSimulator();
      selectedTarget = simulator.udid;
      await bootSimulator(simulator);
      openSimulatorApp();
      log(`Using ${simulator.name} (${simulator.udid})`);
    }
  }

  const devAuthToken = await resolveDevAuthToken();
  const viteEnv = {
    VITE_MASTRA_URL: devServerUrl,
    VITE_WEAVE_DEV_CONNECTION_OVERRIDE: '1',
    ...(devAuthToken ? { WEAVE_AUTH_TOKEN: devAuthToken } : {}),
  };

  log(`Using Weave server ${devServerUrl}`);
  log(devAuthToken ? 'Injecting dev auth token into Vite environment' : 'No dev auth token found for Vite environment');

  viteProcess = await startVite(viteEnv);
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
