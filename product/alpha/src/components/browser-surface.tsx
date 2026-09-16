import { usePaneFocusAdapter } from '@/app/pane-focus';
import { nativeSoftwareKeyboard } from '@/terminal/native-terminal';
import { BrowserProfileButton } from './browser-profile-button';
import { useEffect, useRef, useState } from 'react';
import type { BrowserPage, PaneLayoutNode } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import type { WorkspaceReference } from '@/app/workspace-presentation';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon, RefreshIcon, Cancel01Icon, ArrowExpand01Icon, ArrowShrink01Icon } from '@hugeicons/core-free-icons';
import { NativeBrowserView } from './native-browser-view';
import { nativeBrowserAvailable } from '@/browser/native-browser';
import { PaneFrame } from './pane-frame';
import { PaneSplitMenu } from './pane-split-menu';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Alert, AlertDescription } from './ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
export function BrowserSurface({ controller, reference, node, focused, maximized }: { controller: AlphaController; reference: WorkspaceReference; node: Extract<PaneLayoutNode,{kind:'browser'}>; focused:boolean; maximized:boolean }) {
  const {owner,id}=usePaneFocusAdapter();
  const client = controller.browserClient?.(reference.hostId);
  const [page, setPage] = useState<BrowserPage>(), [address,setAddress] = useState(node.lastCommittedUrl === 'about:blank' ? '' : node.lastCommittedUrl), [error,setError] = useState<string>(), [closing,setClosing] = useState(false), [pending,setPending] = useState(false);
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
    const result = method === 'browser.page.navigate' ? await client.browserRequest(method,{...target,url:!address.trim() ? 'about:blank' : /^[a-z][a-z0-9+.-]*:\/\//i.test(address.trim()) || address.trim() === 'about:blank' ? address.trim() : `https://${address.trim()}`}) : await client.browserRequest(method,target);
    addressDirty.current = false; setPage(result.page);
  };
  const close = async () => { if (!client) return; setPending(true); await perform(async () => {
    const composition = controller.model.workspaceCompositions?.compositions[reference.hostId]; if (!composition) throw new Error('Workspace is unavailable');
    await client.browserRequest('browser.pane.close',{hostId:reference.hostId,expectedRevision:composition.revision,paneId:node.paneId,profileId:node.profileId,generation:page?.generation,confirmed:true});
    setClosing(false); await controller.workspaceActions?.refresh();
  }); setPending(false); };
  return <section className='flex min-h-0 min-w-0 flex-1 flex-col' data-focused={focused || undefined} aria-label='Browser pane' data-browser-page={node.paneId} data-browser-host={reference.hostId} onKeyDownCapture={event => {
    if (!focused || event.altKey && !(event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
    const command=event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'l') { event.preventDefault(); event.stopPropagation(); addressInput.current?.focus(); addressInput.current?.select(); }
    else {
      const method = command && event.key.toLowerCase() === 'r' || event.key === 'F5' ? 'browser.page.reload' : command && event.key === '[' || event.altKey && event.key === 'ArrowLeft' ? 'browser.page.back' : command && event.key === ']' || event.altKey && event.key === 'ArrowRight' ? 'browser.page.forward' : undefined;
      if (method) { event.preventDefault(); event.stopPropagation(); void perform(() => navigate(method)); }
    }
  }}>
    <PaneFrame focused={focused} title={page?.title || 'Browser'} actions={<>
      <PaneSplitMenu sourceType='browser' disabled={!client || pending} onSplit={(axis,type) => void perform(async () => controller.actions.splitPane?.(reference,node.paneId,axis,type))} />
      <Button size='rail' variant='ghost' aria-label={maximized ? 'Restore browser' : 'Maximize browser'} onClick={() => controller.workspaceActions?.maximize(reference,node.paneId)}><HugeiconsIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} /></Button>
      <Button size='rail' variant='ghost' aria-label='Close browser' onClick={() => setClosing(true)}><HugeiconsIcon icon={Cancel01Icon} /></Button>
    </>}>
      <form className='flex shrink-0 items-center gap-1 border-b p-1' onSubmit={event => { event.preventDefault(); if (nativeSoftwareKeyboard && id) owner?.browse(id); else addressInput.current?.blur(); void perform(() => navigate('browser.page.navigate')); }}>
        <Button type='button' size='icon-sm' variant='ghost' aria-label='Back' disabled={!page?.canGoBack} onClick={() => void perform(() => navigate('browser.page.back'))}><HugeiconsIcon icon={ArrowLeft01Icon} /></Button>
        <Button type='button' size='icon-sm' variant='ghost' aria-label='Forward' disabled={!page?.canGoForward} onClick={() => void perform(() => navigate('browser.page.forward'))}><HugeiconsIcon icon={ArrowRight01Icon} /></Button>
        <Button type='button' size='icon-sm' variant='ghost' aria-label='Reload' disabled={!page?.available} onClick={() => void perform(() => navigate('browser.page.reload'))}><HugeiconsIcon icon={RefreshIcon} /></Button>
        <Input ref={addressInput} aria-label='Browser address' placeholder='Enter URL' onFocus={() => controller.workspaceActions?.focus(reference,node.paneId)} value={address} onChange={event => { addressDirty.current=true; setAddress(event.target.value); }} autoCapitalize='none' autoCorrect='off' spellCheck={false} />
        <BrowserProfileButton client={client} page={page} select={async selectedProfileId => {
          if (!client) return; const composition=controller.model.workspaceCompositions?.compositions[reference.hostId]; if (!composition) throw new Error('Workspace is unavailable');
          const result=await client.browserRequest('browser.pane.profile',{hostId:reference.hostId,paneId:node.paneId,profileId:node.profileId,selectedProfileId,expectedRevision:composition.revision});
          setPage(result.page); await controller.workspaceActions?.refresh();
        }} />
      </form>
      {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      {page?.available && client && nativeBrowserAvailable ? <NativeBrowserView client={client} page={page} focused={focused} addressInput={blank ? addressInput : undefined} /> : <div className='flex flex-col items-start gap-2 p-4'><p>{!client ? 'Connect to the Host to view this page.' : !page ? 'Opening browser…' : !page.available ? 'This page needs to be restored after its browser stopped.' : 'Native browser display is unavailable in this client.'}</p>{client && page && !page.available && <Button onClick={() => void perform(async () => { setPage((await client.browserRequest('browser.page.restore',{profileId:node.profileId,pageId:node.paneId})).page); })}>Restore page</Button>}</div>}
    </PaneFrame>
    <Dialog open={closing} onOpenChange={setClosing}><DialogContent><DialogHeader><DialogTitle>Close Browser Pane?</DialogTitle><DialogDescription>This closes the page on every device. Unsaved browser work may be lost.</DialogDescription></DialogHeader><DialogFooter><Button variant='outline' disabled={pending} onClick={() => setClosing(false)}>Cancel</Button><Button variant='destructive' disabled={pending} onClick={() => void close()}>Close page</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
