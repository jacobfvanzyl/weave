import type {
  TerminalClientMessage,
  TerminalHostEvent,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTransport,
} from './terminal-types';
import { getAuthHeaders, getMastraUrl } from './mastra-client';

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

export const isWebTerminalTransportAvailable = () =>
  typeof window !== 'undefined' && typeof window.WebSocket === 'function' && typeof window.fetch === 'function';

export const isTerminalTransportAvailable = () =>
  isDesktopTerminalTransportAvailable() || isWebTerminalTransportAvailable();

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

type TerminalTokenResponse = {
  token: string;
  wsUrl: string;
};

type PendingStart = {
  resolve: (value: TerminalStartResult) => void;
  reject: (error: Error) => void;
};

type WebTerminalConnection = {
  send: (message: TerminalClientMessage) => void;
  start: (input: TerminalStartInput) => Promise<TerminalStartResult>;
  closeSocket: () => void;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
};

const requestTerminalToken = async (input: TerminalStartInput) =>
  parseJson<TerminalTokenResponse>(
    await fetch(`${getMastraUrl()}/terminals/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(input),
    }),
  );

const createWebTerminalConnection = async (
  input: TerminalStartInput,
  emit: (event: TerminalHostEvent) => void,
  onClosed: () => void,
): Promise<WebTerminalConnection> => {
  const token = await requestTerminalToken(input);
  const url = new URL(token.wsUrl);
  url.searchParams.set('token', token.token);

  const socket = new WebSocket(url);
  let pendingStart: PendingStart | undefined;
  let accepted = false;

  const opened = new Promise<void>((resolve, reject) => {
    socket.onopen = () => undefined;
    socket.onerror = () => {
      reject(new Error('Terminal WebSocket connection failed.'));
    };
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as TerminalHostEvent | { type?: string };
      if (message.type === 'terminal.accepted') {
        accepted = true;
        resolve();
        return;
      }

      const terminalEvent = message as TerminalHostEvent;
      if (terminalEvent.type === 'started') {
        pendingStart?.resolve({ sessionId: terminalEvent.sessionId, cwd: terminalEvent.cwd });
        pendingStart = undefined;
      } else if (terminalEvent.type === 'error' && pendingStart && terminalEvent.terminalId === input.terminalId) {
        pendingStart.reject(new Error(terminalEvent.error));
        pendingStart = undefined;
      }
      emit(terminalEvent);
    };
    socket.onclose = () => {
      if (!accepted) reject(new Error('Terminal WebSocket closed before it was accepted.'));
      pendingStart?.reject(new Error('Terminal WebSocket closed.'));
      pendingStart = undefined;
      onClosed();
    };
  });

  await opened;

  const send = (message: TerminalClientMessage) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Terminal WebSocket is not open.');
    socket.send(JSON.stringify(message));
  };

  return {
    send,
    start: nextInput => new Promise<TerminalStartResult>((resolve, reject) => {
      pendingStart = { resolve, reject };
      send({ type: 'start', ...nextInput });
    }),
    closeSocket: () => socket.close(),
  };
};

export const createWebTerminalTransport = (): TerminalTransport | undefined => {
  if (!isWebTerminalTransportAvailable()) return undefined;

  const listeners = new Set<(event: TerminalHostEvent) => void>();
  const connections = new Map<string, WebTerminalConnection>();
  const emit = (event: TerminalHostEvent) => {
    for (const listener of listeners) listener(event);
  };

  const getConnection = async (input: TerminalStartInput) => {
    const existing = connections.get(input.terminalId);
    if (existing) return existing;

    const connection = await createWebTerminalConnection(input, emit, () => {
      connections.delete(input.terminalId);
    });
    connections.set(input.terminalId, connection);
    return connection;
  };

  const sendToTerminal = async (terminalId: string, message: TerminalClientMessage) => {
    const connection = connections.get(terminalId);
    if (!connection) return;
    connection.send(message);
  };

  return {
    start: async input => {
      const connection = await getConnection(input);
      return connection.start(input);
    },
    input: (terminalId, data) => sendToTerminal(terminalId, { type: 'input', terminalId, data }),
    resize: (terminalId, cols, rows) => sendToTerminal(terminalId, { type: 'resize', terminalId, cols, rows }),
    close: async terminalId => {
      await sendToTerminal(terminalId, { type: 'close', terminalId });
      connections.get(terminalId)?.closeSocket();
      connections.delete(terminalId);
    },
    detach: async terminalId => {
      await sendToTerminal(terminalId, { type: 'detach', terminalId });
      connections.get(terminalId)?.closeSocket();
      connections.delete(terminalId);
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export const createTerminalTransport = (): TerminalTransport | undefined =>
  createDesktopTerminalTransport() ?? createWebTerminalTransport();
