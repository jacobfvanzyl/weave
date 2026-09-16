import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowExpand01Icon, ArrowShrink01Icon, Cancel01Icon } from '@hugeicons/core-free-icons';
import type { ClientBrowserPane } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import type { WorkspaceReference } from '@/app/workspace-presentation';
import { paneOverlayOpen, paneRendered, paneVisible, usePaneFocusAdapter } from '@/app/pane-focus';
import { clientBrowserAvailable, clientBrowserPrototype, type ClientBrowserSnapshot } from '@/client-browser/native-client-browser';
import { workspaceClientBrowser } from '@/client-browser/workspace-client-browser';
import { PaneFrame } from './pane-frame';
import { PaneSplitMenu } from './pane-split-menu';
import { Button } from './ui/button';
import { Alert, AlertDescription } from './ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';

export function ClientBrowserSurface({ controller, reference, node, focused, maximized }: { controller: AlphaController; reference: WorkspaceReference; node: ClientBrowserPane; focused: boolean; maximized: boolean }) {
  const slot = useRef<HTMLDivElement>(null), latest = useRef(controller), latestFocused = useRef(focused); latest.current = controller; latestFocused.current = focused;
  const { owner, id } = usePaneFocusAdapter();
  const [snapshot, setSnapshot] = useState<ClientBrowserSnapshot>(), [error, setError] = useState<string>();
  const [closing, setClosing] = useState(false), [pending, setPending] = useState(false), [moving, setMoving] = useState(false);
  const available = controller.model.connections.some(connection => connection.hostId === reference.hostId && connection.status === 'connected');
  useEffect(() => {
    if (!clientBrowserAvailable || !slot.current) return;
    const element = slot.current;
    let disposed = false, closed = false, surfaceId: string | undefined, frame = 0, reading = false;
    const report = (cause: unknown) => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); };
    const measure = () => {
      if (frame || disposed) return;
      frame = requestAnimationFrame(() => {
        frame = 0; if (!surfaceId || disposed || closed) return;
        const rect = element.getBoundingClientRect();
        void clientBrowserPrototype.layout({ surfaceId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: !document.hidden && paneRendered(element), blocked: paneOverlayOpen() || !paneVisible(element) }).catch(report);
      });
    };
    const resize = new ResizeObserver(measure); resize.observe(element);
    const mutation = new MutationObserver(measure); mutation.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'inert', 'aria-hidden'] });
    document.addEventListener('visibilitychange', measure); window.addEventListener('resize', measure);
    const listener = clientBrowserPrototype.addListener('event', event => {
      if (event.kind === 'focused' && event.surfaceId === surfaceId && !disposed && id && owner?.didFocus(id) && !latestFocused.current) latest.current.workspaceActions?.focus(reference, node.paneId);
    });
    const unregister = id && owner?.register(id, { element, available: () => Boolean(surfaceId) && paneVisible(element), focus: async isCurrent => {
      if (!surfaceId || !isCurrent()) return false;
      await clientBrowserPrototype.focus({ surfaceId }); return isCurrent();
    } });
    void workspaceClientBrowser.attach({ ...reference, paneId: node.paneId, initialUrl: node.initialUrl }).then(result => {
      surfaceId = result.surfaceId;
      if (disposed) return workspaceClientBrowser.detach(surfaceId);
      element.dataset.clientBrowserSurface = surfaceId; owner?.ready(); measure();
    }).catch(report);
    const poll = setInterval(() => {
      if (!surfaceId || disposed || closed || reading) return; reading = true;
      void clientBrowserPrototype.snapshot({ surfaceId }).then(value => { if (!disposed) { if (value.closed) { closed = true; return; } setSnapshot(value); if (value.focused && !latestFocused.current && id && owner?.didFocus(id)) latest.current.workspaceActions?.focus(reference, node.paneId); } }).catch(report).finally(() => { reading = false; });
    }, 500);
    return () => {
      disposed = true; void listener.then(handle => handle.remove()); clearInterval(poll); cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); unregister && unregister();
      document.removeEventListener('visibilitychange', measure); window.removeEventListener('resize', measure);
      if (surfaceId) void workspaceClientBrowser.detach(surfaceId).catch(() => {});
    };
  }, [reference.hostId, node.paneId, node.initialUrl, owner, id]);
  const perform = async (action: () => Promise<unknown>) => { setPending(true); setError(undefined); try { await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setPending(false); } };
  const workspaces = controller.model.workspaceCompositions?.compositions[reference.hostId]?.workspaces ?? [];
  return <section className='flex min-h-0 min-w-0 flex-1 flex-col' aria-label='Client Browser pane' data-focused={focused || undefined}>
    <PaneFrame focused={focused} title={snapshot?.title || 'Client Browser'} actions={<>
      <PaneSplitMenu sourceType='client-browser' disabled={!available || pending} onSplit={(axis, type) => void perform(async () => controller.actions.splitPane?.(reference, node.paneId, axis, type))} />
      <Button size='rail' variant='ghost' aria-label='Move Client Browser' disabled={!available || pending} onClick={() => setMoving(true)}>Move</Button>
      <Button size='rail' variant='ghost' aria-label={maximized ? 'Restore Client Browser' : 'Maximize Client Browser'} onClick={() => controller.workspaceActions?.maximize(reference, node.paneId)}><HugeiconsIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} /></Button>
      <Button size='rail' variant='ghost' aria-label='Close Client Browser' disabled={!available || pending} onClick={() => setClosing(true)}><HugeiconsIcon icon={Cancel01Icon} /></Button>
    </>}>
      {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      {clientBrowserAvailable ? <div ref={slot} data-slot='client-browser' className='min-h-0 min-w-0 flex-1' /> : <p className='p-4'>Client Browser requires an enabled Apple build on macOS 26 or iPadOS 26 or later. Its Workspace placement is retained.</p>}
    </PaneFrame>
    <Dialog open={closing} onOpenChange={setClosing}><DialogContent><DialogHeader><DialogTitle>Close Client Browser?</DialogTitle><DialogDescription>This closes the page on every device when it reconnects. Each device keeps its address and profile for reopening. Unsent forms are lost and active page downloads are cancelled.</DialogDescription></DialogHeader><DialogFooter><Button variant='outline' onClick={() => setClosing(false)}>Cancel</Button><Button variant='destructive' disabled={pending} onClick={() => void perform(async () => { await controller.actions.closeClientBrowserPane?.(reference, node.paneId); setClosing(false); })}>Close page</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={moving} onOpenChange={setMoving}><DialogContent><DialogHeader><DialogTitle>Move Client Browser</DialogTitle><DialogDescription>Choose another Workspace on this Host. Each device keeps its live page.</DialogDescription></DialogHeader>{workspaces.filter(workspace => workspace.workspaceId !== reference.workspaceId).map(workspace => <Button key={workspace.workspaceId} data-client-browser-destination={workspace.workspaceId} disabled={pending} onClick={() => void perform(async () => { await controller.actions.moveClientBrowserPane?.(reference, node.paneId, workspace.workspaceId); setMoving(false); })}>{workspace.name}</Button>)}{workspaces.length < 2 && <p>Create another Workspace on this Host first.</p>}</DialogContent></Dialog>
  </section>;
}
