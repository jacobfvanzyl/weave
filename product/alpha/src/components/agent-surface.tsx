import { BrowserGrantsDialog } from './browser-grants-dialog';
import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowExpand01Icon, ArrowShrink01Icon, Archive02Icon, Globe02Icon } from '@hugeicons/core-free-icons';
import type { AlphaController } from '@/app/alpha-controller';
import type { WorkspaceReference } from '@/app/workspace-presentation';
import { DraftChip } from './draft-chip';
import { PaneFrame } from './pane-frame';
import { PaneSplitMenu } from './pane-split-menu';
import { WorkspacePlaceholder } from './workspace-placeholder';
import { Button } from './ui/button';
import { Alert, AlertDescription } from './ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from './ui/dialog';

export function AgentSurface({ controller, threadId, reference, paneId, focused, visible, maximized, compact }: {
  controller: AlphaController; threadId?: string; reference: WorkspaceReference; paneId: string;
  focused: boolean; visible: boolean; maximized: boolean; compact: boolean;
}) {
  const scoped = threadId ? controller.forThread?.(threadId) : undefined;
  const thread = controller.model.threads?.find(thread => thread.id === threadId);
  const connected = controller.model.connections.find(connection => connection.hostId === reference.hostId)?.status === 'connected';
  const latest = useRef(controller); latest.current = controller;
  const [browserAccess, setBrowserAccess] = useState(false);
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false), [closing, setClosing] = useState(false);
  const [retry, setRetry] = useState(0);
  const [splitting, setSplitting] = useState(false);
  const split = async (axis: 'horizontal' | 'vertical', type: 'terminal' | 'agent' | 'browser') => {
    if (!threadId || !controller.actions.splitPane) return;
    setSplitting(true); setError(undefined);
    try { await controller.actions.splitPane(reference, paneId, axis, type); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSplitting(false); }
  };
  useEffect(() => {
    if (!threadId || !visible || !connected) return;
    let cancelled = false; setError(undefined);
    void latest.current.attachThread?.(threadId).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [threadId, visible, connected, retry]);
  useEffect(() => {
    if (!focused || !visible || !threadId) return;
    const update = () => latest.current.actions.setFocusedAgentThread?.(document.hidden ? undefined : threadId);
    update(); document.addEventListener('visibilitychange', update);
    return () => { document.removeEventListener('visibilitychange', update); latest.current.actions.setFocusedAgentThread?.(undefined); };
  }, [focused, visible, threadId]);
  const close = async (stop = false) => {
    if (!threadId || !scoped) return;
    setClosing(true); setError(undefined);
    try {
      // Portal refuses to archive a running Thread, including work that starts
      // after this client's observation. A failed close retains the Pane.
      await scoped.actions.archiveThread(threadId, stop);
      setConfirming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setClosing(false); }
  };
  const requestClose = () => {
    if (thread?.draft) { void controller.actions.discardThreadDraft?.(thread.id); return; }
    const active = scoped?.model.transcript?.turn.status === 'running' || !thread?.attention || !['idle', 'completed'].includes(thread.attention.state);
    if (active) setConfirming(true); else void close();
  };
  return <section aria-label={`Agent pane ${thread?.title ?? paneId}`} data-thread-id={threadId} className='flex min-h-0 min-w-0 flex-1 flex-col'>
    <PaneFrame focused={focused} title={thread?.draft || !thread?.title?.trim() ? <DraftChip /> : thread.title} actions={<>
      {thread && !thread.draft && controller.browserClient && <Button size='rail' variant='ghost' aria-label='Browser access' title='Browser access' disabled={!connected} onClick={() => setBrowserAccess(true)}><HugeiconsIcon icon={Globe02Icon} data-icon='inline-start' strokeWidth={2} /></Button>}
      {!compact && <PaneSplitMenu sourceType='agent' disabled={!connected || splitting || closing || !threadId || !controller.actions.splitPane} onSplit={(axis, type) => void split(axis, type)} />}
      {!compact && <Button size='rail' variant='ghost' aria-label={maximized ? 'Restore agent pane' : 'Maximize agent pane'} aria-pressed={maximized} onClick={() => controller.workspaceActions?.maximize(reference, paneId)}><HugeiconsIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} strokeWidth={2} /></Button>}
      <Button size='rail' variant='ghost' aria-label={thread?.draft ? 'Discard draft pane' : 'Archive agent pane'} title={thread?.draft ? 'Discard draft pane' : 'Archive agent pane'} disabled={(!connected && !thread?.draft) || closing || splitting || scoped?.model.busy || !scoped} onClick={requestClose}><HugeiconsIcon icon={Archive02Icon} strokeWidth={2} /></Button>
    </>}>
      {error && <Alert variant='destructive'><AlertDescription>{error}<Button variant='outline' size='sm' onClick={() => setRetry(value => value + 1)}>Retry connection</Button></AlertDescription></Alert>}
      {scoped ? <WorkspacePlaceholder controller={scoped} showHeader={false} showFooter={false} preserveDraft inputFocusRequest={null} /> : <p className='p-4 text-sm text-muted-foreground'>Loading Thread…</p>}
    </PaneFrame>
    {thread && !thread.draft && <BrowserGrantsDialog controller={controller} hostId={reference.hostId} threadId={thread.threadId} open={browserAccess} onOpenChange={setBrowserAccess} />}
    <Dialog open={confirming} onOpenChange={open => { if (!closing) setConfirming(open); }}><DialogContent>
      <DialogHeader><DialogTitle>Archive Agent Pane?</DialogTitle><DialogDescription>This stops active work and archives the Thread on every device. The conversation remains available in Archived Threads.</DialogDescription></DialogHeader>
      {error && <p role='alert' className='text-destructive'>{error}</p>}
      <div className='flex justify-end gap-2'><Button variant='outline' disabled={closing} onClick={() => setConfirming(false)}>Keep open</Button><Button disabled={closing} onClick={() => void close(true)}>Stop and archive</Button></div>
    </DialogContent></Dialog>
  </section>;
}
