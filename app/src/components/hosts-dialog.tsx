import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ComputerIcon, Delete02Icon, RefreshIcon, ServerStack01Icon } from '@hugeicons/core-free-icons';
import type { AppController, DispatcherSummary, HostSummary } from '@/app/app-controller';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PairDispatcherForm } from '@/components/pair-dispatcher';
import { cn } from '@/lib/utils';

const dispatcherStatus: Record<DispatcherSummary['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Unreachable',
  refused: 'Refused',
  revoked: 'Revoked',
  incompatible: 'Incompatible',
};

const hostStatus: Record<HostSummary['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  unreachable: 'Unreachable',
  disconnected: 'Disconnected',
  incompatible: 'Incompatible',
};

/** The Dispatcher this device is paired with: how it's connected, trying again, and forgetting it. */
function DispatcherRow({ dispatcher, actions }: { dispatcher: DispatcherSummary; actions: AppController['actions'] }) {
  const halted = dispatcher.status === 'refused' || dispatcher.status === 'incompatible';
  return (
    <section aria-label='Dispatcher' className='grid gap-2 rounded-lg border border-border p-3'>
      <div className='flex items-center gap-3'>
        <span className='flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground'>
          <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
        </span>
        <span className='min-w-0 flex-1'>
          <span className='flex items-center gap-2'>
            <span className='truncate font-medium'>Dispatcher on {dispatcher.name}</span>
            <Badge variant={dispatcher.status === 'connected' ? 'default' : halted ? 'destructive' : 'secondary'}>{dispatcherStatus[dispatcher.status]}</Badge>
          </span>
          <span className='block truncate text-muted-foreground'>{dispatcher.url}</span>
        </span>
        {dispatcher.status !== 'connected' && dispatcher.status !== 'connecting' && (
          <Button variant='outline' size='icon' aria-label='Reconnect to the Dispatcher' onClick={() => void actions.reconnectDispatcher()}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant='ghost' size='icon' aria-label='Forget the Dispatcher' />}>
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Forget the Dispatcher on {dispatcher.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This device deletes its key and reaches no Host until it pairs again. Your threads keep running on your
                Hosts. To cut this device off on the Dispatcher too, run <code>weave devices revoke</code> there.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction variant='destructive' onClick={() => void actions.forgetDispatcher()}>Forget Dispatcher</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {dispatcher.error && dispatcher.status !== 'connected' && <p className='text-muted-foreground'>{dispatcher.error}</p>}
    </section>
  );
}

/** One of the Hosts the Dispatcher lists, as it reaches it. */
function HostRow({ host, away, actions }: { host: HostSummary; away: boolean; actions: AppController['actions'] }) {
  const stopped = host.status === 'disconnected' || host.status === 'incompatible';
  return (
    <li className={cn('grid gap-2 rounded-lg border border-border p-3', away && 'opacity-60')}>
      <div className='flex items-center gap-3'>
        <span className='flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground'>
          <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
        </span>
        <span className='flex min-w-0 flex-1 items-center gap-2'>
          <span className='truncate font-medium'>{host.name}</span>
          <Badge variant={host.status === 'connected' ? 'default' : stopped ? 'destructive' : 'secondary'}>{hostStatus[host.status]}</Badge>
        </span>
        {stopped && !away && (
          <Button variant='outline' size='icon' aria-label={`Reconnect to ${host.name}`} onClick={() => void actions.reconnectHost(host.id)}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
          </Button>
        )}
      </div>
      {host.error && host.status !== 'connected' && <p className='text-muted-foreground'>{host.error}</p>}
    </li>
  );
}

/**
 * The Dispatcher this device is paired with and the Hosts it lists, each saying how the
 * Dispatcher reaches it; and pairing with the Dispatcher, again or for the first time, with the URL
 * and code `weave pair` shows.
 */
export function HostsDialog({ controller, open, onOpenChange, offer }: {
  controller: AppController;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** A pairing link's URL and code, to confirm. */
  offer?: { url: string; code: string };
}) {
  const { model, actions } = controller;
  const { dispatcher } = model;
  const away = dispatcher?.status !== 'connected';
  const unpaired = !dispatcher || dispatcher.status === 'revoked' || dispatcher.status === 'refused';
  const [pairing, setPairing] = useState(false);
  useEffect(() => {
    if (offer) setPairing(true);
  }, [offer]);
  useEffect(() => {
    if (!open) setPairing(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100%-2rem))] max-w-none overflow-y-auto sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle>Hosts</DialogTitle>
          <DialogDescription>
            This device reaches your Hosts through the Dispatcher it's paired with. Its key never leaves this device.
          </DialogDescription>
        </DialogHeader>
        {dispatcher && dispatcher.status !== 'revoked' && <DispatcherRow dispatcher={dispatcher} actions={actions} />}
        {model.hosts.length > 0 && (
          <ul aria-label='Hosts' className='grid gap-2'>
            {model.hosts.map((host) => <HostRow key={host.id} host={host} away={away} actions={actions} />)}
          </ul>
        )}
        {dispatcher?.status === 'connected' && model.hosts.length === 0 && (
          <p className='text-muted-foreground'>
            No Host has joined the Dispatcher yet. <code>weave hosts add</code> on a computer has its Host join.
          </p>
        )}
        {unpaired || pairing
          ? <PairDispatcherForm controller={controller} offer={offer} onPaired={() => setPairing(false)} />
          : (
            <div className='flex justify-end'>
              <Button variant='outline' onClick={() => setPairing(true)}>Pair again</Button>
            </div>
          )}
      </DialogContent>
    </Dialog>
  );
}
