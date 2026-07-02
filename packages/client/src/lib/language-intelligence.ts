import type { Transport } from '@codemirror/lsp-client';
import type { EditorTarget } from './editor-types';
import { detectLanguagePackLspId } from './language-packs/core';
import { getAuthHeaders } from './mastra-client';
import { weaveRoutes } from './weave-routes';

export type LspSessionStatus = 'ready' | 'missing' | 'disabled' | 'unsupported' | 'error';

export type LspSessionInput = {
  target: EditorTarget;
  path: string;
  languageId?: string;
  serverId?: string;
};

export type LspSessionResult = {
  ok: true;
  sessionId: string;
  status: LspSessionStatus;
  serverId?: string;
  languageId?: string;
  documentUri?: string;
  rootUri?: string;
  rootPath?: string;
  command?: string;
  args?: string[];
  capabilities?: unknown;
  error?: string;
  token?: string;
  portalId?: string;
  wsUrl: string;
};

type DesktopLspBridge = {
  lspCreateSession: (target: EditorTarget, path: string, languageId?: string, serverId?: string) => Promise<LspSessionResult>;
};

type WindowWithDesktopLsp = Window & {
  weaveDesktop?: Partial<DesktopLspBridge>;
};

type LspEventEnvelope = {
  type: 'lsp.event';
  clientId?: string;
  event?: {
    type?: string;
    sessionId?: string;
    status?: LspSessionStatus;
    message?: string;
    error?: string;
  };
};

export const detectEditorLanguageId = (path: string) =>
  detectLanguagePackLspId(path);

const getDesktopBridge = () => {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as WindowWithDesktopLsp).weaveDesktop;
  return typeof bridge?.lspCreateSession === 'function' ? bridge as DesktopLspBridge : undefined;
};

const requestWebLspSession = async (input: LspSessionInput) => {
  const response = await fetch(weaveRoutes.code.lspSession(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  const parsed = text
    ? (() => {
      try {
        return JSON.parse(text) as { error?: string } & LspSessionResult;
      } catch {
        return undefined;
      }
    })()
    : undefined;
  if (!response.ok) throw new Error(parsed?.error || text || `LSP session request failed: HTTP ${response.status}`);
  if (!parsed) throw new Error('LSP session response was empty.');
  return parsed;
};

export const createLspSession = async (input: LspSessionInput) => {
  const languageId = input.languageId ?? detectEditorLanguageId(input.path);
  if (!languageId) {
    return {
      ok: true,
      sessionId: '',
      status: 'unsupported',
      languageId,
      wsUrl: '',
      error: 'Unsupported file type.',
    } satisfies LspSessionResult;
  }

  const request = { ...input, languageId };
  const bridge = getDesktopBridge();
  return bridge
    ? await bridge.lspCreateSession(request.target, request.path, request.languageId, request.serverId)
    : await requestWebLspSession(request);
};

const sessionWsUrl = (session: LspSessionResult) => {
  const url = new URL(session.wsUrl, window.location.href);
  if (session.token && !url.searchParams.has('token')) url.searchParams.set('token', session.token);
  return url.toString();
};

const parseEnvelope = (data: unknown): LspEventEnvelope | undefined => {
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : undefined;
    return parsed && typeof parsed === 'object' ? parsed as LspEventEnvelope : undefined;
  } catch {
    return undefined;
  }
};

export const createLspWebSocketTransport = (session: LspSessionResult) => {
  const handlers = new Set<(message: string) => void>();
  const socket = new WebSocket(sessionWsUrl(session));
  let closed = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'start', sessionId: session.sessionId }));
  });

  socket.addEventListener('message', (event) => {
    const envelope = parseEnvelope(event.data);
    if (envelope?.type !== 'lsp.event') return;
    const lspEvent = envelope.event;
    if (!lspEvent) return;

    if (lspEvent.type === 'ready') {
      readyResolve?.();
      readyResolve = undefined;
      readyReject = undefined;
      return;
    }

    if (lspEvent.type === 'jsonrpc' && typeof lspEvent.message === 'string') {
      for (const handler of handlers) handler(lspEvent.message);
      return;
    }

    if (lspEvent.type === 'error') {
      const error = new Error(lspEvent.error || 'Language server connection failed.');
      readyReject?.(error);
      readyResolve = undefined;
      readyReject = undefined;
      console.warn(error.message);
    }
  });

  socket.addEventListener('error', () => {
    readyReject?.(new Error('Language server WebSocket failed.'));
    readyResolve = undefined;
    readyReject = undefined;
  });

  const transport: Transport = {
    send(message: string) {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ type: 'jsonrpc', sessionId: session.sessionId, message }));
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
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'detach', sessionId: session.sessionId }));
      }
      socket.close();
      handlers.clear();
    },
  };
};
