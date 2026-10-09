import { usePaneFocusAdapter } from '@/app/pane-focus';
import { nativeSoftwareKeyboard } from '@/terminal/native-terminal';
import { HostBrowserProfileButton } from './host-browser-profile-button';
import { useEffect, useRef, useState } from 'react';
import type { HostBrowserPage, PaneLayoutNode } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import type { WorkspaceReference } from '@/app/workspace-presentation';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, ArrowExpand01Icon, ArrowShrink01Icon } from '@hugeicons/core-free-icons';
import { NativeHostBrowserView } from './native-browser-view';
import { nativeBrowserAvailable } from '@/browser/native-browser';
import { PaneFrame } from './pane-frame';
import { PaneSplitMenu } from './pane-split-menu';
import { Button } from './ui/button';
import { BrowserToolbar, browserAddress, browserShortcut } from './browser-toolbar';
import { Alert, AlertDescription } from './ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
export function HostBrowserSurface({ controller, reference, node, focused, maximized }: { controller: AlphaController; reference: WorkspaceReference; node: Extract<PaneLayoutNode,{kind:'host-browser'}>; focused:boolean; maximized:boolean }) {
  const {owner,id}=usePaneFocusAdapter();
  const client = controller.browserClient?.(reference.hostId);
  const [page, setPage] = useState<HostBrowserPage>(), [address,setAddress] = useState(node.lastCommittedUrl === 'about:blank' ? '' : node.lastCommittedUrl), [error,setError] = useState<string>(), [closing,setClosing] = useState(false), [pending,setPending] = useState(false);
  const addressInput = useRef<HTMLInputElement>(null), addressDirty = useRef(false);
  const blank = (page?.url ?? node.lastCommittedUrl) === 'about:blank';
  const perform = async (action: () => Promise<unknown>) => { try { setError(undefined); await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } };
  useEffect(() => {
    if (!client) return;
    let disposed = false, running = false;
    const refresh = async () => {
      if (running || disposed) return; running = true;
      try { const { page } = await client.browserRequest('browser.page.get', { profileId:node.profileId,pageId:node.paneId }); if (!disposed) { setPage(page); } }
      catch (cause) { if (!disposed) setError(String(cause)); }
      finally { running = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(),1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [client,node.paneId,node.profileId]);
  useEffect(() => { if (!addressDirty.current) { const url=page?.url ?? node.lastCommittedUrl; setAddress(url === 'about:blank' ? '' : url); } }, [page?.url,node.lastCommittedUrl]);
  useEffect(() => { if (focused && blank) addressInput.current?.focus(); }, [focused, blank]);
  const navigate = async (method:'browser.page.navigate'|'browser.page.back'|'browser.page.forward'|'browser.page.reload') => {
    if (!client || !page?.generation) return;
    const target = { profileId:node.profileId,pageId:node.paneId,generation:page.generation };
    const result = method === 'browser.page.navigate' ? await client.browserRequest(method,{...target,url:browserAddress(address)}) : await client.browserRequest(method,target);
    addressDirty.current = false; setPage(result.page);
  };
  const close = async () => { if (!client) return; setPending(true); await perform(async () => {
    const composition = controller.model.workspaceCompositions?.compositions[reference.hostId]; if (!composition) throw new Error('Workspace is unavailable');
    await client.browserRequest('browser.pane.close',{hostId:reference.hostId,expectedRevision:composition.revision,paneId:node.paneId,profileId:node.profileId,generation:page?.generation,confirmed:true});
    setClosing(false); await controller.workspaceActions?.refresh();
  }); setPending(false); };
  return <section className='flex min-h-0 min-w-0 flex-1 flex-col' data-focused={focused || undefined} aria-label='Host Browser pane' data-browser-page={node.paneId} data-browser-host={reference.hostId} onKeyDownCapture={event => {
    if (!focused) return;
    const action = browserShortcut(event);
    if (!action) return;
    event.preventDefault(); event.stopPropagation();
    if (action === 'address') { addressInput.current?.focus(); addressInput.current?.select(); }
    else void perform(() => navigate(`browser.page.${action}`));
  }}>
    <PaneFrame focused={focused} title={page?.title || 'Host Browser'} actions={<>
      <PaneSplitMenu sourceType='host-browser' disabled={!client || pending} onSplit={(axis,type) => void perform(async () => controller.actions.splitPane?.(reference,node.paneId,axis,type))} />
      <Button size='rail' variant='ghost' aria-label={maximized ? 'Restore Host Browser' : 'Maximize Host Browser'} onClick={() => controller.workspaceActions?.maximize(reference,node.paneId)}><HugeiconsIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} /></Button>
      <Button size='rail' variant='ghost' aria-label='Close Host Browser' onClick={() => setClosing(true)}><HugeiconsIcon icon={Cancel01Icon} /></Button>
    </>}>
      <BrowserToolbar address={address} addressLabel='Host Browser address' addressInput={addressInput}
        onAddressFocus={() => controller.workspaceActions?.focus(reference,node.paneId)}
        onAddressChange={value => { addressDirty.current = true; setAddress(value); }}
        canGoBack={page?.canGoBack} canGoForward={page?.canGoForward} available={page?.available}
        onNavigate={action => void perform(() => navigate(`browser.page.${action}`))}
        onSubmit={() => { if (nativeSoftwareKeyboard && id) owner?.browse(id); else addressInput.current?.blur(); void perform(() => navigate('browser.page.navigate')); }}
        profile={<HostBrowserProfileButton client={client} page={page} select={async selectedProfileId => {
          if (!client) return; const composition=controller.model.workspaceCompositions?.compositions[reference.hostId]; if (!composition) throw new Error('Workspace is unavailable');
          const result=await client.browserRequest('browser.pane.profile',{hostId:reference.hostId,paneId:node.paneId,profileId:node.profileId,selectedProfileId,expectedRevision:composition.revision});
          setPage(result.page); await controller.workspaceActions?.refresh();
        }} />} />
      {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      {page?.available && client && nativeBrowserAvailable ? <NativeHostBrowserView client={client} page={page} focused={focused} addressInput={blank ? addressInput : undefined} /> : <div className='flex flex-col items-start gap-2 p-4'><p>{!client ? 'Connect to the Host to view this page.' : !page ? 'Opening browser…' : !page.available ? 'This page needs to be restored after its browser stopped.' : 'Native browser display is unavailable in this client.'}</p>{client && page && !page.available && <Button onClick={() => void perform(async () => { setPage((await client.browserRequest('browser.page.restore',{profileId:node.profileId,pageId:node.paneId})).page); })}>Restore page</Button>}</div>}
    </PaneFrame>
    <Dialog open={closing} onOpenChange={setClosing}><DialogContent><DialogHeader><DialogTitle>Close Host Browser Pane?</DialogTitle><DialogDescription>This closes the page on every device. Unsaved browser work may be lost.</DialogDescription></DialogHeader><DialogFooter><Button variant='outline' disabled={pending} onClick={() => setClosing(false)}>Cancel</Button><Button variant='destructive' disabled={pending} onClick={() => void close()}>Close page</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
