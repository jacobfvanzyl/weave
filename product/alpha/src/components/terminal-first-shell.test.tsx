import { useComposerPaneFocus } from '@/app/pane-focus';
import { useEffect, useState, useRef } from 'react';
import type { TerminalOutputSource } from '@/terminal/output-stream';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceComposition, Workspace, TerminalLayoutNode } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import { useLiveAlphaController } from '@/app/use-live-alpha-controller';
import { type DirectHostClient, type HostSnapshot } from '@/portal-client';
import { AlphaShell } from './alpha-shell';

const storage = vi.hoisted(() => new Map<string, string>());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
vi.mock('@capacitor/preferences', () => ({ Preferences: {
  get: vi.fn(async ({ key }: { key: string }) => ({ value: storage.get(key) ?? null })),
  set: vi.fn(async ({ key, value }: { key: string; value: string }) => { storage.set(key, value); }),
} }));
vi.mock('@/app/portal-connection-storage', () => ({
  loadPortalConnections: async () => ({ connections: ['one', 'two'].map((hostId) => ({ hostId, displayName: hostId, hostUrl: `ws://${hostId}.test`, credentialId: hostId, keyId: hostId })) }),
  savePortalConnections: vi.fn(),
}));
vi.mock('./terminal-view', () => ({ TerminalView: ({ output, onInput, dimAmount }: { output?: TerminalOutputSource; onInput(data: string): void; dimAmount?: number }) => {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  useComposerPaneFocus(ref);
  useEffect(() => output?.subscribe({ reset: async (value) => { setText(new TextDecoder().decode(value)); }, write: async (value) => { setText((current) => current + new TextDecoder().decode(value)); } }), [output]);
  return <div data-slot='native-terminal' data-dim-amount={dimAmount}><textarea ref={ref} aria-label='Terminal input' value={text} onChange={(event) => onInput(event.target.value)} /></div>;
} }));
beforeEach(() => {
  storage.clear();
  localStorage.clear();
  const refs = ['one', 'two'].map((hostId) => ({ hostId, workspaceId: `initial-${hostId}` }));
  storage.set('weave.workspace-presentation.v2', JSON.stringify({ schemaVersion: 2, openWorkspaces: refs, recentWorkspaces: [], focusedPanes: {}, maximizedPanes: {}, collapsedWorkspaces: [] }));
});

