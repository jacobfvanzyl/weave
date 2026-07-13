import { useEffect, useMemo } from 'react';
import { registerRpcHandler, rpcRequest } from '../../lib/mastra-client';
import { collectLiveEditorContext, type LiveEditorContextRequest } from '../../stores/live-editor-context-store';

type ClientToolHostProps = {
  active?: boolean;
  projectId?: string;
  resourceId?: string;
  threadId?: string;
  workspaceId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const normalizeRequest = (args: unknown): LiveEditorContextRequest => {
  const record = isRecord(args) ? args : {};
  return {
    mode: record.mode === 'code' || record.mode === 'notes' ? record.mode : undefined,
    projectId: typeof record.projectId === 'string' ? record.projectId : undefined,
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : undefined,
  };
};

export const ClientToolHost = ({
  active = true,
  projectId,
  resourceId,
  threadId,
  workspaceId,
}: ClientToolHostProps) => {
  const metadata = useMemo(() => ({
    active,
    capabilities: ['editor.context'],
    projectId,
    surfaceId: resourceId,
    threadId,
    workspaceId,
  }), [active, projectId, resourceId, threadId, workspaceId]);

  useEffect(() => {
    if (!resourceId) return;
    void rpcRequest('client.surface.update', metadata).catch(error => {
      console.info(`Client surface update unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, [metadata, resourceId]);

  useEffect(() => registerRpcHandler('client.editorContext.get', args => {
    const context = collectLiveEditorContext(normalizeRequest(args));
    if (!context) {
      return {
        ok: false,
        reason: 'no_context',
        error: 'No live editor context is available for the requested Workspace.',
      };
    }
    return { ok: true, context };
  }), []);

  return null;
};
