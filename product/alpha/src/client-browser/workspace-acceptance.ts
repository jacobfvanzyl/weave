// Included only by the opt-in acceptance driver. Native webpage interaction is
// performed through AppKit/UIKit input; these hooks only observe fixture events.
import { nativeClientBrowser, type ClientBrowserEvent } from './native-client-browser';
import type { LiveAcceptanceInput } from '@/acceptance';

export const clientBrowserRecoveryKey = 'weave.client-browser.acceptance-reload';
const marker = 'WVE-80 retained form';
type Recovery = { input: LiveAcceptanceInput; surfaceId: string; pageIdentity: string; documentIdentity: string; url: string; workspaceId: string };
export function pendingClientBrowserRecovery(): Recovery | undefined {
  const value = sessionStorage.getItem(clientBrowserRecoveryKey);
  return value ? JSON.parse(value) as Recovery : undefined;
}
const stage = (value: string) => Object.assign(window, { alphaAcceptanceStage: value, alphaAcceptanceDetail: value });
const wait = async (predicate: () => unknown) => {
  for (let attempt = 0; attempt < 1800; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Client Browser native acceptance timed out at ${(window as unknown as { alphaAcceptanceStage?: string }).alphaAcceptanceStage}`);
};
function fixture(event: ClientBrowserEvent) {
  if (event.kind !== 'fixture' || typeof event.value !== 'string') return;
  try { return JSON.parse(event.value) as { kind: string; identity: string; value: unknown }; } catch { return; }
}
const visibleSurface = (id: string) => [...document.querySelectorAll<HTMLElement>('[data-client-browser-surface]')].find(element => element.dataset.clientBrowserSurface === id && element.checkVisibility());

export async function beginClientBrowserWorkspaceRecovery(input: LiveAcceptanceInput, surfaceId: string, workspaceId: string): Promise<never> {
  const events: ClientBrowserEvent[] = [];
  const listener = await nativeClientBrowser.addListener('event', event => { if (events.length < 1000) events.push(event); });
  try {
    stage('client-browser-address');
    await wait(async () => (await nativeClientBrowser.snapshot({ surfaceId })).url === input.clientBrowserRecovery);
    stage('client-browser-input');
    const typed = () => events.filter(event => event.surfaceId === surfaceId).map(fixture).find(value => value?.kind === 'input' && value.value === marker);
    await wait(typed);
    stage('client-browser-post-popup');
    await wait(() => events.filter(event => event.surfaceId === surfaceId).map(fixture).some(value => {
      if (value?.kind !== 'message') return false;
      const result = value.value as Record<string, unknown>;
      return result.kind === 'popup-callback' && result.method === 'POST' && result.body === 'proof=wve80-post-body' && result.cookie === true;
    }));
    const popup = () => [...document.querySelectorAll<HTMLElement>('[data-client-browser-surface]')].find(element => element.dataset.clientBrowserSurface !== surfaceId);
    await wait(popup);
    const popupSurface = popup()!.dataset.clientBrowserSurface!;
    stage('client-browser-close-popup');
    await wait(async () => !(await nativeClientBrowser.list()).panes.some(pane => pane.surfaceId === popupSurface));
    await wait(() => visibleSurface(surfaceId));
    const snapshot = await nativeClientBrowser.snapshot({ surfaceId });
    const { pairingToken: _pairingToken, ...resumableInput } = input;
    const recovery: Recovery = { input: resumableInput, surfaceId, pageIdentity: snapshot.pageIdentity, documentIdentity: typed()!.identity, url: snapshot.url, workspaceId };
    sessionStorage.setItem(clientBrowserRecoveryKey, JSON.stringify(recovery));
    stage('client-browser-shell-reload');
    location.reload();
    return await new Promise<never>(() => {});
  } finally { await listener.remove(); }
}

export async function resumeClientBrowserWorkspaceRecovery(recovery: Recovery) {
  const events: ClientBrowserEvent[] = [];
  const listener = await nativeClientBrowser.addListener('event', event => { if (events.length < 1000) events.push(event); });
  try {
    stage('client-browser-reattach');
    await wait(() => visibleSurface(recovery.surfaceId));
    await wait(async () => !(await nativeClientBrowser.snapshot({ surfaceId: recovery.surfaceId })).hidden);
    const snapshot = await nativeClientBrowser.snapshot({ surfaceId: recovery.surfaceId });
    if (snapshot.pageIdentity !== recovery.pageIdentity || snapshot.url !== recovery.url) throw new Error('Shell reload replaced the native page or navigation');
    stage('client-browser-check-form');
    await wait(() => events.filter(event => event.surfaceId === recovery.surfaceId).map(fixture).some(value => value?.kind === 'retained-state' && value.identity === recovery.documentIdentity && value.value === marker));
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.checkVisibility() && (element.getAttribute('aria-label') === label || element.textContent?.trim() === label));
    stage('client-browser-shared-close');
    await wait(() => button('Close Client Browser')); button('Close Client Browser')!.click();
    await wait(() => button('Close page')); button('Close page')!.click();
    await wait(async () => !(await nativeClientBrowser.list()).panes.some(pane => pane.surfaceId === recovery.surfaceId));
    return { passed: true, clientBrowserRecovery: true, workspaceId: recovery.workspaceId, nativePageIdentity: recovery.pageIdentity, documentIdentity: recovery.documentIdentity, postPopupOpenerAndCookie: true, scriptClose: true, shellReload: true, unsentFormRetained: true, confirmedClose: true, driver: 'Native webpage input; shell controls driven in-process; passive fixture and native identity observations' };
  } finally { sessionStorage.removeItem(clientBrowserRecoveryKey); await listener.remove(); }
}
