import { usePaneFocusTarget, agentFocusId } from '@/app/pane-focus';
import { PathLabel } from "./path-label";
import type { ReactNode } from "react";
import type { AlphaController } from "@/app/alpha-controller";
import { selectedThread } from "@/app/alpha-controller";
import { CodexIcon } from "@/components/codex-icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { ChatPane } from "@/chat/chat-pane";
import { isCapacitorPlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";

export function WorkspacePlaceholder({
  controller,
  className,
  footerActions,
  headerActions,
  showFooter = true,
  inputFocusRequest,
  preserveDraft = false,
}: {
  controller: AlphaController;
  className?: string;
  footerActions?: ReactNode;
  headerActions?: ReactNode;
  showFooter?: boolean;
  preserveDraft?: boolean;
  inputFocusRequest?: number | null;
}) {
  const { model, actions } = controller;
  const thread = selectedThread(model);
  const focusTarget = usePaneFocusTarget();
  const reconnecting = Boolean(
    thread && model.connections.some(
      ({ hostId, status }) =>
        hostId === thread.hostId && status !== "connected",
    ),
  );
  const context = model.executionContexts.find((workspace) => workspace.hostId === thread?.hostId && workspace.executionContextId === thread.executionContextId);
  const shouldFocusComposer = !isCapacitorPlatform(model.platform) ||
    model.composerFocusThreadId === thread?.id;

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col bg-background",
        className,
      )}
      data-slot="thread-pane"
      data-agent-input-focused={Boolean(thread && focusTarget === agentFocusId(thread.id)) || undefined}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-slot="thread-pane-contents">
        <header
          className="flex h-[var(--rail-height)] shrink-0 items-center gap-1 border-b bg-sidebar-selected px-2 text-foreground"
          data-slot="thread-top-rail"
        >
          {thread && (
            reconnecting
              ? (
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2" aria-label="Reconnecting Host">
                  <Skeleton className="h-3 w-28" />
                  {model.showHostIdentity && <Skeleton className="h-2.5 w-16" />}
                </div>
              )
              : (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <p className="min-w-0 max-w-1/2 shrink-0 truncate text-xs font-medium">
                    {thread.title || "Weave"}
                  </p>
                  {(model.showHostIdentity || model.workspaceCompositions) && (
                    <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                      <span aria-hidden="true">·</span>
                      {model.showHostIdentity && <span className="max-w-24 truncate">{thread.hostName || model.connection.hostName}</span>}{model.workspaceCompositions && <>{model.showHostIdentity && " · "}<PathLabel className="text-left" path={context?.canonicalPath ?? context?.name ?? thread.executionContextId} /></>}
                    </div>
                  )}
                </div>
              )
          )}
          {headerActions && <div className="ml-auto flex shrink-0 items-center gap-1">{headerActions}</div>}
        </header>

        {reconnecting
          ? (
            <section
              className="flex min-h-0 flex-1 flex-col justify-between gap-8 p-5"
              data-slot="reconnecting-thread-pane"
              aria-label="Reconnecting thread"
              aria-busy="true"
            >
              <div className="space-y-3 pt-5">
                <Skeleton className="h-3 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="ml-auto h-9 w-1/3 rounded-lg" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-24 w-full rounded-lg" />
            </section>
          )
          : model.loadingThreadId
          ? (
            <section
              className="relative flex min-h-0 flex-1 items-center justify-center p-6"
              data-slot="thread-loading"
            >
              <Spinner
                className="size-5 text-primary"
                aria-label="Loading thread"
              />
            </section>
          )
          : thread
          ? model.transcript
            ? (
              <ChatPane
                model={model.transcript}
                actions={actions}
                focusRequest={inputFocusRequest !== undefined ? inputFocusRequest ?? undefined : shouldFocusComposer
                  ? model.composerFocusRequest
                  : undefined}
                discardDraftOnUnmount={thread.draft && !preserveDraft}
              />
            )
            : (
              <section
                className="relative flex min-h-0 flex-1 items-center justify-center p-6"
                data-slot="thread-content"
              >
                <Empty className="max-w-sm">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <CodexIcon />
                    </EmptyMedia>
                    <EmptyTitle>Choose a thread</EmptyTitle>
                    <EmptyDescription>
                      Select a Portal-managed ACP thread to attach to it.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </section>
            )
          : <section className="min-h-0 flex-1" data-slot="thread-content" />}

        {showFooter && (
          <footer
            className="flex h-[var(--bottom-rail-height)] shrink-0 items-center border-t bg-status-bar px-1"
            data-slot="main-bottom-rail"
          >
            {footerActions && (
              <div className="ml-auto">
                {footerActions}
              </div>
            )}
          </footer>
        )}

        {model.error && (
          <Alert
            variant="destructive"
            className="absolute inset-x-3 top-14 z-50 w-auto sm:left-auto sm:right-4 sm:w-full sm:max-w-sm"
          >
            <AlertTitle>Couldn’t complete that action</AlertTitle>
            <AlertDescription>{model.error}</AlertDescription>
          </Alert>
        )}
      </div>
    </div>
  );
}
