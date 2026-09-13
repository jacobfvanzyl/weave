import { usePhoneLayout } from '@/app/use-phone-layout';
import { CompactShell } from './compact-shell';
import { PaneFocusProvider, usePaneFocus, agentFocusId, terminalFocusId } from '@/app/pane-focus';
import { type CSSProperties, useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { SidebarLeftIcon } from '@hugeicons/core-free-icons';
import { paneTargets } from '@weave/product-protocol';
import { useDesktopTitlebar } from '@/app/use-desktop-titlebar';
import type { AlphaController } from '@/app/alpha-controller';
import { SidebarInset, SidebarProvider, useSidebar } from './ui/sidebar';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { Button } from './ui/button';
import { WorkspaceSidebar } from './workspace-sidebar';
import { WorkspaceCanvas } from './workspace-canvas';
import { cn } from '@/lib/utils';
import { useDevicePaneSize } from '@/app/device-pane-size';
import { alphaPaneMinimumWidth, alphaSidebarMinimumWidth, alphaSidebarWidthStorageKey } from '@/app/alpha-pane-layout';
import { workspaceKey, type WorkspaceReference } from '@/app/workspace-presentation';

const minimumPaneSize = `${alphaPaneMinimumWidth}px`;
const minimumSidebarSize = `${alphaSidebarMinimumWidth}px`;
function Content({ controller }: { controller: AlphaController }) {
  useDesktopTitlebar(true);
  const sidebar = useSidebar();
  const focus = usePaneFocus()!;
  const state = controller.model.workspaceCompositions!;
  const [sidebarSize, rememberSidebarSize] = useDevicePaneSize(alphaSidebarWidthStorageKey);
  const reference = state.presentation.openWorkspaces.find(ref => workspaceKey(ref) === state.presentation.activeWorkspace);
  const workspace = reference && state.compositions[reference.hostId]?.workspaces.find(workspace => workspace.workspaceId === reference.workspaceId);
  const panes = workspace ? paneTargets([workspace]) : [];
  const focused = reference && (state.presentation.maximizedPanes[workspaceKey(reference)] ?? state.presentation.focusedPanes[workspaceKey(reference)]);
  const pane = panes.find(pane => pane.paneId === focused) ?? panes[0];
  const thread = pane?.kind === 'agent' && controller.model.threads?.find(thread => thread.hostId === reference?.hostId && thread.threadId === pane.threadId);
  const target = pane && reference ? thread ? agentFocusId(thread.id) : terminalFocusId(workspaceKey(reference), pane.paneId) : undefined;
  useEffect(() => {
    focus.setFallbacks(target ? [target] : []);
    if (target) {
      if (controller.model.platform === 'ios') focus.browse(target); else focus.request(target);
    } else focus.browse();
  }, [focus, target]);
  const selectPane = (ref: WorkspaceReference, paneId: string) => {
    controller.workspaceActions?.focus(ref, paneId); sidebar.setOpenMobile(false);
  };
  const selectAgent = (id: string) => { void controller.actions.selectThread(id, { preserveDraft: true }); sidebar.setOpenMobile(false); };
  const sidebarToggle = <Button data-slot='sidebar-toggle' size='rail' variant='ghost' aria-label='Toggle threads' title='Toggle threads' aria-pressed={sidebar.isMobile ? sidebar.openMobile : sidebar.open} className={cn((sidebar.isMobile ? sidebar.openMobile : sidebar.open) && 'text-primary')} onClick={sidebar.toggleSidebar}><HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} /></Button>;
  const workspaceSidebar = <WorkspaceSidebar controller={controller} onSelectThread={selectAgent} onSelectTerminal={selectPane} />;
  return <div className='relative flex min-h-0 min-w-0 flex-1 overflow-hidden'>
    {sidebar.isMobile && workspaceSidebar}
    <ResizablePanelGroup orientation='horizontal' id='workspace-sidebar-layout'
      defaultLayout={sidebarSize === undefined ? undefined : { 'workspace-sidebar': sidebarSize, content: 100 - sidebarSize }}
      onLayoutChanged={(layout, { isUserInteraction }) => { if (isUserInteraction && layout['workspace-sidebar'] && layout.content) rememberSidebarSize(layout['workspace-sidebar']); }}>
      {!sidebar.isMobile && sidebar.open && <>
        <ResizablePanel id='workspace-sidebar' defaultSize={minimumSidebarSize} minSize={minimumSidebarSize} className='flex min-h-0 min-w-0 overflow-hidden'>{workspaceSidebar}</ResizablePanel>
        <ResizableHandle aria-label='Resize sidebar' />
      </>}
      <ResizablePanel id='content' minSize={sidebar.isMobile ? '100%' : minimumPaneSize} className='flex min-h-0 min-w-0'>
        <SidebarInset className='min-h-0 min-w-0 overflow-hidden'><WorkspaceCanvas controller={controller} inputFocusRequest={null} /></SidebarInset>
      </ResizablePanel>
    </ResizablePanelGroup>
    <div data-slot='sidebar-toggle-rail' className='absolute top-0 z-30 flex h-[var(--rail-height)] items-center' style={{ left: 'calc(var(--alpha-window-controls-width, 0px) + var(--alpha-sidebar-toggle-offset, 8px))' }}>{sidebarToggle}</div>
  </div>;
}
export function TerminalFirstShell({ controller }: { controller: AlphaController }) {
  const phone = usePhoneLayout();
  if (phone) return <CompactShell controller={controller} />;
  return <SidebarProvider cookieName={false} keyboardShortcut={false} className={cn('fixed inset-x-0 top-[var(--alpha-viewport-top,0px)] h-[var(--alpha-viewport-height,100dvh)] min-h-0 flex-col overflow-hidden', controller.model.platform === 'ios' && 'pt-[env(safe-area-inset-top)]')}
    style={{ '--sidebar-width': minimumSidebarSize, '--sidebar-width-mobile': minimumSidebarSize, '--alpha-sidebar-toggle-width': '1.75rem' } as CSSProperties}>
    <PaneFocusProvider><Content controller={controller} /></PaneFocusProvider>
  </SidebarProvider>;
}
