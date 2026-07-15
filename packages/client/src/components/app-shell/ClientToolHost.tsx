import { useEffect, useMemo } from "react";
import { registerRpcHandler, rpcRequest } from "../../lib/mastra-client";
import { collectLiveEditorContext } from "../../stores/live-editor-context-store";

type ClientToolHostProps = {
  active?: boolean;
  projectId?: string;
  resourceId?: string;
  threadId?: string;
  workspaceId?: string;
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
    capabilities: ["client.editorContext.get"],
    projectId,
    surfaceId: resourceId,
    threadId,
    workspaceId,
  }), [active, projectId, resourceId, threadId, workspaceId]);

  useEffect(() => {
    if (!resourceId) return;
    void rpcRequest("client.surface.update", metadata).catch((error) => {
      console.info(
        `Client surface update unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, [metadata, resourceId]);

  useEffect(() =>
    registerRpcHandler("client.editorContext.get", (args) => {
      const context = collectLiveEditorContext(args);
      if (!context) {
        return {
          ok: false,
          reason: "no_context",
          error:
            "No live editor context is available for the requested Workspace.",
        } as const;
      }
      return { ok: true, context } as const;
    }), []);

  return null;
};
