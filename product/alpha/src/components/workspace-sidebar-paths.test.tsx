import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { activateWorkspace, emptyWorkspacePresentation } from '@/app/workspace-presentation';
import { WorkspaceSidebar } from './workspace-sidebar';
import { SidebarProvider } from './ui/sidebar';

it('groups by full directory, keeps rows compact, and mirrors type ordering with the agent dock', () => {
  const paths = ['/one/code/project', '/two/code/project'];
  const leaf = (id: string) => ({ kind: 'terminal', nodeId: `node-${id}`, paneId: id, terminalId: id, executionContextId: id });
  const controller = { actions: {}, workspaceActions: {}, model: {
    connections: [{ hostId: 'host', status: 'connected' }],
    executionContexts: [{ hostId: 'host', executionContextId: 'a', canonicalPath: paths[0] }],
    threads: [{ id: 'agent-b', title: 'Agent B', hostId: 'host', workspaceId: 'work', executionContextId: 'b', workingDirectory: paths[1] }, { id: 'agent-a', title: 'Agent A', hostId: 'host', workspaceId: 'work', executionContextId: 'a' }],
    workspaceCompositions: { pending: false, loading: false,
      presentation: activateWorkspace(emptyWorkspacePresentation(), { hostId: 'host', workspaceId: 'work' }),
      terminals: { host: [{ terminalId: 'a', title: 'nvim', processName: 'nvim', currentDirectory: paths[0] }, { terminalId: 'b', title: paths[1], processName: 'zsh', currentDirectory: paths[1] }] },
      compositions: { host: { hostId: 'host', workspaces: [{ workspaceId: 'work', name: 'Work', layout: { kind: 'split', children: [leaf('a'), leaf('b')] } }] } },
    },
  } } as unknown as AlphaController;
  const ui = (dock: 'left' | 'right') => <SidebarProvider><WorkspaceSidebar controller={controller} agentDock={dock} /></SidebarProvider>;
  const view = render(ui('right'));
  const groups = () => [...view.container.querySelectorAll('[data-slot="workspace-directory-group"]')];
  const children = (group: Element) => [...group.querySelectorAll('[data-pane-id], [data-thread-id]')].map((row) => row.getAttribute('data-pane-id') ?? row.getAttribute('data-thread-id'));
  expect(groups().map((group) => group.getAttribute('data-directory'))).toEqual(paths);
  expect(groups().map(children)).toEqual([['a', 'agent-a'], ['b', 'agent-b']]);
  expect(view.container.querySelectorAll('[data-slot="badge"]')).toHaveLength(2);
  expect(groups()[0]!.querySelector('[data-slot="badge"]')).toHaveAttribute('data-variant', 'sidebar-selected');
  for (const name of ['Workspace Work', 'Agent Agent A', 'Agent Agent B', 'Terminal nvim', 'Terminal zsh']) {
    const row = screen.getByRole('button', { name });
    expect(row).toHaveClass('h-8');
    expect(row).not.toHaveTextContent('code/project');
  }
  view.rerender(ui('left'));
  expect(groups().map((group) => group.getAttribute('data-directory'))).toEqual([...paths].reverse());
  expect(groups().map(children)).toEqual([['agent-b', 'b'], ['agent-a', 'a']]);
  controller.model.workspaceCompositions!.presentation.activeWorkspace = undefined;
  view.rerender(ui('left'));
  expect(groups()[0]!.querySelector('[data-slot="badge"]')).toHaveAttribute('data-variant', 'sidebar');
});
