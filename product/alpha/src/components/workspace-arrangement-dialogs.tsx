import { useEffect, useState } from 'react';
import type { TerminalSummary } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import type { WorkspaceTabReference } from '@/app/workspace-presentation';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty';

export function RenameWorkspaceDialog({ controller, reference, initialName, onClose }: {
  controller: AlphaController; reference: WorkspaceTabReference; initialName: string; onClose(): void;
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

export function RunningTerminalDialog({ controller, reference, paneId, onClose }: {
  controller: AlphaController; reference: WorkspaceTabReference; paneId: string; onClose(): void;
}) {
  const [terminals, setTerminals] = useState<TerminalSummary[]>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const client = controller.terminalClient?.(reference.hostId);
  const context = controller.model.workspaces.find((workspace) => (workspace.placements ?? [workspace]).some((placement) => placement.hostId === reference.hostId && placement.workspaceId === reference.workspaceId));
  useEffect(() => {
    let disposed = false;
    setTerminals(undefined); setError(undefined);
    if (!client) { setError('This Host is unavailable.'); return; }
    void client.listTerminals(reference.workspaceId).then(({ terminals }) => {
      if (!disposed) setTerminals(terminals.filter((terminal) => terminal.workspaceId === reference.workspaceId && terminal.status === 'running'));
    }).catch((cause) => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; };
  }, [client, reference.hostId, reference.workspaceId]);
  return <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
    <DialogContent>
      <DialogHeader><DialogTitle>Use a running terminal</DialogTitle><DialogDescription>{context?.hostName} · {context?.canonicalPath ?? context?.name ?? 'Saved workspace'}</DialogDescription></DialogHeader>
      {(error || controller.model.workspaceCompositions?.error) && <Alert variant='destructive'><AlertDescription>{error ?? controller.model.workspaceCompositions?.error}</AlertDescription></Alert>}
      <div className='flex max-h-80 flex-col gap-2 overflow-y-auto'>
        {terminals?.map((terminal) => <Button key={terminal.terminalId} type='button' variant='outline' className='justify-between' disabled={saving} data-terminal-id={terminal.terminalId} aria-label={`Use terminal ${terminal.title} (${terminal.terminalId.slice(-8)})`} onClick={() => {
          setSaving(true);
          void controller.workspaceActions?.adoptTerminal(reference, paneId, terminal.terminalId).then((saved) => { if (saved) onClose(); }).finally(() => setSaving(false));
        }}><span className='truncate'>{terminal.title}</span><span>{terminal.terminalId.slice(-8)} · {terminal.cols}×{terminal.rows}</span></Button>)}
        {!error && (!terminals || !terminals.length) && <Empty><EmptyHeader><EmptyTitle>{terminals ? 'No running terminals' : 'Loading terminals…'}</EmptyTitle><EmptyDescription>{terminals ? 'Start a new shell from this pane when you are ready.' : 'Checking the selected Host directory.'}</EmptyDescription></EmptyHeader></Empty>}
      </div>
      <DialogFooter><Button variant='outline' disabled={saving} onClick={onClose}>Cancel</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
