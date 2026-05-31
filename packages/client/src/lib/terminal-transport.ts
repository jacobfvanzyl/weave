import type {
  TerminalHostEvent,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTransport,
} from './terminal-types';

type DesktopTerminalBridge = {
  terminalStart: (input: TerminalStartInput) => Promise<TerminalStartResult>;
  terminalInput: (terminalId: string, data: string) => Promise<void>;
  terminalResize: (terminalId: string, cols: number, rows: number) => Promise<void>;
  terminalClose: (terminalId: string) => Promise<void>;
  terminalDetach: (terminalId: string) => Promise<void>;
  onTerminalEvent: (listener: (event: TerminalHostEvent) => void) => () => void;
};

type WindowWithDesktopTerminal = Window & {
  weaveDesktop?: Partial<DesktopTerminalBridge>;
};

const getDesktopBridge = () => {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as WindowWithDesktopTerminal).weaveDesktop;
  if (
    typeof bridge?.terminalStart !== 'function'
    || typeof bridge.terminalInput !== 'function'
    || typeof bridge.terminalResize !== 'function'
    || typeof bridge.terminalClose !== 'function'
    || typeof bridge.terminalDetach !== 'function'
    || typeof bridge.onTerminalEvent !== 'function'
  ) {
    return undefined;
  }

  return bridge as DesktopTerminalBridge;
};

export const isDesktopTerminalTransportAvailable = () => Boolean(getDesktopBridge());

export const createDesktopTerminalTransport = (): TerminalTransport | undefined => {
  const bridge = getDesktopBridge();
  if (!bridge) return undefined;

  return {
    start: input => bridge.terminalStart(input),
    input: (terminalId, data) => bridge.terminalInput(terminalId, data),
    resize: (terminalId, cols, rows) => bridge.terminalResize(terminalId, cols, rows),
    close: terminalId => bridge.terminalClose(terminalId),
    detach: terminalId => bridge.terminalDetach(terminalId),
    subscribe: listener => bridge.onTerminalEvent(listener),
  };
};
