import type { EditorTarget } from './editor-types';
import { onRpcConnectionState, onRpcNotification, rpcRequest } from './mastra-client';

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
  venvPath?: string;
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

const sessionInputs = new Map<string, CoppermindJupyterSessionInput>();

export const getCoppermindJupyterStatus = async (target: EditorTarget) =>
  await rpcRequest<CoppermindJupyterStatusResult>('jupyter.status', { target });

export const getCoppermindJupyterKernelspecs = async (target: EditorTarget) =>
  await rpcRequest<CoppermindJupyterKernelspecsResult>('jupyter.kernelspecs', { target });

export const createCoppermindJupyterSession = async (input: CoppermindJupyterSessionInput) => {
  const result = await rpcRequest<CoppermindJupyterSessionResult>('jupyter.session.create', input);
  sessionInputs.set(result.sessionId, input);
  return result;
};

export const createCoppermindJupyterRpcSession = (
  session: CoppermindJupyterSessionResult,
  onEvent: (event: CoppermindJupyterEvent) => void,
) => {
  let closed = false;
  const input = sessionInputs.get(session.sessionId);
  let activeSession = session;
  let recreateOnExecute = false;
  const pending = new Map<string, string>();
  const detach = onRpcNotification('jupyter.event', raw => {
    const envelope = raw && typeof raw === 'object'
      ? raw as { sessionId?: string; event?: CoppermindJupyterEvent }
      : undefined;
    if (envelope?.sessionId !== activeSession.sessionId || !envelope.event) return;
    if (envelope.event.type === 'complete' || envelope.event.type === 'error') {
      if (envelope.event.requestId) pending.delete(envelope.event.requestId);
    }
    onEvent(envelope.event);
  });
  const detachState = onRpcConnectionState(state => {
    if (state === 'connected' || closed) return;
    recreateOnExecute = true;
    for (const [requestId, cellId] of pending) {
      onEvent({
        type: 'complete',
        sessionId: activeSession.sessionId,
        requestId,
        cellId,
        status: 'interrupted',
      });
    }
    pending.clear();
  });
  return {
    ready: Promise.resolve(),
    isOpen: () => !closed,
    execute: (request: { requestId: string; cellId: string; code: string }) => {
      if (closed || !input) return false;
      pending.set(request.requestId, request.cellId);
      void (async () => {
        if (recreateOnExecute) {
          activeSession = await createCoppermindJupyterSession(input);
          recreateOnExecute = false;
        }
        await rpcRequest('jupyter.session.execute', {
          ...input,
          sessionId: activeSession.sessionId,
          requestId: request.requestId,
          cellId: request.cellId,
          code: request.code,
          allowStdin: false,
          silent: false,
          storeHistory: true,
        });
      })().catch(error => {
        pending.delete(request.requestId);
        onEvent({
          type: 'error',
          sessionId: activeSession.sessionId,
          requestId: request.requestId,
          cellId: request.cellId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return true;
    },
    close: () => {
      if (closed) return;
      closed = true;
      detach();
      detachState();
      sessionInputs.delete(activeSession.sessionId);
      if (input) void rpcRequest('jupyter.session.close', { ...input, sessionId: activeSession.sessionId }).catch(() => undefined);
    },
  };
};
