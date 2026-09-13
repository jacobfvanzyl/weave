import { BrowserSurface } from './browser-surface';
import { BrowserProfileDialog } from './browser-profile-dialog';
import { useTerminalPaneActions } from '@/app/terminal-pane-actions';
import { PaneFocusScope, usePaneFocus, terminalFocusId, agentFocusId } from '@/app/pane-focus';
import { useState, useEffect, useRef } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowExpand01Icon, ArrowShrink01Icon, Cancel01Icon } from '@hugeicons/core-free-icons';
import { TerminalTitle } from './path-label';
import { cn } from '@/lib/utils';
import { PaneFrame } from './pane-frame';
import { PaneSplitMenu } from './pane-split-menu';
import { AgentSurface } from './agent-surface';
import { paneTargets, type TerminalLayoutNode } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import { useAlphaTerminals } from '@/app/use-alpha-terminals';
import { workspaceKey, hostCompositionKey, type WorkspaceReference } from '@/app/workspace-presentation';
import { Button } from './ui/button';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty';
import { Alert, AlertDescription } from './ui/alert';
import { WorkspacePaneLayout } from './workspace-pane-layout';
import { TerminalView } from './terminal-view';
import { TerminalPaneSkeleton } from './terminal-pane-skeleton';
import { PortalTransportError } from '@/portal-client';

