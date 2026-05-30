import type {
  TerminalHostEvent,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTransport,
} from './terminal-types';

type DesktopTerminalBridge = {
  terminalStart: (input: TerminalStartInput) => Promise<TerminalStartResult>;
  terminalInput: (demiplaneId: string, data: string) => Promise<void>;
  terminalResize: (demiplaneId: string, cols: number, rows: number) => Promise<void>;
  terminalClose: (demiplaneId: string) => Promise<void>;
  terminalDetach: (demiplaneId: string) => Promise<void>;
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
    input: (demiplaneId, data) => bridge.terminalInput(demiplaneId, data),
    resize: (demiplaneId, cols, rows) => bridge.terminalResize(demiplaneId, cols, rows),
    close: demiplaneId => bridge.terminalClose(demiplaneId),
    detach: demiplaneId => bridge.terminalDetach(demiplaneId),
    subscribe: listener => bridge.onTerminalEvent(listener),
  };
};
