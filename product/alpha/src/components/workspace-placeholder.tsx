import type { AlphaController } from '@/app/alpha-controller';
import { selectedThread } from '@/app/alpha-controller';
import { CodexIcon } from '@/components/codex-icon';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { ChatPane } from '@/chat/chat-pane';

export function WorkspacePlaceholder({ controller }: { controller: AlphaController }) {
  const { model, actions } = controller;
  const thread = selectedThread(model);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-title-bar px-2">
        <SidebarTrigger />
        <div className="min-w-0">
          <p className="truncate text-xs font-medium">
            {thread?.title || 'Alpha'}
          </p>
          <p className="truncate text-[0.625rem] text-muted-foreground">
            {thread?.hostName || model.connection.hostName}
          </p>
        </div>
      </header>

      {thread && model.transcript
        ? <ChatPane model={model.transcript} actions={actions} />
        : <section className="relative flex min-h-0 flex-1 items-center justify-center p-6">
          <Empty className="max-w-sm">
            <EmptyHeader>
              <EmptyMedia variant="icon"><CodexIcon /></EmptyMedia>
              <EmptyTitle>Choose a thread</EmptyTitle>
              <EmptyDescription>
                Select a Portal-managed ACP thread to attach to it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>

        </section>}

      {(!thread || !model.transcript) && (
        <footer
          aria-hidden="true"
          className="h-[var(--bottom-rail-height)] shrink-0 border-t bg-status-bar"
        />
      )}

      {model.error && (
        <Alert variant="destructive" className="absolute bottom-10 right-4 z-50 max-w-sm">
          <AlertTitle>Portal error</AlertTitle>
          <AlertDescription>{model.error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
