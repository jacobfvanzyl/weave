import { useState } from 'react';
import type { TerminalLayoutNode } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import { useAlphaTerminals } from '@/app/use-alpha-terminals';
import { tabReferenceKey, workspaceReferenceKey, type WorkspaceTabReference } from '@/app/workspace-presentation';
import { Button } from './ui/button';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from './ui/empty';
import { Alert, AlertDescription } from './ui/alert';
import { WorkspacePaneLayout } from './workspace-pane-layout';
import { RunningTerminalDialog } from './workspace-arrangement-dialogs';
import { TerminalView } from './terminal-view';

function TerminalSurface({ controller, reference, node, focusRequest }: { focusRequest?: string; controller: AlphaController; reference: WorkspaceTabReference; node: Extract<TerminalLayoutNode, { kind: 'terminal' }> }) {
  const { model, actions } = useAlphaTerminals({
    target: node.terminalId ? { scope: { hostId: reference.hostId, workspaceId: reference.workspaceId, projectId: reference.workspaceId }, terminalId: node.terminalId, supported: true } : undefined,
    client: controller.terminalClient?.(reference.hostId),
  });
  const [error, setError] = useState<string>();
  const [choosingTerminal, setChoosingTerminal] = useState(false);
  const perform = async (action: () => Promise<unknown>) => {
    try { setError(undefined); await action(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const available = controller.model.connections.some((connection) => connection.hostId === reference.hostId && connection.status === 'connected');
  const context = controller.model.workspaces.find((workspace) => (workspace.placements ?? [workspace]).some((placement) => placement.hostId === reference.hostId && placement.workspaceId === reference.workspaceId));
  const directoryAvailable = context?.availability === undefined || context.availability === 'available';
  const pending = controller.model.workspaceCompositions?.pending;
  const connecting = model.loading || Boolean(node.terminalId && !model.attachmentId && !model.error && available);
  return <section className='flex min-h-0 min-w-0 flex-1 flex-col' aria-label={`Terminal pane ${node.paneId}`} data-terminal-id={node.terminalId ?? undefined} onFocusCapture={(event) => { if ((event.target as HTMLElement).closest('[data-slot="native-terminal"], [data-slot="xterm-terminal"]')) controller.workspaceActions?.focus(reference, node.paneId); }}>
    <header className='flex shrink-0 items-center gap-1 border-b bg-title-bar px-2 py-1'>
      <span className='min-w-0 flex-1 truncate text-xs' aria-label='Terminal session'>{model.tabs[0]?.title ?? 'Terminal'}</span>
      <Button size='xs' variant='ghost' disabled={pending || !available} onClick={() => void controller.workspaceActions?.split(reference, node.paneId, 'horizontal')}>Split right</Button>
      <Button size='xs' variant='ghost' disabled={pending || !available} onClick={() => void controller.workspaceActions?.split(reference, node.paneId, 'vertical')}>Split down</Button>
      <Button size='xs' variant='ghost' onClick={() => controller.workspaceActions?.maximize(reference, node.paneId)}>Maximize / restore</Button>
      {model.attachmentId && <Button size='xs' variant='ghost' disabled={model.attachmentMode !== 'control'} onClick={() => void perform(() => actions.close(node.terminalId!))}>Terminate</Button>}
    </header>
    {(error || model.error || !available) && <Alert variant='destructive'><AlertDescription>{error ?? (!available ? 'Host unavailable. This pane will reconnect when the Host returns.' : model.error)}</AlertDescription></Alert>}
    {!directoryAvailable && <Alert><AlertDescription>{context?.availability === 'path-changed' ? 'The registered directory has changed. Its saved identity is retained; new shells are disabled.' : 'The workspace directory is unavailable. Existing terminal processes can still be attached.'}</AlertDescription></Alert>}
    {model.attachmentMode === 'observe' && <div className='flex items-center gap-2 p-2 text-xs'><span>{model.readOnlyReason}</span><Button size='xs' variant='outline' onClick={() => void perform(actions.retryControl)}>Request control</Button></div>}
    {model.attachmentId ? <TerminalView focusRequest={focusRequest} output={model.output} data={model.data} dataEpoch={model.dataEpoch} dataOffset={model.dataOffset} readOnly={model.attachmentMode !== 'control' || !available} onInput={(data) => void perform(() => actions.input(data))} onResize={(cols, rows) => void perform(() => actions.resize(cols, rows))} /> : <Empty>
      <EmptyHeader><EmptyTitle>{connecting ? 'Connecting terminal…' : node.terminalId ? 'Terminal unavailable' : 'Empty terminal pane'}</EmptyTitle><EmptyDescription>{node.terminalId ? 'The saved terminal reference stays here until you explicitly replace it.' : 'Start a shell in this workspace directory.'}</EmptyDescription></EmptyHeader>
      <div className='flex flex-wrap justify-center gap-2'><Button disabled={!available || !directoryAvailable || pending || connecting} onClick={() => void controller.workspaceActions?.startTerminal(reference, node.paneId)}>{node.terminalId ? 'Start replacement terminal' : 'Start terminal'}</Button>
      <Button variant='outline' disabled={!available || pending || connecting} onClick={() => setChoosingTerminal(true)}>Use running terminal…</Button></div>
    </Empty>}
    {choosingTerminal && <RunningTerminalDialog controller={controller} reference={reference} paneId={node.paneId} onClose={() => setChoosingTerminal(false)} />}
  </section>;
}
export function WorkspaceCanvas({ controller }: { controller: AlphaController }) {
  const state = controller.model.workspaceCompositions!;
  const ref = state.presentation.openTabs.find((tab) => tabReferenceKey(tab) === state.presentation.activeTab);
  const composition = ref ? state.compositions[workspaceReferenceKey(ref.hostId, ref.workspaceId)] : undefined;
  const tab = composition?.tabs.find((tab) => tab.tabId === ref?.tabId);
  const context = ref ? controller.model.workspaces.find((workspace) => (workspace.placements ?? [workspace]).some((placement) => placement.hostId === ref.hostId && placement.workspaceId === ref.workspaceId)) : undefined;

  return <main className='flex min-h-0 min-w-0 flex-1 flex-col' aria-label='Terminal workspace'>
    <header className='flex h-11 shrink-0 items-center gap-2 border-b bg-title-bar px-3'>
      <span className='min-w-0 flex-1 truncate text-xs' aria-label='Active terminal context'>{context ? `${context.hostName} · ${context.canonicalPath ?? context.name} · ${tab?.name ?? 'Unavailable workspace'}` : 'Terminal workspaces'}</span>
      {ref && <Button size='xs' variant='ghost' onClick={() => controller.workspaceActions?.close(ref)}>Close workspace view</Button>}
    </header>
    {state.error && <Alert variant='destructive'><AlertDescription>{state.error}</AlertDescription></Alert>}
    {state.presentation.openTabs.map((reference) => {
      const key = tabReferenceKey(reference);
      const saved = state.compositions[workspaceReferenceKey(reference.hostId, reference.workspaceId)]?.tabs.find((item) => item.tabId === reference.tabId);
      if (!saved || key !== state.presentation.activeTab) return null;
      const active = key === state.presentation.activeTab;
      const maximized = state.presentation.maximizedPanes[key];
      const focused = state.presentation.focusedPanes[key];
      return <WorkspacePaneLayout key={key} layout={saved.layout} active={active} maximized={maximized}
        setRatio={async (id, ratio) => controller.workspaceActions?.setRatio(reference, id, ratio)}
        renderPane={(node, visible) => <TerminalSurface controller={controller} reference={reference} node={node} focusRequest={visible && (maximized ?? focused) === node.paneId ? `${key}:${node.paneId}:${maximized ?? ''}` : undefined} />} />;
    })}
    {(!ref || !tab) && <Empty>
      <EmptyHeader><EmptyTitle>{ref ? 'Workspace arrangement unavailable' : 'Open a terminal workspace'}</EmptyTitle><EmptyDescription>{ref ? 'The saved workspace selection is retained. Reconnect its Host to recover the arrangement.' : 'Choose a Host directory from Open in the sidebar. Agents can run with no terminal workspace open.'}</EmptyDescription></EmptyHeader>
    </Empty>}
  </main>;
}
