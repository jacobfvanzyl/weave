import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { WorkspaceSidebar } from './workspace-sidebar';
import { SidebarProvider } from './ui/sidebar';
import { emptyWorkspacePresentation, activateWorkspace } from '@/app/workspace-presentation';
import type { AlphaController } from '@/app/alpha-controller';

function setup(dirty: boolean) {
  const reference = { hostId: 'host', workspaceId: 'workspace' };
  const plan = { workspaceId: 'workspace', name: 'Work', token: 'preview-token', terminals: [], threads: [{ threadId: 'thread', title: 'Agent', dirty }] };
  const actions = { previewClose: vi.fn(async () => plan), close: vi.fn(async () => undefined) };
  const controller = { actions: {}, workspaceActions: actions, model: { executionContexts: [], connections: [{ hostId: 'host', status: 'connected' }], threads: [], workspaceCompositions: { presentation: activateWorkspace(emptyWorkspacePresentation(), reference), compositions: { host: { hostId: 'host', workspaces: [{ workspaceId: 'workspace', name: 'Work', layout: null }] } }, terminals: {}, pending: false, loading: false } } } as unknown as AlphaController;
  render(<SidebarProvider><WorkspaceSidebar controller={controller} /></SidebarProvider>);
  return { user: userEvent.setup(), actions, reference, plan };
}

it('confirms dirty close, cancels without stopping anything, and reports a failed stop', async () => {
  const { user, actions, reference, plan } = setup(true);
  await user.click(screen.getByRole('button', { name: 'Workspace actions for Work' }));
  expect(screen.queryByRole('menuitem', { name: /Hide workspace/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('menuitem', { name: 'Close workspace' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/conversations will be archived/)).toBeInTheDocument();
  expect(actions.close).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(actions.close).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Workspace actions for Work' }));
  await user.click(screen.getByRole('menuitem', { name: 'Close workspace' }));
  actions.close.mockRejectedValueOnce(new Error('A terminal did not stop'));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Close workspace' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('A terminal did not stop');
  expect(actions.close).toHaveBeenCalledWith(reference, plan, true);
  expect(screen.getByRole('button', { name: 'Workspace Work', hidden: true })).toBeInTheDocument();
});

it('closes a Host-confirmed clean workspace immediately', async () => {
  const { user, actions, reference, plan } = setup(false);
  await user.click(screen.getByRole('button', { name: 'Workspace actions for Work' }));
  await user.click(screen.getByRole('menuitem', { name: 'Close workspace' }));
  await waitFor(() => expect(actions.close).toHaveBeenCalledWith(reference, plan, false));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
