import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { activateWorkspace, emptyWorkspacePresentation } from '@/app/workspace-presentation';
import { WorkspaceSidebar } from './workspace-sidebar';
import { SidebarProvider } from './ui/sidebar';

vi.mock('@/client-browser/native-client-browser', () => ({ clientBrowserAvailable: true, nativeClientBrowser: {} }));

it('opens a Client Browser in the chosen Workspace through its normal menu', async () => {
  const reference = { hostId: 'host', workspaceId: 'work' };
  const create = vi.fn().mockResolvedValue(undefined);
  const controller = { actions: { newClientBrowserPane: create }, workspaceActions: {}, model: {
    connections: [{ hostId: 'host', status: 'connected' }], executionContexts: [], threads: [],
    workspaceCompositions: { pending: false, loading: false, terminals: {},
      presentation: activateWorkspace(emptyWorkspacePresentation(), reference),
      compositions: { host: { hostId: 'host', workspaces: [{ workspaceId: 'work', name: 'Work', layout: null }] } },
    },
  } } as unknown as AlphaController;
  const user = userEvent.setup();
  render(<SidebarProvider><WorkspaceSidebar controller={controller} /></SidebarProvider>);
  await user.click(screen.getByRole('button', { name: 'Workspace actions for Work' }));
  await user.click(screen.getByRole('menuitem', { name: 'New Client Browser' }));
  expect(create).toHaveBeenCalledExactlyOnceWith(reference);
});
