import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { createTranscript } from '@/chat/acp-transcript';
import { SidebarProvider } from '@/components/ui/sidebar';
import { WorkspacePlaceholder } from './workspace-placeholder';

const controller = (): AlphaController => ({
  model: {
    platform: 'test',
    connectionsLoaded: true,
    connectionsOpen: false,
    connections: [{ hostId: 'host-1', displayName: 'bazzite', hostUrl: 'bazzite', status: 'connected', selected: true }],
    connection: {
      status: 'connected',
      hostUrl: 'ws://bazzite:4122',
      hostName: 'bazzite',
    },
    searchQuery: '',
    workspaces: [{
      id: 'weave',
      workspaceId: 'weave',
      hostId: 'host-1',
      name: 'weave',
      threads: [{
        id: 'thread-1',
        threadId: 'thread-1',
        hostId: 'host-1',
        title: 'Acceptance',
        agentName: 'Codex',
        hostName: 'bazzite',
        status: 'active',
        updatedAt: '2026-08-25T00:00:00.000Z',
        workspaceId: 'weave',
      }],
    }],
    selectedThreadId: 'thread-1',
    transcript: createTranscript('session-1'),
    busy: false,
    error: 'Portal lost the connection to this host.',
  },
  actions: {
    setSearchQuery: vi.fn(),
    openConnections: vi.fn(),
    closeConnections: vi.fn(),
    pairHost: vi.fn(),
    selectHost: vi.fn(),
    forgetHost: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    createThread: vi.fn(),
    selectThread: vi.fn(),
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

describe('WorkspacePlaceholder', () => {
  it('anchors errors below the title bar and within phone-width gutters', () => {
    const { container } = render(
      <SidebarProvider>
        <WorkspacePlaceholder controller={controller()} onToggleThreads={vi.fn()} />
      </SidebarProvider>,
    );

    expect(container.querySelector('.relative')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveClass(
      'inset-x-3',
      'top-14',
      'w-auto',
      'sm:left-auto',
      'sm:right-4',
      'sm:max-w-sm',
    );
    expect(screen.getByRole('alert')).not.toHaveClass('bottom-10');
  });

  it('keeps the empty-workspace bottom rail visible on mobile', () => {
    const value = controller();
    value.model.selectedThreadId = undefined;
    value.model.transcript = undefined;
    value.model.error = undefined;
    const { container } = render(
      <SidebarProvider>
        <WorkspacePlaceholder controller={value} onToggleThreads={vi.fn()} />
      </SidebarProvider>,
    );

    expect(container.querySelector('[data-slot="main-bottom-rail"]')).toHaveClass(
      'h-[var(--bottom-rail-height)]',
      'shrink-0',
    );
    expect(container.querySelector('[data-slot="main-bottom-rail"]'))
      .not.toHaveClass('hidden', 'sm:block');
    expect(container.querySelector('[data-slot="thread-top-rail"]')).toBeEmptyDOMElement();
    expect(container.querySelector('[data-slot="thread-content"]')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: 'Show Project Pane' })).toBeDisabled();
  });

  it('restores a hidden Project Pane from an icon-only bottom-rail control', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SidebarProvider defaultOpen={false}>
        <WorkspacePlaceholder controller={controller()} onToggleThreads={vi.fn()} />
      </SidebarProvider>,
    );

    const toggle = screen.getByRole('button', { name: 'Show Project Pane' });
    expect(toggle).toHaveTextContent('');
    expect(toggle).toHaveClass('size-7', 'items-center', 'justify-center');
    expect(toggle.querySelector('[data-symbol="project-pane"]')).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByRole('button', { name: 'Show Project Pane' })).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="main-bottom-rail"]')).toBeInTheDocument();
  });
});
