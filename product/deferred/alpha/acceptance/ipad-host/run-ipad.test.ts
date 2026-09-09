import { describe, expect, test } from 'bun:test';
import {
  isBenignDevicectlLaunchFailure,
  selectPhysicalIPad,
  validateIPadBrowserAcceptanceReport,
  validateIPadBrowserRestartReport,
} from './run-ipad';

describe('Weave Alpha physical-iPad acceptance', () => {
  test('selects the only paired, booted, developer-enabled physical iPad', () => {
    expect(selectPhysicalIPad({
      result: {
        devices: [
          {
            identifier: 'ipad-id',
            connectionProperties: { pairingState: 'paired' },
            deviceProperties: {
              bootState: 'booted',
              developerModeStatus: 'enabled',
              name: 'Test iPad',
            },
            hardwareProperties: {
              deviceType: 'iPad',
              reality: 'physical',
              udid: 'ipad-udid',
            },
          },
          {
            identifier: 'iphone-id',
            connectionProperties: { pairingState: 'paired' },
            deviceProperties: {
              bootState: 'booted',
              developerModeStatus: 'enabled',
              name: 'Test iPhone',
            },
            hardwareProperties: {
              deviceType: 'iPhone',
              reality: 'physical',
              udid: 'iphone-udid',
            },
          },
        ],
      },
    })).toMatchObject({ identifier: 'ipad-id', udid: 'ipad-udid' });
  });

  test('rejects stale or incomplete app-written evidence', () => {
    expect(() => validateIPadBrowserAcceptanceReport({
      fixtureLoaded: true,
      multiTabLifecycleSucceeded: true,
      runId: 'old-run',
      screenshotWritten: true,
      slotMatchesSurface: true,
      slotPresented: true,
    }, 'current-run')).toThrow('current-run');
  });

  test('requires each restart stage to match its launch process', () => {
    expect(validateIPadBrowserRestartReport({
      browserDataStoreIsNonPersistent: true,
      cookieAbsent: true,
      cookiePresent: false,
      runId: 'verify-run',
      stage: 'verify',
    }, 'verify-run', 'verify')).toMatchObject({ cookieAbsent: true });
  });

  test('requires the native Browser frame to match the React surface', () => {
    expect(() => validateIPadBrowserAcceptanceReport({
      browserDataStoreIsNonPersistent: true,
      cookieAvailableBeforeReset: true,
      cookieClearedByReset: true,
      fixtureLoaded: true,
      multiTabLifecycleSucceeded: true,
      runId: 'geometry-run',
      screenshotWritten: true,
      slotMatchesSurface: false,
      slotPresented: true,
    }, 'geometry-run')).toThrow('geometry-run');
  });

  test('only tolerates devicectl losing the PID of an app that exited successfully', () => {
    expect(isBenignDevicectlLaunchFailure(
      'The process was launched, but the process identifier could not be determined because it exited.',
    )).toBe(true);
    expect(isBenignDevicectlLaunchFailure('Device is disconnected.')).toBe(false);
    expect(isBenignDevicectlLaunchFailure('Application com.veezee.alpha is not installed.')).toBe(false);
  });
});
