import { useEffect, useState } from 'react';
import type { TerminalOutputSource } from '@/terminal/output-stream';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import type { WorkspaceComposition, WorkspaceTab } from '@weave/product-protocol';
import type { AlphaController } from '@/app/alpha-controller';
import { useLiveAlphaController } from '@/app/use-live-alpha-controller';
import { type DirectHostClient, type HostSnapshot } from '@/portal-client';
import { AlphaShell } from './alpha-shell';

const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@capacitor/preferences', () => ({ Preferences: {
  get: vi.fn(async ({ key }: { key: string }) => ({ value: storage.get(key) ?? null })),
  set: vi.fn(async ({ key, value }: { key: string; value: string }) => { storage.set(key, value); }),
} }));
vi.mock('@/app/portal-connection-storage', () => ({
  loadPortalConnections: async () => ({ connections: ['one', 'two'].map((hostId) => ({ hostId, displayName: hostId, hostUrl: `ws://${hostId}.test`, credentialId: hostId, keyId: hostId })) }),
  savePortalConnections: vi.fn(),
}));
vi.mock('./xterm-terminal-view', () => ({ XtermTerminalView: ({ data = '', output, onInput }: { data?: string; output?: TerminalOutputSource; onInput(data: string): void }) => {
  const [text, setText] = useState(data);
  useEffect(() => output?.subscribe({ reset: async (value) => { setText(value); }, write: async (value) => { setText((current) => current + value); } }), [output]);
  return <textarea aria-label='Terminal input' value={text} onChange={(event) => onInput(event.target.value)} />;
} }));
beforeEach(() => storage.clear());

