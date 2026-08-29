import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DirectHostClient,
  type HostSnapshot,
  PortalRpcError,
} from "@/portal-client";
import { loadPortalConnections } from "./portal-connection-storage";
import { useLiveAlphaController } from "./use-live-alpha-controller";

vi.mock("./portal-connection-storage", () => ({
  loadPortalConnections: vi.fn(async () => ({
    connections: [
      {
        hostId: "host-1",
        displayName: "Bazzite",
        hostUrl: "wss://bazzite.test:4122",
        credentialId: "credential-1",
        keyId: "key-1",
      },
    ],
    selectedHostId: "host-1",
  })),
  savePortalConnections: vi.fn(async () => undefined),
}));

const snapshot: HostSnapshot = {
  hostId: "host-1",
  displayName: "Bazzite",
  capabilities: ["workspace.add"],
  workspaces: [{ workspaceId: "weave", name: "Weave" }],
  agents: [{ agentId: "codex", name: "Codex" }],
  archivedThreads: [],
  threads: [
    {
      threadId: "thread-1",
      agentId: "codex",
      workspaceId: "weave",
      acpSessionId: "session-1",
      title: "Acceptance",
      status: "active",
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useLiveAlphaController", () => {
  it("removes the selected Host placement and refreshes only that Portal", async () => {
    const removableSnapshot: HostSnapshot = {
      ...snapshot,
      capabilities: ["workspace.add", "workspace.remove"],
    };
    const removedSnapshot: HostSnapshot = {
      ...removableSnapshot,
      workspaces: [],
      threads: [],
    };
    let currentSnapshot = removableSnapshot;
    const client = {
      snapshot: vi.fn(async () => currentSnapshot),
      removeWorkspace: vi.fn(async () => {
        currentSnapshot = removedSnapshot;
      }),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() =>
      useLiveAlphaController(vi.fn(() => client)),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const workspace = result.current.model.workspaces[0]!;
    const placement = workspace.placements?.[0];

    await act(async () =>
      result.current.actions.removeProject?.(workspace.id, placement?.id),
    );

    expect(client.removeWorkspace).toHaveBeenCalledWith("weave");
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(result.current.model.workspaces).toEqual([]);
    expect(result.current.model.error).toBeUndefined();
  });

  it("reflects an Agent title update in the active transcript and sidebar immediately", async () => {
    let onEvent: ConstructorParameters<typeof DirectHostClient>[2] | undefined;
    const client = {
      snapshot: vi.fn(async () => snapshot),
      attach: vi.fn(async () => snapshot.threads[0]),
      listWorkspaceFiles: vi.fn(async () => ({
        path: "",
        entries: [],
        truncated: false,
      })),
      watchWorkspaceFiles: vi.fn(
        async (_workspaceId: string, paths: string[]) => ({
          subscriptionId: "watch-title",
          paths,
          update: vi.fn(async (nextPaths: string[]) => nextPaths),
          close: vi.fn(async () => undefined),
        }),
      ),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() =>
      useLiveAlphaController(
        vi.fn(
          (
            _hostUrl: string,
            _credential: unknown,
            nextOnEvent: ConstructorParameters<typeof DirectHostClient>[2],
          ) => {
            onEvent = nextOnEvent;
            return client;
          },
        ),
      ),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      result.current.actions.selectThread("host-1:thread-1"),
    );
    act(() => onEvent?.({ type: "history/reset", sessionId: "session-1" }));

    act(() =>
      onEvent?.({
        type: "session/update",
        update: {
          sessionUpdate: "session_info_update",
          title: "Agent-selected title",
          updatedAt: "2026-08-28T06:00:00.000Z",
        },
      }),
    );

    expect(result.current.model.transcript?.title).toBe("Agent-selected title");
    expect(result.current.model.workspaces[0]?.threads[0]).toMatchObject({
      id: "host-1:thread-1",
      title: "Agent-selected title",
      updatedAt: "2026-08-28T06:00:00.000Z",
    });

    act(() =>
      onEvent?.({
        type: "session/update",
        update: {
          sessionUpdate: "session_info_update",
          title: null,
          updatedAt: "2026-08-28T06:05:00.000Z",
        },
      }),
    );
    expect(result.current.model.transcript?.title).toBeNull();
    expect(result.current.model.workspaces[0]?.threads[0]).toMatchObject({
      title: "Weave",
      updatedAt: "2026-08-28T06:05:00.000Z",
    });
    expect(client.snapshot).toHaveBeenCalledOnce();
  });

  it("optimistically selects and clears a switching Thread until attach and files finish loading", async () => {
    const secondThread = {
      ...snapshot.threads[0],
      threadId: "thread-2",
      acpSessionId: "session-2",
      title: "Second Thread",
      updatedAt: "2026-08-26T00:00:00.000Z",
    };
    const switchingSnapshot: HostSnapshot = {
      ...snapshot,
      threads: [...snapshot.threads, secondThread],
    };
    let onEvent: ConstructorParameters<typeof DirectHostClient>[2] | undefined;
    let resolveSecondAttach!: () => void;
    const secondAttach = new Promise<void>((resolve) => {
      resolveSecondAttach = resolve;
    });
    const client = {
      snapshot: vi.fn(async () => switchingSnapshot),
      attach: vi.fn(async (threadId: string) => {
        if (threadId === "thread-2") await secondAttach;
        return switchingSnapshot.threads.find(
          (thread) => thread.threadId === threadId,
        )!;
      }),
      listWorkspaceFiles: vi.fn(async () => ({
        path: "",
        entries: [],
        truncated: false,
      })),
      watchWorkspaceFiles: vi.fn(
        async (_workspaceId: string, paths: string[]) => ({
          subscriptionId: "watch-1",
          paths,
          update: vi.fn(async (nextPaths: string[]) => nextPaths),
          close: vi.fn(async () => undefined),
        }),
      ),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() =>
      useLiveAlphaController(
        vi.fn(
          (
            _hostUrl: string,
            _credential: unknown,
            nextOnEvent: ConstructorParameters<typeof DirectHostClient>[2],
          ) => {
            onEvent = nextOnEvent;
            return client;
          },
        ),
      ),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      result.current.actions.selectThread("host-1:thread-1"),
    );
    act(() => onEvent?.({ type: "history/reset", sessionId: "session-1" }));
    expect(result.current.model.transcript?.sessionId).toBe("session-1");
    expect(result.current.model.workspaceFiles).toBeDefined();

    let switchPromise: Promise<void> | void;
    act(() => {
      switchPromise = result.current.actions.selectThread("host-1:thread-2");
    });

    expect(result.current.model.selectedThreadId).toBe("host-1:thread-2");
    expect(result.current.model.loadingThreadId).toBe("host-1:thread-2");
    expect(result.current.model.transcript).toBeUndefined();
    expect(result.current.model.workspaceFiles).toBeUndefined();

    await act(async () => {
      onEvent?.({ type: "history/reset", sessionId: "session-2" });
      resolveSecondAttach();
      await switchPromise;
    });

    expect(result.current.model.loadingThreadId).toBeUndefined();
    expect(result.current.model.transcript?.sessionId).toBe("session-2");
    expect(result.current.model.workspaceFiles).toBeDefined();
  });

  it("aggregates concurrent Hosts with collision-safe routing and preserves unrelated state on failure", async () => {
    const repositoryIdentity = {
      canonicalKey: "github.com/veezee/weave",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:VeeZee/weave.git",
      },
      displayName: "veezee/weave",
      name: "weave",
    };
    const firstSnapshot: HostSnapshot = {
      ...snapshot,
      workspaces: [
        ...snapshot.workspaces.map((workspace) => ({
          ...workspace,
          repositoryIdentity,
        })),
        { workspaceId: "scratch", name: "Scratch" },
      ],
    };
    const secondSnapshot: HostSnapshot = {
      ...firstSnapshot,
      hostId: "host-2",
      displayName: "MacBook",
      threads: snapshot.threads.map((thread) => ({
        ...thread,
        title: "Same raw ID on MacBook",
      })),
    };
    vi.mocked(loadPortalConnections).mockResolvedValueOnce({
      connections: [
        {
          hostId: "host-1",
          displayName: "Bazzite",
          hostUrl: "wss://bazzite.test:4122",
          credentialId: "credential-1",
          keyId: "key-1",
        },
        {
          hostId: "host-2",
          displayName: "MacBook",
          hostUrl: "wss://macbook.test:4122",
          credentialId: "credential-2",
          keyId: "key-2",
        },
      ],
      selectedHostId: "host-1",
    });

    const closeHandlers = new Map<string, (error: Error) => void>();
    const makeClient = (hostId: string, hostSnapshot: HostSnapshot) =>
      ({
        snapshot: vi.fn(async () => hostSnapshot),
        attach: vi.fn(async () => hostSnapshot.threads[0]),
        createThread: vi.fn(async () => ({
          ...hostSnapshot.threads[0],
          threadId: "created-thread",
        })),
        prompt: vi.fn(async () => undefined),
        listWorkspaceFiles: vi.fn(async () => ({
          path: "",
          entries: [],
          truncated: false,
        })),
        watchWorkspaceFiles: vi.fn(
          async (_workspaceId: string, paths: string[]) => ({
            subscriptionId: `${hostId}-watch`,
            paths,
            update: vi.fn(async (nextPaths: string[]) => nextPaths),
            close: vi.fn(async () => undefined),
          }),
        ),
        close: vi.fn(),
      }) as unknown as DirectHostClient;
    const host1 = makeClient("host-1", firstSnapshot);
    const host2 = makeClient("host-2", secondSnapshot);
    const createClient = vi.fn(
      (
        hostUrl: string,
        _credential: unknown,
        _onEvent: ConstructorParameters<typeof DirectHostClient>[2],
        onClose: (error: Error) => void,
      ) => {
        const hostId = hostUrl.includes("macbook") ? "host-2" : "host-1";
        closeHandlers.set(hostId, onClose);
        return hostId === "host-2" ? host2 : host1;
      },
    );
    const { result } = renderHook(() => useLiveAlphaController(createClient));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      result.current.model.connections.map(({ hostId, status }) => ({
        hostId,
        status,
      })),
    ).toEqual([
      { hostId: "host-1", status: "connected" },
      { hostId: "host-2", status: "connected" },
    ]);
    expect(result.current.model.workspaces.map(({ id }) => id)).toEqual([
      "repository:github.com/veezee/weave",
      "workspace:host-1:scratch",
      "workspace:host-2:scratch",
    ]);
    expect(result.current.model.workspaces[0].placements).toHaveLength(2);
    expect(
      result.current.model.workspaces
        .slice(1)
        .map(({ placements }) => placements?.length),
    ).toEqual([1, 1]);
    expect(
      result.current.model.workspaces
        .flatMap(({ threads }) => threads)
        .map(({ id }) => id)
        .sort(),
    ).toEqual(["host-1:thread-1", "host-2:thread-1"]);

    await act(async () =>
      result.current.actions.selectThread("host-2:thread-1"),
    );
    expect(host2.attach).toHaveBeenCalledWith("thread-1");
    expect(host1.attach).not.toHaveBeenCalled();
    expect(result.current.model.selectedThreadId).toBe("host-2:thread-1");

    act(() => closeHandlers.get("host-1")?.(new Error("Bazzite offline.")));
    expect(
      result.current.model.connections.find(({ hostId }) => hostId === "host-1")
        ?.status,
    ).toBe("reconnecting");
    expect(
      result.current.model.connections.find(({ hostId }) => hostId === "host-2")
        ?.status,
    ).toBe("connected");
    expect(result.current.model.selectedThreadId).toBe("host-2:thread-1");
    expect(
      result.current.model.workspaces.flatMap(({ threads }) => threads),
    ).toHaveLength(2);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      result.current.model.connections.find(({ hostId }) => hostId === "host-1")
        ?.status,
    ).toBe("connected");

    await act(async () =>
      result.current.actions.createThread(
        "repository:github.com/veezee/weave",
        "host-1:weave",
      ),
    );
    expect(host2.createThread).not.toHaveBeenCalled();
    expect(host1.createThread).not.toHaveBeenCalled();
    expect(result.current.model.workspaces[0]?.threads[0]).toMatchObject({
      draft: true,
      hostId: "host-1",
      title: "New thread",
    });

    await act(async () => result.current.actions.reconnectHost("host-1"));
    expect(
      result.current.model.connections.find(({ hostId }) => hostId === "host-1")
        ?.status,
    ).toBe("connected");
    expect(result.current.model.workspaces).toHaveLength(3);
  });

  it("registers a project through the chosen connected Portal and refreshes only that Host", async () => {
    const client = {
      snapshot: vi.fn(async () => snapshot),
      addWorkspace: vi.fn(async () => ({
        workspaceId: "odin",
        name: "Odin",
      })),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() =>
      useLiveAlphaController(vi.fn(() => client)),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () =>
      result.current.actions.addProject?.({
        hostId: "host-1",
        path: "/srv/odin",
        name: "Odin",
      }),
    );

    expect(client.addWorkspace).toHaveBeenCalledWith("/srv/odin", "Odin");
    expect(client.snapshot).toHaveBeenCalledTimes(2);
  });

  it("creates one local draft and materializes it only once on first send", async () => {
    const createdThread = {
      ...snapshot.threads[0],
      threadId: "thread-created",
      acpSessionId: "session-created",
      title: "Created Thread",
    };
    let currentSnapshot = snapshot;
    let resolveCreate!: () => void;
    const pendingCreate = new Promise<typeof createdThread>((resolve) => {
      resolveCreate = () => {
        currentSnapshot = {
          ...snapshot,
          threads: [...snapshot.threads, createdThread],
        };
        resolve(createdThread);
      };
    });
    const client = {
      snapshot: vi.fn(async () => currentSnapshot),
      createThread: vi.fn(() => pendingCreate),
      attach: vi.fn(async () => createdThread),
      prompt: vi.fn(async () => undefined),
      listWorkspaceFiles: vi.fn(async () => ({
        path: "",
        entries: [],
        truncated: false,
      })),
      watchWorkspaceFiles: vi.fn(
        async (_workspaceId: string, paths: string[]) => ({
          subscriptionId: "watch-created",
          paths,
          update: vi.fn(async (nextPaths: string[]) => nextPaths),
          close: vi.fn(async () => undefined),
        }),
      ),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() =>
      useLiveAlphaController(vi.fn(() => client)),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const workspaceId = result.current.model.workspaces[0]!.id;

    await act(async () => {
      await result.current.actions.createThread(workspaceId);
    });

    const draftId = result.current.model.selectedThreadId;
    const firstFocusRequest = result.current.model.composerFocusRequest;
    expect(result.current.model.composerFocusThreadId).toBe(draftId);
    expect(client.createThread).not.toHaveBeenCalled();
    expect(result.current.model.workspaces[0]?.threads[0]).toMatchObject({
      id: draftId,
      draft: true,
      title: "New thread",
    });
    expect(result.current.model.transcript?.entries).toEqual([]);

    await act(async () => {
      await result.current.actions.createThread(workspaceId);
    });
    expect(result.current.model.selectedThreadId).toBe(draftId);
    expect(result.current.model.composerFocusThreadId).toBe(draftId);
    expect(result.current.model.composerFocusRequest).toBeGreaterThan(
      firstFocusRequest ?? 0,
    );
    expect(client.createThread).not.toHaveBeenCalled();

    let firstSend: Promise<void> | void;
    let duplicateSend: Promise<void> | void;
    act(() => {
      firstSend = result.current.actions.sendPrompt("Start the work");
      duplicateSend = result.current.actions.sendPrompt("Start it again");
    });

    expect(client.createThread).toHaveBeenCalledOnce();
    expect(result.current.model.creatingThreadWorkspaceId).toBe(workspaceId);

    await act(async () => {
      resolveCreate();
      await Promise.all([firstSend, duplicateSend]);
    });
    expect(client.createThread).toHaveBeenCalledOnce();
    expect(client.createThread).toHaveBeenCalledWith("weave", "codex");
    expect(client.prompt).toHaveBeenCalledOnce();
    expect(client.prompt).toHaveBeenCalledWith([
      { type: "text", text: "Start the work" },
    ]);
    expect(result.current.model.creatingThreadWorkspaceId).toBeUndefined();
    expect(result.current.model.selectedThreadId).toBe("host-1:thread-created");
    expect(
      result.current.model.workspaces[0]?.threads.some(({ draft }) => draft),
    ).toBe(false);
  });

  it("preflights supported drafts so config is available before the first prompt", async () => {
    const prepared = {
      ...snapshot.threads[0],
      threadId: "draft-prepared",
      acpSessionId: "session-prepared",
      title: undefined,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    };
    let currentSnapshot: HostSnapshot = {
      ...snapshot,
      capabilities: [...snapshot.capabilities, "thread.draft"],
    };
    let onEvent: ConstructorParameters<typeof DirectHostClient>[2] | undefined;
    const client = {
      snapshot: vi.fn(async () => currentSnapshot),
      createThread: vi.fn(),
      createThreadDraft: vi.fn(async () => prepared),
      discardThreadDraft: vi.fn(async () => undefined),
      attach: vi.fn(async () => {
        onEvent?.({
          type: "history/reset",
          sessionId: prepared.acpSessionId,
        });
        onEvent?.({
          type: "session/loaded",
          modes: {
            currentModeId: "code",
            availableModes: [
              { id: "ask", name: "Ask" },
              { id: "code", name: "Code" },
            ],
          },
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              currentValue: "gpt-5.6-sol",
              options: [{ value: "gpt-5.6-sol", name: "GPT-5.6 Sol" }],
            },
            {
              type: "select",
              id: "reasoning_effort",
              name: "Reasoning effort",
              currentValue: "high",
              options: [{ value: "high", name: "High" }],
            },
          ],
        });
        return prepared;
      }),
      prompt: vi.fn(async () => {
        currentSnapshot = {
          ...currentSnapshot,
          threads: [prepared, ...currentSnapshot.threads],
        };
      }),
      setMode: vi.fn(async () => undefined),
      setConfigOption: vi.fn(async () => undefined),
      listWorkspaceFiles: vi.fn(async () => ({
        path: "",
        entries: [],
        truncated: false,
      })),
      watchWorkspaceFiles: vi.fn(
        async (_workspaceId: string, paths: string[]) => ({
          subscriptionId: "watch-prepared",
          paths,
          update: vi.fn(async (nextPaths: string[]) => nextPaths),
          close: vi.fn(async () => undefined),
        }),
      ),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() =>
      useLiveAlphaController(
        vi.fn(
          (
            _hostUrl: string,
            _credential: unknown,
            nextOnEvent: ConstructorParameters<typeof DirectHostClient>[2],
          ) => {
            onEvent = nextOnEvent;
            return client;
          },
        ),
      ),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const workspaceId = result.current.model.workspaces[0]!.id;

    await act(async () => {
      await result.current.actions.createThread(workspaceId);
    });

    expect(client.createThreadDraft).toHaveBeenCalledWith("weave", "codex");
    expect(client.createThread).not.toHaveBeenCalled();
    expect(client.attach).toHaveBeenCalledWith("draft-prepared");
    expect(result.current.model.transcript).toMatchObject({
      sessionId: "session-prepared",
      currentModeId: "code",
      configOptions: [
        { id: "model", currentValue: "gpt-5.6-sol" },
        { id: "reasoning_effort", currentValue: "high" },
      ],
    });

    await act(async () => {
      await result.current.actions.setMode("ask");
      await result.current.actions.setConfigOption("reasoning_effort", "high");
    });
    expect(client.setMode).toHaveBeenCalledWith("ask");
    expect(client.setConfigOption).toHaveBeenCalledWith(
      "reasoning_effort",
      "high",
    );

    await act(async () => {
      await result.current.actions.sendPrompt("Use these settings");
    });
    expect(client.createThread).not.toHaveBeenCalled();
    expect(client.prompt).toHaveBeenCalledWith([
      { type: "text", text: "Use these settings" },
    ]);
    expect(result.current.model.workspaces[0]?.threads[0]?.id).toBe(
      "host-1:draft-prepared",
    );
    expect(
      result.current.model.workspaces[0]?.threads[0]?.draft,
    ).toBeUndefined();
  });

  it("discards an untouched local draft when another Thread is selected", async () => {
    const prepared = {
      ...snapshot.threads[0],
      threadId: "draft-discarded",
      acpSessionId: "session-discarded",
    };
    const client = {
      snapshot: vi.fn(async () => ({
        ...snapshot,
        capabilities: [...snapshot.capabilities, "thread.draft"],
      })),
      createThread: vi.fn(),
      createThreadDraft: vi.fn(async () => prepared),
      discardThreadDraft: vi.fn(async () => undefined),
      attach: vi.fn(async () => snapshot.threads[0]),
      listWorkspaceFiles: vi.fn(async () => ({
        path: "",
        entries: [],
        truncated: false,
      })),
      watchWorkspaceFiles: vi.fn(
        async (_workspaceId: string, paths: string[]) => ({
          subscriptionId: "watch-draft",
          paths,
          update: vi.fn(async (nextPaths: string[]) => nextPaths),
          close: vi.fn(async () => undefined),
        }),
      ),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() =>
      useLiveAlphaController(vi.fn(() => client)),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const workspaceId = result.current.model.workspaces[0]!.id;

    await act(async () => {
      await result.current.actions.createThread(workspaceId);
    });
    const draftId = result.current.model.selectedThreadId;
    expect(result.current.model.workspaces[0]?.threads[0]?.id).toBe(draftId);

    await act(async () => {
      await result.current.actions.selectThread("host-1:thread-1");
    });

    expect(client.createThread).not.toHaveBeenCalled();
    expect(client.discardThreadDraft).toHaveBeenCalledWith("draft-discarded");
    expect(result.current.model.selectedThreadId).toBe("host-1:thread-1");
    expect(result.current.model.workspaces[0]?.threads).toHaveLength(1);
    expect(result.current.model.workspaces[0]?.threads[0]?.id).toBe(
      "host-1:thread-1",
    );
  });

  it("archives the selected Host-scoped Thread and restores it without changing identity", async () => {
    let current: HostSnapshot = { ...snapshot, archivedThreads: [] };
    const client = {
      snapshot: vi.fn(async () => current),
      attach: vi.fn(async () => current.threads[0]),
      archiveThread: vi.fn(async (threadId: string) => {
        const thread = current.threads.find(
          (candidate) => candidate.threadId === threadId,
        )!;
        const archived = {
          ...thread,
          status: "archived" as const,
          archivedAt: "2026-08-26T02:00:00.000Z",
        };
        current = { ...current, threads: [], archivedThreads: [archived] };
        return archived;
      }),
      restoreThread: vi.fn(async (threadId: string) => {
        const thread = current.archivedThreads.find(
          (candidate) => candidate.threadId === threadId,
        )!;
        const restored = {
          ...thread,
          status: "active" as const,
          archivedAt: undefined,
        };
        current = { ...current, threads: [restored], archivedThreads: [] };
        return restored;
      }),
      listWorkspaceFiles: vi.fn(async () => ({
        path: "",
        entries: [],
        truncated: false,
      })),
      watchWorkspaceFiles: vi.fn(
        async (_workspaceId: string, paths: string[]) => ({
          subscriptionId: "watch-1",
          paths,
          update: vi.fn(async (nextPaths: string[]) => nextPaths),
          close: vi.fn(async () => undefined),
        }),
      ),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() =>
      useLiveAlphaController(vi.fn(() => client)),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      result.current.actions.selectThread("host-1:thread-1"),
    );
    expect(result.current.model.selectedThreadId).toBe("host-1:thread-1");

    await act(async () =>
      result.current.actions.archiveThread("host-1:thread-1"),
    );
    expect(result.current.model.selectedThreadId).toBeUndefined();
    expect(result.current.model.workspaces[0].threads).toEqual([]);
    expect(
      result.current.model.archivedThreads.map(({ id, status }) => ({
        id,
        status,
      })),
    ).toEqual([{ id: "host-1:thread-1", status: "archived" }]);

    await act(async () =>
      result.current.actions.restoreThread("host-1:thread-1"),
    );
    expect(result.current.model.archivedThreads).toEqual([]);
    expect(result.current.model.workspaces[0].threads[0]).toMatchObject({
      id: "host-1:thread-1",
      status: "active",
    });
  });

  it("reports prompt failures and rejects so the composer can restore its draft", async () => {
    let onEvent: ConstructorParameters<typeof DirectHostClient>[2] | undefined;
    const client = {
      snapshot: vi.fn(async () => snapshot),
      attach: vi.fn(async () => snapshot.threads[0]),
      listWorkspaceFiles: vi.fn(async () => ({
        path: "",
        entries: [],
        truncated: false,
      })),
      watchWorkspaceFiles: vi.fn(
        async (_workspaceId: string, paths: string[]) => ({
          subscriptionId: "watch-1",
          paths,
          update: vi.fn(async (nextPaths: string[]) => nextPaths),
          close: vi.fn(async () => undefined),
        }),
      ),
      prompt: vi.fn(async () => {
        throw new Error("Portal unavailable.");
      }),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const createClient = vi.fn(
      (
        _hostUrl: string,
        _credential: unknown,
        nextOnEvent: ConstructorParameters<typeof DirectHostClient>[2],
      ) => {
        onEvent = nextOnEvent;
        return client;
      },
    );
    const { result } = renderHook(() => useLiveAlphaController(createClient));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      result.current.actions.selectThread("host-1:thread-1"),
    );
    act(() => onEvent?.({ type: "history/reset", sessionId: "session-1" }));

    await act(async () => {
      await expect(
        result.current.actions.sendPrompt("Keep my draft"),
      ).rejects.toThrow("Portal unavailable.");
    });

    expect(result.current.model.error).toBe("Portal unavailable.");
    expect(client.prompt).toHaveBeenCalledWith([
      { type: "text", text: "Keep my draft" },
    ]);
  });

  it("silently refreshes a connected Portal and demotes stale state when the transport closes", async () => {
    vi.useFakeTimers();
    let connectionClosed: ((error: Error) => void) | undefined;
    const client = {
      snapshot: vi.fn(async () => snapshot),
      attach: vi.fn(async () => snapshot.threads[0]),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const createClient = vi.fn(
      (
        _hostUrl: string,
        _credential: unknown,
        _onEvent: ConstructorParameters<typeof DirectHostClient>[2],
        onClose: (error: Error) => void,
      ) => {
        connectionClosed = onClose;
        return client;
      },
    );
    const { result } = renderHook(() => useLiveAlphaController(createClient));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.model.connection.status).toBe("connected");
    expect(client.snapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(result.current.model.busy).toBe(false);

    vi.mocked(client.snapshot).mockRejectedValueOnce(
      new Error("Temporary refresh failure."),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.model.error).toBeUndefined();
    expect(result.current.model.connections[0]?.error).toBeUndefined();

    vi.mocked(client.snapshot).mockResolvedValueOnce(snapshot);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.model.error).toBeUndefined();

    act(() => connectionClosed?.(new Error("Portal connection closed.")));
    expect(result.current.model.connections[0]?.status).toBe("reconnecting");
    expect(result.current.model.error).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.model.connection.status).toBe("connected");
  });

  it("keeps cached Host threads during reconnect and hides them after the timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let connectionClosed: ((error: Error) => void) | undefined;
    const initialClient = {
      snapshot: vi.fn(async () => snapshot),
      attach: vi.fn(async () => snapshot.threads[0]),
      listWorkspaceFiles: vi.fn(async () => ({
        path: "",
        entries: [],
        truncated: false,
      })),
      watchWorkspaceFiles: vi.fn(
        async (_workspaceId: string, paths: string[]) => ({
          subscriptionId: "watch-1",
          paths,
          update: vi.fn(async (nextPaths: string[]) => nextPaths),
          close: vi.fn(async () => undefined),
        }),
      ),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const reconnectClient = {
      snapshot: vi.fn(() => new Promise<HostSnapshot>(() => undefined)),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const createClient = vi.fn(
      (
        _hostUrl: string,
        _credential: unknown,
        _onEvent: ConstructorParameters<typeof DirectHostClient>[2],
        onClose: (error: Error) => void,
      ) => {
        connectionClosed = onClose;
        return createClient.mock.calls.length === 1
          ? initialClient
          : reconnectClient;
      },
    );
    const { result } = renderHook(() => useLiveAlphaController(createClient));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      result.current.actions.selectThread("host-1:thread-1"),
    );

    act(() => connectionClosed?.(new Error("Socket closed.")));
    expect(result.current.model.connections[0]?.status).toBe("reconnecting");
    expect(result.current.model.workspaces[0]?.threads).toHaveLength(1);
    expect(result.current.model.selectedThreadId).toBe("host-1:thread-1");
    expect(result.current.model.error).toBeUndefined();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.model.connections[0]).toMatchObject({
      status: "disconnected",
      error:
        "Couldn’t reconnect to this Portal Host. Check that Portal is running and try again.",
    });
    expect(result.current.model.workspaces).toEqual([]);
    expect(result.current.model.selectedThreadId).toBeUndefined();
    expect(result.current.model.workspaceFiles).toBeUndefined();
    expect(result.current.model.error).toBeUndefined();
  });

  it("browses and reads Workspace files through the connected Portal", async () => {
    let onWatchEvent:
      | ((event: {
          kind: "modify";
          paths: string[];
          affectedDirectories: string[];
        }) => void)
      | undefined;
    const watch = {
      update: vi.fn(async (paths: string[]) => paths),
      close: vi.fn(async () => undefined),
    };
    const client = {
      snapshot: vi.fn(async () => snapshot),
      attach: vi.fn(async () => snapshot.threads[0]),
      listWorkspaceFiles: vi.fn(async (_workspaceId: string, path: string) => ({
        path,
        entries:
          path === ""
            ? [
                { name: "src", path: "src", type: "directory" as const },
                {
                  name: "README.md",
                  path: "README.md",
                  type: "file" as const,
                },
              ]
            : [{ name: "main.ts", path: "src/main.ts", type: "file" as const }],
        truncated: false,
      })),
      readWorkspaceFile: vi.fn(async (_workspaceId: string, path: string) => ({
        path,
        content: path === "src/main.ts" ? "export {};\n" : "# Weave\n",
        contentHash: "0".repeat(64),
        size: 11,
      })),
      watchWorkspaceFiles: vi.fn(
        async (
          _workspaceId: string,
          paths: string[],
          listener: typeof onWatchEvent,
        ) => {
          onWatchEvent = listener;
          return { subscriptionId: "watch-1", paths, ...watch };
        },
      ),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const createClient = vi.fn(() => client);
    const { result } = renderHook(() => useLiveAlphaController(createClient));

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      result.current.actions.selectThread("host-1:thread-1"),
    );
    expect(result.current.model.workspaceFiles).toMatchObject({
      workspaceId: "weave",
      workspaceName: "Weave",
      directories: {
        "": { entries: [{ path: "src" }, { path: "README.md" }] },
      },
    });
    expect(client.watchWorkspaceFiles).toHaveBeenCalledWith(
      "weave",
      [""],
      expect.any(Function),
    );

    await act(async () => result.current.actions.openWorkspaceDirectory("src"));
    expect(
      result.current.model.workspaceFiles?.directories.src?.entries,
    ).toEqual([
      {
        name: "main.ts",
        path: "src/main.ts",
        type: "file",
      },
    ]);
    expect(
      result.current.model.workspaceFiles?.directories[""]?.entries,
    ).toHaveLength(2);
    expect(watch.update).not.toHaveBeenCalled();
    await act(async () => result.current.actions.openWorkspaceDirectory("src"));
    expect(client.listWorkspaceFiles).toHaveBeenCalledTimes(2);
    await act(async () =>
      result.current.actions.openWorkspaceFile("src/main.ts"),
    );
    expect(result.current.model.workspaceFiles?.openFiles[0]).toMatchObject({
      kind: "text",
      path: "src/main.ts",
      content: "export {};\n",
    });
    await act(async () =>
      result.current.actions.openWorkspaceFile("README.md"),
    );
    expect(
      result.current.model.workspaceFiles?.openFiles.map((file) => file.path),
    ).toEqual(["src/main.ts", "README.md"]);
    expect(result.current.model.workspaceFiles?.activeFilePath).toBe(
      "README.md",
    );
    act(() => result.current.actions.activateWorkspaceFile("src/main.ts"));
    expect(result.current.model.workspaceFiles?.activeFilePath).toBe(
      "src/main.ts",
    );
    await act(async () =>
      result.current.actions.openWorkspaceFile("README.md"),
    );
    expect(client.readWorkspaceFile).toHaveBeenCalledTimes(2);
    act(() => result.current.actions.closeWorkspaceFile("README.md"));
    expect(result.current.model.workspaceFiles?.activeFilePath).toBe(
      "src/main.ts",
    );

    await act(async () => {
      onWatchEvent?.({
        kind: "modify",
        paths: ["src/main.ts"],
        affectedDirectories: ["src"],
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.model.workspaceFiles?.openFiles[0]).toMatchObject({
      kind: "text",
      path: "src/main.ts",
      content: "export {};\n",
      changed: true,
    });

    await act(async () => result.current.actions.reloadWorkspaceFile());
    expect(result.current.model.workspaceFiles?.openFiles[0]).toMatchObject({
      changed: false,
    });
    expect(result.current.model.selectedThreadId).toBe("host-1:thread-1");
  });

  it("turns binary and oversized read errors into preview-unavailable state", async () => {
    const client = {
      snapshot: vi.fn(async () => snapshot),
      attach: vi.fn(async () => snapshot.threads[0]),
      listWorkspaceFiles: vi.fn(async () => ({
        path: "",
        entries: [],
        truncated: false,
      })),
      readWorkspaceFile: vi.fn(async () => {
        throw new PortalRpcError(
          -32010,
          "Only UTF-8 text files are supported.",
          {
            domain: "workspace-filesystem",
            code: "UNSUPPORTED_CONTENT",
            path: "image.bin",
          },
        );
      }),
      watchWorkspaceFiles: vi.fn(
        async (_workspaceId: string, paths: string[]) => ({
          subscriptionId: "watch-1",
          paths,
          update: vi.fn(async (nextPaths: string[]) => nextPaths),
          close: vi.fn(async () => undefined),
        }),
      ),
      close: vi.fn(),
    } as unknown as DirectHostClient;
    const { result } = renderHook(() =>
      useLiveAlphaController(vi.fn(() => client)),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () =>
      result.current.actions.selectThread("host-1:thread-1"),
    );
    await act(async () =>
      result.current.actions.openWorkspaceFile("image.bin"),
    );

    expect(result.current.model.workspaceFiles?.openFiles).toEqual([
      {
        kind: "unavailable",
        path: "image.bin",
        reason: "unsupported",
      },
    ]);
    expect(result.current.model.workspaceFiles?.activeFilePath).toBe(
      "image.bin",
    );
    expect(result.current.model.error).toBeUndefined();
  });
});