it('renders independent terminal and agent selection, compact groups, and non-destructive view closure', async () => {
  let contentWidth = 1000;
  let resizeContent: (() => void) | undefined;
  const bounds = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.slot === 'sidebar-inset' ? new DOMRect(0, 0, contentWidth, 800) : bounds.call(this);
  });
  const Observer = globalThis.ResizeObserver;
  vi.stubGlobal('ResizeObserver', class extends Observer {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      this.notify = () => callback([], this);
    }
    notify: () => void;
    override observe(element: Element, options?: ResizeObserverOptions) {
      super.observe(element, options);
      if (element.getAttribute('data-slot') === 'sidebar-inset') resizeContent = this.notify;
    }
  });
  const user = userEvent.setup();
  const arrangements = new Map<string, WorkspaceComposition>();
  const snapshots = new Map<string, HostSnapshot>();
  const makeClient = (hostId: string) => {
    const snapshot: HostSnapshot = {
      hostId, displayName: hostId, capabilities: ['workspace.composition.get', 'workspace.composition.replace', 'workspace.composition.terminal-create', 'terminal.attach'],
      executionContexts: [{ executionContextId: 'workspace', name: `Checkout ${hostId}`, canonicalPath: '/code/weave', availability: 'available' }],
      agents: [{ agentId: 'agent', name: 'Agent' }], archivedThreads: [],
      threads: [{ attention: { state: hostId === 'one' ? 'working' : 'waiting', observedAt: new Date().toISOString(), generation: 1 }, threadId: 'thread', executionContextId: 'workspace', agentId: 'agent', title: `Agent on ${hostId}`, status: 'active', workspaceId: `initial-${hostId}`, membershipRevision: 0, acpSessionId: 'session', createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z' }],
    };
    snapshots.set(hostId, snapshot);
    arrangements.set(hostId, { schemaVersion: 2, hostId, revision: 0, workspaces: [{ workspaceId: `initial-${hostId}`, name: `Initial ${hostId}`, layout: null }] });
    const terminals = new Map<string, { terminalId: string; executionContextId: string; title: string; cols: number; rows: number; status: string }>();
    const create = () => { const terminal = { terminalId: `${hostId}-terminal${terminals.size ? `-${terminals.size + 1}` : ''}`, executionContextId: 'workspace', title: 'Shell', currentDirectory: '/code/weave', initialDirectory: '/code/weave', cols: 80, rows: 24, status: 'running' }; terminals.set(terminal.terminalId, terminal); return terminal; };
    const provision = (node: TerminalLayoutNode): TerminalLayoutNode => node.kind === 'split' ? { ...node, children: [provision(node.children[0]), provision(node.children[1])] } : node.terminalId ? node : { ...node, terminalId: create().terminalId };
    return {
      snapshot: vi.fn(async () => snapshot), close: vi.fn(), attach: vi.fn(async () => snapshot.threads[0]),
      getWorkspaceComposition: vi.fn(async () => ({ composition: arrangements.get(hostId) ?? { schemaVersion: 2, hostId, revision: 0, workspaces: [] } })),
      replaceWorkspaceComposition: vi.fn(async (_id: string, revision: number, tabs: Workspace[]) => {
        if ((arrangements.get(hostId)?.revision ?? 0) !== revision) throw new Error('stale revision');
        const composition: WorkspaceComposition = { schemaVersion: 2, hostId, revision: revision + 1, workspaces: tabs.map((tab) => ({ ...tab, layout: tab.layout ? provision(tab.layout) : null })) };
        arrangements.set(hostId, composition); return { composition };
      }),
      assignThread: vi.fn(async (_threadId, _hostId, workspaceId, expectedRevision) => { if (snapshot.threads[0]!.membershipRevision !== expectedRevision) throw new Error('stale membership'); snapshot.threads[0] = { ...snapshot.threads[0]!, workspaceId, membershipRevision: expectedRevision + 1 }; return snapshot.threads[0]; }),
      createTerminal: vi.fn(async () => ({ terminal: create() })),
      listTerminals: vi.fn(async () => ({ terminals: [...terminals.values()] })),
      attachTerminal: vi.fn(async (_executionContextId: string, terminalId: string) => ({ attachment: { attachmentId: `${terminalId}-attachment`, mode: 'shared' }, snapshot: { terminal: terminals.get(terminalId), data: new TextEncoder().encode('ready'), generation: 1, cursor: 5 }, startEvents: vi.fn() })),
      detachTerminal: vi.fn(async () => undefined), closeTerminal: vi.fn(async () => undefined), inputTerminal: vi.fn(async () => undefined), resizeTerminal: vi.fn(async () => undefined),
    };
  };
  const one = makeClient('one'); const two = makeClient('two');
  let controller: AlphaController;
  const factory = (url: string) => (url.includes('one') ? one : two) as unknown as DirectHostClient;
  function App() { controller = useLiveAlphaController(factory); return <AlphaShell controller={controller} />; }
  const rendered = render(<App />);

  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Agent Agent on/ })).toHaveLength(2));
  expect(rendered.container.querySelector('[data-slot="global-bottom-rail"]')).not.toBeInTheDocument();
  const topAgentToggle = screen.getByRole('button', { name: 'Agent conversation' });
  const topConnections = screen.getByRole('button', { name: 'Connections' });
  expect(topAgentToggle.closest('[data-slot="sidebar-header"]')).toContainElement(topConnections);
  expect(topAgentToggle.compareDocumentPosition(topConnections) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Toggle threads' }));
  expect(screen.queryByRole('button', { name: 'Connections' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Agent conversation' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Toggle threads' }));
  expect(screen.getByRole('button', { name: 'Agent conversation' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Agent Agent on two' }));
  await user.click(screen.getByRole('button', { name: 'Workspace Initial one' }));
  expect(screen.queryByText('No terminals')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Agent conversation' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Agent conversation' }));
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Workspace Initial two' }));
  const conversation = screen.getByRole('region', { name: 'Selected agent conversation' });
  expect(screen.queryByRole('main', { name: 'Terminal workspace' })).not.toBeInTheDocument();
  expect(screen.queryByRole('separator', { name: 'Resize terminal workspace and agent conversation' })).not.toBeInTheDocument();
  const conversationToggle = screen.getByRole('button', { name: 'Agent conversation' });
  expect(conversationToggle).toHaveAttribute('aria-disabled', 'true');
  expect(screen.getByRole('button', { name: 'Close agent pane' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Maximize agent pane' })).toBeDisabled();
  expect(conversationToggle).toHaveAttribute('aria-pressed', 'true');
  await user.click(conversationToggle);
  expect(screen.getByRole('region', { name: 'Selected agent conversation' })).toBe(conversation);
  await user.click(screen.getByRole('button', { name: 'Workspace Initial one' }));
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Agent conversation' })).toHaveAttribute('aria-pressed', 'false');
  await user.click(screen.getByRole('button', { name: 'Agent conversation' }));
  await act(async () => { await controller.workspaceActions!.open('one:workspace'); await controller.workspaceActions!.refresh(); });
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveValue('ready'));
  const first = controller!.model.workspaceCompositions!.presentation.openWorkspaces[2]!;
  const originalInput = screen.getByRole('textbox', { name: 'Terminal input' });
  let conversationRegion = screen.getByRole('region', { name: 'Selected agent conversation' });
  const group = conversationRegion.closest('[data-group]')!;
  expect(group).toHaveStyle({ flexDirection: 'row' });
  await user.click(screen.getByRole('button', { name: 'Maximize agent pane' }));
  expect(screen.getByRole('button', { name: 'Restore agent pane' })).toHaveClass('bg-primary-foreground/15');
  expect(originalInput.closest('[data-panel]')).toHaveAttribute('hidden');
  expect(originalInput.isConnected).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Restore agent pane' }));
  expect(originalInput.closest('[data-panel]')).not.toHaveAttribute('hidden');
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(originalInput);
  await user.click(screen.getByRole('button', { name: 'Close agent pane' }));
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();
  expect(controller!.model.selectedThreadId).toBe('two:thread');
  await user.click(screen.getByRole('button', { name: 'Agent conversation' }));
  expect(screen.getByRole('button', { name: 'Maximize agent pane' })).toBeInTheDocument();
  conversationRegion = screen.getByRole('region', { name: 'Selected agent conversation' });
  act(() => { contentWidth = 750; resizeContent!(); });
  expect(group).toHaveStyle({ flexDirection: 'column' });
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(originalInput);
  expect(screen.getByRole('region', { name: 'Selected agent conversation' })).toBe(conversationRegion);
  act(() => { contentWidth = 900; resizeContent!(); });
  expect(group).toHaveStyle({ flexDirection: 'row' });
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(originalInput);
  expect(controller!.model.selectedThreadId).toBe('two:thread');
  await act(async () => { await controller.actions.assignThread!('one:thread', first.workspaceId); });
  let root = rendered.container.querySelector(`[data-workspace-id="${first.workspaceId}"]`)! as HTMLElement;
  expect([...root.querySelectorAll('[data-pane-id], [data-thread-id]')].map((item) => item.hasAttribute('data-thread-id') ? 'agent' : 'terminal')).toEqual(['terminal', 'agent']);
  expect(within(root).getByRole('button', { name: 'Agent Agent on one' })).not.toHaveTextContent('/code/weave');
  expect(root.querySelector('[data-slot="workspace-card"]')).toHaveClass('bg-sidebar-selected');
  await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: 'Agent conversation' }) });
  expect(await screen.findByRole('menuitemradio', { name: 'Right Dock' })).toHaveAttribute('aria-checked', 'true');
  await user.click(screen.getByRole('menuitemradio', { name: 'Left Dock' }));
  expect([...root.querySelectorAll('[data-pane-id], [data-thread-id]')].map((item) => item.hasAttribute('data-thread-id') ? 'agent' : 'terminal')).toEqual(['agent', 'terminal']);
  expect(group.querySelector('[data-panel]')).toHaveAttribute('id', 'agent-conversation');
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(originalInput);
  expect(screen.getByRole('region', { name: 'Selected agent conversation' })).toBe(conversationRegion);
  expect(screen.getByRole('button', { name: 'Agent conversation' })).not.toHaveClass('ml-auto');
  expect(JSON.parse(localStorage.getItem('weave.alpha.agent-dock.v1')!)).toEqual({ schemaVersion: 1, position: 'left' });
  const dockButton = screen.getByRole('button', { name: 'Agent conversation' });
  fireEvent.touchStart(dockButton, { touches: [{ clientX: 30, clientY: 750 }] });
  expect(await screen.findByRole('menuitemradio', { name: 'Left Dock' })).toHaveAttribute('aria-checked', 'true');
  fireEvent.touchEnd(dockButton);
  fireEvent.click(dockButton);
  expect(conversationRegion.isConnected).toBe(true);
  expect(dockButton).toHaveAttribute('aria-pressed', 'true');
  await user.click(screen.getByRole('menuitemradio', { name: 'Right Dock' }));
  expect(group.querySelector('[data-panel]')).toHaveAttribute('id', 'terminal-workspace');
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(originalInput);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Agent conversation' }), { key: 'F10', shiftKey: true });
  expect(await screen.findByRole('menuitemradio', { name: 'Right Dock' })).toHaveAttribute('aria-checked', 'true');
  await user.keyboard('{Escape}');

  for (const name of ['Agent conversation', 'Toggle threads']) {
    await user.click(screen.getByRole('button', { name }));
    expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(originalInput);
    await user.click(screen.getByRole('button', { name }));
  }
  await user.click(screen.getByRole('button', { name: 'Split right' }));
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Maximize terminal' })).toHaveLength(2));
  expect(screen.getAllByRole('textbox', { name: 'Terminal input' })[0]).toBe(originalInput);
  conversationRegion = screen.getByRole('region', { name: 'Selected agent conversation' });
  await user.click(screen.getAllByRole('button', { name: 'Maximize terminal' })[0]!);
  expect(await screen.findByRole('button', { name: 'Restore terminal' })).toHaveClass('text-primary');
  expect(conversationRegion.closest('[data-panel]')).toHaveAttribute('hidden');
  expect(conversationRegion.isConnected).toBe(true);
  expect(screen.getByRole('button', { name: 'Agent conversation' })).toHaveAttribute('aria-pressed', 'false');
  await user.click(screen.getByRole('button', { name: 'Restore terminal' }));
  expect(conversationRegion.closest('[data-panel]')).not.toHaveAttribute('hidden');
  expect(screen.getByRole('region', { name: 'Selected agent conversation' })).toBe(conversationRegion);
  await user.click(screen.getByRole('button', { name: 'Close agent pane' }));
  await user.click(screen.getAllByRole('button', { name: 'Maximize terminal' })[0]!);
  await user.click(screen.getByRole('button', { name: 'Restore terminal' }));
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Agent conversation' }));
  await act(async () => { await controller.workspaceActions!.open('one:workspace'); await controller.workspaceActions!.refresh(); });
  expect(controller!.model.workspaceCompositions!.presentation.openWorkspaces).toHaveLength(4);
  expect(rendered.container.querySelectorAll('[data-workspace-id]')).toHaveLength(4);
  const second = controller!.model.workspaceCompositions!.presentation.openWorkspaces[3]!;
  await act(async () => { await controller.actions.assignThread!('one:thread', second.workspaceId); });
  expect(controller!.model.threads!.find((thread) => thread.id === 'one:thread')).toMatchObject({ workspaceId: second.workspaceId, workingDirectory: '/code/weave', membershipRevision: 2 });
  expect(screen.getByRole('button', { name: 'Agent Agent on one' })).toBeInTheDocument();
  expect(controller!.model.threads!.find((thread) => thread.id === 'one:thread')!.workspaceId).toBe(second.workspaceId);
  await act(async () => { await controller.actions.assignThread!('one:thread', first.workspaceId); });
  expect(await screen.findByRole('button', { name: 'Agent Agent on one' })).not.toHaveTextContent('/code/weave');
  expect(screen.queryByLabelText('Unassigned agents')).not.toBeInTheDocument();
  expect(one.closeTerminal).not.toHaveBeenCalled();
  expect(controller!.model.selectedThreadId).toBe('two:thread');
  const pane = arrangements.get('one')!.workspaces.find((workspace) => workspace.workspaceId === first.workspaceId)!.layout!;
  const firstPane = pane.kind === 'split' ? pane.children[0] : pane;
  if (firstPane.kind !== 'terminal') throw new Error('Expected terminal');
  await act(async () => { controller.workspaceActions!.focus(first, firstPane.paneId); });
  expect(controller!.model.workspaceCompositions!.presentation.focusedPanes[JSON.stringify(['one', first.workspaceId])]).toBe(firstPane.paneId);
  rendered.unmount();
}, 15000);

