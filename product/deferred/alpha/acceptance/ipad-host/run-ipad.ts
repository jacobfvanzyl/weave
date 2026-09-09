import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBrowserFixtureServer } from '../browser-fixture/server';

type CoreDevice = {
  identifier?: string;
  connectionProperties?: { pairingState?: string };
  deviceProperties?: {
    bootState?: string;
    developerModeStatus?: string;
    name?: string;
  };
  hardwareProperties?: {
    deviceType?: string;
    reality?: string;
    udid?: string;
  };
};

export type PhysicalIPad = {
  identifier: string;
  name: string;
  udid: string;
};

export type IPadBrowserAcceptanceReport = {
  browserDataStoreIsNonPersistent: boolean;
  cookieAvailableBeforeReset: boolean;
  cookieClearedByReset: boolean;
  fixtureLoaded: boolean;
  inactiveTabHidden: boolean;
  multiTabLifecycleSucceeded: boolean;
  nativeFrameHeight: number;
  nativeFrameWidth: number;
  nativeFrameX: number;
  nativeFrameY: number;
  popupCloseRestoredSource: boolean;
  popupLoaded: boolean;
  popupSourcePreserved: boolean;
  popupTabAdjacent: boolean;
  popupTabCreated: boolean;
  popupTabSelected: boolean;
  runId: string;
  screenshotWritten: boolean;
  slotMatchesSurface: boolean;
  slotPresented: boolean;
  surfaceHeight: number;
  surfaceWidth: number;
  surfaceX: number;
  surfaceY: number;
  tabsShareProfile: boolean;
};

export type IPadBrowserRestartReport = {
  browserDataStoreIsNonPersistent: boolean;
  cookieAbsent: boolean;
  cookiePresent: boolean;
  runId: string;
  stage: 'seed' | 'verify';
};

