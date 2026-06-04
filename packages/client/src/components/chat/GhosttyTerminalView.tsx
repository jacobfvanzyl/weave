import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { FitAddon, Ghostty, Terminal } from 'ghostty-web';
import type { ITheme } from 'ghostty-web';
import ghosttyWasmUrl from 'ghostty-web/ghostty-vt.wasm?url';

type GhosttyTerminalViewProps = {
  autoFocus?: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onError?: (message: string) => void;
  onTitleChange?: (title: string) => void;
};

export type GhosttyTerminalHandle = {
  fit: () => void;
  focus: () => void;
  getSize: () => { cols: number; rows: number } | undefined;
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

const terminalFontFallbackFamily =
  '"JetBrains Mono", "Pure Nerd Font", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const terminalFontLoadSamples = [
  'M',
  '\u2500\u2502\u250c\u2510\u2514\u2518\u256d\u256e\u2570\u256f',
  '\ue0b0\ue0b2\ue0b6\ue0b4',
  '\u25cb\u25cf\u2605\u21a9\u21d4',
];

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
    '--font-terminal',
    cssVar(styles, '--font-code', terminalFontFallbackFamily),
  );
};

const getTerminalFontSize = () => {
  const styles = getComputedStyle(document.documentElement);
  return parseCssPixelLength(
    cssVar(styles, '--weave-terminal-font-size', cssVar(styles, '--weave-chat-text-size', '1rem')),
    styles,
    16,
  );
};

const ensureTerminalFontsReady = async (fontSize: number, fontFamily: string) => {
  const fonts = document.fonts;
  if (!fonts) return;

  const fontDeclaration = `${fontSize}px ${fontFamily}`;
  await Promise.all(
    terminalFontLoadSamples.map(sample => fonts.load(fontDeclaration, sample)),
  );
};

const loadTerminalFontConfig = async () => {
  const fontFamily = getTerminalFontFamily() || terminalFontFallbackFamily;
  const fontSize = getTerminalFontSize();
  const config = { fontFamily, fontSize: Number.isFinite(fontSize) ? fontSize : 16 };
  try {
    await ensureTerminalFontsReady(config.fontSize, config.fontFamily);
  } catch {
    // Font loading should improve glyph metrics, not block terminal startup.
  }
  return config;
};

export const GhosttyTerminalView = forwardRef<GhosttyTerminalHandle, GhosttyTerminalViewProps>(
  ({ autoFocus = true, onInput, onResize, onError, onTitleChange }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const pendingWritesRef = useRef<string[]>([]);
    const incompleteCursorSequenceRef = useRef('');

    useImperativeHandle(ref, () => ({
      fit: () => fitAddonRef.current?.fit(),
      focus: () => terminalRef.current?.focus(),
      getSize: () => terminalRef.current
        ? { cols: terminalRef.current.cols, rows: terminalRef.current.rows }
        : undefined,
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
        const [ghostty, fontConfig] = await Promise.all([
          ensureGhosttyReady(),
          loadTerminalFontConfig(),
        ]);
        if (disposed || !containerRef.current) return;

        terminal = new Terminal({
          ghostty,
          cols: 80,
          rows: 24,
          cursorBlink: true,
          cursorStyle: 'block',
          fontFamily: fontConfig.fontFamily,
          fontSize: fontConfig.fontSize,
          scrollback: 2_000,
          theme: getTerminalTheme(),
        });
        fitAddon = new FitAddon();
        fitAddonRef.current = fitAddon;
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

        if (autoFocus) terminal.focus();

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
        fitAddonRef.current = null;
        incompleteCursorSequenceRef.current = '';
        disposeSubscriptions?.();
        fitAddon?.dispose();
        terminal?.dispose();
      };
    }, [autoFocus, onError, onInput, onResize, onTitleChange]);

    return (
      <div
        ref={containerRef}
        className="relative grid h-full min-h-0 w-full place-items-center overflow-hidden outline-none select-text"
        data-weave-terminal-view
        data-weave-text-surface="true"
        style={{ caretColor: 'transparent' }}
        onMouseDown={() => terminalRef.current?.focus()}
      />
    );
  },
);

GhosttyTerminalView.displayName = 'GhosttyTerminalView';
