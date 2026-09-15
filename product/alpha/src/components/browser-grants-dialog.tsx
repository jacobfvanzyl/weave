import { useEffect, useState } from 'react';
import type { BrowserProfile, BrowserThreadGrants } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Field, FieldGroup, FieldLabel, FieldSet, FieldLegend } from './ui/field';
import { Checkbox } from './ui/checkbox';
import { Button } from './ui/button';
import { Alert, AlertDescription } from './ui/alert';
import { Spinner } from './ui/spinner';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty';

export function BrowserGrantsDialog({ controller, hostId, threadId, open, onOpenChange }: { controller: AlphaController; hostId: string; threadId: string; open: boolean; onOpenChange(open: boolean): void }) {
  const client = controller.browserClient?.(hostId);
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]), [grants, setGrants] = useState<BrowserThreadGrants>();
  const [selected, setSelected] = useState<string[]>([]), [pending, setPending] = useState(false), [error, setError] = useState<string>();
  useEffect(() => {
    if (!open || !client) return;
    let disposed = false; setPending(true); setError(undefined); setGrants(undefined);
    void Promise.all([client.browserRequest('browser.profile.list', {}), client.browserRequest('browser.grants.get', { threadId })]).then(([list, grant]) => {
      if (disposed) return; setProfiles(list.profiles); setGrants(grant); setSelected(grant.profileIds);
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!disposed) setPending(false); });
    return () => { disposed = true; };
  }, [open, client, threadId]);
  const save = async () => {
    if (!client || !grants || pending) return;
    setPending(true); setError(undefined);
    try { await client.browserRequest('browser.grants.set', { threadId, profileIds: selected, expectedRevision: grants.revision }); onOpenChange(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <Dialog open={open} onOpenChange={value => { if (!pending) onOpenChange(value); }}><DialogContent>
    <DialogHeader><DialogTitle>Browser access</DialogTitle><DialogDescription>This Thread can use the selected Profiles’ sign-ins and control their pages across this Host’s Workspaces, including while you’re away. Other Threads receive no access.</DialogDescription></DialogHeader>
    <form onSubmit={event => { event.preventDefault(); void save(); }}><FieldGroup>
      {pending && !grants ? <Spinner aria-label='Loading Browser access' /> : grants && (profiles.length ? <FieldSet><FieldLegend>Profiles</FieldLegend><FieldGroup>
        {profiles.map(profile => <Field key={profile.profileId} orientation='horizontal' data-disabled={pending || undefined}>
          <Checkbox id={`grant-${threadId}-${profile.profileId}`} checked={selected.includes(profile.profileId)} disabled={pending} onCheckedChange={checked => setSelected(current => checked ? [...current, profile.profileId] : current.filter(id => id !== profile.profileId))} />
          <FieldLabel htmlFor={`grant-${threadId}-${profile.profileId}`}>{profile.name}</FieldLabel>
        </Field>)}
      </FieldGroup></FieldSet> : <Empty><EmptyHeader><EmptyTitle>No Browser Profiles</EmptyTitle><EmptyDescription>Create a Profile when opening a Browser Pane, then grant access here.</EmptyDescription></EmptyHeader></Empty>)}
      {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      <DialogFooter><Button type='button' variant='outline' disabled={pending} onClick={() => onOpenChange(false)}>Cancel</Button><Button type='submit' disabled={pending || !grants}>{pending ? 'Saving…' : 'Save access'}</Button></DialogFooter>
    </FieldGroup></form>
  </DialogContent></Dialog>;
}
