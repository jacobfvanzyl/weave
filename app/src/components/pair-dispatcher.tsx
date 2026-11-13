import { useEffect, useState, type FormEvent } from 'react';
import type { AppController } from '@/app/app-controller';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { pairingLink } from '@/host/storage';
import { cn } from '@/lib/utils';

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
export function PairDispatcherForm({ controller, offer, onPaired, className }: {
  controller: AppController;
  /** A pairing link's URL and code, to confirm. */
  offer?: { url: string; code: string };
  onPaired?(): void;
  className?: string;
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

  /** A pasted `weave pair` link fills both fields. */
  const enterUrl = (value: string) => {
    const link = pairingLink(value.trim());
    setUrl(link ? link.url : value);
    if (link) setCode(link.code);
  };

  return (
    <form aria-label='Pair with the Dispatcher' className={cn('grid gap-4', className)} onSubmit={pair}>
      {offered
        ? <p>Pair with the Dispatcher on <strong>{offered}</strong>? Only pair with one you just ran <code>weave pair</code> for.</p>
        : (
          <p className='text-muted-foreground'>
            Run <code className='text-foreground'>weave pair</code> on the Dispatcher's computer, then scan its QR
            code with the Camera or enter what it shows.
          </p>
        )}
      <div className='grid gap-3'>
        <div className='grid gap-1.5'>
          <Label htmlFor='pair-url'>URL</Label>
          <Input id='pair-url' required inputMode='url' autoCapitalize='off' autoCorrect='off' spellCheck={false}
            value={url} placeholder='wss://…' onChange={(event) => enterUrl(event.target.value)} />
        </div>
        <div className='grid grid-cols-2 gap-3'>
          <div className='grid gap-1.5'>
            <Label htmlFor='pair-code'>Code</Label>
            <Input id='pair-code' required autoCapitalize='characters' autoCorrect='off' spellCheck={false}
              className='tracking-widest' value={code} onChange={(event) => setCode(event.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='pair-name'>Device name</Label>
            <Input id='pair-name' required value={name} onChange={(event) => setName(event.target.value)} />
          </div>
        </div>
      </div>
      {error && (
        <Alert variant='destructive'>
          <AlertTitle>Couldn't pair</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type='submit' className='w-full' disabled={pairing || !url.trim() || !code.trim() || !name.trim()}>
        {pairing ? 'Pairing…' : 'Pair'}
      </Button>
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
    <main className='flex h-(--app-height) min-h-0 justify-center overflow-y-auto bg-background px-4 pt-[calc(env(safe-area-inset-top)+min(14vh,7rem))] pb-[calc(env(safe-area-inset-bottom)+2rem)]'>
      <div className='grid w-full max-w-sm content-start gap-4'>
        <h1 className='text-lg font-semibold'>{revoked ? 'Pair this device again' : 'Pair with your Dispatcher'}</h1>
        {revoked?.error && <p className='text-muted-foreground'>{revoked.error}</p>}
        <PairDispatcherForm controller={controller} offer={offer} />
      </div>
    </main>
  );
}