export function selectPhysicalIPad(
  input: { result?: { devices?: CoreDevice[] } },
  requestedIdentifier?: string,
): PhysicalIPad {
  const matches = (input.result?.devices ?? []).filter((device) =>
    device.hardwareProperties?.deviceType === 'iPad' &&
    device.hardwareProperties.reality === 'physical' &&
    device.connectionProperties?.pairingState === 'paired' &&
    device.deviceProperties?.bootState === 'booted' &&
    device.deviceProperties.developerModeStatus === 'enabled' &&
    (!requestedIdentifier ||
      device.identifier === requestedIdentifier ||
      device.hardwareProperties.udid === requestedIdentifier ||
      device.deviceProperties.name === requestedIdentifier));
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one paired, booted, developer-enabled physical iPad; found ${matches.length}.`,
    );
  }
  const [device] = matches;
  if (!device.identifier || !device.hardwareProperties?.udid || !device.deviceProperties?.name) {
    throw new Error('The selected physical iPad is missing a CoreDevice identifier, UDID, or name.');
  }
  return {
    identifier: device.identifier,
    name: device.deviceProperties.name,
    udid: device.hardwareProperties.udid,
  };
}

export function validateIPadBrowserAcceptanceReport(
  input: unknown,
  runId: string,
): IPadBrowserAcceptanceReport {
  if (!input || typeof input !== 'object') {
    throw new Error(`Physical-iPad acceptance report for ${runId} is missing.`);
  }
  const report = input as Record<string, unknown>;
  const required = [
    'browserDataStoreIsNonPersistent',
    'cookieAvailableBeforeReset',
    'cookieClearedByReset',
    'fixtureLoaded',
    'multiTabLifecycleSucceeded',
    'screenshotWritten',
    'slotMatchesSurface',
    'slotPresented',
  ];
  if (report.runId !== runId || required.some((key) => report[key] !== true)) {
    throw new Error(`Physical-iPad acceptance report for ${runId} is stale or incomplete.`);
  }
  return report as IPadBrowserAcceptanceReport;
}

export function validateIPadBrowserRestartReport(
  input: unknown,
  runId: string,
  stage: 'seed' | 'verify',
): IPadBrowserRestartReport {
  if (!input || typeof input !== 'object') {
    throw new Error(`Physical-iPad restart report for ${runId} is missing.`);
  }
  const report = input as Record<string, unknown>;
  const validStageResult = stage === 'seed'
    ? report.cookiePresent === true
    : report.cookieAbsent === true;
  if (
    report.runId !== runId ||
    report.stage !== stage ||
    report.browserDataStoreIsNonPersistent !== true ||
    !validStageResult
  ) {
    throw new Error(`Physical-iPad restart report for ${runId} is stale or incomplete.`);
  }
  return report as IPadBrowserRestartReport;
}

export function isBenignDevicectlLaunchFailure(stderr: string): boolean {
  return stderr.includes('process identifier could not be determined');
}

const alphaRoot = resolve(import.meta.dir, '../..');
const bundleIdentifier = 'com.veezee.alpha';

const run = (command: string, args: string[], allowFailure = false) => {
  const result = Bun.spawnSync([command, ...args], {
    cwd: alphaRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!allowFailure && result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString().trim() || `${command} exited with status ${result.exitCode}.`,
    );
  }
  return result;
};

const option = (name: string) => {
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] : undefined;
};

const copyFromApp = ({
  destination,
  device,
  source,
}: {
  destination: string;
  device: string;
  source: string;
}) => {
  rmSync(destination, { force: true, recursive: true });
  return run('xcrun', [
    'devicectl', 'device', 'copy', 'from',
    '--device', device,
    '--source', source,
    '--destination', destination,
    '--domain-type', 'appDataContainer',
    '--domain-identifier', bundleIdentifier,
  ], true).exitCode === 0;
};

export async function runPhysicalIPadAcceptance({
  device: requestedDevice,
  evidenceDirectory = resolve(
    alphaRoot,
    'acceptance/evidence',
    `ipad-${new Date().toISOString().replaceAll(':', '-')}`,
  ),
  fixtureHost,
}: {
  device?: string;
  evidenceDirectory?: string;
  fixtureHost: string;
}) {
  if (process.platform !== 'darwin') {
    throw new Error('Physical-iPad acceptance can only run on macOS.');
  }
  mkdirSync(evidenceDirectory, { recursive: true });
  const devicesPath = join(evidenceDirectory, 'devices.json');
  run('xcrun', ['devicectl', 'list', 'devices', '--json-output', devicesPath]);
  const device = selectPhysicalIPad(
    JSON.parse(readFileSync(devicesPath, 'utf8')),
    requestedDevice,
  );
  const fixture = createBrowserFixtureServer({ hostname: '0.0.0.0', port: 0 });
  const runId = randomUUID();
  const reportName = `alpha-browser-acceptance-${runId}.json`;
  const screenshotName = `alpha-browser-acceptance-${runId}.png`;
  const reportPath = join(evidenceDirectory, 'report.json');
  const screenshotPath = join(evidenceDirectory, 'screenshot.png');
  try {
    run('env', ['VITE_ALPHA_ACCEPTANCE=1', 'bun', 'run', 'cap:sync']);
    const derivedData = '/tmp/weave-alpha-ipad-acceptance-derived-data';
    run('xcodebuild', [
      '-project', 'ios/App/App.xcodeproj',
      '-scheme', 'App',
      '-configuration', 'Debug',
      '-destination', `id=${device.udid}`,
      '-derivedDataPath', derivedData,
      'build',
    ]);
    const appPath = join(derivedData, 'Build/Products/Debug-iphoneos/App.app');
    run('xcrun', [
      'devicectl', 'device', 'install', 'app',
      '--device', device.identifier,
      appPath,
    ]);
    run('xcrun', [
      'devicectl', 'device', 'process', 'launch',
      '--device', device.identifier,
      '--terminate-existing',
      bundleIdentifier,
      '--browser-acceptance-run-id', runId,
      '--browser-acceptance-fixture-url', `http://${fixtureHost}:${fixture.port}/`,
    ]);
    let report: IPadBrowserAcceptanceReport | undefined;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (copyFromApp({
        destination: reportPath,
        device: device.identifier,
        source: `Documents/${reportName}`,
      })) {
        try {
          report = validateIPadBrowserAcceptanceReport(
            JSON.parse(readFileSync(reportPath, 'utf8')),
            runId,
          );
          break;
        } catch {
          // The app may still be replacing the report atomically.
        }
      }
      await Bun.sleep(500);
    }
    if (!report) {
      throw new Error(`Timed out waiting for physical-iPad acceptance report ${runId}.`);
    }
    if (!copyFromApp({
      destination: screenshotPath,
      device: device.identifier,
      source: `Documents/${screenshotName}`,
    })) {
      throw new Error('The physical iPad report passed but its screenshot could not be copied.');
    }
    const runRestartStage = async (stage: 'seed' | 'verify') => {
      const stageRunId = randomUUID();
      const stageReportPath = join(evidenceDirectory, `restart-${stage}.json`);
      const launch = run('xcrun', [
        'devicectl', 'device', 'process', 'launch',
        '--device', device.identifier,
        '--terminate-existing',
        bundleIdentifier,
        '--browser-acceptance-run-id', stageRunId,
        '--browser-acceptance-fixture-url', `http://${fixtureHost}:${fixture.port}/`,
        '--browser-acceptance-stage', stage,
      ], true);
      if (launch.exitCode !== 0) {
        const stderr = launch.stderr.toString().trim();
        if (!isBenignDevicectlLaunchFailure(stderr)) {
          throw new Error(stderr || `xcrun exited with status ${launch.exitCode}.`);
        }
      }
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (copyFromApp({
          destination: stageReportPath,
          device: device.identifier,
          source: `Documents/alpha-browser-acceptance-${stageRunId}.json`,
        })) {
          try {
            return validateIPadBrowserRestartReport(
              JSON.parse(readFileSync(stageReportPath, 'utf8')),
              stageRunId,
              stage,
            );
          } catch {
            // The app may still be replacing the report atomically.
          }
        }
        await Bun.sleep(500);
      }
      throw new Error(`Timed out waiting for physical-iPad ${stage} restart report.`);
    };
    const restartSeed = await runRestartStage('seed');
    const restartVerify = await runRestartStage('verify');
    return {
      device,
      evidenceDirectory,
      report,
      restart: { seed: restartSeed, verify: restartVerify },
      screenshotPath,
    };
  } finally {
    fixture.stop(true);
  }
}

if (import.meta.main) {
  const fixtureHost = option('--fixture-host');
  if (!fixtureHost) {
    throw new Error('--fixture-host must be an IP address reachable from the physical iPad.');
  }
  const result = await runPhysicalIPadAcceptance({
    device: option('--device'),
    evidenceDirectory: option('--output'),
    fixtureHost,
  });
  console.log(JSON.stringify(result, null, 2));
}