function TerminalSurface({ controller, reference, node, focusRequest, maximized, focused, compact = false }: { compact?: boolean; focused: boolean; maximized: boolean; focusRequest?: string; controller: AlphaController; reference: WorkspaceReference; node: Extract<TerminalLayoutNode, { kind: 'terminal' }> }) {
  const dimAmount = focused ? 0 : 0.4;
  const paneFocusId = terminalFocusId(workspaceKey(reference), node.paneId);
  const [exited, setExited] = useState(false);
  const { model, actions } = useAlphaTerminals({
    onExit: () => { setExited(true); void controller.workspaceActions?.refresh(); },
    target: node.terminalId ? { scope: { hostId: reference.hostId, executionContextId: node.executionContextId, contextId: node.executionContextId }, terminalId: node.terminalId, supported: true } : undefined,
    client: controller.terminalClient?.(reference.hostId),
  });
  const [error, setError] = useState<string>();
  const perform = async (action: () => Promise<unknown>) => {
    try { setError(undefined); await action(); } catch (cause) { if (!(cause instanceof PortalTransportError)) setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const available = controller.model.connections.some((connection) => connection.hostId === reference.hostId && connection.status === 'connected');
  const context = controller.model.executionContexts.find((workspace) => (workspace.placements ?? [workspace]).some((placement) => placement.hostId === reference.hostId && placement.executionContextId === node.executionContextId));
  const directoryAvailable = context?.availability === undefined || context.availability === 'available';
  const pending = controller.model.workspaceCompositions?.pending;
  const registerActions = useTerminalPaneActions();
  const latestActions = useRef(actions); latestActions.current = actions;
  useEffect(() => {
    if (!registerActions || !node.terminalId) return;
    registerActions(paneFocusId, { enabled: Boolean(model.attachmentId && model.attachmentMode !== 'observe' && available), terminate: async () => {
      await latestActions.current.close(node.terminalId!); setExited(true); await controller.workspaceActions?.refresh();
    } });
    return () => registerActions(paneFocusId);
  }, [registerActions, paneFocusId, node.terminalId, model.attachmentId, model.attachmentMode, available]);
  const connecting = model.loading || Boolean(node.terminalId && !model.attachmentId && !model.error && available);
  if (exited || !node.terminalId) return null;
  return <section className='flex min-h-0 min-w-0 flex-1 flex-col' data-focused={focused || undefined} data-pane-focus-id={paneFocusId} data-dimmed={!focused || undefined} aria-label={`Terminal pane ${node.paneId}`} data-terminal-id={node.terminalId ?? undefined} onFocusCapture={(event) => { if ((event.target as HTMLElement).closest('[data-slot="native-terminal"]')) controller.workspaceActions?.focus(reference, node.paneId); }}>
    {!available || connecting ? <TerminalPaneSkeleton framed /> : <>
    <PaneFrame focused={focused} title={<TerminalTitle title={model.tabs[0]?.title ?? 'Terminal'} />} actions={<>
      {!compact && <><PaneSplitMenu sourceType='terminal' disabled={pending || !available || !directoryAvailable || !controller.actions.splitPane} onSplit={(axis, type) => void perform(async () => { await controller.actions.splitPane?.(reference, node.paneId, axis, type); })} />
      <Button size='rail' variant='ghost' aria-label={maximized ? 'Restore terminal' : 'Maximize terminal'} title={maximized ? 'Restore terminal' : 'Maximize terminal'} aria-pressed={maximized} className={cn(maximized && 'text-primary')} onClick={() => controller.workspaceActions?.maximize(reference, node.paneId)}><HugeiconsIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} strokeWidth={2} /></Button>
      {model.attachmentId && <Button size='rail' variant='ghost' aria-label='Terminate terminal' title='Terminate terminal' disabled={model.attachmentMode === 'observe'} onClick={() => void perform(() => actions.close(node.terminalId!).then(() => { setExited(true); return controller.workspaceActions?.refresh(); }))}><HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} /></Button>}
      </>}
    </>}>
    {(error || model.error) && <Alert variant='destructive'><AlertDescription>{error ?? model.error}</AlertDescription></Alert>}
    {!directoryAvailable && <Alert><AlertDescription>{context?.availability === 'path-changed' ? 'The registered directory has changed. Its saved identity is retained; new shells are disabled.' : 'The workspace directory is unavailable. Existing terminal processes can still be attached.'}</AlertDescription></Alert>}
    {model.attachmentId ? <TerminalView dimAmount={dimAmount} focusRequest={focusRequest} output={model.output} readOnly={model.attachmentMode === 'observe' || !available} onInput={(data) => void perform(() => actions.input(data))} onResize={(cols, rows) => void perform(() => actions.resize(cols, rows))} /> : <TerminalPaneSkeleton />}
    </PaneFrame>
    </>}
  </section>;
}
export type TerminalInputFocusRequest = { workspaceKey: string; paneId: string; token: number };
export function WorkspaceCanvas({ controller, inputFocusRequest, singlePaneId, active = true }: { singlePaneId?: string; active?: boolean; controller: AlphaController; inputFocusRequest?: TerminalInputFocusRequest | null }) {
  const focusOwner = usePaneFocus();
  const state = controller.model.workspaceCompositions!;
  const ref = state.presentation.openWorkspaces.find((tab) => workspaceKey(tab) === state.presentation.activeWorkspace);
  const composition = ref ? state.compositions[hostCompositionKey(ref.hostId)] : undefined;
  const tab = composition?.workspaces.find((tab) => tab.workspaceId === ref?.workspaceId);
  return <main className='flex min-h-0 min-w-0 flex-1 flex-col' aria-label='Workspace panes'>
    <BrowserProfileDialog controller={controller} />
    {state.error && <Alert variant='destructive'><AlertDescription>{state.error}</AlertDescription></Alert>}
    {state.presentation.openWorkspaces.map((reference) => {
      const key = workspaceKey(reference);
      const saved = state.compositions[hostCompositionKey(reference.hostId)]?.workspaces.find((item) => item.workspaceId === reference.workspaceId);
      if (!saved?.layout || key !== state.presentation.activeWorkspace) return null;
      const workspaceActive = active && key === state.presentation.activeWorkspace;
      const maximized = singlePaneId ?? state.presentation.maximizedPanes[key];
      const focused = state.presentation.focusedPanes[key] ?? paneTargets([saved])[0]?.paneId;
      return <WorkspacePaneLayout key={key} layout={saved.layout} active={workspaceActive} maximized={maximized}
        setRatio={async (id, ratio) => controller.workspaceActions?.setRatio(reference, id, ratio)}
        renderPane={(node, visible) => {
          const isFocused = visible && (maximized ?? focused) === node.paneId;
          const thread = node.kind === 'agent' ? controller.model.threads?.find(thread => thread.hostId === reference.hostId && thread.threadId === node.threadId) : undefined;
          const target = thread ? agentFocusId(thread.id) : terminalFocusId(key, node.paneId);
          return <PaneFocusScope id={target}><div className='flex min-h-0 min-w-0 flex-1' data-pane-focus-id={target} onPointerDownCapture={() => controller.workspaceActions?.focus(reference, node.paneId)} onClickCapture={event => { if ((event.target as HTMLElement).closest('[data-slot="pane-top-rail"]')) controller.workspaceActions?.focus(reference, node.paneId); }} onFocusCapture={() => {
            // The native handoff can refocus the old composer after a click.
            // Apply the same stale-acknowledgement fence to Pane selection.
            if (!focusOwner || focusOwner.didFocus(target)) controller.workspaceActions?.focus(reference, node.paneId);
          }}>
            {node.kind === 'terminal' ? <TerminalSurface controller={controller} reference={reference} node={node} compact={singlePaneId !== undefined} focused={isFocused} maximized={maximized === node.paneId} focusRequest={isFocused && inputFocusRequest !== null ? `${key}:${node.paneId}:${inputFocusRequest?.token ?? maximized ?? ''}` : undefined} />
              : node.kind === 'agent' ? <AgentSurface controller={controller} threadId={thread?.id} reference={reference} paneId={node.paneId} focused={isFocused} visible={visible} maximized={maximized === node.paneId} compact={singlePaneId !== undefined} />
              : <BrowserSurface controller={controller} reference={reference} node={node} focused={isFocused} maximized={maximized === node.paneId} />}
          </div></PaneFocusScope>;
        }} />;
    })}
    {ref && !tab ? <TerminalPaneSkeleton /> : !ref && <Empty>
      <EmptyHeader><EmptyTitle>Open a workspace</EmptyTitle><EmptyDescription>Create a workspace or reopen one from the sidebar menu.</EmptyDescription></EmptyHeader>
    </Empty>}
  </main>;
}
