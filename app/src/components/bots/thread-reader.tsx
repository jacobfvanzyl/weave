// One of a Bot's earlier threads, to read (WVE-178): its transcript with no composer. The store
// shows it beside what's on screen (`peekThread`); a thread that had closed is opened in its agent
// to be read, which is the only way a Host gives its transcript, and closes again once nothing
// needs it.
import { useEffect } from 'react';
import type { AppController } from '@/app/app-controller';
import { ChatPane } from '@/chat/chat-pane';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';

const noop = () => {};

export function ThreadReader({ controller, threadKey, title, description, onClose }: {
  controller: AppController;
  /** The thread to read, by key; none closes it. */
  threadKey?: string;
  title: string;
  description?: string;
  onClose(): void;
}) {
  const { model, actions } = controller;
  useEffect(() => {
    if (!threadKey) return;
    actions.peekThread?.(threadKey);
    return () => actions.peekThread?.(undefined);
  }, [threadKey]);
  const open = threadKey ? model.open?.[threadKey] : undefined;
  const failure = threadKey ? model.threadErrors?.[threadKey] : undefined;
  return (
    <Dialog open={threadKey !== undefined} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent data-slot='thread-reader' className='flex h-[min(44rem,calc(100dvh-2rem))] w-[min(48rem,calc(100%-2rem))] max-w-none flex-col gap-2 p-0 sm:max-w-3xl'>
        <DialogHeader className='px-4 pt-4'>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? 'To read: this thread has ended, and its Bot carries on in a newer one.'}</DialogDescription>
        </DialogHeader>
        {failure && !open && <Alert variant='destructive' className='mx-4 w-auto'><AlertDescription>{failure}</AlertDescription></Alert>}
        <div className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-b-xl border-t border-border'>
          {open
            ? <ChatPane key={open.key} model={open.transcript} loading={open.loading} readOnly
                actions={{ send: noop, cancelTurn: noop, respondToPermission: noop, respondToElicitation: noop, setMode: noop, setConfigOption: noop }} />
            : (
              <div className='flex flex-1 items-center justify-center text-xs text-muted-foreground'>
                <Spinner className='mr-1.5 size-3' />Opening the thread…
              </div>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
