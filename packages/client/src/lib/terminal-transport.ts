import type {
  TerminalClientMessage,
  TerminalHostEvent,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTargetInput,
  TerminalTransport,
  TerminalWindowRecord,
} from './terminal-types';
import { getAuthHeaders, getMastraUrl } from './mastra-client';

type DesktopTerminalBridge = {
  terminalSnapshot: () => Promise<TerminalWindowRecord[]>;
  terminalList: (input: TerminalTargetInput) => Promise<TerminalWindowRecord[]>;
  terminalCreate: (input: TerminalTargetInput) => Promise<TerminalWindowRecord>;
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
    || typeof bridge.terminalSnapshot !== 'function'
    || typeof bridge.terminalList !== 'function'
    || typeof bridge.terminalCreate !== 'function'
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
    snapshot: () => bridge.terminalSnapshot(),
    list: input => bridge.terminalList(input),
    create: input => bridge.terminalCreate(input),
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

type PendingTerminalRequest = {
  resolve: (value: TerminalWindowRecord[] | TerminalWindowRecord) => void;
  reject: (error: Error) => void;
};

type WebTerminalConnection = {
  send: (message: TerminalClientMessage) => void;
  list: (input: TerminalTargetInput) => Promise<TerminalWindowRecord[]>;
  create: (input: TerminalTargetInput) => Promise<TerminalWindowRecord>;
  start: (input: TerminalStartInput) => Promise<TerminalStartResult>;
  closeSocket: () => void;
};

let terminalRequestCounter = 0;

const nextTerminalRequestId = () => {
  terminalRequestCounter += 1;
  return `terminal-${terminalRequestCounter.toString(36)}`;
};

const parseJson = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
};

const requestTerminalToken = async (input: TerminalTargetInput) =>
  parseJson<TerminalTokenResponse>(
    await fetch(`${getMastraUrl()}/terminals/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify(input),
    }),
  );

const createWebTerminalConnection = async (
  input: TerminalTargetInput,
  emit: (event: TerminalHostEvent) => void,
  onClosed: () => void,
): Promise<WebTerminalConnection> => {
  const token = await requestTerminalToken(input);
  const url = new URL(token.wsUrl);
  url.searchParams.set('token', token.token);

  const socket = new WebSocket(url);
  let pendingStart: PendingStart | undefined;
  const pendingRequests = new Map<string, PendingTerminalRequest>();
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
      if (terminalEvent.type === 'windows' && terminalEvent.requestId) {
        pendingRequests.get(terminalEvent.requestId)?.resolve(terminalEvent.windows);
        pendingRequests.delete(terminalEvent.requestId);
        return;
      }

      if (terminalEvent.type === 'created' && terminalEvent.requestId) {
        pendingRequests.get(terminalEvent.requestId)?.resolve(terminalEvent.window);
        pendingRequests.delete(terminalEvent.requestId);
        return;
      }

      if (terminalEvent.type === 'error' && terminalEvent.requestId) {
        pendingRequests.get(terminalEvent.requestId)?.reject(new Error(terminalEvent.error));
        pendingRequests.delete(terminalEvent.requestId);
        return;
      }

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
      for (const pending of pendingRequests.values()) pending.reject(new Error('Terminal WebSocket closed.'));
      pendingRequests.clear();
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
    list: nextInput => new Promise<TerminalWindowRecord[]>((resolve, reject) => {
      const requestId = nextTerminalRequestId();
      pendingRequests.set(requestId, {
        resolve: value => resolve(value as TerminalWindowRecord[]),
        reject,
      });
      send({ type: 'list', requestId, ...nextInput });
    }),
    create: nextInput => new Promise<TerminalWindowRecord>((resolve, reject) => {
      const requestId = nextTerminalRequestId();
      pendingRequests.set(requestId, {
        resolve: value => resolve(value as TerminalWindowRecord),
        reject,
      });
      send({ type: 'create', requestId, ...nextInput });
    }),
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

  const getTargetConnectionKey = (input: TerminalTargetInput) => [
    input.kind,
    input.portalId ?? '',
    input.rootId ?? '',
    input.projectId ?? '',
    input.workspaceId ?? '',
    input.workspacePath ?? '',
    input.cwd ?? '',
  ].join(':');

  const getConnection = async (input: TerminalTargetInput, connectionKey: string) => {
    const existing = connections.get(connectionKey);
    if (existing) return existing;

    const connection = await createWebTerminalConnection(input, emit, () => {
      connections.delete(connectionKey);
    });
    connections.set(connectionKey, connection);
    return connection;
  };

  const sendToTerminal = async (terminalId: string, message: TerminalClientMessage) => {
    const connection = connections.get(terminalId);
    if (!connection) return;
    connection.send(message);
  };

  return {
    snapshot: async input => {
      if (!input) return [];
      const connection = await getConnection(input, getTargetConnectionKey(input));
      return connection.list(input);
    },
    list: async input => {
      const connection = await getConnection(input, getTargetConnectionKey(input));
      return connection.list(input);
    },
    create: async input => {
      const connection = await getConnection(input, getTargetConnectionKey(input));
      return connection.create(input);
    },
    start: async input => {
      const connection = await getConnection(input, input.terminalId);
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
