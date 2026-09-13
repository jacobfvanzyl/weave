import { useEffect, useState } from 'react';
import type { BrowserProfile } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Button } from './ui/button';
import { Alert, AlertDescription } from './ui/alert';
export function BrowserProfileDialog({ controller }: { controller: AlphaController }) {
  const request = controller.model.browserCreation, client = request && controller.browserClient?.(request.hostId);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]), [profileId, setProfileId] = useState('');
  const [name, setName] = useState(''), [url, setUrl] = useState('about:blank'), [pending, setPending] = useState(false), [error, setError] = useState<string>();
  useEffect(() => {
    if (!request || !client) return;
    let disposed = false; setError(undefined); setProfiles([]); setName(''); setProfileId(''); setUrl('about:blank'); setPending(true);
    void client.browserRequest('browser.profile.list', {}).then(({ profiles }) => {
      if (disposed) return; setProfiles(profiles); setProfileId(profiles.find(profile => profile.profileId === request.profileId)?.profileId ?? profiles[0]?.profileId ?? 'new');
    }).catch(cause => { if (!disposed) setError(String(cause)); }).finally(() => { if (!disposed) setPending(false); });
    return () => { disposed = true; };
  }, [request, client]);
  const submit = async () => {
    if (!client || pending || !profileId) return;
    setPending(true); setError(undefined);
    try {
      let selected = profileId;
      if (selected === 'new') {
        const { profile } = await client.browserRequest('browser.profile.create', { name });
        selected = profile.profileId; setProfiles(values => [...values, profile]); setProfileId(selected);
      }
      const address = url.trim() || 'about:blank';
      await controller.actions.createBrowserPane?.(selected, address.includes(':') ? address : `https://${address}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <Dialog open={Boolean(request)} onOpenChange={open => { if (!open && !pending) controller.actions.cancelBrowserPane?.(); }}>
    <DialogContent><DialogHeader><DialogTitle>New Browser Pane</DialogTitle><DialogDescription>Profiles share cookies and sign-ins across this Host’s Workspaces.</DialogDescription></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}>
        <FieldGroup>
          <Field><FieldLabel htmlFor='browser-profile'>Profile</FieldLabel><Select value={profileId} onValueChange={value => setProfileId(value ?? '')} disabled={pending}>
            <SelectTrigger id='browser-profile'><SelectValue>{profiles.find(profile => profile.profileId === profileId)?.name ?? (profileId === 'new' ? 'New profile…' : 'Loading…')}</SelectValue></SelectTrigger>
            <SelectContent><SelectGroup>{profiles.map(profile => <SelectItem key={profile.profileId} value={profile.profileId}>{profile.name}</SelectItem>)}<SelectItem value='new'>New profile…</SelectItem></SelectGroup></SelectContent>
          </Select></Field>
          {profileId === 'new' && <Field><FieldLabel htmlFor='browser-profile-name'>Profile name</FieldLabel><Input id='browser-profile-name' value={name} onChange={event => setName(event.target.value)} maxLength={120} placeholder='Work' required disabled={pending} /></Field>}
          <Field><FieldLabel htmlFor='browser-address'>Address</FieldLabel><Input id='browser-address' value={url} onChange={event => setUrl(event.target.value)} autoCapitalize='none' autoCorrect='off' spellCheck={false} disabled={pending} /></Field>
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter><Button type='button' variant='outline' disabled={pending} onClick={() => controller.actions.cancelBrowserPane?.()}>Cancel</Button><Button type='submit' disabled={pending || !profileId || (profileId === 'new' && !name.trim())}>{pending ? 'Opening…' : 'Open'}</Button></DialogFooter>
        </FieldGroup>
      </form>
    </DialogContent>
  </Dialog>;
}
