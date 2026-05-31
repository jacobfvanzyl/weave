import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { FitAddon, Ghostty, Terminal } from 'ghostty-web';
import type { ITheme } from 'ghostty-web';
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url';

type GhosttyTerminalViewProps = {
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onError?: (message: string) => void;
  onTitleChange?: (title: string) => void;
};

export type GhosttyTerminalHandle = {
  focus: () => void;
  write: (data: string) => void;
};

type TerminalCursorStyle = 'block' | 'underline' | 'bar';

type TerminalCursorMode = {
  blink: boolean;
  style: TerminalCursorStyle;
};

let ghosttyPromise: Promise<Ghostty> | undefined;

const ensureGhosttyReady = () => {
  ghosttyPromise ??= Ghostty.load(ghosttyWasmUrl);
  return ghosttyPromise;
};

const cursorStyleSequencePattern = /\x1b\[(\d*) q/g;
const cursorStyleSequencePrefixPattern = /^\x1b(?:\[(?:\d{0,3}(?: )?)?)?$/;
const maxCursorStyleSequencePrefixLength = 6;

const getCursorMode = (rawMode: string): TerminalCursorMode | undefined => {
  const mode = rawMode === '' ? 0 : Number(rawMode);
  if (!Number.isInteger(mode)) return undefined;

  switch (mode) {
    case 0:
    case 1:
      return { blink: true, style: 'block' };
    case 2:
      return { blink: false, style: 'block' };
    case 3:
      return { blink: true, style: 'underline' };
    case 4:
      return { blink: false, style: 'underline' };
    case 5:
      return { blink: true, style: 'bar' };
    case 6:
      return { blink: false, style: 'bar' };
    default:
      return undefined;
  }
};

const getIncompleteCursorStyleSequence = (data: string) => {
  const maxLength = Math.min(data.length, maxCursorStyleSequencePrefixLength);
  for (let length = maxLength; length > 0; length--) {
    const suffix = data.slice(-length);
    if (cursorStyleSequencePrefixPattern.test(suffix)) return suffix;
  }

  return '';
};

const applyCursorStyleSequences = (terminal: Terminal, data: string, incompleteSequence: { current: string }) => {
  const input = incompleteSequence.current + data;
  let nextCursorMode: TerminalCursorMode | undefined;

  cursorStyleSequencePattern.lastIndex = 0;
  for (const match of input.matchAll(cursorStyleSequencePattern)) {
    nextCursorMode = getCursorMode(match[1] ?? '');
  }

  incompleteSequence.current = getIncompleteCursorStyleSequence(input);

  if (!nextCursorMode) return;
  terminal.options.cursorStyle = nextCursorMode.style;
  terminal.options.cursorBlink = nextCursorMode.blink;
};

const writeTerminalData = (terminal: Terminal, data: string, incompleteCursorSequence: { current: string }) => {
  applyCursorStyleSequences(terminal, data, incompleteCursorSequence);
  terminal.write(data);
};

const cssVar = (styles: CSSStyleDeclaration, name: string, fallback: string) =>
  styles.getPropertyValue(name).trim() || fallback;

const parseCssPixelLength = (value: string, styles: CSSStyleDeclaration, fallback: number) => {
  const trimmed = value.trim();
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed)) return fallback;

  if (trimmed.endsWith('rem')) {
    const rootFontSize = Number.parseFloat(styles.fontSize) || fallback;
    return parsed * rootFontSize;
  }

  return parsed;
};

