import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { AlphaShell } from './alpha-shell';

const controller = (): AlphaController => ({
  model: {
    platform: 'test',
    connectionsLoaded: true,
    connectionsOpen: false,
    connections: [{
      hostId: 'host-1',
      displayName: 'bazzite',
      hostUrl: 'ws://bazzite:4122',
      status: 'connected',
      selected: true,
    }],
    connection: {
      status: 'connected',
      hostUrl: 'ws://bazzite:4122',
      hostName: 'bazzite',
    },
    searchQuery: '',
    workspaces: [],
    busy: false,
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

describe('AlphaShell', () => {
  it('shows only the undismissable Connections dialog when no Hosts are configured', () => {
    const value = controller();
    value.model.connections = [];
    value.model.connectionsOpen = true;
    const { container } = render(<AlphaShell controller={value} />);

    expect(screen.getByRole('dialog', { name: 'Connections' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="sidebar-wrapper"]')).not.toBeInTheDocument();
  });

  it('keeps the shell available when a configured Host is offline', () => {
    const value = controller();
    value.model.connection.status = 'disconnected';
    value.model.connections[0].status = 'disconnected';
    const { container } = render(<AlphaShell controller={value} />);

    expect(container.querySelector('[data-slot="sidebar-wrapper"]')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Connections' })).not.toBeInTheDocument();
  });

  it('places a tabbed Editor Pane between the Thread and Project Panes', () => {
    const value = controller();
    value.model.selectedThreadId = 'thread-1';
    value.model.workspaces = [{
      id: 'weave',
      workspaceId: 'weave',
      hostId: 'host-1',
      name: 'Weave',
      threads: [{
        id: 'thread-1',
        threadId: 'thread-1',
        hostId: 'host-1',
        title: 'Selected Thread',
        agentName: 'Codex',
        hostName: 'bazzite',
        status: 'active',
        updatedAt: '2026-08-26T00:00:00.000Z',
        workspaceId: 'weave',
      }],
    }];
    value.model.workspaceFiles = {
      workspaceId: 'weave',
      workspaceName: 'Weave',
      activeFilePath: 'README.md',
      openFiles: [{
        kind: 'text',
        path: 'README.md',
        content: '# Weave\n',
        contentHash: '0'.repeat(64),
        size: 8,
        changed: false,
      }],
      directories: {
        '': {
          entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
          truncated: false,
        },
      },
    };

    const { container } = render(<AlphaShell controller={value} />);
    const threadPane = container.querySelector('[data-slot="thread-pane"]');
    const editorPane = container.querySelector('[data-slot="editor-pane"]');
    const projectPane = container.querySelector('[data-slot="project-pane"]');
    const paneRow = container.querySelector('[data-slot="alpha-pane-row"]');

    expect(paneRow).toBeInTheDocument();
    expect(Array.from(paneRow?.querySelectorAll(':scope > [data-slot="resizable-panel"]') ?? [])
      .map((panel) => panel.id))
      .toEqual(['threads', 'thread', 'editor', 'project']);
    expect(threadPane?.closest('[data-slot="resizable-panel"]')).toHaveAttribute('id', 'thread');
    expect(editorPane?.closest('[data-slot="resizable-panel"]')).toHaveAttribute('id', 'editor');
    expect(projectPane?.closest('[data-slot="resizable-panel"]')).toHaveAttribute('id', 'project');
    expect(paneRow?.querySelectorAll('[role="separator"]')).toHaveLength(3);
    expect(projectPane).toBeInTheDocument();
    expect(editorPane).toHaveTextContent('# Weave');
    expect(projectPane).not.toHaveTextContent('# Weave');
    expect(container.querySelector('[data-slot="editor-bottom-rail"]')).toHaveClass(
      'h-[var(--bottom-rail-height)]',
    );
  });

  it('shows only the sidebar and a blank Thread Pane when no Thread is selected', () => {
    const value = controller();
    value.model.workspaceFiles = {
      workspaceId: 'weave',
      workspaceName: 'Weave',
      activeFilePath: 'README.md',
      openFiles: [{
        kind: 'text',
        path: 'README.md',
        content: '# Hidden without a Thread\n',
        contentHash: '0'.repeat(64),
        size: 26,
        changed: false,
      }],
      directories: {},
    };

    const { container } = render(<AlphaShell controller={value} />);
    const paneRow = container.querySelector('[data-slot="alpha-pane-row"]');

    expect(Array.from(paneRow?.querySelectorAll(':scope > [data-slot="resizable-panel"]') ?? [])
      .map((panel) => panel.id))
      .toEqual(['threads', 'thread']);
    expect(container.querySelector('[data-slot="editor-pane"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="project-pane"]')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="thread-top-rail"]')).toBeEmptyDOMElement();
    expect(container.querySelector('[data-slot="thread-content"]')).toBeEmptyDOMElement();
    expect(container.querySelector('[data-symbol="project-pane"]')?.closest('button')).toBeDisabled();
  });

  it('restores the hidden Project Pane state after an app reload', async () => {
    const selectedController = () => {
      const value = controller();
      value.model.selectedThreadId = 'thread-1';
      value.model.workspaces = [{
        id: 'weave',
        workspaceId: 'weave',
        hostId: 'host-1',
        name: 'Weave',
        threads: [{
          id: 'thread-1',
          threadId: 'thread-1',
          hostId: 'host-1',
          title: 'Selected Thread',
          agentName: 'Codex',
          hostName: 'bazzite',
          status: 'active',
          updatedAt: '2026-08-26T00:00:00.000Z',
          workspaceId: 'weave',
        }],
      }];
      return value;
    };
    const user = userEvent.setup();
    const initial = render(<AlphaShell controller={selectedController()} />);

    await user.click(screen.getByRole('button', { name: 'Hide Project Pane' }));
    expect(document.cookie).toContain('project_pane_state=false');
    initial.unmount();

    const restored = render(<AlphaShell controller={selectedController()} />);
    expect(restored.container.querySelector('[data-slot="project-pane"]')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Project Pane' })).toBeEnabled();

    document.cookie = 'project_pane_state=; path=/; max-age=0';
  });

  it('sizes the native shell to the visible viewport without duplicating the top safe area', () => {
    const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    const events = new EventTarget();
    const viewport = {
      height: 640,
      offsetTop: 12,
      addEventListener: vi.fn(events.addEventListener.bind(events)),
      removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    };
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: viewport,
    });

    const value = controller();
    value.model.selectedThreadId = 'thread-1';
    value.model.workspaces = [{
      id: 'weave',
      workspaceId: 'weave',
      hostId: 'host-1',
      name: 'Weave',
      threads: [{
        id: 'thread-1',
        threadId: 'thread-1',
        hostId: 'host-1',
        title: 'Selected Thread',
        agentName: 'Codex',
        hostName: 'bazzite',
        status: 'active',
        updatedAt: '2026-08-26T00:00:00.000Z',
        workspaceId: 'weave',
      }],
    }];

    const { container, unmount } = render(<AlphaShell controller={value} />);
    const shell = container.querySelector('[data-slot="sidebar-wrapper"]');

    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-height')).toBe('640px');
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-top')).toBe('12px');
    expect(shell).toHaveClass(
      'top-[var(--alpha-viewport-top,0px)]',
      'h-[var(--alpha-viewport-height,100dvh)]',
    );
    expect(shell).not.toHaveClass(
      'pt-[env(safe-area-inset-top)]',
      'pb-[env(safe-area-inset-bottom)]',
    );
    expect(container.querySelector('[data-slot="project-pane"][data-side="right"]'))
      .toBeInTheDocument();
    expect(container.querySelector('[data-slot="main-bottom-rail"]')).toHaveClass(
      'h-[var(--bottom-rail-height)]',
    );

    const projectSidebar = container.querySelector('[data-slot="project-pane"][data-side="right"]');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true })));
    expect(container.querySelector('[data-slot="sidebar"][data-side="left"]'))
      .not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="resizable-panel"]#threads'))
      .not.toBeInTheDocument();
    expect(projectSidebar).toHaveAttribute('data-state', 'expanded');

    viewport.height = 480;
    viewport.offsetTop = 4;
    events.dispatchEvent(new Event('resize'));
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-height')).toBe('480px');
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-top')).toBe('4px');

    unmount();
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-height')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--alpha-viewport-top')).toBe('');

    if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport);
    else Reflect.deleteProperty(window, 'visualViewport');
  });
});
