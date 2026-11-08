import { useEffect, useState, type FormEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Link01Icon } from '@hugeicons/core-free-icons';
import type { AppController } from '@/app/app-controller';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** What a new pairing calls this device until the person names it. */
const defaultDeviceName = () => {
  const idiom = document.documentElement.dataset.deviceIdiom;
  return idiom === 'phone' ? 'iPhone' : idiom === 'pad' ? 'iPad' : 'Browser';
};

/** A pairing link's address, by its host name, for the person to confirm; none for one that doesn't parse. */
const hostName = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

/**
 * Pairs with the Dispatcher at the URL and code `weave pair` shows, in place of any
 * pairing before (ADR 0030): the one pairing this device has, which reaches every Host.
 */
export function PairDispatcherForm({ controller, offer, onPaired }: {
  controller: AppController;
  /** A pairing link's URL and code, to confirm. */
  offer?: { url: string; code: string };
  onPaired?(): void;
}) {
  const { actions } = controller;
  const [url, setUrl] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState(defaultDeviceName);
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState(false);

  useEffect(() => {
    if (!offer) return;
    setUrl(offer.url);
    setCode(offer.code);
    setError(undefined);
  }, [offer]);

  const offered = offer ? hostName(offer.url) : undefined;

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setPairing(true);
    try {
      await actions.pairDispatcher({ url: url.trim(), code: code.trim(), name: name.trim() });
      setUrl('');
      setCode('');
      onPaired?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPairing(false);
    }
  };

  return (
    <form aria-label='Pair with the Dispatcher' className='grid gap-3 rounded-lg border border-border p-3' onSubmit={pair}>
      <div className='flex items-center gap-2 font-medium'>
        <HugeiconsIcon icon={Link01Icon} strokeWidth={2} />
        Pair with the Dispatcher
      </div>
      {offered
        ? <p>Pair with the Dispatcher on <strong>{offered}</strong>? Only pair with one you just ran <code>weave pair</code> for.</p>
        : (
          <p className='text-muted-foreground'>
            Run <code>weave pair</code> on the Dispatcher's computer and scan its QR code with the Camera, or enter
            the URL and code it shows. This device reaches every Host through it.
          </p>
        )}
      <div className='grid gap-1.5'>
        <Label htmlFor='pair-url'>URL</Label>
        <Input id='pair-url' required inputMode='url' autoCapitalize='off' autoCorrect='off' value={url}
          placeholder='wss://homelab.example.ts.net:7342' onChange={(event) => setUrl(event.target.value)} />
      </div>
      <div className='grid gap-1.5'>
        <Label htmlFor='pair-code'>Code</Label>
        <Input id='pair-code' required autoCapitalize='characters' autoCorrect='off' value={code}
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
      <div className='flex justify-end'>
        <Button type='submit' disabled={pairing || !url.trim() || !code.trim() || !name.trim()}>{pairing ? 'Pairing…' : 'Pair'}</Button>
      </div>
    </form>
  );
}

/**
 * What the app shows until it's paired with the Dispatcher, or once the Dispatcher revoked it:
 * the one pairing it needs, and why it needs it again.
 */
export function PairingScreen({ controller, offer }: { controller: AppController; offer?: { url: string; code: string } }) {
  const revoked = controller.model.dispatcher?.status === 'revoked' ? controller.model.dispatcher : undefined;
  return (
    <main className='flex h-dvh min-h-0 justify-center overflow-y-auto bg-background px-4 pt-[calc(env(safe-area-inset-top)+2rem)] pb-[calc(env(safe-area-inset-bottom)+2rem)]'>
      <div className='grid w-full max-w-md content-start gap-4'>
        <div className='grid gap-1.5'>
          <h1 className='text-lg font-semibold'>{revoked ? 'Pair this device again' : 'Pair with your Dispatcher'}</h1>
          <p className='text-muted-foreground'>
            {revoked?.error ?? 'weave reaches your Hosts through the Dispatcher, which this device pairs with once.'}
          </p>
        </div>
        <PairDispatcherForm controller={controller} offer={offer} />
      </div>
    </main>
  );
}