it('renders independent terminal and agent selection, compact groups, and non-destructive view closure', async () => {
  const user = userEvent.setup();
  const arrangements = new Map<string, WorkspaceComposition>();
  const snapshots = new Map<string, HostSnapshot>();
  const makeClient = (hostId: string) => {
    const snapshot: HostSnapshot = {
      hostId, displayName: hostId, capabilities: ['workspace.composition.get', 'workspace.composition.replace', 'terminal.attach'],
      workspaces: [{ workspaceId: 'workspace', name: `Checkout ${hostId}`, canonicalPath: '/code/weave' }],
      agents: [{ agentId: 'agent', name: 'Agent' }], archivedThreads: [],
      threads: [{ attention: { state: hostId === 'one' ? 'working' : 'waiting', observedAt: new Date().toISOString(), generation: 1 }, threadId: 'thread', workspaceId: 'workspace', agentId: 'agent', title: `Agent on ${hostId}`, status: 'active', acpSessionId: 'session', createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z' }],
    };
    snapshots.set(hostId, snapshot);
    let terminal: { terminalId: string; workspaceId: string; title: string; cols: number; rows: number; status: string } | undefined;
    return {
      snapshot: vi.fn(async () => snapshot), close: vi.fn(), attach: vi.fn(async () => snapshot.threads[0]),
      getWorkspaceComposition: vi.fn(async () => ({ composition: arrangements.get(hostId) ?? { schemaVersion: 1, workspaceId: 'workspace', revision: 0, tabs: [] } })),
      replaceWorkspaceComposition: vi.fn(async (_id: string, revision: number, tabs: WorkspaceTab[]) => {
        if ((arrangements.get(hostId)?.revision ?? 0) !== revision) throw new Error('stale revision');
        const composition: WorkspaceComposition = { schemaVersion: 1, workspaceId: 'workspace', revision: revision + 1, tabs };
        arrangements.set(hostId, composition); return { composition };
      }),
      createTerminal: vi.fn(async () => { terminal = { terminalId: `${hostId}-terminal`, workspaceId: 'workspace', title: 'Shell', cols: 80, rows: 24, status: 'running' }; return { terminal }; }),
      listTerminals: vi.fn(async () => ({ terminals: terminal ? [terminal] : [] })),
      attachTerminal: vi.fn(async () => ({ attachment: { attachmentId: `${hostId}-attachment`, mode: 'control' }, snapshot: { terminal, data: 'ready', generation: 1, cursor: 5 }, startEvents: vi.fn() })),
      detachTerminal: vi.fn(async () => undefined), closeTerminal: vi.fn(async () => undefined), inputTerminal: vi.fn(async () => undefined), resizeTerminal: vi.fn(async () => undefined),
    };
  };
  const one = makeClient('one'); const two = makeClient('two');
  let controller: AlphaController;
  const factory = (url: string) => (url.includes('one') ? one : two) as unknown as DirectHostClient;
  function App() { controller = useLiveAlphaController(factory); return <AlphaShell controller={controller} />; }
  const rendered = render(<App />);
  await waitFor(() => expect(screen.getAllByRole('button', { name: /^Agent Agent on/ })).toHaveLength(2));
  expect(rendered.container.querySelectorAll('[data-context-id]')).toHaveLength(0);
  expect(one.attach).not.toHaveBeenCalled();
  expect(two.attach).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Agent Agent on one' })).toHaveTextContent('working');
  expect(screen.getByRole('button', { name: 'Agent Agent on two' })).toHaveTextContent('waiting');
  await user.click(screen.getByRole('button', { name: 'Agent Agent on two' }));
  await waitFor(() => expect(controller.model.selectedThreadId).toBe('two:thread'));
  await user.click(screen.getByRole('button', { name: 'Open…' }));
  await user.click(screen.getByRole('menuitem', { name: 'Open workspace in Checkout one' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace one /code/weave' })).toHaveAttribute('aria-pressed', 'true'));
  expect(controller!.model.selectedThreadId).toBe('two:thread');
  const root = rendered.container.querySelector('[data-context-id]')! as HTMLElement;
  expect(within(root).getByRole('button', { name: 'Agent Agent on one' })).toBeInTheDocument();
  expect(root.querySelectorAll('[data-workspace-tab]')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Start terminal' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveValue('ready'));
  const selectedTab = controller!.model.workspaceCompositions!.presentation.activeTab;
  const detachCount = one.detachTerminal.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Agent Agent on one' }));
  await user.click(screen.getByRole('button', { name: 'Agent Agent on two' }));
  expect(controller!.model.workspaceCompositions!.presentation.activeTab).toBe(selectedTab);
  expect(one.detachTerminal).toHaveBeenCalledTimes(detachCount);
  expect(one.attachTerminal).toHaveBeenCalledTimes(1);
  await user.type(screen.getByRole('textbox', { name: 'Terminal input' }), 'x');
  expect(one.inputTerminal).toHaveBeenLastCalledWith('workspace', 'one-terminal', 'one-attachment', 'readyx');
  expect(two.inputTerminal).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Workspace actions for Checkout one' }));
  await user.click(screen.getByRole('menuitem', { name: 'New terminal workspace' }));
  await waitFor(() => expect(root.querySelectorAll('[data-workspace-tab]')).toHaveLength(2));
  expect([...root.querySelectorAll('[data-thread-id], [data-workspace-tab]')].map((item) => item.hasAttribute('data-thread-id') ? 'agent' : 'workspace')).toEqual(['agent', 'workspace', 'workspace']);
  expect(root.querySelectorAll('[data-thread-id]')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'Close workspace view Workspace 2' }));
  await waitFor(() => expect(root.querySelectorAll('[data-workspace-tab]')).toHaveLength(0));
  expect(controller!.model.selectedThreadId).toBe('two:thread');
  await user.click(screen.getByRole('button', { name: 'Close workspace view' }));
  await waitFor(() => expect(rendered.container.querySelectorAll('[data-context-id]')).toHaveLength(0));
  expect(within(rendered.container.querySelector('[data-slot="unattached-agents"]')! as HTMLElement).getAllByRole('button', { name: /^Agent Agent on/ })).toHaveLength(2);
  expect(arrangements.get('one')?.tabs).toHaveLength(2);
  expect(one.closeTerminal).not.toHaveBeenCalled();
  expect(one.detachTerminal).toHaveBeenCalled();
  await act(async () => { await Promise.resolve(); });
  expect(JSON.parse(storage.get('weave.workspace-presentation.v1')!).openTabs).toEqual([]);
  rendered.unmount();
  render(<App />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Agent Agent on two' })).toHaveAttribute('aria-pressed', 'true'));
  expect(controller!.model.workspaceCompositions!.presentation.openTabs).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'Open…' }));
  await user.click(screen.getByRole('menuitem', { name: 'Open workspace in Checkout one' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveValue('ready'));
  expect(one.createTerminal).toHaveBeenCalledTimes(1);
  expect(controller!.model.selectedThreadId).toBe('two:thread');
  snapshots.get('one')!.workspaces[0]!.availability = 'path-changed';
  await act(async () => { await controller!.actions.refresh(); });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Workspace one /code/weave' })).toHaveTextContent('directory changed'));
  expect(screen.getByRole('textbox', { name: 'Terminal input' })).toHaveValue('ready');
  await user.click(screen.getByRole('button', { name: 'New agent thread' }));
  expect(screen.getByRole('menuitem', { name: 'New thread in Checkout one' })).toHaveAttribute('aria-disabled', 'true');
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: 'Workspace actions for Checkout one' }));
  await user.click(screen.getByRole('menuitem', { name: 'New terminal workspace' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start terminal' })).toBeDisabled());
  expect(controller!.model.selectedThreadId).toBe('two:thread');

});
