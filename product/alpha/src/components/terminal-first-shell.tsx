import { PaneFocusProvider, PaneFocusScope, usePaneFocus, usePaneFocusTarget, agentFocusId, terminalFocusId } from '@/app/pane-focus';
import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowExpand01Icon, ArrowShrink01Icon, Cancel01Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons';
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
import { cn } from '@/lib/utils';
import { useDevicePaneSize } from '@/app/device-pane-size';
import { alphaPaneMinimumWidth, alphaSidebarMinimumWidth, alphaSidebarWidthStorageKey } from '@/app/alpha-pane-layout';
import { hostCompositionKey, workspaceKey, type WorkspaceReference } from '@/app/workspace-presentation';

const minimumPaneSize = `${alphaPaneMinimumWidth}px`;
const minimumSidebarSize = `${alphaSidebarMinimumWidth}px`;

function Content({ controller }: { controller: AlphaController }) {
  useDesktopTitlebar(true);
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
  const focus = usePaneFocus()!;
  const focusTarget = usePaneFocusTarget();
  const [focusIntent, setFocusIntent] = useState<{ id: string }>();
  const selectTerminal = (workspace: WorkspaceReference, paneId: string) => {
    setConversationMaximized(false);
    controller.workspaceActions?.focus(workspace, paneId);
    sidebar.setOpenMobile(false);
    setFocusIntent({ id: terminalFocusId(workspaceKey(workspace), paneId) });
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
    setFocusIntent({ id: agentFocusId(threadId) });
    void controller.actions.selectThread(threadId);
  };
  const reference = state.presentation.openWorkspaces.find((workspace) => workspaceKey(workspace) === state.presentation.activeWorkspace);
  const workspace = reference && state.compositions[hostCompositionKey(reference.hostId)]?.workspaces.find((workspace) => workspace.workspaceId === reference.workspaceId);
  const thread = controller.model.threads?.find((thread) => thread.id === controller.model.selectedThreadId);
  useEffect(() => {
    if (!thread) setConversationMaximized(false);
  }, [thread]);
  useEffect(() => {
    if (!thread) return;
    setConversationOpen(true);
    setFocusIntent({ id: agentFocusId(thread.id) });
    if (thread.workspaceId) {
      const target = { hostId: thread.hostId, workspaceId: thread.workspaceId };
      const maximized = state.presentation.maximizedPanes[workspaceKey(target)];
      if (maximized) controller.workspaceActions?.maximize(target, maximized);
      if (thread.draft) controller.workspaceActions?.activate(target);
    }
  }, [controller.model.selectedThreadId, controller.model.composerFocusRequest]);
  const conversationOnly = Boolean(workspace?.layout === null && thread && thread.hostId === reference?.hostId && thread.workspaceId === reference?.workspaceId);
  const maximizedTerminal = reference && state.presentation.maximizedPanes[workspaceKey(reference)];
  const terminalExpanded = Boolean(workspace && terminalPaneTargets([workspace]).some((pane) => pane.paneId === maximizedTerminal));
  const conversationVisible = Boolean(thread) && (conversationOnly || conversationOpen);
  const expanded = conversationVisible && conversationMaximized && !conversationOnly && !terminalExpanded;
  const closeConversation = () => { if (!conversationOnly || thread?.draft) { setConversationOpen(false); setConversationMaximized(false); if (thread?.draft) void controller.actions.discardThreadDraft?.(thread.id); } };
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
  const activePaneId = reference && (maximizedTerminal ?? state.presentation.focusedPanes[workspaceKey(reference)] ?? (workspace && terminalPaneTargets([workspace])[0]?.paneId));
  const terminalTarget = reference && activePaneId && !expanded && !conversationOnly ? terminalFocusId(workspaceKey(reference), activePaneId) : undefined;
  const agentTarget = thread && conversationVisible && !terminalExpanded ? agentFocusId(thread.id) : undefined;
  const readThread = agentTarget && focusTarget === agentTarget && !controller.model.loadingThreadId ? thread?.id : undefined;
  useEffect(() => {
    const update = () => controller.actions.setFocusedAgentThread?.(document.hidden ? undefined : readThread);
    update(); document.addEventListener('visibilitychange', update);
    return () => { document.removeEventListener('visibilitychange', update); controller.actions.setFocusedAgentThread?.(undefined); };
  }, [readThread]);
  useEffect(() => { focus.setFallbacks([terminalTarget, agentTarget].filter((id): id is string => Boolean(id))); }, [focus, terminalTarget, agentTarget]);
  useEffect(() => { if (terminalTarget) focus.request(terminalTarget); }, [focus, terminalTarget]);
  useEffect(() => { if (agentTarget && !controller.model.loadingThreadId) focus.request(agentTarget); }, [focus, controller.model.transcript?.sessionId, controller.model.loadingThreadId]);
  useEffect(() => { if (focusIntent) focus.request(focusIntent.id); }, [focus, focusIntent]);
  const panels = [!conversationOnly && <ResizablePanel key='terminal-workspace' id='terminal-workspace' hidden={expanded} defaultSize={`${100 - agentSize}%`} minSize={conversationStacked ? '25%' : minimumPaneSize} className='flex min-h-0 min-w-0'><WorkspaceCanvas controller={controller} inputFocusRequest={null} /></ResizablePanel>,
    conversationVisible && !conversationOnly && <ResizableHandle key='agent-divider' style={expanded || terminalExpanded ? { display: 'none' } : undefined} aria-label='Resize terminal workspace and agent conversation' />,
    conversationVisible && <ResizablePanel key='agent-conversation' id='agent-conversation' style={sharedAgentEdge ? { overflow: 'visible' } : undefined} hidden={terminalExpanded} minSize={conversationStacked ? '25%' : minimumPaneSize} defaultSize={conversationOnly ? '100%' : `${agentSize}%`} className='flex min-h-0 min-w-0'><PaneFocusScope id={agentTarget ?? ''}><section data-pane-focus-id={agentTarget} aria-label='Selected agent conversation' className='flex min-h-0 min-w-0 flex-1'><WorkspacePlaceholder controller={controller} inputFocusRequest={null} showFooter={false} headerActions={<>
      <Button size='icon-xs' variant='ghost' aria-label={expanded ? 'Restore agent pane' : 'Maximize agent pane'} title={expanded ? 'Restore agent pane' : 'Maximize agent pane'} aria-pressed={expanded} disabled={conversationOnly} className={cn(expanded && 'bg-primary-foreground/15')} onClick={() => setConversationMaximized((value) => !value)}><HugeiconsIcon icon={expanded ? ArrowShrink01Icon : ArrowExpand01Icon} strokeWidth={2} /></Button>
      <Button size='icon-xs' variant='ghost' aria-label='Close agent pane' title='Close agent pane' disabled={conversationOnly && !thread?.draft} onClick={closeConversation}><HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} /></Button>
    </>} /></section></PaneFocusScope></ResizablePanel>
  ];
  if (agentDock === 'left') panels.reverse();
  const sidebarToggle = <Button data-slot='sidebar-toggle' size='icon-xs' variant='ghost' aria-label='Toggle threads' title='Toggle threads' aria-pressed={sidebar.isMobile ? sidebar.openMobile : sidebar.open} className={cn((sidebar.isMobile ? sidebar.openMobile : sidebar.open) && 'text-primary')} onClick={sidebar.toggleSidebar}><HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} /></Button>;
  const agentToggle = <ContextMenu open={dockMenuOpen} onOpenChange={setDockMenuOpen}>
      <ContextMenuTrigger aria-haspopup='menu' aria-expanded={dockMenuOpen} onKeyDown={(event) => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x, clientY: rect.y }));
      }} className='flex' render={<Button size='icon-xs' variant='ghost' aria-label='Agent conversation' title='Agent conversation' className={cn(conversationVisible && !terminalExpanded && 'text-primary')} aria-pressed={conversationVisible && !terminalExpanded} aria-disabled={!thread || (conversationOnly && !thread.draft) || undefined}
        onClick={() => { if (thread && (!conversationOnly || thread.draft) && !dockMenuOpen) { if (terminalExpanded && reference && maximizedTerminal) { controller.workspaceActions?.maximize(reference, maximizedTerminal); setConversationOpen(true); setFocusIntent({ id: agentFocusId(thread.id) }); } else if (conversationVisible) closeConversation(); else { setConversationOpen(true); setFocusIntent({ id: agentFocusId(thread.id) }); } } }} />}><WeaveIcon /></ContextMenuTrigger>
      <ContextMenuContent><ContextMenuRadioGroup value={agentDock} onValueChange={(value) => { if (value === 'left' || value === 'right') setAgentDock(value); }}>
        <ContextMenuRadioItem closeOnClick value='left'>Left Dock</ContextMenuRadioItem>
        <ContextMenuRadioItem closeOnClick value='right'>Right Dock</ContextMenuRadioItem>
      </ContextMenuRadioGroup></ContextMenuContent>
    </ContextMenu>;

  return <>
    <div className='relative flex min-h-0 min-w-0 flex-1 overflow-hidden'>
      <div data-slot='sidebar-toggle-rail' className='absolute top-0 z-30 flex h-[var(--rail-height)] items-center' style={{ left: 'calc(var(--alpha-window-controls-width, 0px) + 8px)' }}>{sidebarToggle}</div>
      {sidebar.isMobile && <WorkspaceSidebar controller={controller} headerActions={agentToggle} sidebarToggle={sidebar.isMobile ? sidebarToggle : undefined} agentDock={agentDock} onSelectThread={selectAgent} onSelectTerminal={selectTerminal} />}
      <ResizablePanelGroup orientation='horizontal' id='workspace-sidebar-layout'
        data-agent-leading={conversationVisible && !terminalExpanded && agentDock === 'left' ? 'true' : undefined}
        defaultLayout={sidebarSize === undefined ? undefined : { 'workspace-sidebar': sidebarSize, content: 100 - sidebarSize }}
        onLayoutChanged={(layout, { isUserInteraction }) => { if (isUserInteraction && layout['workspace-sidebar'] && layout.content) rememberSidebarSize(layout['workspace-sidebar']); }}>
        {!sidebar.isMobile && sidebar.open && <>
          <ResizablePanel id='workspace-sidebar' defaultSize={minimumSidebarSize} minSize={minimumSidebarSize} className='flex min-h-0 min-w-0 overflow-hidden'>
            <WorkspaceSidebar controller={controller} headerActions={agentToggle} sidebarToggle={sidebar.isMobile ? sidebarToggle : undefined} agentDock={agentDock} onSelectThread={selectAgent} onSelectTerminal={selectTerminal} />
          </ResizablePanel>
          <ResizableHandle aria-label='Resize sidebar' />
        </>}
        <ResizablePanel id='content' minSize={sidebar.isMobile ? '100%' : minimumPaneSize} className='flex min-h-0 min-w-0'>
          <SidebarInset ref={contentRef} className='min-h-0 min-w-0 overflow-hidden'>
            <ResizablePanelGroup orientation={conversationStacked ? 'vertical' : 'horizontal'} id='terminal-agent-layout' groupRef={agentGroup}
              data-input-owner={focusTarget?.startsWith('agent:') ? 'agent' : 'terminal'}
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

  </>;
}
export function TerminalFirstShell({ controller }: { controller: AlphaController }) {
  return <SidebarProvider cookieName={false} keyboardShortcut={false} className={cn('fixed inset-x-0 top-[var(--alpha-viewport-top,0px)] h-[var(--alpha-viewport-height,100dvh)] min-h-0 flex-col overflow-hidden', controller.model.platform === 'ios' && 'pt-[env(safe-area-inset-top)]')}
    style={{ '--sidebar-width': minimumSidebarSize, '--sidebar-width-mobile': minimumSidebarSize, '--alpha-sidebar-toggle-width': '1.25rem' } as CSSProperties}>
    <PaneFocusProvider><Content controller={controller} /></PaneFocusProvider>
  </SidebarProvider>;
}
