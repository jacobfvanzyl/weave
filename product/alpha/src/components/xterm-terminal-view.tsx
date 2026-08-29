import { useEffect, useRef } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { cn } from '@/lib/utils';

export function XtermTerminalView({
  data,
  dataEpoch = 0,
  dataOffset = 0,
  readOnly,
  className,
  onInput,
  onResize,
}: {
  data: string;
  dataEpoch?: number;
  dataOffset?: number;
  readOnly: boolean;
  className?: string;
  onInput?(data: string): void;
  onResize?(cols: number, rows: number): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const renderedEpochRef = useRef<number | undefined>(undefined);
  const renderedEndOffsetRef = useRef(0);
  const acceptsUserInputRef = useRef(false);
  const replayInProgressRef = useRef(false);
  const replayTokenRef = useRef(0);
  const readOnlyRef = useRef(readOnly);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);

  readOnlyRef.current = readOnly;
  inputRef.current = onInput;
  resizeRef.current = onResize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      disableStdin: readOnlyRef.current,
      fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 10_000,
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#585b70aa',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#cba6f7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#cba6f7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    const dataDisposable = terminal.onData((value) => {
      if (
        !readOnlyRef.current &&
        acceptsUserInputRef.current &&
        !replayInProgressRef.current
      ) {
        inputRef.current?.(value);
      }
    });
    const fit = () => {
      if (!host.isConnected) return;
      fitAddon.fit();
      resizeRef.current?.(terminal.cols, terminal.rows);
    };
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);
    fit();

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      terminalRef.current = undefined;
      fitRef.current = undefined;
      renderedEpochRef.current = undefined;
      renderedEndOffsetRef.current = 0;
      acceptsUserInputRef.current = false;
      replayInProgressRef.current = false;
      // xterm schedules a zero-delay viewport synchronization during open.
      // Its timer is not cancelled by dispose, so let the earlier task drain
      // before tearing down the render service it reads.
      window.setTimeout(() => {
        fitAddon.dispose();
        terminal.dispose();
      }, 0);
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.disableStdin = readOnly;
  }, [readOnly]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const endOffset = dataOffset + data.length;
    if (renderedEpochRef.current !== dataEpoch) {
      const replayToken = ++replayTokenRef.current;
      acceptsUserInputRef.current = false;
      replayInProgressRef.current = true;
      if (renderedEpochRef.current !== undefined) terminal.reset();
      terminal.write(data, () => {
        if (replayTokenRef.current === replayToken) {
          replayInProgressRef.current = false;
        }
      });
      renderedEpochRef.current = dataEpoch;
      renderedEndOffsetRef.current = endOffset;
      return;
    }
    if (renderedEndOffsetRef.current === endOffset) return;
    const start = Math.max(0, renderedEndOffsetRef.current - dataOffset);
    terminal.write(data.slice(start));
    renderedEndOffsetRef.current = endOffset;
  }, [data, dataEpoch, dataOffset]);

  return (
    <div
      ref={hostRef}
      data-slot='xterm-terminal'
      className={cn(
        'min-h-0 min-w-0 flex-1 overflow-hidden bg-[#1e1e2e] [&>.xterm]:p-2',
        className,
      )}
      onPointerDown={() => {
        acceptsUserInputRef.current = true;
        terminalRef.current?.focus();
      }}
      onKeyDownCapture={() => {
        acceptsUserInputRef.current = true;
      }}
      onPasteCapture={() => {
        acceptsUserInputRef.current = true;
      }}
    />
  );
}
