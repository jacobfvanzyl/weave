import { useState } from 'react';
import type { AlphaController } from '@/app/alpha-controller';
import { type WorkspaceReference } from '@/app/workspace-presentation';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';

export function RenameWorkspaceDialog({ controller, reference, initialName, onClose }: {
  controller: AlphaController; reference: WorkspaceReference; initialName: string; onClose(): void;
}) {
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogContent>
      <form className='flex flex-col gap-4' onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim() || saving) return;
        setSaving(true);
        void controller.workspaceActions?.rename(reference, name.trim()).then((saved) => { if (saved) onClose(); }).finally(() => setSaving(false));
      }}>
        <DialogHeader><DialogTitle>Name terminal workspace</DialogTitle><DialogDescription>Name this arrangement of panes within its existing Host directory.</DialogDescription></DialogHeader>
        <FieldGroup><Field><FieldLabel htmlFor='workspace-name'>Workspace name</FieldLabel><Input id='workspace-name' autoFocus maxLength={120} value={name} disabled={saving} onChange={(event) => setName(event.target.value)} /></Field></FieldGroup>
        {controller.model.workspaceCompositions?.error && <Alert variant='destructive'><AlertDescription>{controller.model.workspaceCompositions.error}</AlertDescription></Alert>}
        <DialogFooter><Button type='button' variant='outline' disabled={saving} onClick={onClose}>Cancel</Button><Button type='submit' disabled={saving || !name.trim()}>Save name</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}
