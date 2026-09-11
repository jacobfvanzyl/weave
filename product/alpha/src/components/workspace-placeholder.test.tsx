import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AlphaController } from "@/app/alpha-controller";
import { createTranscript } from "@/chat/acp-transcript";
import { Button } from "@/components/ui/button";
import { SidebarProvider } from "@/components/ui/sidebar";
import { WorkspacePlaceholder } from "./workspace-placeholder";

const controller = (): AlphaController => ({
  model: {
    platform: "test",
    connectionsLoaded: true,
    connectionsOpen: false,
    archivedThreadsOpen: false,
    connections: [{
      hostId: "host-1",
      displayName: "bazzite",
      hostUrl: "bazzite",
      status: "connected",
      selected: true,
    }],
    connection: {
      status: "connected",
      hostUrl: "ws://bazzite:4122",
      hostName: "bazzite",
    },
    searchQuery: "",
    executionContexts: [{
      id: "weave",
      executionContextId: "weave",
      hostId: "host-1",
      hostName: "bazzite",
      name: "weave",
      threads: [{
        id: "thread-1",
        threadId: "thread-1",
        hostId: "host-1",
        title: "Acceptance",
        agentName: "Codex",
        hostName: "bazzite",
        status: "active",
        updatedAt: "2026-08-25T00:00:00.000Z",
        executionContextId: "weave",
      }],
    }],
    archivedThreads: [],
    showHostIdentity: false,
    selectedThreadId: "thread-1",
    transcript: createTranscript("session-1"),
    busy: false,
    error: "Portal lost the connection to this host.",
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

describe("WorkspacePlaceholder", () => {
  it("does not focus the composer when a Thread mounts on Capacitor", () => {
    const value = controller();
    value.model.platform = "ios";
    value.model.composerFocusRequest = 0;
    value.model.error = undefined;

    render(
      <SidebarProvider>
        <WorkspacePlaceholder controller={value} />
      </SidebarProvider>,
    );

    expect(screen.getByRole("textbox", { name: "Message agent" })).not
      .toHaveFocus();
  });

  it("honors an explicit composer focus request on Capacitor", () => {
    const value = controller();
    value.model.platform = "ios";
    value.model.composerFocusRequest = 1;
    value.model.composerFocusThreadId = "thread-1";
    value.model.error = undefined;

    render(
      <SidebarProvider>
        <WorkspacePlaceholder controller={value} />
      </SidebarProvider>,
    );

    expect(screen.getByRole("textbox", { name: "Message agent" }))
      .toHaveFocus();
  });

  it("replaces the selected Thread pane with skeletons while its Host reconnects", () => {
    const value = controller();
    value.model.connections[0]!.status = "reconnecting";
    value.model.error = undefined;
    const { container } = render(
      <SidebarProvider>
        <WorkspacePlaceholder controller={value} />
      </SidebarProvider>,
    );

    expect(screen.getByLabelText("Reconnecting thread")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(container.querySelectorAll('[data-slot="skeleton"]')).not.toHaveLength(0);
    expect(screen.queryByRole("textbox", { name: "Message agent" })).not
      .toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears the Thread content and centers a mauve spinner while attachment loads", () => {
    const value = controller();
    value.model.loadingThreadId = "thread-1";
    const { container } = render(
      <SidebarProvider>
        <WorkspacePlaceholder
          controller={value}
        />
      </SidebarProvider>,
    );

    expect(container.querySelector('[data-slot="thread-loading"]')).toHaveClass(
      "items-center",
      "justify-center",
    );
    expect(screen.getByRole("status", { name: "Loading thread" })).toHaveClass(
      "size-5",
      "text-primary",
    );
    expect(screen.queryByRole("textbox", { name: "Message agent" })).not
      .toBeInTheDocument();
  });

  it("anchors errors below the title bar and within phone-width gutters", () => {
    const { container } = render(
      <SidebarProvider>
        <WorkspacePlaceholder
          controller={controller()}
        />
      </SidebarProvider>,
    );

    expect(container.querySelector(".relative")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveClass(
      "inset-x-3",
      "top-14",
      "w-auto",
      "sm:left-auto",
      "sm:right-4",
      "sm:max-w-sm",
    );
    expect(screen.getByRole("alert")).not.toHaveClass("bottom-10");
    expect(screen.getByText("Couldn’t complete that action"))
      .toBeInTheDocument();
  });

  it("keeps the empty-workspace bottom rail visible on mobile", () => {
    const value = controller();
    value.model.selectedThreadId = undefined;
    value.model.transcript = undefined;
    value.model.error = undefined;
    const { container } = render(
      <SidebarProvider>
        <WorkspacePlaceholder
          controller={value}
          footerActions={
            <Button aria-label="Test control" disabled />
          }
        />
      </SidebarProvider>,
    );

    expect(container.querySelector('[data-slot="main-bottom-rail"]'))
      .toHaveClass(
        "h-[var(--bottom-rail-height)]",
        "shrink-0",
      );
    expect(container.querySelector('[data-slot="main-bottom-rail"]'))
      .not.toHaveClass("hidden", "sm:block");
    expect(container.querySelector('[data-slot="thread-top-rail"]'))
      .toBeEmptyDOMElement();
    expect(container.querySelector('[data-slot="thread-content"]'))
      .toBeEmptyDOMElement();
    expect(screen.getByRole("button", { name: "Test control" }))
      .toBeDisabled();
  });

  it("renders a supplied icon-only control in its bottom rail", async () => {
    const user = userEvent.setup();
    const showExecutionContextPane = vi.fn();
    const { container } = render(
      <SidebarProvider defaultOpen={false}>
        <WorkspacePlaceholder
          controller={controller()}
          footerActions={
            <Button aria-label="Test control" size="icon" onClick={showExecutionContextPane} />
          }
        />
      </SidebarProvider>,
    );

    const toggle = screen.getByRole("button", { name: "Test control" });
    expect(toggle).toHaveTextContent("");
    expect(toggle).toHaveClass("size-7", "items-center", "justify-center");
    await user.click(toggle);
    expect(showExecutionContextPane).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-slot="main-bottom-rail"]'))
      .toBeInTheDocument();
  });
});
