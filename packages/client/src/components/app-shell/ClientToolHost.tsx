import { useEffect, useMemo, useRef } from 'react';
import { createClientId } from '../../lib/client-id';
import { getAuthHeaders } from '../../lib/mastra-client';
import { weaveRoutes } from '../../lib/weave-routes';
import { collectLiveEditorContext, type LiveEditorContextRequest } from '../../stores/live-editor-context-store';

type ClientToolHostProps = {
  active?: boolean;
  projectId?: string;
  resourceId?: string;
  threadId?: string;
  workspaceId?: string;
};

type ClientToolTokenResponse = {
  token: string;
  wsUrl: string;
};

type ClientToolHostMetadata = {
  active: boolean;
  projectId?: string;
  threadId?: string;
  workspaceId?: string;
};

type ClientToolCallMessage = {
  args?: unknown;
  id?: unknown;
  tool?: unknown;
  type?: unknown;
};

const clientToolCapabilities = ['editor.context'];
const heartbeatMs = 20_000;
const reconnectMs = 2_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const requestClientToolToken = async (clientId: string): Promise<ClientToolTokenResponse> => {
  const response = await fetch(weaveRoutes.editorContext.clientToken(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ clientId }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) as Partial<ClientToolTokenResponse> & { error?: string } : undefined;
  if (!response.ok) throw new Error(parsed?.error || text || `Client tool token request failed: HTTP ${response.status}`);
  if (!parsed?.token || !parsed.wsUrl) throw new Error('Client tool token response was incomplete.');
  return { token: parsed.token, wsUrl: parsed.wsUrl };
};

const buildClientHello = (metadata: ClientToolHostMetadata) => ({
  type: 'client.hello',
  name: 'Weave Client',
  version: '1',
  capabilities: clientToolCapabilities,
  ...metadata,
});

const buildClientUpdate = (metadata: ClientToolHostMetadata) => ({
  type: 'client.update',
  capabilities: clientToolCapabilities,
  ...metadata,
});

const normalizeRequest = (args: unknown): LiveEditorContextRequest => {
  const record = isRecord(args) ? args : {};
  return {
    mode: record.mode === 'code' || record.mode === 'notes' ? record.mode : undefined,
    projectId: typeof record.projectId === 'string' ? record.projectId : undefined,
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : undefined,
  };
};

const handleToolCall = async (message: ClientToolCallMessage) => {
  if (message.tool !== 'editor.context') {
    return {
      ok: false,
      reason: 'unsupported_tool',
      error: `Unsupported client tool: ${String(message.tool)}`,
    };
  }

  const context = collectLiveEditorContext(normalizeRequest(message.args));
  if (!context) {
    return {
      ok: false,
      reason: 'no_context',
      error: 'No live editor context is available for the requested Workspace.',
    };
  }

  return { ok: true, context };
};

export const ClientToolHost = ({
  active = true,
  projectId,
  resourceId,
  threadId,
  workspaceId,
}: ClientToolHostProps) => {
  const clientIdRef = useRef(createClientId('client'));
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const metadata = useMemo<ClientToolHostMetadata>(() => ({
    active,
    projectId,
    threadId,
    workspaceId,
  }), [active, projectId, threadId, workspaceId]);
  const metadataRef = useRef(metadata);

  useEffect(() => {
    metadataRef.current = metadata;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(buildClientUpdate(metadata)));
    }
  }, [metadata]);

  useEffect(() => {
    if (!resourceId || typeof window === 'undefined' || typeof WebSocket === 'undefined') return undefined;

    let disposed = false;
    let reconnectTimer: number | undefined;
    let heartbeatTimer: number | undefined;

    const clearTimers = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      if (heartbeatTimer !== undefined) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) return;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, reconnectMs);
    };

    const connect = async () => {
      try {
        const token = await requestClientToolToken(clientIdRef.current);
        if (disposed) return;

        const url = new URL(token.wsUrl, window.location.href);
        url.searchParams.set('token', token.token);
        url.searchParams.set('clientId', clientIdRef.current);

        const socket = new WebSocket(url);
        socketRef.current = socket;

        socket.onopen = () => {
          socket.send(JSON.stringify(buildClientHello(metadataRef.current)));
          heartbeatTimer = window.setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'client.pong' }));
          }, heartbeatMs);
        };

        socket.onmessage = event => {
          const message = JSON.parse(String(event.data)) as ClientToolCallMessage;
          if (message.type !== 'tool.call' || typeof message.id !== 'string') return;

          void handleToolCall(message)
            .then(result => {
              if (socket.readyState !== WebSocket.OPEN) return;
              socket.send(JSON.stringify({
                id: message.id,
                type: 'tool.result',
                ...result,
              }));
            })
            .catch(error => {
              if (socket.readyState !== WebSocket.OPEN) return;
              socket.send(JSON.stringify({
                id: message.id,
                type: 'tool.result',
                ok: false,
                reason: 'handler_error',
                error: error instanceof Error ? error.message : String(error),
              }));
            });
        };

        socket.onclose = () => {
          if (socketRef.current === socket) socketRef.current = undefined;
          if (heartbeatTimer !== undefined) {
            window.clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
          scheduleReconnect();
        };

        socket.onerror = () => {
          socket.close();
        };
      } catch (error) {
        console.info(`Client tool host unavailable: ${error instanceof Error ? error.message : String(error)}`);
        scheduleReconnect();
      }
    };

    void connect();

    return () => {
      disposed = true;
      clearTimers();
      socketRef.current?.close();
      socketRef.current = undefined;
    };
  }, [resourceId]);

  return null;
};
