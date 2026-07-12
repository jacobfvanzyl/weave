import type { EditorTarget } from './editor-types';
import { getAuthHeaders } from './mastra-client';
import { weaveRoutes } from './weave-routes';

export type CoppermindJupyterSessionInput = {
  target: EditorTarget;
  path: string;
  kernelName?: string;
  language?: string;
};

export type CoppermindJupyterStatusResult = {
  ok: true;
  available: boolean;
  status: 'ready' | 'missing' | 'error';
  command?: string;
  rootPath?: string;
  url?: string;
  uvAvailable?: boolean;
  uvCommand?: string;
  workspaceKernelName?: string;
  venvPath?: string;
  pythonPath?: string;
  error?: string;
};

export type CoppermindJupyterKernelSpec = {
  name: string;
  displayName: string;
  language?: string;
  argv?: string[];
};

export type CoppermindJupyterKernelspecsResult = {
  ok: true;
  available: boolean;
  defaultKernelName?: string;
  kernelspecs: CoppermindJupyterKernelSpec[];
  error?: string;
};

export type CoppermindJupyterSessionResult = {
  ok: true;
  available: boolean;
  sessionId: string;
  kernelId: string;
  kernelName: string;
  path: string;
  pythonPath?: string;
  portalId?: string;
  rootPath: string;
  token?: string;
  venvPath?: string;
  wsUrl: string;
};

export type CoppermindJupyterOutput =
  | { output_type: 'stream'; name: string; text: string }
  | {
    output_type: 'display_data';
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    transient?: Record<string, unknown>;
  }
  | {
    output_type: 'execute_result';
    execution_count?: number | null;
    data: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] };

export type CoppermindJupyterEvent =
  | { type: 'ready'; sessionId: string; kernelId: string; kernelName: string }
  | { type: 'status'; sessionId: string; requestId?: string; cellId?: string; executionState: string }
  | { type: 'execution_input'; sessionId: string; requestId?: string; cellId?: string; executionCount: number }
  | { type: 'output'; sessionId: string; requestId?: string; cellId?: string; output: CoppermindJupyterOutput }
  | { type: 'clear_output'; sessionId: string; requestId?: string; cellId?: string; wait: boolean }
  | {
    type: 'complete';
    sessionId: string;
    requestId?: string;
    cellId?: string;
    status: 'ok' | 'error' | 'interrupted';
    executionCount?: number | null;
  }
  | { type: 'error'; sessionId?: string; requestId?: string; cellId?: string; error: string };

type JupyterEventEnvelope = {
  type?: string;
  event?: CoppermindJupyterEvent;
};

const parseResponse = async <T>(response: Response, fallbackMessage: string): Promise<T> => {
  const text = await response.text();
  const parsed = text
    ? (() => {
      try {
        return JSON.parse(text) as { error?: string } & T;
      } catch {
        return undefined;
      }
    })()
    : undefined;
  if (!response.ok) throw new Error(parsed?.error || text || `${fallbackMessage}: HTTP ${response.status}`);
  if (!parsed) throw new Error(`${fallbackMessage}: empty response`);
  return parsed;
};

const postNotesJupyter = async <T>(
  url: string,
  body: Record<string, unknown>,
  fallbackMessage: string,
) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body),
  });
  return await parseResponse<T>(response, fallbackMessage);
};

export const getCoppermindJupyterStatus = async (target: EditorTarget) =>
  await postNotesJupyter<CoppermindJupyterStatusResult>(
    weaveRoutes.notes.jupyterStatus(),
    { target },
    'Jupyter status request failed',
  );

export const getCoppermindJupyterKernelspecs = async (target: EditorTarget) =>
  await postNotesJupyter<CoppermindJupyterKernelspecsResult>(
    weaveRoutes.notes.jupyterKernelspecs(),
    { target },
    'Jupyter kernelspec request failed',
  );

export const createCoppermindJupyterSession = async (input: CoppermindJupyterSessionInput) =>
  await postNotesJupyter<CoppermindJupyterSessionResult>(
    weaveRoutes.notes.jupyterSession(),
    {
      target: input.target,
      path: input.path,
      kernelName: input.kernelName,
      language: input.language,
    },
    'Jupyter session request failed',
  );

const jupyterWsUrl = (session: CoppermindJupyterSessionResult) => {
  const url = new URL(session.wsUrl, window.location.href);
  if (session.token && !url.searchParams.has('token')) url.searchParams.set('token', session.token);
  return url.toString();
};

const parseEnvelope = (data: unknown): JupyterEventEnvelope | undefined => {
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : undefined;
    return parsed && typeof parsed === 'object' ? parsed as JupyterEventEnvelope : undefined;
  } catch {
    return undefined;
  }
};

export const createCoppermindJupyterSocket = (
  session: CoppermindJupyterSessionResult,
  onEvent: (event: CoppermindJupyterEvent) => void,
) => {
  const socket = new WebSocket(jupyterWsUrl(session));
  let closed = false;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  socket.addEventListener('open', () => {
    readyResolve?.();
    readyResolve = undefined;
    readyReject = undefined;
  });

  socket.addEventListener('message', (event) => {
    const envelope = parseEnvelope(event.data);
    if (envelope?.type !== 'jupyter.event' || !envelope.event) return;
    onEvent(envelope.event);
  });

  socket.addEventListener('error', () => {
    readyReject?.(new Error('Jupyter WebSocket failed.'));
    readyResolve = undefined;
    readyReject = undefined;
  });

  socket.addEventListener('close', () => {
    closed = true;
    readyReject?.(new Error('Jupyter WebSocket closed before it became ready.'));
    readyResolve = undefined;
    readyReject = undefined;
  });

  const send = (message: Record<string, unknown>) => {
    if (closed || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };

  return {
    ready,
    isOpen: () => !closed && socket.readyState === WebSocket.OPEN,
    execute: (input: { requestId: string; cellId: string; code: string }) =>
      send({
        type: 'execute',
        requestId: input.requestId,
        cellId: input.cellId,
        code: input.code,
        allowStdin: false,
        silent: false,
        storeHistory: true,
      }),
    close: () => {
      if (closed) return;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'detach' }));
      }
      closed = true;
      socket.close();
    },
  };
};
