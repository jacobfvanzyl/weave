import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowExpand01Icon, ArrowShrink01Icon, Cancel01Icon } from '@hugeicons/core-free-icons';
import { terminalPaneTargets } from '@weave/product-protocol';
import { useDesktopTitlebar } from '@/app/use-desktop-titlebar';
import { useAgentBorderPrecedence } from '@/app/use-agent-border-precedence';
import { useGroupRef } from 'react-resizable-panels';
import type { AlphaController } from '@/app/alpha-controller';
import { SidebarInset, SidebarProvider, useSidebar } from './ui/sidebar';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { useAgentDockPosition } from '@/app/agent-dock-position';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuRadioGroup, ContextMenuRadioItem } from './ui/context-menu';
import { WeaveIcon } from './weave-icon';
import { Button } from './ui/button';
import { WorkspaceSidebar } from './workspace-sidebar';
import { WorkspaceCanvas } from './workspace-canvas';
import { WorkspacePlaceholder } from './workspace-placeholder';
import { GlobalBottomRail } from './global-bottom-rail';
import { cn } from '@/lib/utils';
import { useDevicePaneSize } from '@/app/device-pane-size';
import { alphaPaneMinimumWidth, alphaSidebarMinimumWidth, alphaSidebarWidthStorageKey } from '@/app/alpha-pane-layout';
import { hostCompositionKey, workspaceKey, type WorkspaceReference } from '@/app/workspace-presentation';

const minimumPaneSize = `${alphaPaneMinimumWidth}px`;
const minimumSidebarSize = `${alphaSidebarMinimumWidth}px`;

