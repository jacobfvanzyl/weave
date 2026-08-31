import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createBrowserFixtureServer } from '../browser-fixture/server';

export type MacosBrowserAcceptanceReport = {
  alphaLoaded: boolean;
  browserDataStoreIsNonPersistent: boolean;
  browserPaneMounted: boolean;
  cookieAvailableBeforeReset: boolean;
  cookieClearedByReset: boolean;
  downloadNoticeReportedToShell: boolean;
  downloadWasBlocked: boolean;
  fixtureLoaded: boolean;
  frameEmbeddingWasDenied: boolean;
  historyBackReturnedHome: boolean;
  historyForwardReturnedPage2: boolean;
  navigatedToPage2: boolean;
  mediaCaptureWasDenied: boolean;
  mediaPolicyReportedToShell: boolean;
  multiTabLifecycleSucceeded: boolean;
  popupNoticeReportedToShell: boolean;
  popupStayedInVisibleSession: boolean;
  reloadRecoveredSessionState: boolean;
  resetClearedHistory: boolean;
  screenshotWritten: boolean;
  shellHistoryStateMatchedBrowser: boolean;
  stopCancelledSlowNavigation: boolean;
  unreachableFailureReportedToShell: boolean;
  unreachableRecoverySucceeded: boolean;
  uploadPolicyReportedToShell: boolean;
  browserHidden: boolean;
  slotHeight: number;
  slotMatchesSurface: boolean;
  slotPresented: boolean;
  slotOrientation: 'bottom' | 'right';
  slotWidth: number;
  slotX: number;
  slotY: number;
  surfaceHeight: number;
  surfaceWidth: number;
  surfaceX: number;
  surfaceY: number;
  webViewsAreDistinct: boolean;
};

export type MacosBrowserRestartAcceptanceReport = {
  browserDataStoreIsNonPersistent: boolean;
  cookieAbsent: boolean;
  cookiePresent: boolean;
  stage: 'seed' | 'verify';
};

const alphaRoot = resolve(import.meta.dir, '../..');
const macosRoot = resolve(alphaRoot, 'macos');
const swiftScratchPath = '/tmp/weave-alpha-browser-acceptance-build';

const run = (command: string, args: string[]) => {
  const result = Bun.spawnSync([command, ...args], {
    cwd: alphaRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.toString().trim() || `${command} exited with status ${result.exitCode}.`,
    );
  }
  return result.stdout.toString().trim();
};

const availablePort = () => {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port;
  reservation.stop(true);
  return port;
};

const waitForHTTP = async (url: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The development server is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}.`);
};

export async function runMacosBrowserAcceptance({
  dock,
  evidenceDirectory,
  restartStage,
}: {
  dock: 'bottom' | 'right';
  evidenceDirectory?: string;
  restartStage?: 'seed' | 'verify';
}) {
  if (process.platform !== 'darwin') {
    throw new Error('macOS Browser acceptance can only run on macOS.');
  }
  const fixture = createBrowserFixtureServer({ hostname: '127.0.0.1', port: 0 });
  const alphaPort = availablePort();
  const alphaURL = `http://127.0.0.1:${alphaPort}/?mock=sidebar`;
  const vite = Bun.spawn([
    'bunx',
    'vite',
    '--host',
    '127.0.0.1',
    '--port',
    String(alphaPort),
    '--strictPort',
  ], {
    cwd: alphaRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const outputDirectory = evidenceDirectory ??
    mkdtempSync(join(tmpdir(), 'weave-alpha-browser-acceptance-'));
  mkdirSync(outputDirectory, { recursive: true });
  const reportPath = join(outputDirectory, `${dock}.json`);
  const screenshotPath = join(outputDirectory, `${dock}.png`);
  try {
    await waitForHTTP(alphaURL);
    run('swift', [
      'build',
      '--package-path',
      macosRoot,
      '--scratch-path',
      swiftScratchPath,
    ]);
    const binPath = run('swift', [
      'build',
      '--package-path',
      macosRoot,
      '--scratch-path',
      swiftScratchPath,
      '--show-bin-path',
    ]);
    const hostArguments = [
      resolve(binPath, 'WeaveAlpha'),
      '--acceptance-alpha-url',
      alphaURL,
      '--acceptance-fixture-url',
      `http://${fixture.hostname}:${fixture.port}/`,
      '--acceptance-report',
      reportPath,
      '--acceptance-screenshot',
      screenshotPath,
      '--acceptance-dock',
      dock,
    ];
    if (restartStage) {
      hostArguments.push('--acceptance-restart-stage', restartStage);
    }
    const host = Bun.spawn(hostArguments, {
      cwd: alphaRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timeout = setTimeout(() => host.kill(), 30_000);
    const exitCode = await host.exited;
    clearTimeout(timeout);
    const stdout = await new Response(host.stdout).text();
    const stderr = await new Response(host.stderr).text();
    if (!existsSync(reportPath)) {
      throw new Error(stderr.trim() || 'The macOS Browser host did not write an acceptance report.');
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as
      | MacosBrowserAcceptanceReport
      | MacosBrowserRestartAcceptanceReport;
    return { exitCode, report, reportPath, screenshotPath, stderr, stdout };
  } finally {
    vite.kill();
    fixture.stop(true);
    if (!evidenceDirectory) {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  }
}

export async function runMacosBrowserRestartAcceptance(evidenceDirectory?: string) {
  const seedResult = await runMacosBrowserAcceptance({
    dock: 'right',
    evidenceDirectory: evidenceDirectory ? join(evidenceDirectory, 'restart-seed') : undefined,
    restartStage: 'seed',
  });
  const verifyResult = await runMacosBrowserAcceptance({
    dock: 'right',
    evidenceDirectory: evidenceDirectory ? join(evidenceDirectory, 'restart-verify') : undefined,
    restartStage: 'verify',
  });
  if (seedResult.exitCode !== 0 || verifyResult.exitCode !== 0) {
    throw new Error('A macOS Browser restart acceptance process failed.');
  }
  return {
    seed: seedResult.report as MacosBrowserRestartAcceptanceReport,
    verify: verifyResult.report as MacosBrowserRestartAcceptanceReport,
  };
}
