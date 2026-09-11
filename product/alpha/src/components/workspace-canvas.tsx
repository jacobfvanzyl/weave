import { PaneFocusScope, terminalFocusId, usePaneFocusTarget } from '@/app/pane-focus';
import { useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { LayoutTwoColumnIcon, LayoutTwoRowIcon, ArrowExpand01Icon, ArrowShrink01Icon, Cancel01Icon } from '@hugeicons/core-free-icons';
import { TerminalTitle } from './path-label';
import { cn } from '@/lib/utils';
import { terminalPaneTargets, type TerminalLayoutNode } from '@weave/product-protocol';
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

function TerminalSurface({ controller, reference, node, focusRequest, maximized, focused }: { focused: boolean; maximized: boolean; focusRequest?: string; controller: AlphaController; reference: WorkspaceReference; node: Extract<TerminalLayoutNode, { kind: 'terminal' }> }) {
  const inputTarget = usePaneFocusTarget();
  const agentFocused = inputTarget?.startsWith('agent:') ?? false;
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
  const connecting = model.loading || Boolean(node.terminalId && !model.attachmentId && !model.error && available);
  if (exited || !node.terminalId) return null;
  // The active terminal remains bright even when the composer owns input.
  return <section className='flex min-h-0 min-w-0 flex-1 flex-col' data-focused={focused || undefined} data-pane-focus-id={paneFocusId} data-dimmed={!focused || undefined} data-agent-focused={agentFocused || undefined} aria-label={`Terminal pane ${node.paneId}`} data-terminal-id={node.terminalId ?? undefined} onFocusCapture={(event) => { if ((event.target as HTMLElement).closest('[data-slot="native-terminal"]')) controller.workspaceActions?.focus(reference, node.paneId); }}>
    {!available || connecting ? <TerminalPaneSkeleton framed /> : <>
    <header data-slot='terminal-top-rail' className='relative flex h-[var(--rail-height)] shrink-0 items-center gap-1 border-b bg-title-bar px-2'>
      <div className='min-w-0 flex-1 text-xs' aria-label='Terminal session'><TerminalTitle title={model.tabs[0]?.title ?? 'Terminal'} /></div>
      <Button size='icon-xs' variant='ghost' aria-label='Split right' title='Split right' disabled={pending || !available || !directoryAvailable} onClick={() => void controller.workspaceActions?.split(reference, node.paneId, 'horizontal')}><HugeiconsIcon icon={LayoutTwoColumnIcon} strokeWidth={2} /></Button>
      <Button size='icon-xs' variant='ghost' aria-label='Split down' title='Split down' disabled={pending || !available || !directoryAvailable} onClick={() => void controller.workspaceActions?.split(reference, node.paneId, 'vertical')}><HugeiconsIcon icon={LayoutTwoRowIcon} strokeWidth={2} /></Button>
      <Button size='icon-xs' variant='ghost' aria-label={maximized ? 'Restore terminal' : 'Maximize terminal'} title={maximized ? 'Restore terminal' : 'Maximize terminal'} aria-pressed={maximized} className={cn(maximized && 'text-primary')} onClick={() => controller.workspaceActions?.maximize(reference, node.paneId)}><HugeiconsIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} strokeWidth={2} /></Button>
      {model.attachmentId && <Button size='icon-xs' variant='ghost' aria-label='Terminate terminal' title='Terminate terminal' disabled={model.attachmentMode === 'observe'} onClick={() => void perform(() => actions.close(node.terminalId!).then(() => { setExited(true); return controller.workspaceActions?.refresh(); }))}><HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} /></Button>}
      <div aria-hidden='true' data-slot='terminal-rail-dim' className='pointer-events-none absolute inset-0 bg-title-bar' style={{ opacity: dimAmount }} />
    </header>
    <div data-slot='terminal-focus-border' className={cn('flex min-h-0 min-w-0 flex-1 flex-col border', focused ? agentFocused ? 'border-sidebar-selected' : 'border-terminal-focus' : 'border-transparent')}>
    {(error || model.error) && <Alert variant='destructive'><AlertDescription>{error ?? model.error}</AlertDescription></Alert>}
    {!directoryAvailable && <Alert><AlertDescription>{context?.availability === 'path-changed' ? 'The registered directory has changed. Its saved identity is retained; new shells are disabled.' : 'The workspace directory is unavailable. Existing terminal processes can still be attached.'}</AlertDescription></Alert>}
    {model.attachmentId ? <TerminalView dimAmount={dimAmount} focusRequest={focusRequest} output={model.output} readOnly={model.attachmentMode === 'observe' || !available} onInput={(data) => void perform(() => actions.input(data))} onResize={(cols, rows) => void perform(() => actions.resize(cols, rows))} /> : <TerminalPaneSkeleton />}
    </div>
    </>}
  </section>;
}
export type TerminalInputFocusRequest = { workspaceKey: string; paneId: string; token: number };
export function WorkspaceCanvas({ controller, inputFocusRequest }: { controller: AlphaController; inputFocusRequest?: TerminalInputFocusRequest | null }) {
  const state = controller.model.workspaceCompositions!;
  const ref = state.presentation.openWorkspaces.find((tab) => workspaceKey(tab) === state.presentation.activeWorkspace);
  const composition = ref ? state.compositions[hostCompositionKey(ref.hostId)] : undefined;
  const tab = composition?.workspaces.find((tab) => tab.workspaceId === ref?.workspaceId);
  return <main className='flex min-h-0 min-w-0 flex-1 flex-col' aria-label='Terminal workspace'>
    {state.error && <Alert variant='destructive'><AlertDescription>{state.error}</AlertDescription></Alert>}
    {state.presentation.openWorkspaces.map((reference) => {
      const key = workspaceKey(reference);
      const saved = state.compositions[hostCompositionKey(reference.hostId)]?.workspaces.find((item) => item.workspaceId === reference.workspaceId);
      if (!saved?.layout || key !== state.presentation.activeWorkspace) return null;
      const active = key === state.presentation.activeWorkspace;
      const maximized = state.presentation.maximizedPanes[key];
      const focused = state.presentation.focusedPanes[key] ?? terminalPaneTargets([saved])[0]?.paneId;
      return <WorkspacePaneLayout key={key} layout={saved.layout} active={active} maximized={maximized}
        setRatio={async (id, ratio) => controller.workspaceActions?.setRatio(reference, id, ratio)}
        renderPane={(node, visible) => <PaneFocusScope id={terminalFocusId(key, node.paneId)}><TerminalSurface controller={controller} reference={reference} node={node} focused={visible && (maximized ?? focused) === node.paneId} maximized={maximized === node.paneId} focusRequest={visible && (maximized ?? focused) === node.paneId ? inputFocusRequest === undefined ? `${key}:${node.paneId}:${maximized ?? ''}` : inputFocusRequest === null ? undefined : inputFocusRequest.workspaceKey === key && inputFocusRequest.paneId === node.paneId ? `sidebar:${inputFocusRequest.token}` : `${key}:${node.paneId}:${maximized ?? ''}` : undefined} /></PaneFocusScope>} />;
    })}
    {ref && !tab ? <TerminalPaneSkeleton /> : !ref && <Empty>
      <EmptyHeader><EmptyTitle>Open a workspace</EmptyTitle><EmptyDescription>Create a workspace or reopen one from the sidebar menu.</EmptyDescription></EmptyHeader>
    </Empty>}
  </main>;
}
