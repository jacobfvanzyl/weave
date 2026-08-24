import type { AlphaViewModel } from '@/app/alpha-controller';
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

export function WorkspacePlaceholder({ model }: { model: AlphaViewModel }) {
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

      <section className="relative flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty className="max-w-sm">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CodexIcon />
            </EmptyMedia>
            <EmptyTitle>
              {thread ? 'Conversation surface paused' : 'Choose a thread'}
            </EmptyTitle>
            <EmptyDescription>
              {thread
                ? 'The hand-rolled chat has been removed. The next slice will rebuild it with shadcn message and composer primitives.'
                : 'The new sidebar is live. Select a Portal-managed ACP thread to attach to it.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>

        {model.error && (
          <Alert variant="destructive" className="absolute bottom-4 right-4 max-w-sm">
            <AlertTitle>Portal error</AlertTitle>
            <AlertDescription>{model.error}</AlertDescription>
          </Alert>
        )}
      </section>

      <footer
        aria-hidden="true"
        className="h-[var(--bottom-rail-height)] shrink-0 border-t bg-status-bar"
      />
    </div>
  );
}
