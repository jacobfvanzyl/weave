import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import type { ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type TerminalRendererViewProps = {
  autoFocus?: boolean;
  onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void;
  onError?: (message: string) => void;
  onTitleChange?: (title: string) => void;
};

export type TerminalRendererHandle = {
  fit: () => TerminalGridSize | undefined;
  focus: () => void;
  getSize: () => TerminalGridSize | undefined;
  resetAndWrite: (data: string) => void;
  write: (data: string) => void;
};

type TerminalGridSize = {
  cols: number;
  rows: number;
};

const fitTerminal = (
  terminal: Terminal | null | undefined,
  fitAddon: FitAddon | null | undefined,
): TerminalGridSize | undefined => {
  if (!terminal || !fitAddon) return undefined;

  const proposedSize = fitAddon.proposeDimensions();
  fitAddon.fit();
  if (!proposedSize) return undefined;

  return { cols: proposedSize.cols, rows: proposedSize.rows };
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

export const XtermTerminalView = forwardRef<TerminalRendererHandle, TerminalRendererViewProps>(
  ({ autoFocus = true, onInput, onResize, onError, onTitleChange }, ref) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const pendingWritesRef = useRef<string[]>([]);

    useImperativeHandle(ref, () => ({
      fit: () => fitTerminal(terminalRef.current, fitAddonRef.current),
      focus: () => terminalRef.current?.focus(),
      getSize: () => terminalRef.current
        ? { cols: terminalRef.current.cols, rows: terminalRef.current.rows }
        : undefined,
      resetAndWrite: data => {
        const terminal = terminalRef.current;
        if (terminal) {
          terminal.reset();
          terminal.write(data);
          return;
        }

        pendingWritesRef.current = [data];
      },
      write: data => {
        const terminal = terminalRef.current;
        if (terminal) {
          terminal.write(data);
          return;
        }

        pendingWritesRef.current.push(data);
      },
    }), []);

    useEffect(() => {
      let disposed = false;
      let terminal: Terminal | undefined;
      let fitAddon: FitAddon | undefined;
      let terminalResizeObserver: ResizeObserver | undefined;
      const initialFitFrames = new Set<number>();
      const initialFitTimers = new Set<number>();

      const emitFittedSize = () => {
        if (disposed || terminalRef.current !== terminal || fitAddonRef.current !== fitAddon) return;
        const nextSize = fitTerminal(terminal, fitAddon);
        if (nextSize) onResize(nextSize.cols, nextSize.rows);
      };

      const scheduleInitialFit = (delayMs: number) => {
        if (delayMs <= 0) {
          const frame = window.requestAnimationFrame(() => {
            initialFitFrames.delete(frame);
            emitFittedSize();
          });
          initialFitFrames.add(frame);
          return;
        }

        const timer = window.setTimeout(() => {
          initialFitTimers.delete(timer);
          emitFittedSize();
        }, delayMs);
        initialFitTimers.add(timer);
      };

      const setup = async () => {
        const fontConfig = await loadTerminalFontConfig();
        if (disposed || !containerRef.current) return;

        terminal = new Terminal({
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

        const fittedSize = fitTerminal(terminal, fitAddon);
        if (fittedSize) onResize(fittedSize.cols, fittedSize.rows);
        terminalResizeObserver = new ResizeObserver(() => {
          emitFittedSize();
          scheduleInitialFit(0);
        });
        terminalResizeObserver.observe(containerRef.current);
        [0, 50, 150, 350, 750].forEach(scheduleInitialFit);

        const pendingWrites = pendingWritesRef.current;
        pendingWritesRef.current = [];
        for (const data of pendingWrites) {
          terminal.write(data);
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
        terminalResizeObserver?.disconnect();
        initialFitFrames.forEach(frame => window.cancelAnimationFrame(frame));
        initialFitTimers.forEach(timer => window.clearTimeout(timer));
        terminalRef.current = null;
        fitAddonRef.current = null;
        disposeSubscriptions?.();
        fitAddon?.dispose();
        terminal?.dispose();
      };
    }, [autoFocus, onError, onInput, onResize, onTitleChange]);

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

XtermTerminalView.displayName = 'XtermTerminalView';
