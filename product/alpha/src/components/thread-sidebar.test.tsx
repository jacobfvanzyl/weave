import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AlphaController } from "@/app/alpha-controller";
import {
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { ThreadSidebar } from "./thread-sidebar";

const controller = (platform = "ios"): AlphaController => ({
  model: {
    platform,
    connectionsLoaded: true,
    connectionsOpen: false,
    archivedThreadsOpen: false,
    connections: [
      {
        hostId: "host-1",
        displayName: "bazzite",
        hostUrl: "bazzite",
        status: "connected",
        selected: true,
      },
    ],
    connection: {
      status: "connected",
      hostUrl: "bazzite",
      hostName: "bazzite",
    },
    searchQuery: "",
    executionContexts: [
      {
        id: "weave",
        executionContextId: "weave",
        hostId: "host-1",
        hostName: "bazzite",
        name: "weave",
        threads: [
          {
            id: "thread-1",
            threadId: "thread-1",
            hostId: "host-1",
            title: "Acceptance",
            agentName: "Codex",
            hostName: "bazzite",
            supportsThreadLifecycle: true,
            status: "active",
            updatedAt: new Date().toISOString(),
            executionContextId: "weave",
          },
        ],
      },
    ],
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
    addExecutionContext: vi.fn(async () => undefined),
    removeExecutionContext: vi.fn(async () => undefined),
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

function MobileSidebarState() {
  const { isMobile, openMobile } = useSidebar();
  return (
    <output aria-label="Mobile sidebar state">
      {isMobile ? String(openMobile) : "desktop"}
    </output>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ThreadSidebar", () => {
  it("leaves an empty workspace section blank beneath its header", () => {
    const value = controller();
    value.model.executionContexts[0].threads = [];
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    expect(screen.getByText("weave")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New thread in weave" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No threads yet")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Create the first thread in this workspace."),
    ).not.toBeInTheDocument();
  });

  it("replaces the active new-thread action with a disabled spinner", () => {
    const value = controller();
    value.model.creatingThreadExecutionContextId = "weave";
    const { container } = render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    const creating = screen.getByRole("button", {
      name: "Creating thread in weave",
    });
    expect(creating).toBeDisabled();
    expect(creating).toHaveAttribute("aria-busy", "true");
    expect(
      within(creating).getByRole("status", { hidden: true }),
    ).toHaveAttribute("data-slot", "spinner");
    expect(container.querySelectorAll('[data-slot="spinner"]')).toHaveLength(1);
  });

  it("creates directly when a project has only one Host", async () => {
    const value = controller();
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "New thread in weave" }),
    );

    expect(value.actions.createThread).toHaveBeenCalledWith("weave");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks which connected Host should create a thread for a merged project", async () => {
    const value = controller();
    value.model.executionContexts[0].placements = [
      {
        id: "host-1:weave",
        executionContextId: "weave",
        hostId: "host-1",
        hostName: "Bazzite",
      },
      {
        id: "host-2:weave",
        executionContextId: "weave",
        hostId: "host-2",
        hostName: "Jaco’s MacBook Air",
      },
    ];
    value.model.connections.push({
      hostId: "host-2",
      displayName: "Jaco’s MacBook Air",
      hostUrl: "macbook",
      status: "connected",
      selected: false,
    });
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "New thread in weave" }),
    );

    expect(value.actions.createThread).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("Choose a Host");
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Create a new thread for weave on:",
    );
    await user.click(
      screen.getByRole("button", { name: "macbook" }),
    );

    expect(value.actions.createThread).toHaveBeenCalledWith(
      "weave",
      "host-2:weave",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows unavailable project Hosts in the picker without allowing selection", async () => {
    const value = controller();
    value.model.executionContexts[0].placements = [
      {
        id: "host-1:weave",
        executionContextId: "weave",
        hostId: "host-1",
        hostName: "Bazzite",
      },
      {
        id: "host-2:weave",
        executionContextId: "weave",
        hostId: "host-2",
        hostName: "Jaco’s MacBook Air",
      },
    ];
    value.model.connections.push({
      hostId: "host-2",
      displayName: "Jaco’s MacBook Air",
      hostUrl: "macbook",
      status: "disconnected",
      selected: false,
    });
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "New thread in weave" }),
    );

    expect(
      screen.getByRole("button", { name: /macbook disconnected/ }),
    ).toBeDisabled();
  });

  it("offers only project removal and removes a single-Host placement directly", async () => {
    const value = controller();
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "ExecutionContext settings for weave" }),
    );
    const remove = await screen.findByRole("menuitem", {
      name: "Remove ExecutionContext",
    });
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
    await user.click(remove);

    expect(value.actions.removeExecutionContext).toHaveBeenCalledWith(
      "weave",
      "host-1:weave",
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("asks which Host placement to remove for a merged project", async () => {
    const value = controller();
    value.model.executionContexts[0].placements = [
      {
        id: "placement-1",
        executionContextId: "weave",
        hostId: "host-1",
        hostName: "Bazzite",
      },
      {
        id: "placement-2",
        executionContextId: "weave",
        hostId: "host-2",
        hostName: "Jaco’s MacBook Air",
      },
    ];
    value.model.connections.push({
      hostId: "host-2",
      displayName: "Jaco’s MacBook Air",
      hostUrl: "macbook",
      status: "connected",
      selected: false,
    });
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    await user.click(
      screen.getByRole("button", { name: "ExecutionContext settings for weave" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Remove ExecutionContext" }),
    );

    expect(screen.getByRole("dialog")).toHaveTextContent("Choose a Host");
    expect(screen.getByRole("dialog")).toHaveTextContent("Remove weave from:");
    await user.click(
      screen.getByRole("button", { name: "macbook" }),
    );

    expect(value.actions.removeExecutionContext).toHaveBeenCalledWith(
      "weave",
      "placement-2",
    );
  });

  it("replaces only reconnecting Host threads with non-interactive skeletons", () => {
    const value = controller();
    value.model.connections[0]!.status = "reconnecting";
    const { container } = render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    expect(
      screen.getByLabelText("Reconnecting thread"),
    ).toHaveAttribute("data-slot", "reconnecting-thread");
    expect(
      container.querySelector('[data-slot="skeleton"]'),
    ).toBeInTheDocument();
    expect(screen.queryByText("Acceptance")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "New thread in weave" }),
    ).toBeDisabled();
  });

  it("keeps search compact until activated and places Add ExecutionContext in the top rail", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SidebarProvider>
        <ThreadSidebar controller={controller()} />
      </SidebarProvider>,
    );
    const topRail = container.querySelector('[data-slot="sidebar-top-rail"]')!;
    const footer = container.querySelector('[data-slot="sidebar-footer"]')!;
    const search = container.querySelector('[data-slot="thread-search"]')!;

    expect(search).toHaveClass("w-7");
    expect(
      within(topRail as HTMLElement).queryByRole("searchbox", {
        name: "Search threads",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(topRail as HTMLElement).getByRole("button", {
        name: "Add ExecutionContext",
      }),
    ).toHaveClass("w-6");
    expect(
      within(topRail as HTMLElement).getByRole("button", {
        name: "Add ExecutionContext",
      }),
    ).toHaveAttribute("data-slot", "sidebar-group-action");
    expect(
      within(footer as HTMLElement).queryByRole("button", {
        name: "Add ExecutionContext",
      }),
    ).not.toBeInTheDocument();

    await user.click(
      within(topRail as HTMLElement).getByRole("button", {
        name: "Search threads",
      }),
    );

    expect(search).toHaveClass("flex-1");
    expect(
      within(topRail as HTMLElement).getByRole("searchbox", {
        name: "Search threads",
      }),
    ).toHaveFocus();
  });

  it("dismisses the mobile sheet after selecting a thread", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal(
      "matchMedia",
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
      expect(screen.getByLabelText("Mobile sidebar state")).toHaveTextContent(
        "false",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    expect(screen.getByLabelText("Mobile sidebar state")).toHaveTextContent(
      "true",
    );

    await user.click(screen.getByText("Acceptance").closest("button")!);

    expect(value.actions.selectThread).toHaveBeenCalledWith("thread-1");
    expect(screen.getByLabelText("Mobile sidebar state")).toHaveTextContent(
      "false",
    );
  });

  it("keeps the Capacitor settings action inside the rounded display without changing rail height", () => {
    const { container } = render(
      <SidebarProvider>
        <ThreadSidebar controller={controller()} />
      </SidebarProvider>,
    );

    expect(container.querySelector('[data-slot="sidebar-footer"]')).toHaveClass(
      "h-[var(--bottom-rail-height)]",
      "py-0",
      "pl-7",
      "pr-1",
    );
    expect(
      container.querySelector('[data-slot="sidebar-footer"]'),
    ).not.toHaveClass("pb-[max(1rem,env(safe-area-inset-bottom))]");
    expect(
      container.querySelector(
        '[data-slot="sidebar-footer"] [data-slot="sidebar-menu"]',
      ),
    ).toHaveClass("flex-row");
  });

  it("opens central Connections from Settings", async () => {
    const value = controller();
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(value.actions.openConnections).toHaveBeenCalledOnce();
  });

  it("opens Archived Threads and archives from the accessible Thread action menu", async () => {
    const value = controller();
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Archived Threads" }));
    expect(value.actions.openArchivedThreads).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", { name: "Actions for Acceptance" }),
    );
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(value.actions.archiveThread).toHaveBeenCalledWith("thread-1");
  });

  it("does not advertise lifecycle actions for an older Portal", () => {
    const value = controller();
    value.model.executionContexts[0].threads[0].supportsThreadLifecycle = false;
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "Actions for Acceptance" }),
    ).not.toBeInTheDocument();
  });

  it("keeps Host identity quiet for one Host and shows it for a merged projection", () => {
    const single = controller();
    const { rerender } = render(
      <SidebarProvider>
        <ThreadSidebar controller={single} />
      </SidebarProvider>,
    );
    expect(screen.queryByText("bazzite")).not.toBeInTheDocument();

    const merged = controller();
    merged.model.showHostIdentity = true;
    merged.model.connections.push({
      hostId: "host-2",
      displayName: "macbook",
      hostUrl: "macbook",
      status: "connected",
      selected: false,
    });
    rerender(
      <SidebarProvider>
        <ThreadSidebar controller={merged} />
      </SidebarProvider>,
    );
    expect(screen.getAllByText(/bazzite/).length).toBeGreaterThan(0);
    expect(screen.getByText("weave").parentElement).not.toHaveTextContent(
      "bazzite",
    );
  });

  it("adds a project through a selected connected Portal", async () => {
    const value = controller("web");
    value.model.connections.push({
      hostId: "host-2",
      displayName: "macbook",
      hostUrl: "macbook",
      status: "connected",
      selected: false,
    });
    const user = userEvent.setup();
    render(
      <SidebarProvider>
        <ThreadSidebar controller={value} />
      </SidebarProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Add ExecutionContext" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Choose the Host that can access the directory",
    );
    await user.click(screen.getByRole("combobox", { name: "Host" }));
    await user.click(await screen.findByRole("option", { name: "macbook" }));
    expect(screen.getByRole("combobox", { name: "Host" })).toHaveTextContent(
      "macbook",
    );
    await user.type(
      screen.getByLabelText("Directory path"),
      "/srv/projects/odin",
    );
    await user.type(screen.getByLabelText("Name (optional)"), "Odin");
    await user.click(screen.getByRole("button", { name: "Add directory" }));

    expect(value.actions.addExecutionContext).toHaveBeenCalledWith({
      hostId: "host-2",
      path: "/srv/projects/odin",
      name: "Odin",
    });
  });

  it("removes the Capacitor-only settings offset on the web", () => {
    const { container } = render(
      <SidebarProvider>
        <ThreadSidebar controller={controller("web")} />
      </SidebarProvider>,
    );

    expect(container.querySelector('[data-slot="sidebar-footer"]')).toHaveClass(
      "pl-1",
      "pr-1",
    );
    expect(
      container.querySelector('[data-slot="sidebar-footer"]'),
    ).not.toHaveClass("pl-7");
  });

  it("keeps every new-thread action at least 24px square", () => {
    render(
      <SidebarProvider>
        <ThreadSidebar controller={controller()} />
      </SidebarProvider>,
    );

    expect(
      screen.getByRole("button", { name: "New thread in weave" }),
    ).toHaveClass("top-2", "w-6");
    expect(
      screen.getByRole("button", { name: "ExecutionContext settings for weave" }),
    ).toHaveClass("top-2", "w-6");
  });

  it("does not expose Workspace files as a dedicated Thread-sidebar artifact", () => {
    render(
      <SidebarProvider>
        <ThreadSidebar controller={controller()} />
      </SidebarProvider>,
    );

    expect(screen.queryByText("Browse files")).not.toBeInTheDocument();
  });
});
