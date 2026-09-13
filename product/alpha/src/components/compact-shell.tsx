import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons';
import type { AlphaController } from '@/app/alpha-controller';
import { workspaceKey, type WorkspaceReference } from '@/app/workspace-presentation';
import { paneTargets } from '@weave/product-protocol';
import type { CompactPane } from '@/app/compact-pane';
import { PaneFocusProvider, agentFocusId, terminalFocusId, usePaneFocus } from '@/app/pane-focus';
import { TerminalPaneActionsContext, type TerminalPaneAction } from '@/app/terminal-pane-actions';
import { SidebarProvider, useSidebar } from './ui/sidebar';
import { Button } from './ui/button';
import { Alert, AlertDescription } from './ui/alert';
import { WorkspaceSidebar } from './workspace-sidebar';
import { WorkspaceCanvas } from './workspace-canvas';

function Content({ controller }: { controller: AlphaController }) {
  const state = controller.model.workspaceCompositions!;
  const sidebar = useSidebar();
  const focus = usePaneFocus()!;
  const reference = state.presentation.openWorkspaces.find(ref => workspaceKey(ref) === state.presentation.activeWorkspace);
  const key = reference && workspaceKey(reference);
  const workspace = reference && state.compositions[reference.hostId]?.workspaces.find(item => item.workspaceId === reference.workspaceId);
  const panes = workspace ? paneTargets([workspace]) : [];
  const node = panes.find(pane => pane.paneId === state.presentation.focusedPanes[key!]) ?? panes[0];
  const thread = node?.kind === 'agent' ? controller.model.threads?.find(thread => thread.hostId === reference?.hostId && thread.threadId === node.threadId) : undefined;
  const pane: CompactPane | undefined = node ? node.kind === 'agent' && thread ? { kind: 'agent', id: thread.id } : { kind: 'terminal', id: node.paneId } : undefined;
  const [error, setError] = useState<string>();
  const [terminalActions, setTerminalActions] = useState<Record<string, TerminalPaneAction>>({});
  const registerActions = useCallback((id: string, action?: TerminalPaneAction) => setTerminalActions(current => {
    const next = { ...current }; if (action) next[id] = action; else delete next[id]; return next;
  }), []);
  const select = (ref: WorkspaceReference, next: CompactPane) => {
    focus.browse();
    controller.workspaceActions?.activate(ref);
    const workspace = state.compositions[ref.hostId]?.workspaces.find(workspace => workspace.workspaceId === ref.workspaceId);
    const target = workspace && paneTargets([workspace]).find(pane => next.kind === 'agent' ? pane.kind === 'agent' && controller.model.threads?.some(thread => thread.id === next.id && thread.threadId === pane.threadId && thread.hostId === ref.hostId) : pane.paneId === next.id);
    if (target) controller.workspaceActions?.focus(ref, target.paneId);
    sidebar.setOpenMobile(false);
  };
  const selectAgent = (id: string) => {
    const thread = controller.model.threads?.find(item => item.id === id);
    if (!thread?.workspaceId) return;
    select({ hostId: thread.hostId, workspaceId: thread.workspaceId }, { kind: 'agent', id });
    void controller.actions.selectThread(id, { preserveDraft: true });
  };
  const target = pane && key ? pane.kind === 'agent' ? agentFocusId(pane.id) : terminalFocusId(key, pane.id) : undefined;
  useEffect(() => {
    focus.browse(target);
    if (pane?.kind === 'agent' && controller.model.selectedThreadId !== pane.id) void controller.actions.selectThread(pane.id, { preserveDraft: true });
  }, [target]);
  useEffect(() => { sidebar.setOpenMobile(false); }, [key]);
  useEffect(() => { if (sidebar.openMobile) focus.browse(target); }, [sidebar.openMobile]);
  useEffect(() => {
    const update = () => controller.actions.setFocusedAgentThread?.(!document.hidden && !sidebar.openMobile && pane?.kind === 'agent' && controller.model.selectedThreadId === pane.id && !controller.model.loadingThreadId ? pane.id : undefined);
    update(); document.addEventListener('visibilitychange', update);
    return () => { document.removeEventListener('visibilitychange', update); controller.actions.setFocusedAgentThread?.(undefined); };
  }, [target, sidebar.openMobile, controller.model.selectedThreadId, controller.model.loadingThreadId]);
  const selectWorkspace = (ref: WorkspaceReference) => { focus.browse(); controller.workspaceActions?.activate(ref); sidebar.setOpenMobile(false); };
  const addTerminal = async (ref: WorkspaceReference, contextId: string) => {
    const id = await controller.workspaceActions?.addPane(ref, contextId);
    if (typeof id === 'string') select(ref, { kind: 'terminal', id });
  };
  const toggle = <Button data-slot='sidebar-toggle' size='rail' variant='ghost' aria-label='Toggle threads' aria-expanded={sidebar.openMobile} onClick={() => { focus.browse(target); sidebar.toggleSidebar(); }}><HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} /></Button>;
  const topRail = (drawer = false) => <div data-slot='phone-safe-area-rail'>{toggle}{drawer && <Button size='rail' variant='ghost' aria-label='Close sidebar' onClick={() => sidebar.setOpenMobile(false)}><HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} /></Button>}</div>;
  return <TerminalPaneActionsContext value={registerActions}>
    <WorkspaceSidebar controller={controller} compact selectedPane={pane} compactHeader={topRail(true)} onSelectWorkspace={selectWorkspace} onSelectThread={selectAgent} onSelectTerminal={(ref, id) => select(ref, { kind: 'terminal', id })} onAddTerminal={addTerminal}
      terminalActions={terminalActions} onActionError={setError} />
    <div className='relative flex min-h-0 min-w-0 flex-1 flex-col' data-slot='compact-content'>
      {topRail()}
      {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
      <WorkspaceCanvas controller={controller} inputFocusRequest={null} singlePaneId={node?.paneId ?? ''} active={Boolean(node)} />
      {!pane && workspace && <p className='p-4 pt-14 text-sm text-muted-foreground'>Choose New terminal or New agent thread from this workspace’s sidebar menu.</p>}
    </div>
  </TerminalPaneActionsContext>;
}
export function CompactShell({ controller }: { controller: AlphaController }) {
  return <SidebarProvider mobile cookieName={false} keyboardShortcut={false} data-compact='true'
    className='fixed inset-x-0 top-[var(--alpha-viewport-top,0px)] h-[var(--alpha-viewport-height,100dvh)] min-h-0 flex-col overflow-hidden'
    style={{ '--rail-height': '2.75rem', '--alpha-sidebar-toggle-width': '2.75rem' } as CSSProperties}>
    <PaneFocusProvider browseOnly><Content controller={controller} /></PaneFocusProvider>
  </SidebarProvider>;
}
