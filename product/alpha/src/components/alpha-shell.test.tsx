import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlphaController } from "@/app/alpha-controller";
import { AlphaShell } from "./alpha-shell";

const mobileViewport = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobileViewport.value,
}));

vi.mock("./terminal-view", () => ({
  TerminalView: () => (
    <div data-slot="mock-terminal" />
  ),
}));

const controller = (): AlphaController => ({
  model: {
    platform: "test",
    connectionsLoaded: true,
    connectionsOpen: false,
    archivedThreadsOpen: false,
    connections: [
      {
        hostId: "host-1",
        displayName: "bazzite",
        hostUrl: "ws://bazzite:4122",
        status: "connected",
        selected: true,
      },
    ],
    connection: {
      status: "connected",
      hostUrl: "ws://bazzite:4122",
      hostName: "bazzite",
    },
    searchQuery: "",
    workspaces: [],
    archivedThreads: [],
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
    addProject: vi.fn(),
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

describe("AlphaShell", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, "webkit");
  });

  beforeEach(() => {
    mobileViewport.value = false;
    document.cookie = "project_pane_state=; path=/; max-age=0";
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return values.size;
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, value),
      } satisfies Storage,
    });
  });
  it("shows only the undismissable Connections dialog when no Hosts are configured", () => {
    const value = controller();
    value.model.connections = [];
    value.model.connectionsOpen = true;
    const { container } = render(<AlphaShell controller={value} />);

    expect(
      screen.getByRole("dialog", { name: "Connections" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close" }),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="sidebar-wrapper"]'),
    ).not.toBeInTheDocument();
  });

  it("keeps the shell available when a configured Host is offline", () => {
    const value = controller();
    value.model.connection.status = "disconnected";
    value.model.connections[0].status = "disconnected";
    const { container } = render(<AlphaShell controller={value} />);

    expect(
      container.querySelector('[data-slot="sidebar-wrapper"]'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Connections" }),
    ).not.toBeInTheDocument();
  });

  it("ignores saved deferred surfaces and exposes only Terminal", () => {
    window.localStorage.setItem("weave.alpha.docks.v3", JSON.stringify({
      schemaVersion: 3,
      panelPosition: { terminal: "bottom", browser: "right", project: "right" },
      browserOpen: true, projectOpen: true, terminalOpenByScope: {},
      activePanelByDock: { bottom: null, right: "browser" },
      rememberedSize: { bottom: 32, right: 24 },
    }));
    const { container } = render(<AlphaShell controller={controller()} />);
    expect(screen.queryByRole("button", { name: /(?:Browser|Project|Editor) Pane/ })).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="browser-pane"], [data-slot="editor-pane"], [data-slot="project-pane"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Show Terminal Pane" })).toBeDisabled();
  });

  it("reattaches Terminal when an open dock is restored for a selected Thread", async () => {
    window.localStorage.setItem(
      "weave.alpha.docks.v1",
      JSON.stringify({
        schemaVersion: 1,
        panelPosition: { terminal: "bottom", project: "right" },
        docks: {
          bottom: { open: true, activePanelId: "terminal" },
          right: { open: false, activePanelId: null },
        },
        rememberedSize: { bottom: 32, right: 24 },
      }),
    );
    const value = controller();
    value.model.selectedThreadId = "thread-1";
    value.model.workspaces = [
      {
        id: "weave",
        workspaceId: "weave",
        hostId: "host-1",
        hostName: "bazzite",
        name: "Weave",
        threads: [
          {
            id: "thread-1",
            threadId: "thread-1",
            hostId: "host-1",
            title: "Selected Thread",
            agentName: "Codex",
            hostName: "bazzite",
            status: "active",
            updatedAt: "2026-08-26T00:00:00.000Z",
            workspaceId: "weave",
          },
        ],
      },
    ];
    value.actions.showTerminals = vi.fn();
    value.actions.hideTerminals = vi.fn();

    const { container } = render(<AlphaShell controller={value} />);

    expect(
      container.querySelector('[data-slot="terminal-pane"]'),
    ).toBeInTheDocument();
    expect(value.actions.showTerminals).toHaveBeenCalledOnce();
    expect(value.actions.hideTerminals).not.toHaveBeenCalled();
  });

  it("presents an open dock as a replacement surface on narrow screens", async () => {
    mobileViewport.value = true;
    const value = controller();
    value.model.selectedThreadId = "thread-1";
    value.model.workspaces = [
      {
        id: "weave",
        workspaceId: "weave",
        hostId: "host-1",
        hostName: "bazzite",
        name: "Weave",
        threads: [
          {
            id: "thread-1",
            threadId: "thread-1",
            hostId: "host-1",
            title: "Selected Thread",
            agentName: "Codex",
            hostName: "bazzite",
            status: "active",
            updatedAt: "2026-08-26T00:00:00.000Z",
            workspaceId: "weave",
          },
        ],
      },
    ];
    value.model.terminals = {
      scope: {
        hostId: "host-1",
        projectId: "weave",
        workspaceId: "weave",
      },
      supported: true,
      tabs: [],
      loading: false,
    };
    value.actions.showTerminals = vi.fn();
    value.actions.hideTerminals = vi.fn();
    const { container } = render(<AlphaShell controller={value} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Show Terminal Pane" }),
    );
    expect(
      container.querySelector('[data-slot="alpha-mobile-dock-surface"]'),
    ).toContainElement(container.querySelector('[data-slot="terminal-pane"]'));
    expect(
      container.querySelector('[data-slot="alpha-right-dock-group"]'),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Hide Terminal Pane" }),
    );
    expect(
      container.querySelector('[data-slot="alpha-mobile-dock-surface"]'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show Terminal Pane" }),
    ).toBeInTheDocument();
  });

  it("switches Terminal pane state by Host and Project scope and restores it on return", async () => {
    window.localStorage.setItem(
      "weave.alpha.docks.v1",
      JSON.stringify({
        schemaVersion: 1,
        panelPosition: { terminal: "bottom", project: "right" },
        docks: {
          bottom: { open: true, activePanelId: "terminal" },
          right: { open: false, activePanelId: null },
        },
        rememberedSize: { bottom: 32, right: 24 },
      }),
    );
    const value = controller();
    value.model.selectedThreadId = "thread-1";
    value.model.workspaces = [
      {
        id: "weave",
        workspaceId: "weave",
        hostId: "host-1",
        hostName: "Bazzite",
        name: "Weave",
        threads: [
          {
            id: "thread-1",
            threadId: "thread-1",
            hostId: "host-1",
            title: "Existing thread",
            agentName: "Codex",
            hostName: "Bazzite",
            status: "active",
            updatedAt: "2026-08-28T00:00:00.000Z",
            workspaceId: "weave",
          },
        ],
      },
    ];
    value.model.terminals = {
      scope: {
        hostId: "host-1",
        projectId: "weave",
        workspaceId: "weave",
      },
      supported: true,
      tabs: [],
      loading: false,
    };
    value.actions.showTerminals = vi.fn();
    value.actions.hideTerminals = vi.fn();
    const { container, rerender } = render(<AlphaShell controller={value} />);

    expect(container.querySelector('[data-slot="terminal-pane"]'))
      .toBeInTheDocument();
    expect(value.actions.showTerminals).toHaveBeenCalledOnce();

    value.model.selectedThreadId = "draft-same-scope";
    value.model.workspaces[0].threads = [{
      id: "draft-same-scope",
      threadId: "draft-same-scope",
      hostId: "host-1",
      title: "New thread",
      agentName: "Codex",
      hostName: "Bazzite",
      status: "active",
      updatedAt: "2026-08-28T00:00:30.000Z",
      workspaceId: "weave",
      draft: true,
    }];
    rerender(<AlphaShell controller={value} />);

    expect(container.querySelector('[data-slot="terminal-pane"]'))
      .toBeInTheDocument();
    expect(value.actions.showTerminals).toHaveBeenCalledTimes(2);

    value.model.connections.push({
      hostId: "host-2",
      displayName: "MacBook",
      hostUrl: "ws://macbook:4122",
      status: "connected",
      selected: false,
    });
    value.model.selectedThreadId = "draft-2";
    value.model.workspaces = [{
      id: "weave",
      workspaceId: "weave",
      hostId: "host-1",
      hostName: "Bazzite",
      name: "Weave",
      threads: [{
        id: "draft-2",
        threadId: "draft-2",
        hostId: "host-2",
        title: "New thread",
        agentName: "Codex",
        hostName: "MacBook",
        status: "active",
        updatedAt: "2026-08-28T00:01:00.000Z",
        workspaceId: "weave",
        draft: true,
      }],
    }];
    value.model.terminals = {
      scope: {
        hostId: "host-2",
        projectId: "weave",
        workspaceId: "weave",
      },
      supported: true,
      tabs: [],
      loading: false,
    };
    rerender(<AlphaShell controller={value} />);

    expect(container.querySelector('[data-slot="terminal-pane"]'))
      .not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show Terminal Pane" }))
      .toBeInTheDocument();
    expect(value.actions.showTerminals).toHaveBeenCalledTimes(2);
    expect(value.actions.hideTerminals).toHaveBeenCalled();

    value.model.selectedThreadId = "thread-1";
    value.model.workspaces = [{
      id: "weave",
      workspaceId: "weave",
      hostId: "host-1",
      hostName: "Bazzite",
      name: "Weave",
      threads: [{
        id: "thread-1",
        threadId: "thread-1",
        hostId: "host-1",
        title: "Existing thread",
        agentName: "Codex",
        hostName: "Bazzite",
        status: "active",
        updatedAt: "2026-08-28T00:00:00.000Z",
        workspaceId: "weave",
      }],
    }];
    value.model.terminals = {
      scope: {
        hostId: "host-1",
        projectId: "weave",
        workspaceId: "weave",
      },
      supported: true,
      tabs: [],
      loading: false,
    };
    rerender(<AlphaShell controller={value} />);

    expect(container.querySelector('[data-slot="terminal-pane"]'))
      .toBeInTheDocument();
    expect(value.actions.showTerminals).toHaveBeenCalledTimes(3);
  });

  it("shows only the sidebar and a blank Thread Pane when no Thread is selected", () => {
    const value = controller();
    value.model.workspaceFiles = {
      workspaceId: "weave",
      workspaceName: "Weave",
      activeFilePath: "README.md",
      openFiles: [
        {
          kind: "text",
          path: "README.md",
          content: "# Hidden without a Thread\n",
          contentHash: "0".repeat(64),
          size: 26,
          changed: false,
        },
      ],
      directories: {},
    };

    const { container } = render(<AlphaShell controller={value} />);
    const paneRow = container.querySelector('[data-slot="alpha-pane-row"]');

    expect(
      Array.from(
        paneRow?.querySelectorAll(':scope > [data-slot="resizable-panel"]') ??
          [],
      ).map((panel) => panel.id),
    ).toEqual(["threads", "workspace"]);
    expect(
      Array.from(
        container
          .querySelector('[data-slot="alpha-content-pane-row"]')
          ?.querySelectorAll(':scope > [data-slot="resizable-panel"]') ?? [],
      ).map((panel) => panel.id),
    ).toEqual([]);
    expect(
      container.querySelector('[data-slot="editor-pane"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="project-pane"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="thread-top-rail"]'),
    ).toBeEmptyDOMElement();
    expect(
      container.querySelector('[data-slot="thread-content"]'),
    ).toBeEmptyDOMElement();
    expect(container.querySelector('[data-symbol="project-pane"]')).toBeNull();
  });

  it("uses the full native viewport while reserving the iOS display safe area", async () => {
    const originalViewport = Object.getOwnPropertyDescriptor(
      window,
      "visualViewport",
    );
    const events = new EventTarget();
    const viewport = {
      height: 640,
      offsetTop: 0,
      addEventListener: vi.fn(events.addEventListener.bind(events)),
      removeEventListener: vi.fn(events.removeEventListener.bind(events)),
    };
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });

    const value = controller();
    value.model.platform = "ios";
    value.model.selectedThreadId = "thread-1";
    value.model.workspaces = [
      {
        id: "weave",
        workspaceId: "weave",
        hostId: "host-1",
        hostName: "bazzite",
        name: "Weave",
        threads: [
          {
            id: "thread-1",
            threadId: "thread-1",
            hostId: "host-1",
            title: "Selected Thread",
            agentName: "Codex",
            hostName: "bazzite",
            status: "active",
            updatedAt: "2026-08-26T00:00:00.000Z",
            workspaceId: "weave",
          },
        ],
      },
    ];

    const { container, unmount } = render(<AlphaShell controller={value} />);
    const shell = container.querySelector('[data-slot="sidebar-wrapper"]');

    expect(
      document.documentElement.style.getPropertyValue(
        "--alpha-viewport-height",
      ),
    ).toBe("640px");
    expect(
      document.documentElement.style.getPropertyValue("--alpha-viewport-top"),
    ).toBe("0px");
    expect(shell).toHaveClass(
      "top-[var(--alpha-viewport-top,0px)]",
      "h-[var(--alpha-viewport-height,100dvh)]",
    );
    expect(shell).toHaveClass("pt-[env(safe-area-inset-top)]");
    expect(shell).not.toHaveClass("pb-[env(safe-area-inset-bottom)]");
    expect(
      container.querySelector('[data-slot="project-pane"][data-side="right"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="global-bottom-rail"]'),
    ).toHaveClass("h-[var(--bottom-rail-height)]");

    const projectSidebar = container.querySelector(
      '[data-slot="project-pane"][data-side="right"]',
    );
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "b", metaKey: true }),
      )
    );
    expect(
      container.querySelector('[data-slot="sidebar"][data-side="left"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="resizable-panel"]#threads'),
    ).not.toBeInTheDocument();
    expect(projectSidebar).toBeNull();

    viewport.height = 480;
    viewport.offsetTop = 4;
    events.dispatchEvent(new Event("resize"));
    expect(
      document.documentElement.style.getPropertyValue(
        "--alpha-viewport-height",
      ),
    ).toBe("480px");
    expect(
      document.documentElement.style.getPropertyValue("--alpha-viewport-top"),
    ).toBe("4px");

    unmount();
    expect(
      document.documentElement.style.getPropertyValue(
        "--alpha-viewport-height",
      ),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--alpha-viewport-top"),
    ).toBe("");

    if (originalViewport) {
      Object.defineProperty(window, "visualViewport", originalViewport);
    } else Reflect.deleteProperty(window, "visualViewport");
  });
});
