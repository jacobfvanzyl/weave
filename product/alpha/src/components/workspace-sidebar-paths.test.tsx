import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { activateWorkspace, emptyWorkspacePresentation, workspaceKey } from '@/app/workspace-presentation';
import { WorkspaceSidebar } from './workspace-sidebar';
import { SidebarProvider } from './ui/sidebar';

vi.mock('@/client-browser/native-client-browser', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/client-browser/native-client-browser')>(), clientBrowserAvailable: false,
}));
const reference = { hostId: 'host', workspaceId: 'work' };
const paths = ['/one/code/project', '/two/code/project'];
const leaf = (id: string) => ({ kind: 'terminal', nodeId: `node-${id}`, paneId: id, terminalId: id, executionContextId: id });
const agent = (id: string) => ({ kind: 'agent', paneId: `agent-${id}`, threadId: `agent-${id}` });
const split = (...children: unknown[]) => ({ kind: 'split', children });
function fixture(layout: unknown) {
  return { actions: { selectThread: vi.fn() }, workspaceActions: { focus: vi.fn() }, model: {
    connections: [{ hostId: 'host', status: 'connected' }],
    executionContexts: [{ hostId: 'host', executionContextId: 'a', canonicalPath: paths[0] }],
    threads: [
      { id: 'agent-b', threadId: 'agent-b', title: 'Agent B', hostId: 'host', workspaceId: 'work', executionContextId: 'b', workingDirectory: paths[1] },
      { id: 'agent-a', threadId: 'agent-a', title: 'Agent A', hostId: 'host', workspaceId: 'work', executionContextId: 'a' },
    ],
    workspaceCompositions: { pending: false, loading: false,
      presentation: { ...activateWorkspace(emptyWorkspacePresentation(), reference), focusedPanes: { [workspaceKey(reference)]: 'b' } },
      terminals: { host: [
        { terminalId: 'b', title: 'zsh', processName: 'zsh', currentDirectory: paths[1] },
        { terminalId: 'a', title: 'nvim', processName: 'nvim', currentDirectory: paths[0] },
      ] },
      compositions: { host: { hostId: 'host', workspaces: [{ workspaceId: 'work', name: 'Work', layout }] } },
    },
  } } as unknown as AlphaController;
}
const ui = (controller: AlphaController) => <SidebarProvider><WorkspaceSidebar controller={controller} /></SidebarProvider>;
const paneIds = (container: HTMLElement) => [...container.querySelectorAll('[data-pane-id]')].map(row => row.getAttribute('data-pane-id'));

it('shows flat pane rows in layout order and labels plain shells by their current directory', () => {
  const controller = fixture(split(split(leaf('a'), agent('a')), split(leaf('b'), agent('b'))));
  const view = render(ui(controller));
  expect(paneIds(view.container)).toEqual(['a', 'agent-a', 'b', 'agent-b']);
  expect(view.container.querySelector('[data-slot="workspace-directory-group"]')).toBeNull();
  expect(view.container.querySelector('[data-slot="badge"]')).toBeNull();
  for (const name of ['Workspace Work', 'Agent Agent A', 'Agent Agent B', 'Terminal nvim', 'Terminal .../code/project']) {
    expect(screen.getByRole('button', { name })).toHaveClass('h-8');
  }
  const terminal = screen.getByRole('button', { name: 'Terminal .../code/project' });
  expect(terminal).toHaveAttribute('aria-pressed', 'true');
  expect(terminal.querySelector('[title]')).toHaveAttribute('title', paths[1]);
  expect(terminal.querySelector('[title]')).toHaveClass('truncate');
  fireEvent.click(terminal);
  expect(controller.workspaceActions!.focus).toHaveBeenCalledWith(reference, 'b');
  fireEvent.click(screen.getByRole('button', { name: 'Agent Agent A' }));
  expect(controller.actions.selectThread).toHaveBeenCalledWith('agent-a');

  const state = controller.model.workspaceCompositions!;
  state.terminals.host![0]!.currentDirectory = '/different/location/new';
  view.rerender(ui(controller));
  expect(paneIds(view.container)).toEqual(['a', 'agent-a', 'b', 'agent-b']);
  expect(screen.getByRole('button', { name: 'Terminal .../location/new' })).toHaveAttribute('aria-pressed', 'true');
});

it('interleaves both browser types with terminals and agents, and follows rearranged splits', () => {
  const host = { kind: 'host-browser', paneId: 'browser-host', profileId: 'profile' };
  const client = { kind: 'client-browser', paneId: 'browser-client', initialUrl: 'https://client.test/' };
  const controller = fixture(split(split(client, agent('b')), split(host, leaf('a'))));
  const state = controller.model.workspaceCompositions!;
  state.presentation.focusedPanes[workspaceKey(reference)] = 'browser-client';
  const view = render(ui(controller));
  expect(paneIds(view.container)).toEqual(['browser-client', 'agent-b', 'browser-host', 'a']);
  expect(screen.getByRole('button', { name: 'Client Browser client.test' })).toHaveAttribute('aria-pressed', 'true');
  expect(view.container.querySelectorAll('[data-agent-browser-badge]')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Agent Browser Agent Browser' }));
  expect(controller.workspaceActions!.focus).toHaveBeenCalledWith(reference, 'browser-host');

  const layout = state.compositions.host!.workspaces[0]!.layout;
  if (!layout || layout.kind !== 'split') throw new Error('Expected split');
  layout.children.reverse();
  view.rerender(ui(controller));
  expect(paneIds(view.container)).toEqual(['browser-host', 'a', 'browser-client', 'agent-b']);
  expect(screen.getByRole('button', { name: 'Client Browser client.test' })).toHaveAttribute('aria-pressed', 'true');
  state.presentation.collapsedWorkspaces.push(workspaceKey(reference));
  view.rerender(ui(controller));
  expect(paneIds(view.container)).toEqual([]);
});
