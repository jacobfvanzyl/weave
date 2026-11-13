// A terminal drawn in the page, under an element of it (WVE-205): the view (`view.ts`) attached
// to the terminal's stream (`stream.ts`), and attached again when the stream drops.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { TerminalTicket } from '@/app/app-controller';
import type { TerminalSize } from '@/host/protocol';
import { CLOSE, type SurfaceState, type TerminalNotice } from '../terminals';
import { FAMILY, terminalRuntime, type TerminalRuntime } from './runtime';
import { openTerminalStream, type TerminalStream } from './stream';
import { type Probe, TerminalView } from './view';

/** Delays before attaching again after a stream drops, in milliseconds; the last repeats. */
const BACKOFF = [500, 1000, 2000, 5000, 10000];

/** How long the view's size settles before the Host hears it: a window being dragged sends one. */
const FIT_DELAY = 150;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export type WebTerminalOptions = {
  /** The terminal to show; none detaches. */
  terminalId?: string;
  fontSize: number;
  attach(id: string): Promise<TerminalTicket>;
  onNotice?(notice: TerminalNotice): void;
  /** Opens a link the person ⌘-clicked. */
  open?(address: string): void;
  /** Puts what a program copied (OSC 52) on the clipboard. */
  copy?(text: string): Promise<void>;
  /** Shows a program's notification beyond the Block. */
  notify?(title: string, body: string): void;
  /** The module and fonts; tests give their own. */
  runtime?(): Promise<TerminalRuntime>;
  /** Hears output arrive and frames drawn: the terminal check's. */
  probe?: Probe;
};

export function useWebTerminal(host: RefObject<HTMLElement | null>, options: WebTerminalOptions) {
  const { terminalId, fontSize } = options;
  const [state, setState] = useState<SurfaceState>({ kind: 'connecting' });
  const [view, setView] = useState<{ view: TerminalView; runtime: TerminalRuntime }>();
  // Bumped to attach again from a fresh restore.
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(options);
  latest.current = options;
  const stream = useRef<TerminalStream>(undefined);
  const fitTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const failures = useRef(0);
  // Whether the terminal has the keyboard, and whether the key bar holds Control for its next key.
  const [focused, setFocused] = useState(false);
  const [control, setControl] = useState(false);
  /** A snapshot that didn't decode: ask for the screen as VT from then on. */
  const plain = useRef(false);

  const reattach = useCallback(() => {
    clearTimeout(retryTimer.current);
    setAttempt((value) => value + 1);
  }, []);

  // The view: made once the module is loaded, kept across streams, gone with the component.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let made: TerminalView | undefined;
    void (latest.current.runtime ?? terminalRuntime)().then((runtime) => {
      if (disposed) return;
      made = new TerminalView(element, runtime.ghostty, {
        fontSize: latest.current.fontSize,
        family: FAMILY,
        input: (bytes) => stream.current?.input(bytes),
        fit: (size: TerminalSize) => {
          clearTimeout(fitTimer.current);
          fitTimer.current = setTimeout(() => stream.current?.resize(size), FIT_DELAY);
        },
        open: (address) => latest.current.open?.(address),
        copied: (text) => {
          void latest.current.copy?.(text).then(() => latest.current.onNotice?.({ kind: 'clipboard' })).catch(() => undefined);
        },
        focused: setFocused,
        controlUsed: () => setControl(false),
        probe: {
          written: (bytes) => latest.current.probe?.written(bytes),
          drawn: () => latest.current.probe?.drawn(),
        },
      });
      setView({ view: made, runtime });
    }).catch((error) => {
      if (!disposed) setState({ kind: 'failed', message: `The terminal couldn't start: ${message(error)}` });
    });
    return () => {
      disposed = true;
      clearTimeout(fitTimer.current);
      made?.dispose();
      setView(undefined);
    };
  }, [host]);

  // The stream: a ticket from the Host, then the page opens it.
  useEffect(() => {
    if (!view || !terminalId) return;
    let stale = false;
    let exited = false;
    let opened: TerminalStream | undefined;
    setState({ kind: 'connecting' });
    const again = () => {
      const delay = BACKOFF[Math.min(failures.current, BACKOFF.length - 1)];
      failures.current += 1;
      clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => setAttempt((value) => value + 1), delay);
    };
    void latest.current.attach(terminalId).then((ticket) => {
      if (stale) return;
      let restore: 'snapshot' | 'vt' = 'vt';
      opened = openTerminalStream({
        url: ticket.url,
        ticket: ticket.ticket,
        size: view.view.fits,
        // A codec no holder has gets the screen as VT.
        codec: plain.current ? `${view.runtime.codec}, undecoded` : view.runtime.codec,
      }, {
        opened: (_, kind) => { restore = kind; },
        restore: (screen) => {
          if (!view.view.restore(screen)) {
            // The holder's snapshot didn't decode here, though the codecs match by name.
            plain.current = true;
            reattach();
            return;
          }
          failures.current = 0;
          setState({ kind: 'attached', restore });
          // The size this view fits now, if it changed while the stream was opening.
          opened?.resize(view.view.fits);
        },
        output: (bytes) => view.view.write(bytes),
        resized: (size) => view.view.resized(size),
        notification: (title, body) => {
          latest.current.onNotice?.({ kind: 'notification', title, body });
          latest.current.notify?.(title, body);
        },
        clipboard: (text) => {
          void latest.current.copy?.(text).then(() => latest.current.onNotice?.({ kind: 'clipboard' })).catch(() => undefined);
        },
        exited: (exitCode) => {
          exited = true;
          setState({ kind: 'exited', exitCode });
        },
        closed: ({ code, reason }) => {
          if (stale) return;
          stream.current = undefined;
          if (exited || code === CLOSE.exited) {
            setState((current) => current.kind === 'exited' ? current : { kind: 'exited' });
            return;
          }
          if (code === CLOSE.revoked || code === CLOSE.unauthenticated) {
            setState({ kind: 'failed', message: `The Dispatcher refused this device${reason ? ` (${reason})` : ''}. Pair it again to see your terminals.` });
            return;
          }
          // A Host restarting, a late ticket or a network that dropped: attach again, backing
          // off, and say why meanwhile if the app's core did.
          setState(reason && failures.current > 0 ? { kind: 'failed', message: reason } : { kind: 'connecting' });
          again();
        },
      });
      stream.current = opened;
    }).catch((error) => {
      if (stale) return;
      setState({ kind: 'failed', message: `Couldn't attach to the terminal: ${message(error)}` });
      again();
    });
    return () => {
      stale = true;
      clearTimeout(retryTimer.current);
      opened?.close();
      if (stream.current === opened) stream.current = undefined;
    };
  }, [view, terminalId, attempt, reattach]);

  useEffect(() => {
    view?.view.setFontSize(fontSize);
  }, [view, fontSize]);

  const focus = useCallback(() => view?.view.focus(), [view]);
  /** What a key bar over a software keyboard does: a key by name, Control for the next key, and the keyboard away. */
  const keys = useCallback((key: 'Control' | 'Hide' | (string & {})) => {
    if (key === 'Hide') return view?.view.blur();
    if (key !== 'Control') return view?.view.press(key);
    setControl((held) => {
      view?.view.holdControl(!held);
      return !held;
    });
  }, [view]);

  return { state, focus, retry: reattach, view: view?.view, focused, control, keys };
}
