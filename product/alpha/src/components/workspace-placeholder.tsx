import { HugeiconsIcon } from '@hugeicons/react';
import { SidebarLeftIcon } from '@hugeicons/core-free-icons';
import type { AlphaController } from '@/app/alpha-controller';
import { selectedThread } from '@/app/alpha-controller';
import { CodexIcon } from '@/components/codex-icon';
import { ProjectPaneToggle } from '@/components/project-pane-toggle';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { useSidebar } from '@/components/ui/sidebar';
import { ChatPane } from '@/chat/chat-pane';
import { cn } from '@/lib/utils';

export function WorkspacePlaceholder({
  controller,
  onToggleThreads,
  className,
}: {
  controller: AlphaController;
  onToggleThreads(): void;
  className?: string;
}) {
  const { model, actions } = controller;
  const thread = selectedThread(model);
  const {
    isMobile,
    openMobile,
    state: projectPaneState,
    toggleSidebar: toggleProjectPane,
  } = useSidebar();
  const projectPaneVisible = Boolean(thread) && (isMobile ? openMobile : projectPaneState === 'expanded');

  return (
    <div
      className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col bg-background', className)}
      data-slot='thread-pane'
    >
      <header
        className='flex h-11 shrink-0 items-center gap-2 border-b bg-title-bar px-2'
        data-slot='thread-top-rail'
      >
        {thread && (
          <>
            <Button
              type='button'
              size='icon-sm'
              variant='ghost'
              aria-label='Toggle threads'
              onClick={onToggleThreads}
            >
              <HugeiconsIcon data-icon='inline-start' icon={SidebarLeftIcon} strokeWidth={2} />
            </Button>
            <div className='min-w-0'>
              <p className='truncate text-xs font-medium'>
                {thread.title || 'Weave'}
              </p>
              <p className='truncate text-[0.625rem] text-muted-foreground'>
                {thread.hostName || model.connection.hostName}
              </p>
            </div>
          </>
        )}
      </header>

      {thread
        ? model.transcript
          ? <ChatPane model={model.transcript} actions={actions} />
          : (
            <section
              className='relative flex min-h-0 flex-1 items-center justify-center p-6'
              data-slot='thread-content'
            >
              <Empty className='max-w-sm'>
                <EmptyHeader>
                  <EmptyMedia variant='icon'>
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
        : <section className='min-h-0 flex-1' data-slot='thread-content' />}

      <footer
        className='flex h-[var(--bottom-rail-height)] shrink-0 items-center border-t bg-status-bar px-1'
        data-slot='main-bottom-rail'
      >
        {!projectPaneVisible && (
          <div className='ml-auto'>
            <ProjectPaneToggle action='Show' disabled={!thread} onClick={toggleProjectPane} />
          </div>
        )}
      </footer>

      {model.error && (
        <Alert
          variant='destructive'
          className='absolute inset-x-3 top-14 z-50 w-auto sm:left-auto sm:right-4 sm:w-full sm:max-w-sm'
        >
          <AlertTitle>Portal error</AlertTitle>
          <AlertDescription>{model.error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
