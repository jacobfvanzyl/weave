import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlphaController } from "@/app/alpha-controller";
import { AlphaShell } from "./alpha-shell";

const mobileViewport = vi.hoisted(() => ({ value: false }));
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mobileViewport.value,
}));

vi.mock("./xterm-terminal-view", () => ({
  XtermTerminalView: ({ data }: { data: string }) => (
    <div data-slot="mock-xterm">{data}</div>
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

  it("places Project in a separate full-height Right Dock after the Editor Pane", async () => {
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
    value.model.workspaceFiles = {
      workspaceId: "weave",
      workspaceName: "Weave",
      activeFilePath: "README.md",
      openFiles: [
        {
          kind: "text",
          path: "README.md",
          content: "# Weave\n",
          contentHash: "0".repeat(64),
          size: 8,
          changed: false,
        },
      ],
      directories: {
        "": {
          entries: [{ name: "README.md", path: "README.md", type: "file" }],
          truncated: false,
        },
      },
    };

    const { container } = render(<AlphaShell controller={value} />);
    const showProjectPane = screen.getByRole("button", {
      name: "Show Project Pane",
    });
    const toggleThreads = screen.getByRole("button", {
      name: "Toggle threads",
    });
    const archivedThreads = screen.getByRole("button", {
      name: "Archived Threads",
    });
    const sidebarRailDivider = container.querySelector(
      '[data-slot="sidebar-rail-divider"]',
    );
    const threadTopRail = container.querySelector(
      '[data-slot="thread-top-rail"]',
    );
    const globalBottomRail = container.querySelector(
      '[data-slot="global-bottom-rail"]',
    );

    expect(showProjectPane.closest("footer")).toHaveAttribute(
      "data-slot",
      "global-bottom-rail",
    );
    expect(globalBottomRail).toContainElement(toggleThreads);
    expect(toggleThreads.parentElement?.firstElementChild).toBe(toggleThreads);
    expect(toggleThreads.nextElementSibling).toBe(sidebarRailDivider);
    expect(sidebarRailDivider?.nextElementSibling).toBe(archivedThreads);
    expect(sidebarRailDivider).toHaveClass(
      "mx-1",
      "my-1",
      "w-px",
      "self-stretch",
      "shrink-0",
      "bg-border",
    );
    expect(toggleThreads).toHaveAttribute("aria-pressed", "true");
    expect(toggleThreads).toHaveClass("text-primary");
    expect(threadTopRail).not.toContainElement(toggleThreads);

    await userEvent.click(toggleThreads);
    expect(
      container.querySelector('[data-slot="alpha-pane-row"]'),
    ).not.toBeInTheDocument();
    expect(toggleThreads).toHaveAttribute("aria-pressed", "false");
    expect(toggleThreads).not.toHaveClass("text-primary");

    await userEvent.click(toggleThreads);
    expect(
      container.querySelector('[data-slot="alpha-pane-row"]'),
    ).toBeInTheDocument();
    expect(toggleThreads).toHaveAttribute("aria-pressed", "true");
    expect(toggleThreads).toHaveClass("text-primary");
    expect(showProjectPane).not.toHaveClass("mr-6");
    expect(
      container.querySelector('[data-slot="main-bottom-rail"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="global-bottom-rail"]'),
    ).toContainElement(showProjectPane);
    await userEvent.click(showProjectPane);
    const threadPane = container.querySelector('[data-slot="thread-pane"]');
    const editorPane = container.querySelector('[data-slot="editor-pane"]');
    const projectPane = container.querySelector('[data-slot="project-pane"]');
    const paneRow = container.querySelector('[data-slot="alpha-pane-row"]');
    const contentPaneRow = container.querySelector(
      '[data-slot="alpha-content-pane-row"]',
    );

    expect(paneRow).toBeInTheDocument();
    expect(
      Array.from(
        paneRow?.querySelectorAll(':scope > [data-slot="resizable-panel"]') ??
          [],
      ).map((panel) => panel.id),
    ).toEqual(["threads", "workspace"]);
    expect(
      Array.from(
        contentPaneRow?.querySelectorAll(
          ':scope > [data-slot="resizable-panel"]',
        ) ?? [],
      ).map((panel) => panel.id),
    ).toEqual(["thread", "editor"]);
    expect(
      threadPane?.closest('[data-slot="resizable-panel"]'),
    ).toHaveAttribute("id", "thread");
    expect(
      editorPane?.closest('[data-slot="resizable-panel"]'),
    ).toHaveAttribute("id", "editor");
    expect(
      projectPane?.closest('[data-slot="resizable-panel"]'),
    ).toHaveAttribute("id", "right");
    expect(contentPaneRow?.querySelectorAll('[role="separator"]')).toHaveLength(1);
    expect(projectPane).toBeInTheDocument();
    expect(editorPane).toHaveTextContent("# Weave");
    expect(projectPane).not.toHaveTextContent("# Weave");
    expect(
      projectPane?.querySelector('[data-slot="sidebar-footer"]'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide Project Pane" }),
    ).toHaveClass("text-primary");
    expect(
      container.querySelector('[data-slot="global-bottom-rail"]'),
    ).toHaveClass("px-4");
    expect(
      container.querySelector('[data-slot="global-bottom-rail"]'),
    ).toHaveClass("h-[var(--bottom-rail-height)]");
    expect(
      container.querySelectorAll('[data-slot$="bottom-rail"]'),
    ).toHaveLength(1);
    expect(
      screen.getByRole("separator", {
        name: "Resize Workspace and Right Dock",
      }),
    ).toHaveClass("before:inset-y-0");
    expect(
      screen.getByRole("separator", {
        name: "Resize Thread and Editor Panes",
      }),
    ).not.toHaveClass("bg-status-bar");
  });

  it("opens Terminal in Bottom independently of Project and moves it to Right from the rail icon", async () => {
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
      tabs: [
        {
          terminalId: "terminal-1",
          workspaceId: "weave",
          title: "jaco — zsh",
          status: "running",
          cols: 100,
          rows: 30,
        },
      ],
      activeTerminalId: "terminal-1",
      attachmentId: "attachment-1",
      attachmentMode: "control",
      data: "$ ",
      dataEpoch: 1,
      dataOffset: 0,
      loading: false,
    };
    value.actions.showTerminals = vi.fn();
    value.actions.hideTerminals = vi.fn();
    value.actions.closeTerminal = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<AlphaShell controller={value} />);

    const initialRail = screen
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-label")?.endsWith("Pane"));
    expect(
      initialRail.map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Show Terminal Pane", "Show Project Pane"]);

    await user.click(
      screen.getByRole("button", { name: "Show Terminal Pane" }),
    );
    expect(value.actions.showTerminals).toHaveBeenCalledOnce();
    expect(
      container
        .querySelector('[data-slot="terminal-pane"]')
        ?.closest('[data-slot="resizable-panel"]'),
    ).toHaveAttribute("id", "bottom");
    const primaryRow = container.querySelector('[data-slot="alpha-pane-row"]');
    const sidebarPanel = primaryRow?.querySelector<HTMLElement>(
      ':scope > [data-slot="resizable-panel"]#threads',
    );
    const workspacePanel = primaryRow?.querySelector<HTMLElement>(
      ':scope > [data-slot="resizable-panel"]#workspace',
    );
    const bottomPanel = container.querySelector<HTMLElement>(
      '[data-slot="resizable-panel"]#bottom',
    );
    expect(sidebarPanel).not.toContainElement(bottomPanel);
    expect(workspacePanel).toContainElement(bottomPanel);
    expect(
      container.querySelectorAll('[data-slot$="bottom-rail"]'),
    ).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Maximize Terminal" }));
    const maximizedFromBottom = container.querySelector(
      '[data-slot="alpha-maximized-terminal"]',
    );
    expect(maximizedFromBottom).toContainElement(
      container.querySelector('[data-slot="terminal-pane"]'),
    );
    expect(
      container.querySelector('[data-slot="resizable-panel"]#bottom'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="alpha-right-dock-group"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="alpha-pane-row"] #threads'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore Terminal" }));
    expect(
      container
        .querySelector('[data-slot="terminal-pane"]')
        ?.closest('[data-slot="resizable-panel"]'),
    ).toHaveAttribute("id", "bottom");

    await user.click(screen.getByRole("button", { name: "Show Project Pane" }));
    expect(
      container.querySelector('[data-slot="project-pane"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Hide Terminal Pane" }),
    ).toHaveClass("text-primary");
    expect(
      screen.getByRole("button", { name: "Hide Project Pane" }),
    ).toHaveClass("text-primary");
    expect(
      container.querySelectorAll('[data-slot="dock-group-divider"]'),
    ).toHaveLength(1);
    vi.mocked(value.actions.hideTerminals).mockClear();

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "Hide Terminal Pane" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: "Dock Right" }));
    expect(
      container.querySelector('[data-slot="resizable-panel"]#bottom'),
    ).not.toBeInTheDocument();
    expect(
      container
        .querySelector('[data-slot="terminal-pane"]')
        ?.closest('[data-slot="resizable-panel"]'),
    ).toHaveAttribute("id", "right");
    expect(
      container.querySelector('[data-slot="project-pane"]'),
    ).not.toBeInTheDocument();
    expect(value.actions.hideTerminals).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Maximize Terminal" }));
    const maximizedFromRight = container.querySelector(
      '[data-slot="alpha-maximized-terminal"]',
    );
    expect(maximizedFromRight).toContainElement(
      container.querySelector('[data-slot="terminal-pane"]'),
    );
    expect(
      container.querySelector('[data-slot="alpha-right-dock-group"]'),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Restore Terminal" }));
    expect(
      container
        .querySelector('[data-slot="terminal-pane"]')
        ?.closest('[data-slot="resizable-panel"]'),
    ).toHaveAttribute("id", "right");

    await user.click(screen.getByRole("button", { name: "Close jaco — zsh" }));
    expect(value.actions.closeTerminal).toHaveBeenCalledWith("terminal-1");
    expect(
      container.querySelector('[data-slot="terminal-pane"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="project-pane"]'),
    ).toBeInTheDocument();
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
      data: "",
      dataEpoch: 0,
      dataOffset: 0,
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
      data: "",
      dataEpoch: 0,
      dataOffset: 0,
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
      data: "",
      dataEpoch: 0,
      dataOffset: 0,
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
      data: "",
      dataEpoch: 0,
      dataOffset: 0,
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
    ).toEqual(["thread"]);
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
    expect(
      container
        .querySelector('[data-symbol="project-pane"]')
        ?.closest("button"),
    ).toBeDisabled();
  });

  it("restores the hidden Project Pane state after an app reload", async () => {
    const selectedController = () => {
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
      return value;
    };
    const user = userEvent.setup();
    const initial = render(<AlphaShell controller={selectedController()} />);

    await user.click(screen.getByRole("button", { name: "Show Project Pane" }));
    await user.click(screen.getByRole("button", { name: "Hide Project Pane" }));
    expect(window.localStorage.getItem("weave.alpha.docks.v2")).toContain(
      '"projectOpen":false',
    );
    initial.unmount();

    const restored = render(<AlphaShell controller={selectedController()} />);
    expect(
      restored.container.querySelector('[data-slot="project-pane"]'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show Project Pane" }),
    ).toBeEnabled();
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
    await userEvent.click(
      screen.getByRole("button", { name: "Show Project Pane" }),
    );
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
    ).toBeInTheDocument();
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
    expect(projectSidebar).toHaveAttribute("data-state", "expanded");

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
