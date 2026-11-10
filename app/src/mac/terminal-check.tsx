// The page's side of the Mac's terminal check (WVE-205, `scripts/mac-terminal-check.ts`): one
// terminal of this Mac's Host over the whole window, drawn as a terminal's Block draws it, with
// what the script asks measured and reported through the core (`src-tauri/src/check.rs`). The
// app shows this only when the script started it; nothing in the app leads here.
import { useCallback, useEffect, useRef, useState } from 'react';
import { HostConnection } from '@/host/connection';
import { useWebTerminal } from '@/terminal/web/use-web-terminal';
import { relayed, tauriCore } from './routes';

const report = (name: string, body: { text?: unknown; png?: string }) => tauriCore.invoke('terminal_check_report', {
  report: { name, ...(body.text !== undefined ? { text: JSON.stringify(body.text) } : {}), ...(body.png ? { png: body.png } : {}) },
}).catch(() => {});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** The next frame, or a moment later where the window is covered and none comes. */
const frame = () => Promise.race([new Promise<void>((resolve) => requestAnimationFrame(() => resolve())), wait(250)]);
const middle = (sorted: number[], part: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * part))] ?? 0;

export function TerminalCheck({ terminal }: { terminal: string }) {
  const host = useRef<HTMLDivElement>(null);
  const connection = useRef<Promise<HostConnection>>(undefined);
  const [width, setWidth] = useState('100%');
  const notices = useRef<unknown[]>([]);
  /** Output and frames since the script last asked, by when they came. */
  const seen = useRef({ bytes: 0, firstWrite: 0, lastWrite: 0, frames: 0, lastFrame: 0, longestGap: 0 });

  const attach = useCallback(async (id: string) => {
    connection.current ??= HostConnection.connect({
      connector: relayed(tauriCore, (channel) => tauriCore.invoke('open_local', { channel })),
      client: { name: 'weave-app-check', version: '0' },
      credentials: { method: 'local' },
      onEvent: () => {},
    });
    const { ticket } = await (await connection.current).request('terminals/attach', { id });
    return { url: await tauriCore.invoke<string>('terminal_stream', { host: null }), ticket };
  }, []);

  const { state, view, focus } = useWebTerminal(host, {
    terminalId: terminal,
    fontSize: 13,
    attach,
    onNotice: (notice) => notices.current.push(notice),
    copy: (text) => tauriCore.invoke<void>('clipboard_write', { text }),
    probe: {
      written: (bytes) => {
        const now = performance.now();
        const counted = seen.current;
        if (counted.bytes === 0) counted.firstWrite = now;
        counted.bytes += bytes;
        counted.lastWrite = now;
      },
      drawn: () => {
        const now = performance.now();
        const counted = seen.current;
        if (counted.frames > 0) counted.longestGap = Math.max(counted.longestGap, now - counted.lastFrame);
        counted.frames += 1;
        counted.lastFrame = now;
      },
    },
  });
  const latest = useRef({ state, view });
  latest.current = { state, view };

  useEffect(() => {
    if (state.kind === 'attached') focus();
  }, [state.kind, focus]);

  useEffect(() => {
    let stopped = false;
    const canvas = () => host.current?.querySelector('canvas');
    const field = () => host.current?.querySelector('textarea');
    const count = () => {
      seen.current = { bytes: 0, firstWrite: 0, lastWrite: 0, frames: 0, lastFrame: 0, longestGap: 0 };
    };
    /** A key as the keyboard sends it, to the field that has the keyboard. */
    const press = (key: string, code: string, held: KeyboardEventInit = {}) => {
      field()?.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...held }));
      field()?.dispatchEvent(new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true, ...held }));
    };
    const handlers: Record<string, (argument: string) => Promise<void>> = {
      /** What the page is showing: the stream's state, the grid, the text and the canvas. */
      async shot(name) {
        await frame();
        await frame();
        const drawn = latest.current.view;
        await report(name, {
          text: { state: latest.current.state, fits: drawn?.fits, lines: drawn?.text() ?? [], notices: notices.current, focused: document.activeElement === field(), visible: document.visibilityState === 'visible' },
          png: canvas()?.toDataURL('image/png').split(',')[1],
        });
      },
      /** Starts counting output and frames, for a flood the script is about to start. */
      async count(name) {
        count();
        await report(name, { text: { counting: true } });
      },
      /** What came since `count`, once it has been still for a moment. */
      async counted(name) {
        for (let still = 0; still < 20;) {
          const before = seen.current.bytes;
          await wait(25);
          still = seen.current.bytes === before ? still + 1 : 0;
        }
        await frame();
        const counted = seen.current;
        await report(name, {
          text: {
            bytes: counted.bytes,
            frames: counted.frames,
            outputMs: counted.lastWrite - counted.firstWrite,
            // From the first byte to the frame that showed the last.
            drawnMs: counted.lastFrame - counted.firstWrite,
            longestFrameGapMs: counted.longestGap,
          },
        });
      },
      /** A key to its echo, and to the frame that shows it, over and over. */
      async latency(name) {
        const echo: number[] = [];
        const paint: number[] = [];
        for (let round = 0; round < 60 && !stopped; round += 1) {
          count();
          const started = performance.now();
          press('x', 'KeyX');
          for (let waited = 0; seen.current.bytes === 0 && waited < 400; waited += 1) await wait(1);
          if (seen.current.bytes === 0) continue;
          const echoed = seen.current.lastWrite;
          for (let frames = 0; seen.current.lastFrame < echoed && frames < 8; frames += 1) await frame();
          if (seen.current.lastFrame < echoed) continue;
          echo.push(echoed - started);
          paint.push(seen.current.lastFrame - started);
          await wait(40);
        }
        press('u', 'KeyU', { ctrlKey: true });
        const sorted = (values: number[]) => [...values].sort((left, right) => left - right);
        const [echoes, paints] = [sorted(echo), sorted(paint)];
        await report(name, {
          text: {
            keys: echo.length,
            echoMs: { median: middle(echoes, 0.5), p95: middle(echoes, 0.95) },
            paintMs: { median: middle(paints, 0.5), p95: middle(paints, 0.95) },
          },
        });
      },
      /** Types `text` as keys, a character at a time. */
      async type(text) {
        for (const character of JSON.parse(text) as string) {
          if (character === '\r') press('Enter', 'Enter');
          else if (character === '\x1b') press('Escape', 'Escape');
          else press(character, '');
          await wait(5);
        }
        await report('typed', { text: { typed: true } });
      },
      /** The view's width, as dragging the window's edge changes it. */
      async width(value) {
        setWidth(value);
        await wait(400);
        await report('width', { text: { fits: latest.current.view?.fits } });
      },
    };
    void (async () => {
      while (!stopped) {
        const request = await tauriCore.invoke<string | null>('terminal_check_poll').catch(() => null);
        if (request) {
          const [command, ...rest] = request.split(' ');
          await handlers[command ?? '']?.(rest.join(' ')).catch((error: unknown) => report('failed', { text: { request, error: String(error) } }));
        }
        await wait(50);
      }
    })();
    return () => { stopped = true; };
  }, []);

  return (
    <div className='flex h-dvh w-dvw bg-[#1e1e2e]'>
      <div ref={host} role='group' aria-label='Terminal' data-state={state.kind} className='relative min-h-0 min-w-0 overflow-hidden' style={{ width }} />
    </div>
  );
}
