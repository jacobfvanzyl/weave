import { type CSSProperties, useState } from 'react';
import type { AlphaController } from '@/app/alpha-controller';
import { SidebarInset, SidebarProvider, useSidebar } from './ui/sidebar';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { Button } from './ui/button';
import { WorkspaceSidebar } from './workspace-sidebar';
import { WorkspaceCanvas } from './workspace-canvas';
import { WorkspacePlaceholder } from './workspace-placeholder';
import { GlobalBottomRail } from './global-bottom-rail';
import { cn } from '@/lib/utils';

function Content({ controller }: { controller: AlphaController }) {
  const sidebar = useSidebar();
  const [conversationOpen, setConversationOpen] = useState(true);
  return <>
    <div className='flex min-h-0 min-w-0 flex-1 overflow-hidden'>
      <WorkspaceSidebar controller={controller} />
      <SidebarInset className='min-h-0 min-w-0 overflow-hidden'>
        <ResizablePanelGroup orientation={sidebar.isMobile ? 'vertical' : 'horizontal'} id='terminal-agent-layout'>
          <ResizablePanel id='terminal-workspace' defaultSize='65%' minSize='25%' className='flex min-h-0 min-w-0'><WorkspaceCanvas controller={controller} /></ResizablePanel>
          {conversationOpen && <>
            <ResizableHandle aria-label='Resize terminal workspace and agent conversation' />
            <ResizablePanel id='agent-conversation' minSize='25%' defaultSize='35%' className='flex min-h-0 min-w-0'><section aria-label='Selected agent conversation' className='flex min-h-0 min-w-0 flex-1'><WorkspacePlaceholder controller={controller} showFooter={false} /></section></ResizablePanel>
          </>}
        </ResizablePanelGroup>
      </SidebarInset>
    </div>
    <GlobalBottomRail controller={controller} threadsVisible={sidebar.open} threadsToggleDisabled={false} onToggleThreads={sidebar.toggleSidebar} dockActions={<Button size='sm' variant='ghost' aria-pressed={conversationOpen} onClick={() => setConversationOpen((value) => !value)}>Agent conversation</Button>} />
  </>;
}
export function TerminalFirstShell({ controller }: { controller: AlphaController }) {
  return <SidebarProvider cookieName={false} keyboardShortcut={false} className={cn('fixed inset-x-0 top-[var(--alpha-viewport-top,0px)] h-[var(--alpha-viewport-height,100dvh)] min-h-0 flex-col overflow-hidden', controller.model.platform === 'ios' && 'pt-[env(safe-area-inset-top)]')}
    style={{ '--sidebar-width': '18rem', '--sidebar-width-mobile': '18rem', '--bottom-rail-height': '2rem' } as CSSProperties}>
    <Content controller={controller} />
  </SidebarProvider>;
}
