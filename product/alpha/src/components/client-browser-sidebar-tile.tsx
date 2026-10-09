import { useEffect, useState } from 'react';
import { clientBrowserAvailable, type ClientBrowserSnapshot } from '@/client-browser/native-client-browser';
import { workspaceClientBrowser } from '@/client-browser/workspace-client-browser';
import { SidebarMenuItem, SidebarMenuButton } from './ui/sidebar';
import { BrowserSiteIcon, browserPageLabel } from './browser-site-icon';

export function ClientBrowserSidebarTile({ hostId, paneId, initialUrl, active, select }: { hostId: string; paneId: string; initialUrl: string; active: boolean; select(): void }) {
  const [page, setPage] = useState<ClientBrowserSnapshot>();
  useEffect(() => {
    setPage(undefined);
    if (!clientBrowserAvailable) return;
    let disposed = false, busy = false;
    const refresh = async () => {
      if (busy || disposed) return; busy = true;
      try {
        const snapshot = await workspaceClientBrowser.metadata(hostId, paneId);
        if (!disposed) setPage(snapshot);
      } catch { /* Retain last known local metadata during a transient bridge failure. */ }
      finally { busy = false; }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [hostId, paneId]);
  const title = page?.title.trim() || browserPageLabel(page?.url || initialUrl);
  return <SidebarMenuItem data-pane-id={paneId}>
    <SidebarMenuButton className='data-active:bg-terminal-focus data-active:text-terminal-focus-foreground data-active:hover:bg-terminal-focus data-active:hover:text-terminal-focus-foreground' isActive={active} aria-pressed={active} aria-label={`Client Browser ${title}`} title={page?.url || initialUrl} onClick={select}>
      <BrowserSiteIcon faviconUrl={page?.faviconUrl} />
      <span className='min-w-0 flex-1 truncate'>{title}</span>
    </SidebarMenuButton>
  </SidebarMenuItem>;
}
