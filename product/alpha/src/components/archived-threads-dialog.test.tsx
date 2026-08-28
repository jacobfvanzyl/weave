import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { ArchivedThreadsDialog } from './archived-threads-dialog';

const controller = (): AlphaController => ({
  model: {
    platform: 'test',
    connectionsLoaded: true,
    connectionsOpen: false,
    archivedThreadsOpen: true,
    connections: [{
      hostId: 'host-1',
      displayName: 'bazzite',
      hostUrl: 'ws://bazzite:4122',
      status: 'connected',
      selected: false,
    }],
    connection: {
      status: 'connected',
      hostUrl: 'ws://bazzite:4122',
      hostName: 'bazzite',
    },
    searchQuery: '',
    workspaces: [],
    archivedThreads: [{
      id: 'host-1:thread-1',
      threadId: 'thread-1',
      hostId: 'host-1',
      title: 'Archived acceptance',
      agentName: 'Codex',
      hostName: 'bazzite',
      status: 'archived',
      updatedAt: '2026-08-26T00:00:00.000Z',
      archivedAt: '2026-08-26T00:00:00.000Z',
      workspaceId: 'weave',
    }],
    showHostIdentity: false,
    busy: false,
  },
  actions: {
    setSearchQuery: vi.fn(),
    openConnections: vi.fn(),
    closeConnections: vi.fn(),
    openArchivedThreads: vi.fn(),
    closeArchivedThreads: vi.fn(),
    pairHost: vi.fn(),
    forgetHost: vi.fn(),
    reconnectHost: vi.fn(),
    refresh: vi.fn(),
    createThread: vi.fn(),
    selectThread: vi.fn(),
    archiveThread: vi.fn(),
    restoreThread: vi.fn(),
    openWorkspaceDirectory: vi.fn(),
    openWorkspaceFile: vi.fn(),
    activateWorkspaceFile: vi.fn(),
    closeWorkspaceFile: vi.fn(),
    reloadWorkspaceFile: vi.fn(),
    sendPrompt: vi.fn(),
    cancelPrompt: vi.fn(),
    respondToPermission: vi.fn(),
    respondToElicitation: vi.fn(),
    setMode: vi.fn(),
    setConfigOption: vi.fn(),
  },
});

describe('ArchivedThreadsDialog', () => {
  it('restores the host-scoped Thread identity', async () => {
    const value = controller();
    render(<ArchivedThreadsDialog controller={value} />);

    expect(screen.getByRole('dialog', { name: 'Archived Threads' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }));

    expect(value.actions.restoreThread).toHaveBeenCalledWith('host-1:thread-1');
  });

  it('does not offer a restore through a disconnected owning Host', () => {
    const value = controller();
    value.model.connection.status = 'disconnected';
    value.model.connections[0].status = 'disconnected';
    render(<ArchivedThreadsDialog controller={value} />);

    expect(screen.getByRole('button', { name: 'Restore' })).toBeDisabled();
  });

  it('shows a useful empty state', () => {
    const value = controller();
    value.model.archivedThreads = [];
    render(<ArchivedThreadsDialog controller={value} />);

    expect(screen.getByText('No archived Threads')).toBeInTheDocument();
  });
});