const getTerminalTheme = (): ITheme => {
  const styles = getComputedStyle(document.documentElement);
  return {
    foreground: cssVar(styles, '--vscode-editor-foreground', '#cdd6f4'),
    background: cssVar(styles, '--vscode-panel-background', '#1e1e2e'),
    cursor: cssVar(styles, '--vscode-editor-foreground', '#cdd6f4'),
    selectionBackground: 'rgba(203, 166, 247, 0.28)',
    black: cssVar(styles, '--vscode-terminal-ansiBlack', '#45475a'),
    red: cssVar(styles, '--vscode-terminal-ansiRed', '#f38ba8'),
    green: cssVar(styles, '--vscode-terminal-ansiGreen', '#a6e3a1'),
    yellow: cssVar(styles, '--vscode-terminal-ansiYellow', '#f9e2af'),
    blue: cssVar(styles, '--vscode-terminal-ansiBlue', '#89b4fa'),
    magenta: cssVar(styles, '--vscode-terminal-ansiMagenta', '#f5c2e7'),
    cyan: cssVar(styles, '--vscode-terminal-ansiCyan', '#94e2d5'),
    white: cssVar(styles, '--vscode-terminal-ansiWhite', '#a6adc8'),
    brightBlack: cssVar(styles, '--vscode-terminal-ansiBrightBlack', '#585b70'),
    brightWhite: cssVar(styles, '--vscode-terminal-ansiBrightWhite', '#bac2de'),
  };
};

const getTerminalFontFamily = () => {
  const styles = getComputedStyle(document.documentElement);
  return cssVar(
    styles,
    '--font-code',
    '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  );
};

const getTerminalFontSize = () => {
  const styles = getComputedStyle(document.documentElement);
  return parseCssPixelLength(cssVar(styles, '--weave-chat-text-size', '1rem'), styles, 16);
};

export const GhosttyTerminalView = forwardRef<GhosttyTerminalHandle, GhosttyTerminalViewProps>(
  ({ onInput, onResize, onError, onTitleChange }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const pendingWritesRef = useRef<string[]>([]);
    const incompleteCursorSequenceRef = useRef('');

    useImperativeHandle(ref, () => ({
      focus: () => terminalRef.current?.focus(),
      write: data => {
        const terminal = terminalRef.current;
        if (terminal) {
          writeTerminalData(terminal, data, incompleteCursorSequenceRef);
          return;
        }

        pendingWritesRef.current.push(data);
      },
    }), []);

    useEffect(() => {
      let disposed = false;
      let terminal: Terminal | undefined;
      let fitAddon: FitAddon | undefined;

      const setup = async () => {
        const ghostty = await ensureGhosttyReady();
        if (disposed || !containerRef.current) return;

        terminal = new Terminal({
          ghostty,
          cols: 80,
          rows: 24,
          cursorBlink: true,
          cursorStyle: 'block',
          fontFamily: getTerminalFontFamily(),
          fontSize: getTerminalFontSize(),
          scrollback: 2_000,
          theme: getTerminalTheme(),
        });
        fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(containerRef.current);
        terminalRef.current = terminal;

        const dataSubscription = terminal.onData(onInput);
        const resizeSubscription = terminal.onResize(size => onResize(size.cols, size.rows));
        const titleSubscription = terminal.onTitleChange(title => onTitleChange?.(title));

        fitAddon.fit();
        fitAddon.observeResize();
        onResize(terminal.cols, terminal.rows);

        const pendingWrites = pendingWritesRef.current;
        pendingWritesRef.current = [];
        for (const data of pendingWrites) {
          writeTerminalData(terminal, data, incompleteCursorSequenceRef);
        }

        terminal.focus();

        return () => {
          dataSubscription.dispose();
          resizeSubscription.dispose();
          titleSubscription.dispose();
        };
      };

      let disposeSubscriptions: (() => void) | undefined;
      void setup()
        .then(dispose => {
          disposeSubscriptions = dispose;
          if (disposed) {
            disposeSubscriptions?.();
            fitAddon?.dispose();
            terminal?.dispose();
          }
        })
        .catch(error => {
          if (!disposed) onError?.(error instanceof Error ? error.message : String(error));
        });

      return () => {
        disposed = true;
        terminalRef.current = null;
        incompleteCursorSequenceRef.current = '';
        disposeSubscriptions?.();
        fitAddon?.dispose();
        terminal?.dispose();
      };
    }, [onError, onInput, onResize, onTitleChange]);

    return (
      <div
        ref={containerRef}
        className="relative h-full min-h-0 w-full overflow-hidden outline-none select-text"
        data-weave-terminal-view
        data-weave-text-surface="true"
        style={{ caretColor: 'transparent' }}
        onMouseDown={() => terminalRef.current?.focus()}
      />
    );
  },
);

GhosttyTerminalView.displayName = 'GhosttyTerminalView';
