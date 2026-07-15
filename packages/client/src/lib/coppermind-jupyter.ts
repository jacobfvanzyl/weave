import type { EditorTarget } from './editor-types';
import type {
  JupyterHostEvent,
  JupyterKernelspecsResult,
  JupyterKernelSpec,
  JupyterOutput,
  JupyterSessionResult,
  JupyterStatusResult,
  RpcRequestParams,
} from '@weave/protocol';
import { onRpcConnectionState, onRpcNotification, rpcRequest } from './mastra-client';

export type CoppermindJupyterSessionInput = RpcRequestParams<'client', 'server', 'jupyter.session.create'>;
export type CoppermindJupyterStatusResult = JupyterStatusResult;
export type CoppermindJupyterKernelSpec = JupyterKernelSpec;
export type CoppermindJupyterKernelspecsResult = JupyterKernelspecsResult;
export type CoppermindJupyterSessionResult = JupyterSessionResult;
export type CoppermindJupyterOutput = JupyterOutput;
export type CoppermindJupyterEvent = JupyterHostEvent;

const sessionInputs = new Map<string, CoppermindJupyterSessionInput>();

export const getCoppermindJupyterStatus = async (target: EditorTarget) =>
  await rpcRequest('jupyter.status', { target });

export const getCoppermindJupyterKernelspecs = async (target: EditorTarget) =>
  await rpcRequest('jupyter.kernelspecs', { target });

export const createCoppermindJupyterSession = async (input: CoppermindJupyterSessionInput) => {
  const result = await rpcRequest('jupyter.session.create', input);
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
    const envelope = raw;
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
