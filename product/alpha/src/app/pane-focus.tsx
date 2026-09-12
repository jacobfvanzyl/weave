import { nativeSoftwareKeyboard, nativeTerminalAvailable, nativeTerminalBridge } from '@/terminal/native-terminal';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';

export const overlaySelector = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
const editableSelector = 'input, textarea, select, [contenteditable="true"], [role="textbox"]';
// Modal aria-hidden/inert affects input, not the visibility of the live underlay.
export const paneRendered = (element: HTMLElement) => element.isConnected && !element.closest('[hidden]') && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0;
export const paneVisible = (element: HTMLElement) => element.isConnected && !element.closest('[hidden], [inert], [aria-hidden="true"]') && getComputedStyle(element).display !== 'none';
export const paneOverlayOpen = () => [...document.querySelectorAll<HTMLElement>(overlaySelector)].some((element) => paneVisible(element) && element.getBoundingClientRect().height > 0);
export type PaneFocusAdapter = { element: HTMLElement; available(): boolean; focus(isCurrent: () => boolean): boolean | Promise<boolean> };

/** Owns focus policy for both web composers and native terminal responders.
 * Adapters report readiness; no key events are intercepted or replayed. */
export class PaneFocusOwner {
  constructor(private softwareKeyboard = nativeSoftwareKeyboard, private browseOnly = false) { this.keyboardDismissed = browseOnly; }
  private adapters = new Map<string, PaneFocusAdapter>();
  private listeners = new Set<() => void>();
  private target: string | undefined;
  private focused: string | undefined;
  private fallbacks: string[] = [];
  private frame: number | undefined;
  private inFlight = false;
  private pointerDown = false;
  private windowActive = true;
  private keyboardDismissed = false;
  private connected = false;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.target;
  private publish(id: string | undefined) {
    if (this.target === id) return;
    this.target = id;
    this.listeners.forEach((listener) => listener());
  }
  register(id: string, adapter: PaneFocusAdapter) {
    this.adapters.set(id, adapter); this.schedule();
    return () => {
      if (this.adapters.get(id) !== adapter) return;
      this.adapters.delete(id);
      if (this.focused === id) this.focused = undefined;
      this.schedule();
    };
  }
  setFallbacks(ids: string[]) { this.fallbacks = ids; this.schedule(); }
  request(id: string) { this.keyboardDismissed = false; this.publish(id); this.schedule(); }
  browse(id?: string) {
    this.keyboardDismissed = true; this.focused = undefined; this.publish(id);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches(editableSelector)) active.blur();
    if (nativeTerminalAvailable) void nativeTerminalBridge.focusWeb();
  }
  didFocus(id: string) {
    // A native acknowledgement may arrive after a newer request was made.
    if (this.inFlight && this.target !== id) { this.schedule(); return; }
    this.focused = id; this.publish(id);
  }
  didBlur(id: string) {
    const lostPaneFocus = this.focused === id;
    if (lostPaneFocus) this.focused = undefined;
    if (this.softwareKeyboard && lostPaneFocus && !this.inFlight) {
      // Focusout precedes focusin. Let a control, overlay or another pane claim
      // focus first; a blur with no recipient is iPad's input dismissal.
      queueMicrotask(() => {
        const active = document.activeElement;
        if (this.target === id && this.adapters.get(id)?.available() && !this.focused && !this.inFlight && !this.blocked() && (!active || active === document.body)) this.keyboardDismissed = true;
      });
    }
    this.schedule();
  }
  ready() { this.schedule(); }
  restoreTarget() { this.focused = undefined; this.schedule(); }
  private blocked() {
    if (this.keyboardDismissed || !this.windowActive || document.hidden || this.pointerDown || paneOverlayOpen()) return true;
    const element = document.activeElement as HTMLElement | null;
    return Boolean(element?.matches(editableSelector) && ![...this.adapters.values()].some((adapter) => adapter.element === element || adapter.element.contains(element)));
  }
  private schedule = () => {
    if (!this.connected || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; void this.restore(); });
  };
  private async restore() {
    if (this.inFlight || this.blocked()) return;
    const preferred = this.target && this.adapters.get(this.target);
    if (preferred && paneVisible(preferred.element) && !preferred.available()) return;
    const available = (id: string | undefined) => id && this.adapters.get(id)?.available();
    const id = available(this.target) ? this.target : this.fallbacks.find((candidate) => available(candidate));
    if (!id) return;
    this.publish(id);
    if (this.focused === id) return;
    const adapter = this.adapters.get(id)!;
    this.inFlight = true;
    try {
      const focused = await adapter.focus(() => this.connected && this.target === id && !this.blocked() && adapter.available());
      if (focused && this.target === id && this.adapters.get(id) === adapter) this.focused = id;
    } catch { /* A hidden or removed native surface reports readiness again if it returns. */ }
    finally { this.inFlight = false; if (this.target !== id) this.schedule(); }
  }
  connect() {
    this.connected = true;
    const focus = (event: FocusEvent) => {
      const element = event.target as HTMLElement;
      const match = [...this.adapters].find(([, adapter]) => adapter.element === element || adapter.element.contains(element));
      if (match) this.didFocus(match[0]);
      else { this.focused = undefined; this.schedule(); }
    };
    const blur = (event: FocusEvent) => {
      const element = event.target as HTMLElement;
      const match = [...this.adapters].find(([, adapter]) => adapter.element === element || adapter.element.contains(element));
      if (match) this.didBlur(match[0]);
      else { this.focused = undefined; this.schedule(); }
    };
    const down = (event: PointerEvent) => {
      this.pointerDown = true;
      const element = event.target as HTMLElement;
      if (element.closest(overlaySelector)) return;
      if (this.browseOnly && !element.closest(editableSelector + ', [data-slot="native-terminal"]')) return;
      const id = element.closest<HTMLElement>('[data-pane-focus-id]')?.dataset.paneFocusId;
      if (id) this.request(id);
      // Mouse actions on ordinary chrome must not strand the keyboard on a
      // button. Keep normal focus behavior for menus and editable fields.
      if (event.button === 0 && !(document.activeElement as HTMLElement | null)?.matches(editableSelector) && !element.closest(`${editableSelector}, [aria-haspopup], [role="separator"]`) && element.closest('button')) event.preventDefault();
    };
    const up = () => { this.pointerDown = false; this.schedule(); };
    const activate = () => { this.windowActive = true; this.focused = undefined; this.schedule(); };
    const deactivate = () => { this.windowActive = false; this.pointerDown = false; this.focused = undefined; };
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', blur);
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    document.addEventListener('visibilitychange', this.schedule);
    // A native terminal taking first responder blurs the web view while the
    // application window remains active. Only the host knows window activation.
    let removeActivation: (() => Promise<void>) | undefined;
    if (nativeTerminalAvailable) {
      void nativeTerminalBridge.addListener('event', (event) => {
        if (event.kind === 'window-focus') activate();
        if (event.kind === 'window-blur') deactivate();
      }).then((listener) => { if (!this.connected) void listener.remove(); else removeActivation = () => listener.remove(); });
    } else {
      window.addEventListener('focus', activate);
      window.addEventListener('blur', deactivate);
    }
    const observer = new MutationObserver(this.schedule);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'aria-hidden', 'data-open', 'data-closed', 'style'] });
    this.schedule();
    return () => {
      this.connected = false;
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.frame = undefined;
      observer.disconnect();
      void removeActivation?.();
      document.removeEventListener('focusin', focus); document.removeEventListener('focusout', blur);
      document.removeEventListener('pointerdown', down, true); document.removeEventListener('pointerup', up, true); document.removeEventListener('pointercancel', up, true);
      document.removeEventListener('visibilitychange', this.schedule);
      window.removeEventListener('focus', activate); window.removeEventListener('blur', deactivate);
    };
  }
}
const OwnerContext = createContext<PaneFocusOwner | undefined>(undefined);
const PaneContext = createContext<string | undefined>(undefined);
export function PaneFocusProvider({ children, browseOnly = false }: { children: ReactNode; browseOnly?: boolean }) {
  const [owner] = useState(() => new PaneFocusOwner(nativeSoftwareKeyboard, browseOnly));
  useEffect(() => owner.connect(), [owner]);
  return <OwnerContext value={owner}>{children}</OwnerContext>;
}
export function PaneFocusScope({ id, children }: { id: string; children: ReactNode }) { return <PaneContext value={id}>{children}</PaneContext>; }
export function usePaneFocus() { return useContext(OwnerContext); }
export function usePaneFocusAdapter() { return { owner: useContext(OwnerContext), id: useContext(PaneContext) }; }
const noSubscription = () => () => {};
const noTarget = () => undefined;
export function usePaneFocusTarget() {
  const owner = usePaneFocus();
  return useSyncExternalStore(owner?.subscribe ?? noSubscription, owner?.snapshot ?? noTarget);
}
export function useComposerPaneFocus(ref: RefObject<HTMLTextAreaElement | null>) {
  const { owner, id } = usePaneFocusAdapter();
  useEffect(() => {
    const element = ref.current;
    if (!owner || !id || !element) return;
    return owner.register(id, { element, available: () => paneVisible(element) && !element.disabled,
      focus: async (isCurrent) => {
        // A DOM focus alone cannot transfer AppKit's first responder from a
        // sibling native terminal back into Electron's web contents.
        if (nativeTerminalAvailable) await nativeTerminalBridge.focusWeb();
        if (!isCurrent()) return false;
        element.focus({ preventScroll: true }); return document.activeElement === element;
      } });
  }, [owner, id, ref]);
  return owner;
}
export const terminalFocusId = (workspace: string, paneId: string) => `terminal:${workspace}:${paneId}`;
export const agentFocusId = (threadId: string) => `agent:${threadId}`;
