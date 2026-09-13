import { useEffect, useState } from 'react';
import type { AlphaController } from '@/app/alpha-controller';
import { HugeiconsIcon } from '@hugeicons/react';
import { Globe02Icon } from '@hugeicons/core-free-icons';
import { SidebarMenuItem, SidebarMenuButton } from './ui/sidebar';
export function BrowserSidebarTile({ controller, hostId, paneId, profileId, active, select }: { controller:AlphaController; hostId:string; paneId:string; profileId:string; active:boolean; select():void }) {
  const [title,setTitle] = useState('Browser'), client = controller.browserClient?.(hostId);
  useEffect(() => {
    if (!client) return; let disposed = false, busy = false;
    const refresh = async () => { if (busy || disposed) return; busy = true; try { const { page } = await client.browserRequest('browser.page.get',{profileId,pageId:paneId}); if (!disposed) setTitle(page.title || 'Browser'); } catch {} finally { busy = false; } };
    void refresh(); const timer=setInterval(() => void refresh(),2000); return () => { disposed=true; clearInterval(timer); };
  },[client,paneId,profileId]);
  return <SidebarMenuItem data-pane-id={paneId}><SidebarMenuButton className='data-active:bg-terminal-focus data-active:text-terminal-focus-foreground data-active:hover:bg-terminal-focus data-active:hover:text-terminal-focus-foreground' isActive={active} aria-label={`Browser ${title}`} aria-pressed={active} onClick={select}><HugeiconsIcon icon={Globe02Icon} /><span className='min-w-0 flex-1 truncate'>{title}</span></SidebarMenuButton></SidebarMenuItem>;
}
