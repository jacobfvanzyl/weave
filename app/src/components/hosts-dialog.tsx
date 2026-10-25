import { useEffect, useRef, useState, type FormEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ComputerIcon, Delete02Icon, Link01Icon, RefreshIcon } from '@hugeicons/core-free-icons';
import type { AppController, PairedHost } from '@/app/app-controller';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const statusLabel: Record<PairedHost['status'], string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  revoked: 'Revoked',
  incompatible: 'Incompatible',
};

/** The address `weave pair` shows for a Host's WebSocket. */
const pairingUrl = (url: string) => url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');

function HostRow({ host, actions, onPairAgain }: {
  host: PairedHost;
  actions: AppController['actions'];
  onPairAgain(url: string): void;
}) {
  const revoked = host.status === 'revoked';
  return (
    <li className='grid gap-2 rounded-lg border border-border p-3'>
      <div className='flex items-center gap-3'>
        <span className='flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground'>
          <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
        </span>
        <span className='min-w-0 flex-1'>
          <span className='flex items-center gap-2'>
            <span className='truncate font-medium'>{host.name}</span>
            <Badge variant={host.status === 'connected' ? 'default' : revoked ? 'destructive' : 'secondary'}>{statusLabel[host.status]}</Badge>
          </span>
          <span className='block truncate text-muted-foreground'>{host.url}</span>
        </span>
        {revoked && (
          <>
            <Button variant='outline' size='sm' onClick={() => onPairAgain(pairingUrl(host.url))}>Pair again</Button>
            <Button variant='ghost' size='icon' aria-label={`Remove ${host.name}`} onClick={() => void actions.forgetHost(host.id)}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </Button>
          </>
        )}
        {!revoked && host.status !== 'connected' && (
          <Button variant='outline' size='icon' aria-label={`Reconnect to ${host.name}`} onClick={() => void actions.reconnectHost(host.id)}>
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
          </Button>
        )}
        {!revoked && (
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant='ghost' size='icon' aria-label={`Forget ${host.name}`} />}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Forget {host.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This device deletes its key for the Host and stops showing its sessions. The threads keep running on the
                  Host. To cut this device off on the Host too, run <code>weave devices revoke</code> there.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction variant='destructive' onClick={() => void actions.forgetHost(host.id)}>Forget Host</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
      {host.error && <p className='text-muted-foreground'>{host.error}</p>}
    </li>
  );
}

/** What a new pairing calls this device until the person names it. */
const defaultDeviceName = () => {
  const idiom = document.documentElement.dataset.deviceIdiom;
  return idiom === 'phone' ? 'iPhone' : idiom === 'pad' ? 'iPad' : 'Browser';
};

/** The paired Hosts, and pairing another with the URL and code `weave pair` shows. */
export function HostsDialog({ controller, open, onOpenChange, offer }: {
  controller: AppController;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** A pairing link's URL and code, to confirm. */
  offer?: { url: string; code: string };
}) {
  const { model, actions } = controller;
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName);
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const pairAgain = (hostUrl: string) => {
    setUrl(hostUrl);
    setCode('');
    setError(undefined);
    codeRef.current?.focus();
  };

  useEffect(() => {
    if (!offer) return;
    setUrl(offer.url);
    setCode(offer.code);
    setError(undefined);
  }, [offer]);

  const offeredHost = (() => {
    try {
      return offer ? new URL(offer.url).hostname : undefined;
    } catch {
      return undefined;
    }
  })();

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setPairing(true);
    try {
      await actions.pairHost({ url: url.trim(), code: code.trim(), name: name.trim() });
      setUrl('');
      setCode('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPairing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100%-2rem))] max-w-none overflow-y-auto sm:max-w-xl'>
        <DialogHeader>
          <DialogTitle>Hosts</DialogTitle>
          <DialogDescription>The weave Hosts this device is paired with. Its key never leaves this device.</DialogDescription>
        </DialogHeader>
        {model.hosts.length > 0 && (
          <ul aria-label='Paired Hosts' className='grid gap-2'>
            {model.hosts.map((host) => <HostRow key={host.id} host={host} actions={actions} onPairAgain={pairAgain} />)}
          </ul>
        )}
        <form aria-label='Pair a Host' className='grid gap-3 rounded-lg border border-border p-3' onSubmit={pair}>
          <div className='flex items-center gap-2 font-medium'>
            <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
            Pair a Host
          </div>
          {offeredHost
            ? <p>Pair with <strong>{offeredHost}</strong>? Only pair with a Host you just ran <code>weave pair</code> on.</p>
            : (
              <p className='text-muted-foreground'>
                Run <code>weave pair</code> on the Host's computer and scan its QR code with the Camera, or enter the URL and
                code it shows.
              </p>
            )}
          <div className='grid gap-1.5'>
            <Label htmlFor='pair-url'>URL</Label>
            <Input id='pair-url' required inputMode='url' autoCapitalize='off' autoCorrect='off' value={url}
              placeholder='https://mac.example.ts.net:7341' onChange={(event) => setUrl(event.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='pair-code'>Code</Label>
            <Input id='pair-code' ref={codeRef} required autoCapitalize='characters' autoCorrect='off' value={code}
              onChange={(event) => setCode(event.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='pair-name'>This device's name</Label>
            <Input id='pair-name' required value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          {error && (
            <Alert variant='destructive'>
              <AlertTitle>Couldn't pair</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type='submit' disabled={pairing || !url.trim() || !code.trim() || !name.trim()}>Pair</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
