import { useState, type FormEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ComputerIcon, Delete02Icon, Link01Icon, RefreshIcon } from '@hugeicons/core-free-icons';
import type { AlphaController } from '@/app/alpha-controller';
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
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function ConnectionsDialog({ controller }: { controller: AlphaController }) {
  const { model, actions } = controller;
  const [pairingToken, setPairingToken] = useState('');
  const [hostUrl, setHostUrl] = useState('');
  const [deviceLabel, setDeviceLabel] = useState(`Weave on ${model.platform === 'ios' ? 'iPad' : model.platform}`);
  const [pairingError, setPairingError] = useState<string>();
  const hasConnections = model.connections.length > 0;
  const open = model.connectionsLoaded && (model.connectionsOpen || !hasConnections);

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setPairingError(undefined);
    try {
      await actions.pairHost({ pairingToken, hostUrl, deviceLabel });
      setPairingToken('');
      setHostUrl('');
    } catch (cause) {
      setPairingError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) actions.closeConnections();
      }}
    >
      <DialogContent
        showCloseButton={hasConnections}
        className='max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100%-2rem))] max-w-none overflow-y-auto sm:max-w-2xl'
      >
        <DialogHeader>
          <DialogTitle>Connections</DialogTitle>
          <DialogDescription>
            Pair this device with Portal Hosts. Private keys stay on this device; forgetting a Host does not revoke it remotely.
          </DialogDescription>
        </DialogHeader>

        {!hasConnections && window.weaveDesktop && (
          <p className='text-sm text-muted-foreground'>
            Moving from the earlier Mac app? Pair each Host again here. Your projects,
            threads and terminals stay on their Hosts. After checking this connection,
            you can revoke the old Mac credential from the Host.
          </p>
        )}

        {hasConnections && (
          <div className='grid gap-2' aria-label='Configured Hosts'>
            {model.connections.map((connection) => (
              <Card key={connection.hostId} className={connection.selected ? 'border-ring' : undefined}>
                <CardContent className='flex items-center gap-3 p-3'>
                  <span className='flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground'>
                    <HugeiconsIcon icon={ComputerIcon} strokeWidth={2} />
                  </span>
                  <span className='min-w-0 flex-1'>
                    <span className='flex items-center gap-2'>
                      <span className='truncate font-medium'>{connection.displayName}</span>
                      <Badge variant={connection.status === 'connected' ? 'default' : 'secondary'}>
                        {connection.status}
                      </Badge>
                    </span>
                    <span className='block truncate text-muted-foreground'>{connection.hostUrl}</span>
                  </span>
                  {connection.status === 'disconnected' && !connection.error ? (
                    <Button variant='outline' disabled={model.busy} onClick={() => void actions.reconnectHost(connection.hostId)}>
                      <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                      Reconnect
                    </Button>
                  ) : null}
                  <AlertDialog>
                    <AlertDialogTrigger render={<Button variant='ghost' size='icon' aria-label={`Forget ${connection.displayName}`} />}>
                      <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Forget {connection.displayName}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This removes the local Host entry and device key. It does not revoke the credential on Portal.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction variant='destructive' onClick={() => void actions.forgetHost(connection.hostId)}>
                          Forget Host
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </CardContent>
                {connection.status === 'disconnected' && connection.error && (
                  <Alert variant='destructive' className='mx-3 mb-3 w-auto'>
                    <AlertTitle>Host unavailable</AlertTitle>
                    <AlertDescription>{connection.error}</AlertDescription>
                    <AlertAction>
                      <Button
                        size='sm'
                        variant='outline'
                        disabled={model.busy}
                        onClick={() => void actions.reconnectHost(connection.hostId)}
                      >
                        Retry
                      </Button>
                    </AlertAction>
                  </Alert>
                )}
              </Card>
            ))}
          </div>
        )}

        <form className='grid gap-3 rounded-lg border border-border p-3' onSubmit={pair}>
          <div className='flex items-center gap-2 font-medium'>
            <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
            Pair a Host
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='pairing-token'>Pairing Token</Label>
            <Textarea
              id='pairing-token'
              required
              rows={3}
              value={pairingToken}
              placeholder='Paste the Pairing Token from `weave-portal pairing create`'
              onChange={(event) => setPairingToken(event.target.value)}
            />
          </div>
          <div className='grid gap-1.5 sm:grid-cols-2'>
            <div className='grid gap-1.5'>
              <Label htmlFor='host-url'>Host URL</Label>
              <Input
                id='host-url'
                value={hostUrl}
                placeholder='wss://host.example:4122'
                onChange={(event) => setHostUrl(event.target.value)}
              />
            </div>
            <div className='grid gap-1.5'>
              <Label htmlFor='device-label'>Device name</Label>
              <Input
                id='device-label'
                required
                value={deviceLabel}
                onChange={(event) => setDeviceLabel(event.target.value)}
              />
            </div>
          </div>
          {pairingError && (
            <Alert variant='destructive'>
              <AlertTitle>Couldn’t pair this Host</AlertTitle>
              <AlertDescription>{pairingError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type='submit' disabled={model.busy || !pairingToken.trim()}>
              Pair and Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
