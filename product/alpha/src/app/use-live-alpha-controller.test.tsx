import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DirectHostClient,
  type HostSnapshot,
  PortalRpcError,
  PortalTransportError,
} from "@/portal-client";
import { loadPortalConnections } from "./portal-connection-storage";
import { useLiveAlphaController } from "./use-live-alpha-controller";
import { paneTargets, type WorkspaceComposition, type Workspace } from '@weave/product-protocol';

vi.mock("@capacitor/preferences", () => ({ Preferences: { get: vi.fn(async () => ({ value: null })), set: vi.fn(async () => undefined) } }));

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
  capabilities: ["context.add"],
  executionContexts: [{ executionContextId: "weave", name: "Weave" }],
  agents: [{ agentId: "codex", name: "Codex" }],
  archivedThreads: [],
  threads: [
    {
      threadId: "thread-1",
      agentId: "codex",
      executionContextId: "weave",
      workspaceId: 'workspace', membershipRevision: 0, acpSessionId: "session-1",
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
  it('consumes focused completions at the event and preserves unread completions until focused', async () => {
    let emit!: ConstructorParameters<typeof DirectHostClient>[2];
    const client = { snapshot: vi.fn(async () => snapshot), close: vi.fn() } as unknown as DirectHostClient;
    const { result } = renderHook(() => useLiveAlphaController((_url, _signer, onEvent) => { emit = onEvent; return client; }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const unread = () => result.current.model.threads?.find((thread) => thread.id === 'host-1:thread-1')?.completionUnread;
    act(() => result.current.actions.setFocusedAgentThread?.('host-1:thread-1'));
    act(() => { emit({ type: 'turn/started' }, 'thread-1'); emit({ type: 'turn/stopped', stopReason: 'end_turn' }, 'thread-1'); });
    expect(unread()).toBe(false);
    act(() => result.current.actions.setFocusedAgentThread?.(undefined));
    expect(unread()).toBe(false);
    act(() => { emit({ type: 'turn/started' }, 'thread-1'); emit({ type: 'turn/stopped', stopReason: 'end_turn' }, 'thread-1'); });
    expect(unread()).toBe(true);
    act(() => result.current.actions.setFocusedAgentThread?.('host-1:other'));
    expect(unread()).toBe(true);
    act(() => result.current.actions.setFocusedAgentThread?.('host-1:thread-1'));
    expect(unread()).toBe(false);
  });

  it('discards a prepared draft on pane closure without deleting a persisted thread or a newer selection', async () => {
    const prepared = { ...snapshot.threads[0], threadId: 'draft-closed' };
    const client = { snapshot: vi.fn(async () => ({ ...snapshot, capabilities: ['thread.draft'] })), close: vi.fn(),
      createThreadDraft: vi.fn(async () => prepared), attach: vi.fn(async () => prepared), discardThreadDraft: vi.fn(async () => undefined) } as unknown as DirectHostClient;
    const { result } = renderHook(() => useLiveAlphaController(() => client));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => result.current.actions.createThread('host-1:weave', undefined, 'workspace'));
    await act(async () => result.current.actions.discardThreadDraft?.('host-1:thread-1'));
    expect(client.discardThreadDraft).not.toHaveBeenCalled();
    await act(async () => result.current.actions.discardThreadDraft?.('host-1:draft-closed'));
    expect(client.discardThreadDraft).toHaveBeenCalledExactlyOnceWith('draft-closed');
    expect(result.current.model.threads?.map((thread) => thread.id)).toEqual(['host-1:thread-1']);
    expect(result.current.model.selectedThreadId).toBeUndefined();
    await act(async () => result.current.actions.selectThread('host-1:thread-1'));
    await act(async () => result.current.actions.discardThreadDraft?.('host-1:draft-closed'));
    expect(result.current.model.selectedThreadId).toBe('host-1:thread-1');
  });

  it("recovers automatically when a Host stays offline beyond the immediate reconnect", async () => {
    vi.useFakeTimers();
    let disconnected: ((error: Error) => void) | undefined;
    const ready = { snapshot: vi.fn(async () => snapshot), close: vi.fn() };
    const offline = { snapshot: vi.fn(async () => { throw new PortalTransportError('Host WebSocket closed (1006).', 1006); }), close: vi.fn() };
    let attempts = 0;
    const factory = vi.fn((_url, _signer, _events, onClose) => {
      disconnected = onClose;
      return ([2, 4].includes(++attempts) ? offline : ready) as unknown as DirectHostClient;
    });
    const { result, unmount } = renderHook(() => useLiveAlphaController(factory));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.model.connections[0]?.status).toBe('connected');
    await act(async () => disconnected?.(new PortalTransportError('Host restarted.', 1006)));
    expect(result.current.model.connections[0]?.status).toBe('disconnected');
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(result.current.model.connections[0]?.status).toBe('connected');
    expect(factory).toHaveBeenCalledTimes(3);
    await act(async () => disconnected?.(new PortalTransportError('Host restarted again.', 1006)));
    expect(result.current.model.connections[0]?.status).toBe('disconnected');
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(factory).toHaveBeenCalledTimes(4);
  });

  it("removes the selected Host placement and refreshes only that Portal", async () => {
    const removableSnapshot: HostSnapshot = {
      ...snapshot,
      capabilities: ["context.add", "context.remove"],
    };
    const removedSnapshot: HostSnapshot = {
      ...removableSnapshot,
      executionContexts: [],
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
    const workspace = result.current.model.executionContexts[0]!;
    const placement = workspace.placements?.[0];

    await act(async () =>
      result.current.actions.removeExecutionContext?.(workspace.id, placement?.id),
    );

    expect(client.removeWorkspace).toHaveBeenCalledWith("weave");
    expect(client.snapshot).toHaveBeenCalledTimes(2);
    expect(result.current.model.executionContexts).toEqual([]);
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
        async (_executionContextId: string, paths: string[]) => ({
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
    expect(result.current.model.threads?.[0]).toMatchObject({
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
    expect(result.current.model.threads?.[0]).toMatchObject({
      title: "",
      updatedAt: "2026-08-28T06:05:00.000Z",
    });
    expect(client.snapshot).toHaveBeenCalledOnce();
  });

  it("optimistically selects and clears a switching Thread until attachment finishes without subscribing to files", async () => {
    const secondThread = {
      ...snapshot.threads[0],
      threadId: "thread-2",
      workspaceId: 'workspace', membershipRevision: 0, acpSessionId: "session-2",
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
        async (_executionContextId: string, paths: string[]) => ({
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
    expect(result.current.model.workspaceFiles).toBeUndefined();
    expect(client.listWorkspaceFiles).not.toHaveBeenCalled();
    expect(client.watchWorkspaceFiles).not.toHaveBeenCalled();

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
    act(() => onEvent?.({ type: "turn/failed", error: "Late failure from first Thread" }, "thread-1"));
    expect(result.current.model.transcript?.turn.status).toBe("idle");
    await act(async () => result.current.actions.selectThread("host-1:thread-1"));
    expect(result.current.model.transcript?.turn).toEqual({ status: "failed", error: "Late failure from first Thread" });
    expect(result.current.model.workspaceFiles).toBeUndefined();
    expect(client.listWorkspaceFiles).not.toHaveBeenCalled();
    expect(client.watchWorkspaceFiles).not.toHaveBeenCalled();
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
      executionContexts: [
        ...snapshot.executionContexts.map((workspace) => ({
          ...workspace,
          repositoryIdentity,
          canonicalPath: "/code/weave",
        })),
        { executionContextId: "scratch", name: "Scratch" },
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
          async (_executionContextId: string, paths: string[]) => ({
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
    expect(result.current.model.executionContexts.map(({ id }) => id)).toEqual([
      "host-1:scratch",
      "host-1:weave",
      "host-2:scratch",
      "host-2:weave",
    ]);
    expect(result.current.model.executionContexts[0].placements).toHaveLength(1);
    expect(
      result.current.model.executionContexts
        .slice(1)
        .map(({ placements }) => placements?.length),
    ).toEqual([1, 1, 1]);
    expect(
      result.current.model.executionContexts
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
      result.current.model.executionContexts.flatMap(({ threads }) => threads),
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
        "host-1:weave",
        "host-1:weave",
        "workspace",
      ),
    );
    expect(host2.createThread).not.toHaveBeenCalled();
    expect(host1.createThread).not.toHaveBeenCalled();
    expect(result.current.model.threads?.[0]).toMatchObject({
      draft: true,
      hostId: "host-1",
      title: "New thread",
    });

    await act(async () => result.current.actions.reconnectHost("host-1"));
    expect(
      result.current.model.connections.find(({ hostId }) => hostId === "host-1")
        ?.status,
    ).toBe("connected");
    expect(result.current.model.executionContexts).toHaveLength(4);
  });

  it("registers a project through the chosen connected Portal and refreshes only that Host", async () => {
    const client = {
      snapshot: vi.fn(async () => snapshot),
      addWorkspace: vi.fn(async () => ({
        executionContextId: "odin",
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
      result.current.actions.addExecutionContext?.({
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
      workspaceId: 'workspace', membershipRevision: 0, acpSessionId: "session-created",
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
        async (_executionContextId: string, paths: string[]) => ({
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
    const executionContextId = result.current.model.executionContexts[0]!.id;

    await act(async () => {
      await result.current.actions.createThread(executionContextId, undefined, 'workspace');
    });

    const draftId = result.current.model.selectedThreadId;
    const firstFocusRequest = result.current.model.composerFocusRequest;
    expect(result.current.model.composerFocusThreadId).toBe(draftId);
    expect(client.createThread).not.toHaveBeenCalled();
    expect(result.current.model.threads?.[0]).toMatchObject({
      id: draftId,
      draft: true,
      title: "New thread",
    });
    expect(result.current.model.transcript?.entries).toEqual([]);

    await act(async () => {
      await result.current.actions.createThread(executionContextId, undefined, 'workspace');
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
    expect(result.current.model.creatingThreadExecutionContextId).toBe(executionContextId);

    await act(async () => {
      resolveCreate();
      await Promise.all([firstSend, duplicateSend]);
    });
    expect(client.createThread).toHaveBeenCalledOnce();
    expect(client.createThread).toHaveBeenCalledWith("weave", "codex", undefined, "workspace");
    expect(client.prompt).toHaveBeenCalledOnce();
    expect(client.prompt).toHaveBeenCalledWith([
      { type: "text", text: "Start the work" },
    ]);
    expect(result.current.model.creatingThreadExecutionContextId).toBeUndefined();
    expect(result.current.model.selectedThreadId).toBe("host-1:thread-created");
    expect(
      result.current.model.executionContexts[0]?.threads.some(({ draft }) => draft),
    ).toBe(false);
  });

  it("preflights supported drafts so config is available before the first prompt", async () => {
    const prepared = {
      ...snapshot.threads[0],
      threadId: "draft-prepared",
      workspaceId: 'workspace', membershipRevision: 0, acpSessionId: "session-prepared",
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
        async (_executionContextId: string, paths: string[]) => ({
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
    const executionContextId = result.current.model.executionContexts[0]!.id;

    await act(async () => {
      await result.current.actions.createThread(executionContextId, undefined, 'workspace');
    });

    expect(client.createThreadDraft).toHaveBeenCalledWith("weave", "codex", undefined, "workspace");
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
    expect(result.current.model.threads?.[0]?.id).toBe(
      "host-1:draft-prepared",
    );
    expect(
      result.current.model.threads?.[0]?.draft,
    ).toBeUndefined();
  });

  it.each([false, true])("honors draft retention when selecting another Thread (preserve=%s)", async (preserveDraft) => {
    const prepared = {
      ...snapshot.threads[0],
      threadId: "draft-discarded",
      workspaceId: 'workspace', membershipRevision: 0, acpSessionId: "session-discarded",
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
        async (_executionContextId: string, paths: string[]) => ({
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
    const executionContextId = result.current.model.executionContexts[0]!.id;

    await act(async () => {
      await result.current.actions.createThread(executionContextId, undefined, 'workspace');
    });
    const draftId = result.current.model.selectedThreadId;
    expect(result.current.model.threads?.[0]?.id).toBe(draftId);

    await act(async () => {
      await result.current.actions.selectThread("host-1:thread-1", { preserveDraft });
    });

    expect(client.createThread).not.toHaveBeenCalled();
    if (preserveDraft) expect(client.discardThreadDraft).not.toHaveBeenCalled();
    else expect(client.discardThreadDraft).toHaveBeenCalledWith("draft-discarded");
    expect(result.current.model.selectedThreadId).toBe("host-1:thread-1");
    expect(result.current.model.executionContexts[0]?.threads).toHaveLength(preserveDraft ? 2 : 1);
    expect(result.current.model.threads?.[0]?.id).toBe(
      preserveDraft ? draftId : "host-1:thread-1",
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
        async (_executionContextId: string, paths: string[]) => ({
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
    expect(result.current.model.executionContexts[0].threads).toEqual([]);
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
    expect(result.current.model.executionContexts[0].threads[0]).toMatchObject({
      id: "host-1:thread-1",
      status: "active",
    });
  });

  const archiveScenario = async () => {
    let current: HostSnapshot = {
      ...snapshot,
      capabilities: [...snapshot.capabilities, 'workspace.composition.get', 'workspace.composition.replace'],
      threads: ['first', 'selected', 'next', 'other'].map((threadId) => ({
        ...snapshot.threads[0]!, threadId, workspaceId: threadId === 'other' ? 'other-workspace' : 'workspace',
      })),
    };
    const archive = (threadId: string) => {
      const thread = current.threads.find((thread) => thread.threadId === threadId)!;
      const archived = { ...thread, status: 'archived' as const, archivedAt: '2026-09-11T00:00:00Z' };
      current = { ...current, threads: current.threads.filter((thread) => thread.threadId !== threadId), archivedThreads: [...current.archivedThreads, archived] };
      return archived;
    };
    const client = {
      snapshot: vi.fn(async () => current),
      attach: vi.fn(async (id: string) => current.threads.find((thread) => thread.threadId === id)),
      archiveThread: vi.fn(async (id: string) => archive(id)),
      getWorkspaceComposition: vi.fn(async () => ({ composition: {
        schemaVersion: 4, hostId: 'host-1', revision: 0,
        workspaces: ['workspace', 'other-workspace'].map((workspaceId) => ({ workspaceId, name: workspaceId, layout: null })),
      } })),
      listTerminals: vi.fn(async () => ({ terminals: [] })), close: vi.fn(),
    };
    const hook = renderHook(() => useLiveAlphaController(vi.fn(() => client as unknown as DirectHostClient)));
    await act(async () => { await Promise.resolve(); });
    act(() => hook.result.current.workspaceActions!.activate({ hostId: 'host-1', workspaceId: 'workspace' }));
    await act(async () => hook.result.current.actions.selectThread('host-1:selected'));
    return { ...hook, client, archive };
  };

  it('selects the next Thread in the active workspace and wraps after the final Thread', async () => {
    const { result, client } = await archiveScenario();
    await act(async () => result.current.actions.archiveThread('host-1:selected'));
    expect(result.current.model.selectedThreadId).toBe('host-1:next');
    expect(client.attach).toHaveBeenLastCalledWith('next');
    await act(async () => result.current.actions.archiveThread('host-1:next'));
    expect(result.current.model.selectedThreadId).toBe('host-1:first');
    await act(async () => result.current.actions.archiveThread('host-1:first'));
    expect(result.current.model.selectedThreadId).toBeUndefined();
    expect(result.current.model.threads?.map((thread) => thread.id)).toEqual(['host-1:other']);
  });

  it.each([
    { hostId: 'host-1', workspaceId: 'other-workspace' },
    { hostId: 'other-host', workspaceId: 'workspace' },
  ])('clears an archived selection when active workspace is $hostId/$workspaceId', async (workspace) => {
    const { result, client } = await archiveScenario();
    act(() => result.current.workspaceActions!.activate(workspace));
    await act(async () => result.current.actions.archiveThread('host-1:selected'));
    expect(result.current.model.selectedThreadId).toBeUndefined();
    expect(client.attach).toHaveBeenCalledTimes(1);
  });

  it('preserves selection when an unselected Thread is archived', async () => {
    const { result, client } = await archiveScenario();
    await act(async () => result.current.actions.archiveThread('host-1:first'));
    expect(result.current.model.selectedThreadId).toBe('host-1:selected');
    expect(client.attach).toHaveBeenCalledTimes(1);
  });

  it('also selects a replacement when a periodic snapshot reports the selected Thread archived', async () => {
    vi.useFakeTimers();
    const { result, archive } = await archiveScenario();
    archive('selected');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(result.current.model.selectedThreadId).toBe('host-1:next');
  });

  it.each(['workspace', 'thread'] as const)('respects a changed %s while an archive is in flight', async (navigation) => {
    const { result, client, archive } = await archiveScenario();
    let complete!: () => void;
    client.archiveThread.mockImplementationOnce((id) => new Promise((resolve) => { complete = () => resolve(archive(id)); }));
    let pending!: Promise<void> | void;
    act(() => { pending = result.current.actions.archiveThread('host-1:selected'); });
    if (navigation === 'workspace') {
      act(() => result.current.workspaceActions!.activate({ hostId: 'host-1', workspaceId: 'other-workspace' }));
    } else {
      await act(async () => result.current.actions.selectThread('host-1:other'));
    }
    await act(async () => { complete(); await pending; });
    expect(result.current.model.selectedThreadId).toBe(navigation === 'thread' ? 'host-1:other' : undefined);
    expect(client.attach).not.toHaveBeenCalledWith('next');
  });

  it('keeps the current selection if archive fails, and clears it if replacement attachment fails', async () => {
    const { result, client } = await archiveScenario();
    client.archiveThread.mockRejectedValueOnce(new Error('Archive refused'));
    await act(async () => { await expect(result.current.actions.archiveThread('host-1:selected')).rejects.toThrow('Archive refused'); });
    expect(result.current.model.selectedThreadId).toBe('host-1:selected');
    client.attach.mockRejectedValueOnce(new Error('Attachment refused'));
    await act(async () => result.current.actions.archiveThread('host-1:selected'));
    expect(result.current.model.selectedThreadId).toBeUndefined();
    expect(result.current.model.error).toBe('Attachment refused');
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
        async (_executionContextId: string, paths: string[]) => ({
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

  it("retains cached Host threads and selected conversation after a reconnect timeout", async () => {
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
        async (_executionContextId: string, paths: string[]) => ({
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
    expect(result.current.model.executionContexts[0]?.threads).toHaveLength(1);
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
    expect(result.current.model.executionContexts[0]?.threads).toHaveLength(1);
    expect(result.current.model.selectedThreadId).toBe("host-1:thread-1");
    expect(result.current.model.workspaceFiles).toBeUndefined();
    expect(result.current.model.error).toBeUndefined();
  });

});

it('releases navigation after the first prompt is accepted, while retaining its owning Thread', async () => {
  let onEvent: ConstructorParameters<typeof DirectHostClient>[2] | undefined;
  let count = 0;
  let rejectPrompt!: (cause: Error) => void;
  const prompt = new Promise<void>((_resolve, reject) => { rejectPrompt = reject; });
  const client = {
    snapshot: vi.fn(async () => ({ ...snapshot, capabilities: ['thread.draft'] })),
    createThreadDraft: vi.fn(async () => ({ ...snapshot.threads[0], threadId: `draft-${++count}`, workspaceId: 'workspace', membershipRevision: 0, acpSessionId: `session-${count}` })),
    attach: vi.fn(async (threadId: string) => {
      onEvent?.({ type: 'history/reset', sessionId: threadId }, threadId);
      return { ...snapshot.threads[0], threadId };
    }),
    prompt: vi.fn(() => prompt), close: vi.fn(), discardThreadDraft: vi.fn(),
  } as unknown as DirectHostClient;
  const { result } = renderHook(() => useLiveAlphaController((_url, _credential, events) => { onEvent = events; return client; }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const context = result.current.model.executionContexts[0]!.id;
  await act(async () => result.current.actions.createThread(context, undefined, 'workspace'));
  let sending: Promise<void> | void;
  act(() => { sending = result.current.actions.sendPrompt('Inspect this'); });
  expect(result.current.model.busy).toBe(true);
  act(() => onEvent?.({ type: 'permission/requested', requestId: 'approval', request: {
    sessionId: 'session-1', toolCall: { toolCallId: 'tool', title: 'Read', status: 'pending' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
  } }, 'draft-1'));
  expect(result.current.model.busy).toBe(false);
  await act(async () => result.current.actions.createThread(context, undefined, 'workspace'));
  expect(result.current.model.selectedThreadId).toBe('host-1:draft-2');
  await act(async () => { rejectPrompt(new Error('Old conversation transport detached')); await sending; });
  expect(result.current.model.selectedThreadId).toBe('host-1:draft-2');
  expect(result.current.model.error).toBeUndefined();
  expect(result.current.model.transcript?.turn.status).toBe('idle');
});

it('binds Agent Pane commands to their own Thread even after another Pane is selected', async () => {
  let emit!: ConstructorParameters<typeof DirectHostClient>[2];
  const first = snapshot.threads[0]!;
  const second = { ...first, threadId: 'thread-2', title: 'Second' };
  const client = { snapshot: vi.fn(async () => ({ ...snapshot, threads: [first, second] })), close: vi.fn(),
    attach: vi.fn(async () => first), prompt: vi.fn(async () => {}), cancelPrompt: vi.fn(async () => {}),
    respondToPermission: vi.fn(), respondToElicitation: vi.fn(), setMode: vi.fn(async () => {}), setConfigOption: vi.fn(async () => {}),
  } as unknown as DirectHostClient;
  const { result } = renderHook(() => useLiveAlphaController((_url, _signer, onEvent) => { emit = onEvent; return client; }));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  act(() => { emit({ type: 'history/reset', sessionId: 'same-upstream-id' }, 'thread-1'); emit({ type: 'history/reset', sessionId: 'same-upstream-id' }, 'thread-2'); });
  const firstPane = result.current.forThread!('host-1:thread-1');
  await act(async () => { await result.current.actions.selectThread('host-1:thread-2'); });
  await act(async () => { await firstPane.actions.sendPrompt('for the first pane'); await firstPane.actions.cancelPrompt(); await firstPane.actions.setMode('plan'); await firstPane.actions.setConfigOption('model', 'chosen'); });
  act(() => { firstPane.actions.respondToPermission('request', 'allow'); firstPane.actions.respondToElicitation('request', { action: 'cancel' }); });
  expect(client.prompt).toHaveBeenLastCalledWith([{ type: 'text', text: 'for the first pane' }], 'thread-1');
  expect(client.cancelPrompt).toHaveBeenLastCalledWith('thread-1');
  expect(client.setMode).toHaveBeenLastCalledWith('plan', 'thread-1');
  expect(client.setConfigOption).toHaveBeenLastCalledWith('model', 'chosen', 'thread-1');
  expect(client.respondToPermission).toHaveBeenLastCalledWith('request', 'allow', 'thread-1');
  expect(client.respondToElicitation).toHaveBeenLastCalledWith('request', { action: 'cancel' }, 'thread-1');
  expect(result.current.forThread!('host-1:thread-2').model.transcript?.entries).toHaveLength(0);
});


it.each([['agent', 'agent'], ['agent', 'terminal'], ['terminal', 'agent']] as const)('splits %s into %s beside its source using Host-owned identities', async (sourceType, type) => {
  const record = { ...snapshot.threads[0]!, workspaceId: 'work', agentId: 'source-agent' };
  let current = { ...snapshot, capabilities: [...snapshot.capabilities, 'workspace.composition.get', 'workspace.composition.replace'], threads: [record] };
  let composition: WorkspaceComposition = { schemaVersion: 4, hostId: 'host-1', revision: 1, workspaces: [{ workspaceId: 'work', name: 'Work', layout: sourceType === 'agent'
    ? { kind: 'agent', nodeId: 'source-node', paneId: 'source', threadId: record.threadId }
    : { kind: 'terminal', nodeId: 'source-node', paneId: 'source', terminalId: 'terminal', executionContextId: record.executionContextId } }] };
  const client = {
    snapshot: vi.fn(async () => current), close: vi.fn(), listTerminals: vi.fn(async () => ({ terminals: [] })),
    getWorkspaceComposition: vi.fn(async () => ({ composition })),
    createThread: vi.fn(async (context, agentId, _title, workspaceId) => {
      const thread = { ...record, threadId: 'created', executionContextId: context, agentId, workspaceId };
      current = { ...current, threads: [...current.threads, thread] };
      composition = { ...composition, revision: 2, workspaces: [{ ...composition.workspaces[0]!, layout: { kind: 'split', nodeId: 'host-insertion', axis: 'horizontal', ratio: .5, children: [composition.workspaces[0]!.layout!, { kind: 'agent', nodeId: 'created-node', paneId: 'created-pane', threadId: thread.threadId }] } }] };
      return thread;
    }),
    replaceWorkspaceComposition: vi.fn(async (_host, revision, workspaces: Workspace[]) => {
      expect(revision).toBe(composition.revision);
      composition = { ...composition, revision: revision + 1, workspaces }; return { composition };
    }),
  };
  const { result } = renderHook(() => useLiveAlphaController(() => client as unknown as DirectHostClient));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => result.current.actions.splitPane!({ hostId: 'host-1', workspaceId: 'work' }, 'source', 'vertical', type));
  const displayed = result.current.model.workspaceCompositions!.compositions['host-1']!;
  expect(displayed.workspaces[0]?.layout).toMatchObject({ kind: 'split', axis: 'vertical', children: [{ paneId: 'source' }, { kind: type }] });
  expect(paneTargets(displayed.workspaces)).toHaveLength(2);
  expect(client.createThread).not.toHaveBeenCalled();
  if (type === 'agent') {
    expect(paneTargets(composition.workspaces)).toHaveLength(1);
    expect(client.replaceWorkspaceComposition).not.toHaveBeenCalled();
    expect(result.current.model.threads?.find(thread => thread.draft)).toMatchObject({ executionContextId: record.executionContextId, draft: true, title: 'Draft' });
  }
});

function localPaneHarness() {
  let current = { ...snapshot, capabilities: ['workspace.composition.get', 'workspace.composition.replace'], threads: [{ ...snapshot.threads[0]!, workspaceId: 'work' }] };
  let composition: WorkspaceComposition = { schemaVersion: 4, hostId: 'host-1', revision: 1, workspaces: [{ workspaceId: 'work', name: 'Work', layout: { kind: 'agent', nodeId: 'source-node', paneId: 'source', threadId: 'thread-1' } }] };
  const client = {
    snapshot: vi.fn(async () => current), close: vi.fn(), listTerminals: vi.fn(async () => ({ terminals: [] })),
    getWorkspaceComposition: vi.fn(async () => ({ composition })),
    replaceWorkspaceComposition: vi.fn(async (_host, _revision, workspaces: Workspace[]) => ({ composition: composition = { ...composition, revision: composition.revision + 1, workspaces } })),
    createThreadDraft: vi.fn(), discardThreadDraft: vi.fn(), archiveThread: vi.fn(),
    createThread: vi.fn(async (_context, _agent, _title, workspaceId) => {
      const thread = { ...current.threads[0]!, threadId: `created-${current.threads.length}`, workspaceId, acpSessionId: 'created-session' };
      current = { ...current, threads: [...current.threads, thread] };
      composition = { ...composition, revision: composition.revision + 1, workspaces: [{ ...composition.workspaces[0]!, layout: { kind: 'split', nodeId: 'host-insertion', axis: 'horizontal', ratio: .5, children: [composition.workspaces[0]!.layout!, { kind: 'agent', nodeId: thread.threadId + '-node', paneId: thread.threadId + '-pane', threadId: thread.threadId }] } }] };
      return thread;
    }),
    attach: vi.fn(async () => current.threads[0]), prompt: vi.fn(async () => undefined),
  };
  const hook = renderHook(() => useLiveAlphaController(() => client as unknown as DirectHostClient));
  return { ...hook, client, composition: () => composition,
    open: async () => { await act(async () => hook.result.current.actions.splitPane!({ hostId: 'host-1', workspaceId: 'work' }, 'source', 'vertical', 'agent')); return hook.result.current.model.threads!.find(thread => thread.id === hook.result.current.model.selectedThreadId)!; },
    focusSource: () => act(() => hook.result.current.workspaceActions!.focus({ hostId: 'host-1', workspaceId: 'work' }, 'source')),
  };
}

it('keeps empty draft creation and focus disposal entirely local, including after Host refresh', async () => {
  const h = localPaneHarness();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const draft = await h.open();
  expect(draft.draft).toBe(true);
  await act(async () => h.result.current.attachThread!(draft.id));
  await act(async () => h.result.current.workspaceActions!.refresh());
  expect(h.result.current.model.selectedThreadId).toBe(draft.id);
  h.focusSource();
  expect(h.result.current.model.threads!.some(thread => thread.draft)).toBe(false);
  for (const call of [h.client.createThread, h.client.createThreadDraft, h.client.discardThreadDraft, h.client.archiveThread, h.client.attach, h.client.replaceWorkspaceComposition]) expect(call).not.toHaveBeenCalled();
});

it('retains several typed drafts across pane activation and discards only the empty one', async () => {
  const h = localPaneHarness();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const first = await h.open();
  act(() => h.result.current.actions.setDraftText!(first.id, 'Keep this text'));
  h.focusSource();
  const second = await h.open();
  act(() => h.result.current.actions.setDraftText!(second.id, 'Keep this too'));
  h.focusSource();
  const empty = await h.open();
  await act(async () => h.result.current.actions.selectThread(first.id));
  expect(h.result.current.model.selectedThreadId).toBe(first.id);
  expect(h.result.current.model.threads!.filter(thread => thread.draft).map(thread => thread.id)).toEqual([first.id, second.id]);
  expect(h.result.current.model.threads!.some(thread => thread.id === empty.id)).toBe(false);
  expect(h.client.createThread).not.toHaveBeenCalled();
  expect(h.client.attach).not.toHaveBeenCalled();
});

it('promotes once on first send, preserves split direction and sends to the exact new Thread', async () => {
  const h = localPaneHarness();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const draft = await h.open();
  await act(async () => Promise.all([h.result.current.forThread!(draft.id).actions.sendPrompt('First message'), h.result.current.forThread!(draft.id).actions.sendPrompt('Duplicate')]));
  expect(h.client.createThread).toHaveBeenCalledExactlyOnceWith('weave', 'codex', undefined, 'work');
  expect(h.client.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'First message' }], 'created-1');
  expect(h.composition().workspaces[0]!.layout).toMatchObject({ axis: 'vertical', children: [{ paneId: 'source' }, { paneId: 'created-1-pane' }] });
  expect(h.result.current.model.threads!.some(thread => thread.draft)).toBe(false);
});

it('keeps a failed creation local and retries a failed layout write without creating a second Thread', async () => {
  const h = localPaneHarness();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const draft = await h.open();
  act(() => h.result.current.actions.setDraftText!(draft.id, 'Retain me'));
  h.client.createThread.mockRejectedValueOnce(new Error('Provider unavailable'));
  await act(async () => { await expect(h.result.current.forThread!(draft.id).actions.sendPrompt('Retain me')).rejects.toThrow('Provider unavailable'); });
  expect(h.result.current.model.threads!.some(thread => thread.id === draft.id)).toBe(true);
  h.client.replaceWorkspaceComposition.mockRejectedValueOnce(new Error('Revision changed'));
  await act(async () => { await expect(h.result.current.forThread!(draft.id).actions.sendPrompt('Retain me')).rejects.toThrow('Revision changed'); });
  await act(async () => h.result.current.forThread!(draft.id).actions.sendPrompt('Retain me'));
  expect(h.client.createThread).toHaveBeenCalledTimes(2); // one rejected creation, one successful creation
  expect(h.client.prompt).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'Retain me' }], 'created-1');
});

it('does not steal focus when a first-send creation completes after activating another pane', async () => {
  const h = localPaneHarness();
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const draft = await h.open();
  const create = h.client.createThread.getMockImplementation()!;
  let release!: () => void;
  h.client.createThread.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return create(...args); });
  let sending!: Promise<void> | void;
  await act(async () => { sending = h.result.current.forThread!(draft.id).actions.sendPrompt('First message'); });
  h.focusSource();
  await act(async () => { release(); await sending; });
  expect(h.result.current.model.selectedThreadId).toBe('host-1:thread-1');
  expect(h.client.prompt).toHaveBeenCalledOnce();
});
