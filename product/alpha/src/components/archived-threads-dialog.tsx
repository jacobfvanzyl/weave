import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Archive02Icon, ArchiveRestoreIcon } from '@hugeicons/core-free-icons';
import type { AlphaController } from '@/app/alpha-controller';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

export function ArchivedThreadsDialog({ controller }: { controller: AlphaController }) {
  const { model, actions } = controller;
  const [restoreError, setRestoreError] = useState<string>();

  const restore = async (threadId: string) => {
    setRestoreError(undefined);
    try {
      await actions.restoreThread(threadId);
    } catch (cause) {
      setRestoreError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Dialog
      open={model.archivedThreadsOpen}
      onOpenChange={(open) => {
        if (!open) actions.closeArchivedThreads();
      }}
    >
      <DialogContent className='max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100%-2rem))] max-w-none overflow-y-auto sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Archived Threads</DialogTitle>
          <DialogDescription>
            Restore Portal-managed Threads without losing their transcript or Agent session.
          </DialogDescription>
        </DialogHeader>

        {restoreError && (
          <Alert variant='destructive'>
            <AlertTitle>Restore failed</AlertTitle>
            <AlertDescription>{restoreError}</AlertDescription>
          </Alert>
        )}

        {model.archivedThreads.length ? (
          <div className='flex flex-col gap-2' aria-label='Archived Threads list'>
            {model.archivedThreads.map((thread) => {
              const connection = model.connections.find(({ hostId }) => hostId === thread.hostId);
              const unavailable = connection?.status !== 'connected';
              return (
                <Card key={thread.id} size='sm'>
                  <CardHeader>
                    <CardTitle>{thread.title}</CardTitle>
                    <CardDescription>
                      {model.showHostIdentity ? `${thread.hostName} · ` : ''}{thread.workspaceId}
                    </CardDescription>
                    <CardAction>
                      <Button
                        variant='outline'
                        size='sm'
                        disabled={model.busy || unavailable}
                        onClick={() => void restore(thread.id)}
                      >
                        <HugeiconsIcon data-icon='inline-start' icon={ArchiveRestoreIcon} strokeWidth={2} />
                        Restore
                      </Button>
                    </CardAction>
                  </CardHeader>
                </Card>
              );
            })}
          </div>
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>No archived Threads</EmptyTitle>
              <EmptyDescription>Archived Threads from connected Hosts will appear here.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </DialogContent>
    </Dialog>
  );
}
