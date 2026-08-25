import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { SidebarProvider, SidebarTrigger, useSidebar } from '@/components/ui/sidebar';
import { ThreadSidebar } from './thread-sidebar';

const controller = (platform = 'ios'): AlphaController => ({
  model: {
    platform,
    connection: {
      status: 'connected',
      hostUrl: 'bazzite',
      hostName: 'bazzite',
    },
    accessToken: 'test',
    searchQuery: '',
    workspaces: [{
      id: 'weave',
      name: 'weave',
      threads: [{
        id: 'thread-1',
        title: 'Acceptance',
        agentName: 'Codex',
        hostName: 'bazzite',
        status: 'active',
        updatedAt: new Date().toISOString(),
        workspaceId: 'weave',
      }],
    }],
    busy: false,
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

function MobileSidebarState() {
  const { isMobile, openMobile } = useSidebar();
  return (
    <output aria-label='Mobile sidebar state'>
      {isMobile ? String(openMobile) : 'desktop'}
    </output>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('ThreadSidebar', () => {
  it('dismisses the mobile sheet after selecting a thread', async () => {
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const user = userEvent.setup();
    const value = controller();

    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
        <SidebarTrigger />
        <MobileSidebarState />
      </SidebarProvider>,
    );

    await waitFor(() =>
      expect(screen.getByLabelText('Mobile sidebar state'))
        .toHaveTextContent('false')
    );
    await user.click(screen.getByRole('button', { name: 'Toggle Sidebar' }));
    expect(screen.getByLabelText('Mobile sidebar state')).toHaveTextContent('true');

    await user.click(screen.getByText('Acceptance').closest('button')!);

    expect(value.actions.selectThread).toHaveBeenCalledWith('thread-1');
    expect(screen.getByLabelText('Mobile sidebar state')).toHaveTextContent('false');
  });

  it('keeps the Capacitor settings action inside the rounded display without changing rail height', () => {
    const { container } = render(
      <SidebarProvider>
        <ThreadSidebar controller={controller()} />
      </SidebarProvider>,
    );

    expect(container.querySelector('[data-slot="sidebar-footer"]')).toHaveClass(
      'h-[var(--bottom-rail-height)]',
      'py-0',
      'pl-7',
      'pr-1',
    );
    expect(container.querySelector('[data-slot="sidebar-footer"]')).not.toHaveClass(
      'pb-[max(1rem,env(safe-area-inset-bottom))]',
    );
  });

  it('removes the Capacitor-only settings offset on the web', () => {
    const { container } = render(
      <SidebarProvider>
        <ThreadSidebar controller={controller('web')} />
      </SidebarProvider>,
    );

    expect(container.querySelector('[data-slot="sidebar-footer"]')).toHaveClass(
      'pl-1',
      'pr-1',
    );
    expect(container.querySelector('[data-slot="sidebar-footer"]')).not.toHaveClass('pl-7');
  });

  it('keeps every new-thread action at least 24px square', () => {
    render(
      <SidebarProvider>
        <ThreadSidebar controller={controller()} />
      </SidebarProvider>,
    );

    expect(screen.getByRole('button', { name: 'New thread in weave' }))
      .toHaveClass('w-6');
  });

  it('does not expose Workspace files as a dedicated Thread-sidebar artifact', () => {
    render(
      <SidebarProvider>
        <ThreadSidebar controller={controller()} />
      </SidebarProvider>,
    );

    expect(screen.queryByText('Browse files')).not.toBeInTheDocument();
  });
});
