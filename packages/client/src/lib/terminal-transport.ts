import { onRpcConnectionState, onRpcNotification, rpcRequest } from './mastra-client';
import type {
  TerminalHostEvent,
  TerminalStartInput,
  TerminalStartResult,
  TerminalTargetInput,
  TerminalTransport,
  TerminalWindowRecord,
} from './terminal-types';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const targetKey = (input: TerminalTargetInput) => [
  input.kind,
  input.portalId ?? '',
  input.rootId ?? '',
  input.projectId ?? '',
  input.workspaceId ?? '',
  input.workspacePath ?? '',
  input.cwd ?? '',
].join(':');

let requestCounter = 0;
const nextRequestId = () => `terminal_${++requestCounter}`;

export const isDesktopTerminalTransportAvailable = () => false;
export const isWebTerminalTransportAvailable = () => true;
export const isTerminalTransportAvailable = () => true;
export const createDesktopTerminalTransport = (): TerminalTransport | undefined => undefined;

export const createWebTerminalTransport = (): TerminalTransport => {
  const listeners = new Set<(event: TerminalHostEvent) => void>();
  const pending = new Map<string, PendingRequest>();
  const terminalTargets = new Map<string, TerminalStartInput>();

  const detachNotification = onRpcNotification('terminal.event', raw => {
    const envelope = raw && typeof raw === 'object' ? raw as { event?: TerminalHostEvent } : undefined;
    const event = envelope?.event;
    if (!event) return;
    const requestId = 'requestId' in event ? event.requestId : undefined;
    if (event.type === 'windows' && requestId) {
      pending.get(requestId)?.resolve(event.windows);
      pending.delete(requestId);
    } else if (event.type === 'created' && requestId) {
      pending.get(requestId)?.resolve(event.window);
      pending.delete(requestId);
    } else if (event.type === 'started') {
      pending.get(`start:${event.terminalId}`)?.resolve({ sessionId: event.sessionId, cwd: event.cwd });
      pending.delete(`start:${event.terminalId}`);
    } else if (event.type === 'error') {
      const key = requestId ? requestId : `start:${event.terminalId}`;
      pending.get(key)?.reject(new Error(event.error));
      pending.delete(key);
    }
    for (const listener of listeners) listener(event);
  });

  const detachConnection = onRpcConnectionState(state => {
    if (state !== 'connected') return;
    for (const input of terminalTargets.values()) {
      void rpcRequest('terminal.attach', { ...input, sessionId: input.terminalId }).catch(() => undefined);
    }
  });

  const requestEvent = <T>(key: string, call: () => Promise<unknown>) =>
    new Promise<T>((resolve, reject) => {
      pending.set(key, { resolve: value => resolve(value as T), reject });
      void call().catch(error => {
        pending.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

  const list = (input: TerminalTargetInput) => {
    const requestId = nextRequestId();
    return requestEvent<TerminalWindowRecord[]>(requestId, () => rpcRequest('terminal.list', {
      ...input,
      sessionId: `target:${targetKey(input)}`,
      requestId,
    }));
  };

  return {
    snapshot: input => input ? list(input) : Promise.resolve([]),
    list,
    create: input => {
      const requestId = nextRequestId();
      return requestEvent<TerminalWindowRecord>(requestId, () => rpcRequest('terminal.create', {
        ...input,
        sessionId: `target:${targetKey(input)}`,
        requestId,
      }));
    },
    start: input => {
      terminalTargets.set(input.terminalId, input);
      return requestEvent<TerminalStartResult>(`start:${input.terminalId}`, () =>
        rpcRequest('terminal.attach', { ...input, sessionId: input.terminalId })
      );
    },
    input: async (terminalId, data) => {
      const target = terminalTargets.get(terminalId);
      if (!target) return;
      await rpcRequest('terminal.input', { ...target, sessionId: terminalId, terminalId, data });
    },
    resize: async (terminalId, cols, rows) => {
      const target = terminalTargets.get(terminalId);
      if (!target) return;
      await rpcRequest('terminal.resize', { ...target, sessionId: terminalId, terminalId, cols, rows });
    },
    close: async (terminalId, input) => {
      const target = terminalTargets.get(terminalId) ?? input;
      if (!target) return;
      await rpcRequest('terminal.close', { ...target, sessionId: terminalId, terminalId });
      terminalTargets.delete(terminalId);
    },
    detach: async terminalId => {
      const target = terminalTargets.get(terminalId);
      if (!target) return;
      await rpcRequest('terminal.detach', { ...target, sessionId: terminalId, terminalId });
      terminalTargets.delete(terminalId);
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && terminalTargets.size === 0) {
          detachNotification();
          detachConnection();
        }
      };
    },
  };
};

export const createTerminalTransport = (): TerminalTransport => createWebTerminalTransport();
