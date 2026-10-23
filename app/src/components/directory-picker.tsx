import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, ArrowUp01Icon, Clock01Icon, Folder01Icon, Home01Icon } from '@hugeicons/core-free-icons';
import type { DirectoryListing } from '@/app/app-controller';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { directoryName } from '@/lib/display-path';

/** A path as the person reads it: under the home directory, as `~/…`. */
export const homePath = (path: string, home: string) =>
  path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

const join = (path: string, name: string) => path.endsWith('/') ? `${path}${name}` : `${path}/${name}`;

/** How many of the directories sessions use the picker offers. */
const RECENT = 5;

/**
 * Picks a directory on a Host's computer: one its sessions use (`recent`), or any by browsing it
 * (`files/list`): into a directory, up to its parent, or home, with hidden ones on request. It
 * opens at `start`, or at home when `start` can't be listed.
 */
export function DirectoryPicker({ list, start, recent = [], onChoose, onCancel }: {
  list(input: { path?: string; hidden?: boolean }): Promise<DirectoryListing>;
  start?: string;
  /** Directories the Host's sessions use, most recently active first. */
  recent?: string[];
  onChoose(path: string): void;
  onCancel(): void;
}) {
  const [listing, setListing] = useState<DirectoryListing>();
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  // Only the latest listing asked for shows, however the answers arrive.
  const asked = useRef(0);

  /** Lists `path`, or home; `why` stays shown, saying why it isn't where it was asked to open. */
  const go = async (path: string | undefined, showHidden = hidden, why?: string) => {
    const ask = ++asked.current;
    setLoading(true);
    try {
      const listed = await list({ ...(path ? { path } : {}), ...(showHidden ? { hidden: true } : {}) });
      if (ask !== asked.current) return;
      setListing(listed);
      setError(why);
    } catch (cause) {
      if (ask !== asked.current) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      // Somewhere to start from when the first place can't be listed.
      if (!listing && path) void go(undefined, showHidden, message);
    } finally {
      if (ask === asked.current) setLoading(false);
    }
  };

  useEffect(() => {
    void go(start);
    // Opens once, where it was asked to.
  }, []);

  return (
    <div className='grid gap-3' data-slot='directory-picker'>
      {recent.length > 0 && (
        <ul aria-label='Recent directories' className='rounded-md border'>
          {recent.slice(0, RECENT).map((path) => (
            <li key={path}>
              <button type='button' title={path} className='flex min-h-10 w-full min-w-0 items-center gap-2 px-2.5 text-left text-xs hover:bg-muted'
                onClick={() => onChoose(path)}>
                <HugeiconsIcon icon={Clock01Icon} strokeWidth={1.75} className='size-4 shrink-0 text-muted-foreground' />
                <span className='shrink-0 font-medium'>{directoryName(path)}</span>
                <span className='min-w-0 flex-1 truncate text-muted-foreground'>{listing ? homePath(path, listing.home) : path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className='flex min-w-0 items-center gap-1'>
        <Button type='button' size='icon' variant='outline' aria-label='Up' disabled={!listing?.parent || loading}
          onClick={() => listing?.parent && void go(listing.parent)}>
          <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
        </Button>
        <p className='min-w-0 flex-1 truncate font-mono text-xs' aria-live='polite' title={listing?.path}>
          {listing ? homePath(listing.path, listing.home) : 'Listing…'}
        </p>
        <Button type='button' size='icon' variant='ghost' aria-label='Home' disabled={loading} onClick={() => void go(undefined)}>
          <HugeiconsIcon icon={Home01Icon} strokeWidth={2} />
        </Button>
      </div>
      {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      <ul aria-label='Directories' aria-busy={loading} className='max-h-[min(45vh,20rem)] overflow-y-auto rounded-md border'>
        {listing?.directories.map((name) => (
          <li key={name}>
            <button type='button' className='flex min-h-10 w-full min-w-0 items-center gap-2 px-2.5 text-left text-xs hover:bg-muted'
              onClick={() => void go(join(listing.path, name))}>
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.75} className='size-4 shrink-0 text-muted-foreground' />
              <span className='min-w-0 flex-1 truncate'>{name}</span>
              <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className='size-3.5 shrink-0 text-muted-foreground' />
            </button>
          </li>
        ))}
        {listing && listing.directories.length === 0 && (
          <li className='px-2.5 py-2.5 text-xs text-muted-foreground'>No directories in here.</li>
        )}
      </ul>
      {listing?.truncated && <p className='text-[0.6875rem] text-muted-foreground'>The Host listed only part of this directory.</p>}
      <div className='flex items-center gap-2'>
        <Checkbox id='directory-picker-hidden' checked={hidden} onCheckedChange={(checked) => {
          setHidden(checked);
          void go(listing?.path, checked);
        }} />
        <Label htmlFor='directory-picker-hidden' className='text-xs font-normal'>Show hidden directories</Label>
      </div>
      <div className='flex justify-end gap-1.5'>
        <Button type='button' variant='ghost' onClick={onCancel}>Back</Button>
        <Button type='button' disabled={!listing || loading} onClick={() => listing && onChoose(listing.path)}>Use this directory</Button>
      </div>
    </div>
  );
}
