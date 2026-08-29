import { describe, expect, test } from 'bun:test';
import {
  runMacosBrowserAcceptance,
  runMacosBrowserRestartAcceptance,
} from './run-macos';

describe('Weave Alpha macOS Browser host', () => {
  test('presents the deterministic fixture in a distinct ephemeral WebView', async () => {
    const result = await runMacosBrowserAcceptance({ dock: 'right' });

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      alphaLoaded: true,
      browserDataStoreIsNonPersistent: true,
      controlClickAndWaitSucceeded: true,
      controlKeySucceeded: true,
      controlScrollSucceeded: true,
      controlSnapshotCaptured: true,
      controlTypeSucceeded: true,
      cookieAvailableBeforeReset: true,
      cookieClearedByReset: true,
      downloadNoticeReportedToShell: true,
      downloadWasBlocked: true,
      fixtureLoaded: true,
      frameEmbeddingWasDenied: true,
      historyBackReturnedHome: true,
      historyForwardReturnedPage2: true,
      navigatedToPage2: true,
      mediaCaptureWasDenied: true,
      mediaPolicyReportedToShell: true,
      popupNoticeReportedToShell: true,
      popupStayedInVisibleSession: true,
      reloadRecoveredSessionState: true,
      resetClearedHistory: true,
      screenshotWritten: true,
      shellHistoryStateMatchedBrowser: true,
      stopCancelledSlowNavigation: true,
      unreachableFailureReportedToShell: true,
      unreachableRecoverySucceeded: true,
      uploadPolicyReportedToShell: true,
      slotMatchesSurface: true,
      slotPresented: true,
      slotOrientation: 'right',
      webViewsAreDistinct: true,
    });
  }, 60_000);

  test('presents the same browser surface in the Bottom dock', async () => {
    const result = await runMacosBrowserAcceptance({ dock: 'bottom' });

    expect(result.exitCode).toBe(0);
    expect(result.report).toMatchObject({
      alphaLoaded: true,
      browserDataStoreIsNonPersistent: true,
      fixtureLoaded: true,
      slotMatchesSurface: true,
      slotPresented: true,
      slotOrientation: 'bottom',
      webViewsAreDistinct: true,
    });
  }, 60_000);

  test('starts each macOS process with an empty ephemeral browser store', async () => {
    const result = await runMacosBrowserRestartAcceptance();

    expect(result.seed).toMatchObject({
      browserDataStoreIsNonPersistent: true,
      cookiePresent: true,
      stage: 'seed',
    });
    expect(result.verify).toMatchObject({
      browserDataStoreIsNonPersistent: true,
      cookieAbsent: true,
      stage: 'verify',
    });
  }, 60_000);
});
