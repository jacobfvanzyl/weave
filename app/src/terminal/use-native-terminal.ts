// A native terminal beneath an element of the page (WVE-153): the plugin's surface laid out over
// it, attached to a terminal's stream, and attached again when the stream drops or the app comes
// back to the front. After e30f6e93 (product/alpha/src/components/native-terminal-view.tsx) by way
// of the WVE-150 spike.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { PluginListenerHandle } from '@capacitor/core';
import type { TerminalTicket } from '@/app/app-controller';
import { CLOSE, nativeTerminal, nativeTerminalAvailable, type NativeTerminalEvent } from './native-terminal';

export type SurfaceState =
  /** Not in the iOS app: nothing draws terminals here. */
  | { kind: 'unavailable' }
  | { kind: 'connecting' }
  /** `vt`: restored from the screen alone, without the history from before attaching. */
  | { kind: 'attached'; restore: 'snapshot' | 'vt' }
  | { kind: 'exited'; exitCode?: number }
  | { kind: 'failed'; message: string };

/** What a terminal's program asked the device to show. */
export type TerminalNotice =
  | { kind: 'notification'; title: string; body: string }
  /** It wrote to the clipboard, which now has it. */
  | { kind: 'clipboard' };

/** Delays before attaching again after a stream drops, in milliseconds; the last repeats. */
const BACKOFF = [500, 1000, 2000, 5000, 10000];

/**
 * Whether an overlay the web view paints covers a native terminal: a dialog or menu that isn't the
 * one the terminal is in. While one is open, touches and the keyboard stay with the web view.
 */
export function overlayOver(element: Element) {
  return [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"], [role="alertdialog"]')]
    .some((overlay) => !overlay.contains(element));
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useNativeTerminal(host: RefObject<HTMLElement | null>, { terminalId, fontSize, attach, onNotice }: {
  /** The terminal to show; none detaches. */
  terminalId?: string;
  fontSize: number;
  attach(id: string): Promise<TerminalTicket>;
  onNotice?(notice: TerminalNotice): void;
}) {
  const available = nativeTerminalAvailable();
  const [surfaceId, setSurfaceId] = useState<string>();
  const [state, setState] = useState<SurfaceState>(available ? { kind: 'connecting' } : { kind: 'unavailable' });
  // Bumped to attach again from a fresh restore.
  const [attempt, setAttempt] = useState(0);
  const latest = useRef({ attach, onNotice, fontSize });
  latest.current = { attach, onNotice, fontSize };
  const failures = useRef(0);
  const exited = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reattach = useCallback(() => {
    clearTimeout(retryTimer.current);
    setAttempt((value) => value + 1);
  }, []);

  // The surface: made once, kept over `host` as the page moves, closed with the component.
  useEffect(() => {
    const element = host.current;
    if (!available || !element) return;
    let disposed = false;
    let id: string | undefined;
    let frame: number | undefined;
    let previous = '';
    let listener: PluginListenerHandle | undefined;
    const bounds = (surface: string) => {
      const rect = element.getBoundingClientRect();
      return {
        surfaceId: surface,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible: !document.hidden && rect.width > 0 && rect.height > 0,
        inputBlocked: overlayOver(element),
      };
    };
    const measure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (disposed || !id) return;
        const next = bounds(id);
        const key = JSON.stringify(next);
        if (key === previous) return;
        previous = key;
        void nativeTerminal.layout(next).catch(() => undefined);
      });
    };
    const handle = (event: NativeTerminalEvent) => {
      switch (event.kind) {
        case 'opened':
          failures.current = 0;
          exited.current = false;
          setState({ kind: 'attached', restore: event.restore });
          return;
        case 'exited':
          exited.current = true;
          setState({ kind: 'exited', exitCode: event.exitCode });
          return;
        case 'closed': {
          if (exited.current || event.code === CLOSE.exited) {
            setState((current) => current.kind === 'exited' ? current : { kind: 'exited' });
            return;
          }
          if (event.code === CLOSE.revoked) {
            setState({ kind: 'failed', message: 'The Host revoked this device. Pair it again to see its terminals.' });
            return;
          }
          // A dropped network, a Host restart or a late ticket: attach again, backing off, once
          // the app is in front.
          setState({ kind: 'connecting' });
          if (document.hidden) return;
          const delay = BACKOFF[Math.min(failures.current, BACKOFF.length - 1)];
          failures.current += 1;
          clearTimeout(retryTimer.current);
          retryTimer.current = setTimeout(() => setAttempt((value) => value + 1), delay);
          return;
        }
        case 'notification':
          latest.current.onNotice?.({ kind: 'notification', title: event.title, body: event.body });
          return;
        case 'clipboard':
          latest.current.onNotice?.({ kind: 'clipboard' });
          return;
        default:
          return;
      }
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const mutations = new MutationObserver(measure);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'inert', 'aria-hidden', 'data-open', 'data-closed', 'class'] });
    window.addEventListener('resize', measure);
    // Back in front, attach again from a fresh restore rather than trust a stream the suspension
    // may have stalled.
    const visibility = () => {
      measure();
      if (!document.hidden && !exited.current) {
        failures.current = 0;
        reattach();
      }
    };
    document.addEventListener('visibilitychange', visibility);
    void (async () => {
      listener = await nativeTerminal.addListener('event', (event) => {
        if (!disposed && event.surfaceId === id) handle(event);
      });
      const created = await nativeTerminal.create({ fontSize: latest.current.fontSize });
      if (disposed) {
        await nativeTerminal.close({ surfaceId: created.surfaceId });
        return;
      }
      id = created.surfaceId;
      // Laid out before it attaches, so the stream opens with this view's size.
      const first = bounds(id);
      previous = JSON.stringify(first);
      await nativeTerminal.layout(first);
      if (!disposed) setSurfaceId(id);
    })().catch((error) => {
      if (!disposed) setState({ kind: 'failed', message: `The terminal couldn't start: ${message(error)}` });
    });
    return () => {
      disposed = true;
      clearTimeout(retryTimer.current);
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', visibility);
      void listener?.remove();
      if (id) void nativeTerminal.close({ surfaceId: id }).catch(() => undefined);
      setSurfaceId(undefined);
    };
  }, [available, host, reattach]);

  // The stream: a ticket from the Host, then the plugin opens it.
  useEffect(() => {
    if (!surfaceId) return;
    if (!terminalId) {
      void nativeTerminal.detach({ surfaceId }).catch(() => undefined);
      return;
    }
    let stale = false;
    exited.current = false;
    setState({ kind: 'connecting' });
    void latest.current.attach(terminalId)
      .then(({ url, ticket }) => stale ? undefined : nativeTerminal.attach({ surfaceId, url, ticket }))
      .catch((error) => {
        if (!stale) setState({ kind: 'failed', message: `Couldn't attach to the terminal: ${message(error)}` });
      });
    return () => { stale = true; };
  }, [surfaceId, terminalId, attempt]);

  useEffect(() => {
    if (surfaceId) void nativeTerminal.setFontSize({ surfaceId, fontSize }).catch(() => undefined);
  }, [surfaceId, fontSize]);

  const focus = useCallback(() => {
    if (surfaceId) void nativeTerminal.focus({ surfaceId }).catch(() => undefined);
  }, [surfaceId]);

  return { state, focus, retry: reattach };
}
