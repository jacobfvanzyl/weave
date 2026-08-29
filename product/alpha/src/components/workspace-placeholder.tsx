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
  showFooter = true,
}: {
  controller: AlphaController;
  className?: string;
  footerActions?: ReactNode;
  showFooter?: boolean;
}) {
  const { model, actions } = controller;
  const thread = selectedThread(model);
  const reconnecting = Boolean(
    thread && model.connections.some(
      ({ hostId, status }) =>
        hostId === thread.hostId && status === "reconnecting",
    ),
  );
  const shouldFocusComposer = !isCapacitorPlatform(model.platform) ||
    model.composerFocusThreadId === thread?.id;

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col bg-background",
        className,
      )}
      data-slot="thread-pane"
    >
      <header
        className="flex h-11 shrink-0 items-center gap-2 border-b bg-title-bar px-2"
        data-slot="thread-top-rail"
      >
        {thread && (
          reconnecting
            ? (
              <div className="flex min-w-0 flex-col gap-1" aria-label="Reconnecting Host">
                <Skeleton className="h-3 w-28" />
                {model.showHostIdentity && <Skeleton className="h-2.5 w-16" />}
              </div>
            )
            : (
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">
                  {thread.title || "Weave"}
                </p>
                {model.showHostIdentity && (
                  <p className="truncate text-[0.625rem] text-muted-foreground">
                    {thread.hostName || model.connection.hostName}
                  </p>
                )}
              </div>
            )
        )}
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
              focusRequest={shouldFocusComposer
                ? model.composerFocusRequest
                : undefined}
              discardDraftOnUnmount={thread.draft}
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
  );
}