function Content({ controller }: { controller: AlphaController }) {
  useDesktopTitlebar();
  useAgentBorderPrecedence();
  const sidebar = useSidebar();
  const [agentDock, setAgentDock] = useAgentDockPosition();
  const [dockMenuOpen, setDockMenuOpen] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const [contentWidth, setContentWidth] = useState(0);
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const measure = () => setContentWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const conversationStacked = sidebar.isMobile || (contentWidth > 0 && contentWidth < alphaPaneMinimumWidth * 2 + 1);
  const [conversationOpen, setConversationOpen] = useState(true);
  const [conversationMaximized, setConversationMaximized] = useState(false);
  const state = controller.model.workspaceCompositions!;
  const focusSequence = useRef(0);
  const [sidebarFocus, setSidebarFocus] = useState<
    { kind: 'terminal'; workspaceKey: string; paneId: string; token: number; composerRequest?: number } |
    { kind: 'agent'; workspaceKey: string; threadId: string; token: number; composerRequest?: number }
  >();
  const selectTerminal = (workspace: WorkspaceReference, paneId: string) => {
    setConversationMaximized(false);
    controller.workspaceActions?.focus(workspace, paneId);
    sidebar.setOpenMobile(false);
    setSidebarFocus({ kind: 'terminal', workspaceKey: workspaceKey(workspace), paneId, token: ++focusSequence.current, composerRequest: controller.model.composerFocusRequest });
  };
  const selectAgent = (threadId: string) => {
    const target = controller.model.threads?.find((candidate) => candidate.id === threadId);
    if (!target?.workspaceId) return;
    const workspace = { hostId: target.hostId, workspaceId: target.workspaceId };
    controller.workspaceActions?.activate(workspace);
    const maximized = state.presentation.maximizedPanes[workspaceKey(workspace)];
    if (maximized) controller.workspaceActions?.maximize(workspace, maximized);
    setConversationOpen(true);
    sidebar.setOpenMobile(false);
    setSidebarFocus({ kind: 'agent', workspaceKey: workspaceKey(workspace), threadId, token: ++focusSequence.current, composerRequest: controller.model.composerFocusRequest });
    void controller.actions.selectThread(threadId);
  };
  const reference = state.presentation.openWorkspaces.find((workspace) => workspaceKey(workspace) === state.presentation.activeWorkspace);
  const workspace = reference && state.compositions[hostCompositionKey(reference.hostId)]?.workspaces.find((workspace) => workspace.workspaceId === reference.workspaceId);
  const thread = controller.model.threads?.find((thread) => thread.id === controller.model.selectedThreadId);
  const conversationOnly = Boolean(workspace?.layout === null && thread && thread.hostId === reference?.hostId && thread.workspaceId === reference?.workspaceId);
  const maximizedTerminal = reference && state.presentation.maximizedPanes[workspaceKey(reference)];
  const terminalExpanded = Boolean(workspace && terminalPaneTargets([workspace]).some((pane) => pane.paneId === maximizedTerminal));
  const conversationVisible = conversationOnly || conversationOpen;
  const expanded = conversationVisible && conversationMaximized && !conversationOnly && !terminalExpanded;
  const closeConversation = () => { if (!conversationOnly) { setConversationOpen(false); setConversationMaximized(false); } };
  const [sidebarSize, rememberSidebarSize] = useDevicePaneSize(alphaSidebarWidthStorageKey);
  const [agentWidth, rememberAgentWidth] = useDevicePaneSize('weave.alpha.agent-width.v1', 35);
  const [agentHeight, rememberAgentHeight] = useDevicePaneSize('weave.alpha.agent-height.v1', 35);
  const agentSize = conversationStacked ? agentHeight! : agentWidth!;
  const agentGroup = useGroupRef();
  useEffect(() => {
    if (Object.keys(agentGroup.current?.getLayout() ?? {}).length === 2) {
      agentGroup.current?.setLayout({ 'terminal-workspace': 100 - agentSize, 'agent-conversation': agentSize });
    }
  }, [agentGroup, agentSize, conversationStacked, conversationOnly, conversationVisible, agentDock, expanded, terminalExpanded]);
  const sharedAgentEdge = conversationVisible && !conversationOnly && !expanded && !terminalExpanded && !conversationStacked;
  const terminalInputFocus = sidebarFocus?.workspaceKey !== state.presentation.activeWorkspace
    ? undefined : sidebarFocus?.kind === 'terminal' ? sidebarFocus : null;
  // A later controller request (for example, creating a draft) supersedes the
  // sidebar intent. Terminal selection must not refocus the mounted composer.
  const composerInputFocus = sidebarFocus === undefined || sidebarFocus.composerRequest !== controller.model.composerFocusRequest
    ? undefined : sidebarFocus.kind === 'terminal' ? null : sidebarFocus.threadId === controller.model.selectedThreadId ? sidebarFocus.token : undefined;
  const panels = [!conversationOnly && <ResizablePanel key='terminal-workspace' id='terminal-workspace' hidden={expanded} defaultSize={`${100 - agentSize}%`} minSize={conversationStacked ? '25%' : minimumPaneSize} className='flex min-h-0 min-w-0'><WorkspaceCanvas controller={controller} inputFocusRequest={terminalInputFocus} /></ResizablePanel>,
    conversationVisible && !conversationOnly && <ResizableHandle key='agent-divider' style={expanded || terminalExpanded ? { display: 'none' } : undefined} aria-label='Resize terminal workspace and agent conversation' />,
    conversationVisible && <ResizablePanel key='agent-conversation' id='agent-conversation' style={sharedAgentEdge ? { overflow: 'visible' } : undefined} hidden={terminalExpanded} minSize={conversationStacked ? '25%' : minimumPaneSize} defaultSize={conversationOnly ? '100%' : `${agentSize}%`} className='flex min-h-0 min-w-0'><section aria-label='Selected agent conversation' className='flex min-h-0 min-w-0 flex-1'><WorkspacePlaceholder controller={controller} inputFocusRequest={composerInputFocus} showFooter={false} headerActions={<>
      <Button size='icon-xs' variant='ghost' aria-label={expanded ? 'Restore agent pane' : 'Maximize agent pane'} title={expanded ? 'Restore agent pane' : 'Maximize agent pane'} aria-pressed={expanded} disabled={conversationOnly} className={cn(expanded && 'bg-primary-foreground/15')} onClick={() => setConversationMaximized((value) => !value)}><HugeiconsIcon icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon} strokeWidth={2} /></Button>
      <Button size='icon-xs' variant='ghost' aria-label='Close agent pane' title='Close agent pane' disabled={conversationOnly} onClick={closeConversation}><HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} /></Button>
    </>} /></section></ResizablePanel>
  ];
  if (agentDock === 'left') panels.reverse();
  return <>
    <div className='flex min-h-0 min-w-0 flex-1 overflow-hidden'>
      {sidebar.isMobile && <WorkspaceSidebar controller={controller} agentDock={agentDock} onSelectThread={selectAgent} onSelectTerminal={selectTerminal} />}
      <ResizablePanelGroup orientation='horizontal' id='workspace-sidebar-layout'
        data-agent-leading={conversationVisible && !terminalExpanded && agentDock === 'left' ? 'true' : undefined}
        defaultLayout={sidebarSize === undefined ? undefined : { 'workspace-sidebar': sidebarSize, content: 100 - sidebarSize }}
        onLayoutChanged={(layout, { isUserInteraction }) => { if (isUserInteraction && layout['workspace-sidebar'] && layout.content) rememberSidebarSize(layout['workspace-sidebar']); }}>
        {!sidebar.isMobile && sidebar.open && <>
          <ResizablePanel id='workspace-sidebar' defaultSize={minimumSidebarSize} minSize={minimumSidebarSize} className='flex min-h-0 min-w-0 overflow-hidden'>
            <WorkspaceSidebar controller={controller} agentDock={agentDock} onSelectThread={selectAgent} onSelectTerminal={selectTerminal} />
          </ResizablePanel>
          <ResizableHandle aria-label='Resize sidebar' />
        </>}
        <ResizablePanel id='content' minSize={sidebar.isMobile ? '100%' : minimumPaneSize} className='flex min-h-0 min-w-0'>
          <SidebarInset ref={contentRef} className='min-h-0 min-w-0 overflow-hidden'>
            <ResizablePanelGroup orientation={conversationStacked ? 'vertical' : 'horizontal'} id='terminal-agent-layout' groupRef={agentGroup}
              data-agent-seam={sharedAgentEdge ? 'overlap' : undefined}
              data-agent-dock={agentDock}
              defaultLayout={conversationOnly ? { 'agent-conversation': 100 } : { 'terminal-workspace': 100 - agentSize, 'agent-conversation': agentSize }}
              onLayoutChanged={(layout, { isUserInteraction }) => {
                if (isUserInteraction && layout['terminal-workspace'] && layout['agent-conversation']) {
                  (conversationStacked ? rememberAgentHeight : rememberAgentWidth)(layout['agent-conversation']);
                }
              }}>
              {panels}
            </ResizablePanelGroup>
          </SidebarInset>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
    <GlobalBottomRail controller={controller} threadsVisible={sidebar.open} threadsToggleDisabled={false} onToggleThreads={sidebar.toggleSidebar} dockActions={<ContextMenu open={dockMenuOpen} onOpenChange={setDockMenuOpen}>
      <ContextMenuTrigger aria-haspopup='menu' aria-expanded={dockMenuOpen} onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x, clientY: rect.y }));
      }} className={cn('flex', agentDock === 'right' && 'ml-auto')} render={<Button size='icon' variant='ghost' aria-label='Agent conversation' title='Agent conversation' className={cn(conversationVisible && !terminalExpanded && 'text-primary')} aria-pressed={conversationVisible && !terminalExpanded} aria-disabled={conversationOnly || undefined}
        onClick={() => { if (!conversationOnly && !dockMenuOpen) { if (terminalExpanded && reference && maximizedTerminal) { controller.workspaceActions?.maximize(reference, maximizedTerminal); setConversationOpen(true); } else if (conversationVisible) closeConversation(); else setConversationOpen(true); } }} />}><WeaveIcon /></ContextMenuTrigger>
      <ContextMenuContent><ContextMenuRadioGroup value={agentDock} onValueChange={(value) => { if (value === 'left' || value === 'right') setAgentDock(value); }}>
        <ContextMenuRadioItem closeOnClick value='left'>Left Dock</ContextMenuRadioItem>
        <ContextMenuRadioItem closeOnClick value='right'>Right Dock</ContextMenuRadioItem>
      </ContextMenuRadioGroup></ContextMenuContent>
    </ContextMenu>} />
  </>;
}
export function TerminalFirstShell({ controller }: { controller: AlphaController }) {
  return <SidebarProvider cookieName={false} keyboardShortcut={false} className={cn('fixed inset-x-0 top-[var(--alpha-viewport-top,0px)] h-[var(--alpha-viewport-height,100dvh)] min-h-0 flex-col overflow-hidden', controller.model.platform === 'ios' && 'pt-[env(safe-area-inset-top)]')}
    style={{ '--sidebar-width': minimumSidebarSize, '--sidebar-width-mobile': minimumSidebarSize, '--bottom-rail-height': 'var(--rail-height)' } as CSSProperties}>
    <Content controller={controller} />
  </SidebarProvider>;
}