it('keeps the terminal mounted while archiving selects a replacement or removes the agent pane', async () => {
  const user = userEvent.setup();
  const makeClient = (hostId: string) => {
    let snapshot: HostSnapshot = {
      hostId, displayName: hostId,
      capabilities: ['thread.archive', 'thread.restore', 'workspace.composition.get', 'workspace.composition.replace'],
      executionContexts: [{ executionContextId: 'context', name: 'Code', canonicalPath: '/code', availability: 'available' }],
      agents: [{ agentId: 'agent', name: 'Agent' }], archivedThreads: [],
      threads: ['first', 'next'].map((threadId) => ({
        threadId, executionContextId: 'context', agentId: 'agent', title: `${hostId} ${threadId}`,
        workspaceId: `initial-${hostId}`, membershipRevision: 0, status: 'active', acpSessionId: `${hostId}-${threadId}`,
        createdAt: '2026-09-11T00:00:00Z', updatedAt: '2026-09-11T00:00:00Z',
      })),
    };
    const terminal = { terminalId: 'terminal', executionContextId: 'context', title: 'Shell', cols: 80, rows: 24, status: 'running' };
    return {
      snapshot: vi.fn(async () => snapshot), attach: vi.fn(async (id: string) => snapshot.threads.find((thread) => thread.threadId === id)), close: vi.fn(),
      archiveThread: vi.fn(async (id: string) => {
        const archived = { ...snapshot.threads.find((thread) => thread.threadId === id)!, status: 'archived' as const, archivedAt: '2026-09-11T00:00:01Z' };
        snapshot = { ...snapshot, threads: snapshot.threads.filter((thread) => thread.threadId !== id), archivedThreads: [...snapshot.archivedThreads, archived] };
        return archived;
      }),
      getWorkspaceComposition: vi.fn(async () => ({ composition: {
        schemaVersion: 2, hostId, revision: 0, workspaces: [{ workspaceId: `initial-${hostId}`, name: hostId,
          layout: { kind: 'terminal', nodeId: 'node', paneId: 'pane', terminalId: 'terminal', executionContextId: 'context' },
        }],
      } })),
      listTerminals: vi.fn(async () => ({ terminals: [terminal] })),
      attachTerminal: vi.fn(async () => ({ attachment: { attachmentId: 'attachment', mode: 'shared' }, snapshot: { terminal, data: new TextEncoder().encode('ready'), generation: 1, cursor: 5 }, startEvents: vi.fn() })),
      detachTerminal: vi.fn(async () => undefined), resizeTerminal: vi.fn(async () => undefined), inputTerminal: vi.fn(async () => undefined),
    };
  };
  const one = makeClient('one'), two = makeClient('two');
  const factory = (url: string) => (url.includes('one') ? one : two) as unknown as DirectHostClient;
  let controller!: AlphaController;
  function App() { controller = useLiveAlphaController(factory); return <AlphaShell controller={controller} />; }
  render(<App />);
  await screen.findByRole('button', { name: 'Agent one first' });
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Agent conversation' }));
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Agent one first' }));
  const terminal = await screen.findByRole('textbox', { name: 'Terminal input' });
  expect(screen.getByRole('region', { name: 'Selected agent conversation' })).toHaveTextContent('one first');
  await user.click(screen.getByRole('button', { name: 'Maximize agent pane' }));
  await act(async () => controller.actions.archiveThread('one:first'));
  expect(controller.model.selectedThreadId).toBe('one:next');
  expect(screen.getByRole('region', { name: 'Selected agent conversation' })).toHaveTextContent('one next');
  await act(async () => controller.actions.archiveThread('one:next'));
  expect(controller.model.selectedThreadId).toBeUndefined();
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();
  expect(screen.queryByRole('separator', { name: 'Resize terminal workspace and agent conversation' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(terminal);
  expect(terminal.closest('[data-panel]')).not.toHaveAttribute('hidden');
  await user.click(screen.getByRole('button', { name: 'Agent conversation' }));
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Agent two first' }));
  await user.click(screen.getByRole('button', { name: 'Workspace one' }));
  const activeTerminal = screen.getByRole('textbox', { name: 'Terminal input' });
  await act(async () => controller.actions.archiveThread('two:first'));
  expect(controller.model.selectedThreadId).toBeUndefined();
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).toBe(activeTerminal);
  expect(two.attach).not.toHaveBeenCalledWith('next');

  await act(async () => controller.actions.createThread('one:context', undefined, 'initial-one'));
  let composer = await screen.findByRole('textbox', { name: 'Message agent' });
  await waitFor(() => expect(document.activeElement).toBe(composer));
  const active = screen.getByRole('textbox', { name: 'Terminal input' }).closest('[data-focused]')!;
  expect(active).toHaveAttribute('data-focused', 'true');
  expect(active).not.toHaveAttribute('data-dimmed');
  expect(active.querySelector('[data-slot="native-terminal"]')).toHaveAttribute('data-dim-amount', '0');
  expect(active.querySelector('[data-slot="terminal-focus-border"]')).toHaveClass('border-sidebar-selected');
  expect(document.querySelector('[data-slot="thread-top-rail"]')).toHaveClass('bg-sidebar-selected', 'text-foreground');

  const draftId = controller.model.selectedThreadId;
  await user.click(screen.getByRole('button', { name: 'Close agent pane' }));
  expect(controller.model.threads?.some((thread) => thread.id === draftId)).toBe(false);
  expect(document.querySelector(`[data-thread-id="${draftId}"]`)).not.toBeInTheDocument();
  expect(controller.model.selectedThreadId).toBeUndefined();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Terminal input' })));
  await act(async () => controller.actions.createThread('one:context', undefined, 'initial-one'));
  composer = await screen.findByRole('textbox', { name: 'Message agent' });
  await waitFor(() => expect(document.activeElement).toBe(composer));
  await user.click(screen.getByRole('button', { name: 'Maximize terminal' }));
  expect(screen.queryByRole('region', { name: 'Selected agent conversation' })).not.toBeInTheDocument();
  await act(async () => controller.actions.createThread('one:context', undefined, 'initial-one'));
  composer = await screen.findByRole('textbox', { name: 'Message agent' });
  await waitFor(() => expect(document.activeElement).toBe(composer));
  expect(screen.getByRole('region', { name: 'Selected agent conversation' })).toBeInTheDocument();

});
