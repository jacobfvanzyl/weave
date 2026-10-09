import { useEffect, useState } from 'react';
import type { AlphaController } from '@/app/alpha-controller';
import type { HostBrowserPage } from '@weave/product-protocol';
import { SidebarMenuItem, SidebarMenuButton } from './ui/sidebar';
import { BrowserSiteIcon, browserPageLabel } from './browser-site-icon';
export function HostBrowserSidebarTile({ controller, hostId, paneId, profileId, active, select }: { controller:AlphaController; hostId:string; paneId:string; profileId:string; active:boolean; select():void }) {
  const [page,setPage] = useState<HostBrowserPage>(), client = controller.browserClient?.(hostId);
  useEffect(() => {
    setPage(undefined);
    if (!client) return; let disposed = false, busy = false;
    const refresh = async () => { if (busy || disposed) return; busy = true; try { const { page } = await client.browserRequest('browser.page.get',{profileId,pageId:paneId}); if (!disposed) setPage(page); } catch {} finally { busy = false; } };
    void refresh(); const timer=setInterval(() => void refresh(),2000); return () => { disposed=true; clearInterval(timer); };
  },[client,paneId,profileId]);
  const title = page?.title.trim() || (page ? browserPageLabel(page.url) : 'Agent Browser');
  return <SidebarMenuItem data-pane-id={paneId}><SidebarMenuButton className='data-active:bg-terminal-focus data-active:text-terminal-focus-foreground data-active:hover:bg-terminal-focus data-active:hover:text-terminal-focus-foreground' isActive={active} aria-label={`Agent Browser ${title}`} aria-pressed={active} title={page ? `Agent Browser · ${page.url}` : 'Agent Browser'} onClick={select}><BrowserSiteIcon faviconUrl={page?.faviconUrl} agent /><span className='min-w-0 flex-1 truncate'>{title}</span></SidebarMenuButton></SidebarMenuItem>;
}
