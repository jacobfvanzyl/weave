import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { emptyWorkspacePresentation, workspaceKey, hostCompositionKey } from '@/app/workspace-presentation';
import { WorkspaceCanvas } from './workspace-canvas';
import { ConnectionsButton } from './connections-button';

vi.mock('@/app/use-alpha-terminals', () => ({ useAlphaTerminals: ({ target }: { target?: unknown }) => ({
  model: { tabs: [], loading: false, ...(target ? { attachmentId: 'stale-attachment', attachmentMode: 'shared' } : {}) },
  actions: {},
}) }));
vi.mock('./terminal-view', () => ({ TerminalView: () => <div>Live terminal output</div> }));

it('replaces all disconnected panes with skeletons, badges any failed Host, and recovers without losing the layout', async () => {
  const reference = { hostId: 'host', executionContextId: 'workspace', workspaceId: 'tab' };
  const presentation = { ...emptyWorkspacePresentation(), openWorkspaces: [reference], activeWorkspace: workspaceKey(reference) };
  const controller = {
    model: {
      connections: [{ hostId: 'host', status: 'disconnected' }, { hostId: 'other', status: 'connected' }],
      executionContexts: [],
      workspaceCompositions: { presentation, terminals: {}, pending: false, loading: false, compositions: {
        [hostCompositionKey('host')]: { schemaVersion: 2, hostId: 'host', revision: 1, workspaces: [{
          workspaceId: 'tab', name: 'Workspace 1', layout: { kind: 'split', nodeId: 'split', axis: 'horizontal', ratio: 0.5, children: [
            { kind: 'terminal', executionContextId: 'workspace', nodeId: 'one', paneId: 'one', terminalId: 'terminal' },
            { kind: 'terminal', executionContextId: 'workspace', nodeId: 'two', paneId: 'two', terminalId: 'second-terminal' },
          ] },
        }] },
      } },
    },
    actions: { openConnections: vi.fn() },
  } as unknown as AlphaController;
  const ui = () => <><WorkspaceCanvas controller={controller} /><ConnectionsButton controller={controller} /></>;
  const view = render(ui());
  expect(screen.getAllByRole('status', { name: 'Connecting terminal' })).toHaveLength(2);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('Live terminal output')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Start terminal' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connections' })).toHaveAccessibleDescription('1 Host unavailable');
  expect(screen.getByRole('button', { name: 'Connections' }).querySelector('[data-slot="badge"]')).not.toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Connections' }));
  expect(controller.actions.openConnections).toHaveBeenCalledOnce();

  controller.model.connections[0]!.status = 'connected';
  view.rerender(ui());
  expect(screen.queryByRole('status', { name: 'Connecting terminal' })).not.toBeInTheDocument();
  expect(screen.getAllByText('Live terminal output')).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Start terminal' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connections' }).querySelector('[data-slot="badge"]')).toBeNull();
  expect(view.container.querySelectorAll('[data-pane-id]')).toHaveLength(2);

  // A failure on another Host still appears even when the active workspace is healthy.
  controller.model.connections[1]!.status = 'reconnecting';
  view.rerender(ui());
  expect(screen.getByRole('button', { name: 'Connections' })).toHaveAccessibleDescription('1 Host unavailable');
  expect(screen.getAllByText('Live terminal output')).toHaveLength(2);

  controller.model.workspaceCompositions!.error = 'This arrangement was changed on another device.';
  view.rerender(ui());
  expect(within(screen.getByRole('alert')).getByText('This arrangement was changed on another device.')).toBeInTheDocument();
});
