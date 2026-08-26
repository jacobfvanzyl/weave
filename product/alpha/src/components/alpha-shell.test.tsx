import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaController } from '@/app/alpha-controller';
import { AlphaShell } from './alpha-shell';

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
    workspaces: [],
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

describe('AlphaShell', () => {
  it('places a tabbed Editor Pane between the Thread and Project Panes', () => {
    const value = controller();
    value.model.selectedThreadId = 'thread-1';
    value.model.workspaces = [{
      id: 'weave',
      name: 'Weave',
      threads: [{
        id: 'thread-1',
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
      name: 'Weave',
      threads: [{
        id: 'thread-1',
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
