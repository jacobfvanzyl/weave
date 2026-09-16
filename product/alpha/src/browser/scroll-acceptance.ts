import { Capacitor } from '@capacitor/core';
import { browserDiagnostics, startBrowserDiagnostics } from './browser-diagnostics';

/** Runs only in acceptance builds, through the mounted product input surface. */
export async function runBrowserScrollAcceptance(browser: HTMLTextAreaElement, durationMs: number, animation: boolean) {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  browser.focus();
  // Match scrolling with the iPad software keyboard dismissed. The Pane keeps
  // viewport ownership while its text-input responder is blurred.
  if (Capacitor.getPlatform() === 'ios') { await sleep(100); browser.blur(); await sleep(500); }
  const deadline = performance.now() + 15000;
  while (true) {
    const bounds = browser.getBoundingClientRect();
    if (Number(browser.dataset.frameWidth) === Number(browser.dataset.expectedFrameWidth) && Number(browser.dataset.frameHeight) === Number(browser.dataset.expectedFrameHeight)) break;
    if (performance.now() > deadline) throw new Error('Browser viewport did not settle before scrolling');
    await sleep(25);
  }
  await sleep(2000);
  startBrowserDiagnostics();
  const rect = browser.getBoundingClientRect();
  const events: { at: number; deltaY: number; target: number }[] = [];
  const start = performance.now(), startEpochMs = performance.timeOrigin + start;
  let target = 0, next = start;
  while (performance.now() - start < durationMs) {
    const elapsed = performance.now() - start;
    if (!animation) {
      const deltaY = Math.floor(elapsed / 5000) % 2 === 0 ? 8 : -8;
      target += deltaY;
      events.push({ at: performance.timeOrigin + performance.now(), deltaY, target });
      browser.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2, deltaY, deltaMode: WheelEvent.DOM_DELTA_PIXEL }));
    }
    next += 1000 / 120;
    // Do not inject a catch-up burst after an OS scheduling pause.
    if (next < performance.now()) next = performance.now();
    await sleep(Math.max(1, next - performance.now()));
  }
  const endEpochMs = performance.timeOrigin + performance.now();
  // Drain input and let the native diagnostic writer include the complete run.
  await sleep(6500);
  return { passed: true, benchmark: { startEpochMs, endEpochMs, diagnosticId:browser.dataset.diagnosticId, animation, events, input: browserDiagnostics(), width: Number(browser.dataset.frameWidth), height: Number(browser.dataset.frameHeight), devicePixelRatio } };
}
