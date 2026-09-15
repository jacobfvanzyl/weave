import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { UserCircleIcon } from '@hugeicons/core-free-icons';
import type { BrowserPage, BrowserProfile } from '@weave/product-protocol';
import type { DirectHostClient } from '@/portal-client';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { Alert, AlertDescription } from './ui/alert';

export function BrowserProfileButton({ client, page, select }: { client?: Pick<DirectHostClient, 'browserRequest'>; page?: BrowserPage; select(profileId?: string): Promise<void> }) {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]), [open, setOpen] = useState(false), [creating, setCreating] = useState(false);
  const [name, setName] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState<string>();
  useEffect(() => {
    if (!client) return;
    let disposed = false;
    void client.browserRequest('browser.profile.list', {}).then(result => { if (!disposed) setProfiles(result.profiles.filter(profile => !profile.temporary)); }).catch(cause => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; };
  }, [client, open, page?.profileId]);
  const choose = async (profileId?: string) => {
    if (pending || page?.profileLocked) return;
    setPending(true); setError(undefined);
    try { await select(profileId); setCreating(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setOpen(true); }
    finally { setPending(false); }
  };
  const create = async () => {
    if (!client || pending || page?.profileLocked) return;
    setPending(true); setError(undefined);
    try {
      const { profile } = await client.browserRequest('browser.profile.create', { name });
      setProfiles(values => [...values, profile]);
      await select(profile.profileId); setCreating(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const selected = page && !page.temporary ? profiles.find(profile => profile.profileId === page.profileId) : undefined;
  return <>
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger render={<Button type='button' size='icon-sm' variant='ghost' aria-label='Profiles' disabled={!page || !client || pending} title={page?.profileLocked ? `${selected?.name ?? 'Profile'} — locked for this Pane` : 'Profiles (optional)'} />}>
        <HugeiconsIcon icon={UserCircleIcon} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' finalFocus={false}>
        <DropdownMenuGroup>
          {profiles.map(profile => <DropdownMenuItem key={profile.profileId} disabled={page?.profileLocked || pending} onClick={() => void choose(profile.profileId)}>{profile.name}{selected?.profileId === profile.profileId ? ' ✓' : ''}</DropdownMenuItem>)}
        </DropdownMenuGroup>
        {profiles.length > 0 && <DropdownMenuSeparator />}
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={page?.profileLocked || pending} onClick={() => { setName(''); setError(undefined); setCreating(true); }}>New Profile…</DropdownMenuItem>
        </DropdownMenuGroup>
        {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={creating} onOpenChange={value => { if (!pending) setCreating(value); }}><DialogContent><DialogHeader><DialogTitle>New Browser Profile</DialogTitle><DialogDescription>Keep cookies and sign-ins across Panes on this Host.</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void create(); }}><FieldGroup><Field><FieldLabel htmlFor='new-browser-profile-name'>Name</FieldLabel><Input id='new-browser-profile-name' autoFocus value={name} onChange={event => setName(event.target.value)} maxLength={120} required disabled={pending} placeholder='Work' /></Field>
        {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
        <DialogFooter><Button type='button' variant='outline' disabled={pending} onClick={() => setCreating(false)}>Cancel</Button><Button type='submit' disabled={pending || !name.trim()}>{pending ? 'Creating…' : 'Create Profile'}</Button></DialogFooter>
      </FieldGroup></form>
    </DialogContent></Dialog>
  </>;
}
