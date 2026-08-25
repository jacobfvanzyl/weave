import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { createTranscript } from '@/chat/acp-transcript';
import { SidebarProvider } from '@/components/ui/sidebar';
import { WorkspacePlaceholder } from './workspace-placeholder';

const controller = (): AlphaController => ({
  model: {
    platform: 'test',
    connection: {
      status: 'connected',
      hostUrl: 'ws://bazzite:4122',
      hostName: 'bazzite',
    },
    accessToken: 'test',
    searchQuery: '',
    projects: [{
      id: 'weave',
      name: 'weave',
      threads: [{
        id: 'thread-1',
        title: 'Acceptance',
        agentName: 'Codex',
        hostName: 'bazzite',
        status: 'active',
        updatedAt: '2026-08-25T00:00:00.000Z',
        projectId: 'weave',
      }],
    }],
    selectedThreadId: 'thread-1',
    transcript: createTranscript('session-1'),
    busy: false,
    error: 'Portal lost the connection to this host.',
  },
  actions: {
    setHostUrl: vi.fn(),
    setAccessToken: vi.fn(),
    setSearchQuery: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    refresh: vi.fn(),
    createThread: vi.fn(),
    selectThread: vi.fn(),
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
        <WorkspacePlaceholder controller={controller()} />
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
        <WorkspacePlaceholder controller={value} />
      </SidebarProvider>,
    );

    expect(container.querySelector('[data-slot="main-bottom-rail"]')).toHaveClass(
      'h-[var(--bottom-rail-height)]',
      'shrink-0',
    );
    expect(container.querySelector('[data-slot="main-bottom-rail"]'))
      .not.toHaveClass('hidden', 'sm:block');
  });
});
