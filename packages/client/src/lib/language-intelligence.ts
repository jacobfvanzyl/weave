import type { Transport } from '@codemirror/lsp-client';
import type {
  LspSessionResult,
  RpcRequestParams,
} from '@weave/protocol';
import { detectLanguagePackLspId } from './language-packs/core';
import { onRpcConnectionState, onRpcNotification, rpcRequest } from './mastra-client';

export type LspSessionStatus = LspSessionResult['status'];
export type LspSessionInput = RpcRequestParams<'client', 'server', 'lsp.session.create'>;
export type { LspSessionResult } from '@weave/protocol';

const sessionInputs = new Map<string, LspSessionInput>();

export const detectEditorLanguageId = (path: string) => detectLanguagePackLspId(path);

export const createLspSession = async (input: LspSessionInput) => {
  const languageId = input.languageId ?? detectEditorLanguageId(input.path);
  if (!languageId) {
    return {
      ok: true,
      sessionId: '',
      status: 'unsupported',
      languageId,
      error: 'Unsupported file type.',
    } satisfies LspSessionResult;
  }
  const request = { ...input, languageId };
  const result = await rpcRequest('lsp.session.create', request);
  if (result.sessionId) sessionInputs.set(result.sessionId, request);
  return result;
};

export const createLspRpcTransport = (session: LspSessionResult) => {
  const handlers = new Set<(message: string) => void>();
  const input = sessionInputs.get(session.sessionId);
  let activeSession = session;
  const initializationMessages: string[] = [];
  let closed = false;
  let disconnected = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const detachNotification = onRpcNotification('lsp.event', raw => {
    const envelope = raw;
    if (envelope?.sessionId !== activeSession.sessionId || !envelope.event) return;
    const event = envelope.event;
    if (event.type === 'ready') {
      readyResolve?.();
      readyResolve = undefined;
      readyReject = undefined;
    } else if (event.type === 'jsonrpc') {
      for (const handler of handlers) handler(event.message);
    } else if (event.type === 'error') {
      const error = new Error(event.error);
      readyReject?.(error);
      readyResolve = undefined;
      readyReject = undefined;
      console.warn(error.message);
    }
  });

  const start = () => input
    ? rpcRequest('lsp.session.start', { ...input, sessionId: activeSession.sessionId })
    : Promise.reject(new Error('LSP session target is unavailable.'));
  void start().catch(error => readyReject?.(error instanceof Error ? error : new Error(String(error))));
  const detachState = onRpcConnectionState(state => {
    if (state !== 'connected') {
      disconnected = true;
      return;
    }
    if (!disconnected || closed || !input) return;
    disconnected = false;
    void createLspSession(input).then(async recreated => {
      activeSession = recreated;
      await start();
      for (const message of initializationMessages) {
        await rpcRequest('lsp.session.send', { ...input, sessionId: activeSession.sessionId, message });
      }
    }).catch(error => console.warn(error instanceof Error ? error.message : String(error)));
  });

  const transport: Transport = {
    send(message: string) {
      if (closed || !input) return;
      try {
        const parsed = JSON.parse(message) as { method?: unknown };
        if (
          parsed.method === 'initialize' || parsed.method === 'initialized' ||
          parsed.method === 'textDocument/didOpen'
        ) {
          const index = initializationMessages.findIndex(existing => {
            try {
              return (JSON.parse(existing) as { method?: unknown }).method === parsed.method;
            } catch {
              return false;
            }
          });
          if (index >= 0) initializationMessages[index] = message;
          else initializationMessages.push(message);
        }
      } catch {
        // Inner LSP messages are opaque to the transport unless they are valid JSON-RPC.
      }
      void rpcRequest('lsp.session.send', { ...input, sessionId: activeSession.sessionId, message }).catch(error => {
        console.warn(error instanceof Error ? error.message : String(error));
      });
    },
    subscribe(handler: (message: string) => void) {
      handlers.add(handler);
    },
    unsubscribe(handler: (message: string) => void) {
      handlers.delete(handler);
    },
  };

  return {
    transport,
    ready,
    close: () => {
      if (closed) return;
      closed = true;
      detachNotification();
      detachState();
      handlers.clear();
      sessionInputs.delete(activeSession.sessionId);
      if (input) void rpcRequest('lsp.session.close', { ...input, sessionId: activeSession.sessionId }).catch(() => undefined);
    },
  };
};
