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
    workspaces: [
      {
        id: "weave",
        workspaceId: "weave",
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
            workspaceId: "weave",
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
    addProject: vi.fn(async () => undefined),
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
  it("replaces the active new-thread action with a disabled spinner", () => {
    const value = controller();
    value.model.creatingThreadWorkspaceId = "weave";
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
    expect(within(creating).getByRole("status", { hidden: true }))
      .toHaveAttribute("data-slot", "spinner");
    expect(container.querySelectorAll('[data-slot="spinner"]')).toHaveLength(1);
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
      screen.getByLabelText("Reconnecting bazzite thread"),
    ).toHaveAttribute("data-slot", "reconnecting-thread");
    expect(container.querySelector('[data-slot="skeleton"]'))
      .toBeInTheDocument();
    expect(screen.queryByText("Acceptance")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread in weave" }))
      .toBeDisabled();
  });

  it("keeps search compact until activated and places Add Project in the top rail", async () => {
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
        name: "Add Project",
      }),
    ).toHaveClass("w-6");
    expect(
      within(topRail as HTMLElement).getByRole("button", {
        name: "Add Project",
      }),
    ).toHaveAttribute("data-slot", "sidebar-group-action");
    expect(
      within(footer as HTMLElement).queryByRole("button", {
        name: "Add Project",
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
      )
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
    value.model.workspaces[0].threads[0].supportsThreadLifecycle = false;
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

    await user.click(screen.getByRole("button", { name: "Add Project" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "Choose the Portal that can access the project",
    );
    await user.click(screen.getByRole("combobox", { name: "Portal" }));
    await user.click(await screen.findByRole("option", { name: "macbook" }));
    expect(screen.getByRole("combobox", { name: "Portal" })).toHaveTextContent(
      "macbook",
    );
    await user.type(
      screen.getByLabelText("Project path"),
      "/srv/projects/odin",
    );
    await user.type(screen.getByLabelText("Name (optional)"), "Odin");
    await user.click(screen.getByRole("button", { name: "Add project" }));

    expect(value.actions.addProject).toHaveBeenCalledWith({
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
    ).toHaveClass("w-6");
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
