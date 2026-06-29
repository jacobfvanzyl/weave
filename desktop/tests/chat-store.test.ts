import { afterEach, describe, expect, it, vi } from 'vitest';

const createStorage = (): Storage => {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
};

const loadFreshChatStore = async (seed?: (storage: Storage) => void) => {
  vi.resetModules();
  const storage = createStorage();
  seed?.(storage);
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', {
    localStorage: storage,
    location: { protocol: 'http:', hostname: 'localhost' },
  });
  return import('../../packages/client/src/stores/chat-store');
};

describe('chat store', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('defaults follow writes off and persists setting updates', async () => {
    const { useChatStore } = await loadFreshChatStore();

    expect(useChatStore.getState().followWrites).toBe(false);
    useChatStore.getState().setFollowWrites(true);
    expect(useChatStore.getState().followWrites).toBe(true);
  });

  it('migrates persisted chat settings with follow writes defaulting off', async () => {
    const { useChatStore } = await loadFreshChatStore(storage => {
      storage.setItem('weave-chat', JSON.stringify({
        state: {
          selectedModel: 'openai/test',
          reasoningEffort: 'xhigh',
          serviceTier: 'fast',
          showToolCalls: false,
          showReasoning: false,
          showPlanPanel: false,
          toolActivityCollapsed: { 'message-1:0': true },
        },
        version: 11,
      }));
    });

    expect(useChatStore.getState()).toMatchObject({
      selectedModel: 'openai/test',
      reasoningEffort: 'xhigh',
      serviceTier: 'priority',
      followWrites: false,
      showToolCalls: false,
      showReasoning: false,
      showPlanPanel: false,
      toolActivityCollapsed: { 'message-1:0': true },
    });
  });

  it('migrates legacy persisted reasoning aliases to the fastest current effort', async () => {
    for (const reasoningEffort of ['off', 'minimal']) {
      const { useChatStore } = await loadFreshChatStore(storage => {
        storage.setItem('weave-chat', JSON.stringify({
          state: {
            selectedModel: 'openai/gpt-5.5',
            reasoningEffort,
          },
          version: 11,
        }));
      });

      expect(useChatStore.getState().reasoningEffort).toBe('low');
    }
  });

  it('queues and consumes proposal implementation requests without persisting them', async () => {
    const { useChatStore } = await loadFreshChatStore();
    const request = useChatStore.getState().enqueueProposalImplementationRequest('thread-1', {
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1', 'item-2'],
      requestedAt: '2026-06-28T12:00:00.000Z',
    });

    expect(request).toMatchObject({
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1', 'item-2'],
      requestedAt: '2026-06-28T12:00:00.000Z',
    });
    expect(useChatStore.getState().pendingProposalImplementationRequests['thread-1']).toEqual(request);
    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(true);

    useChatStore.getState().consumeProposalImplementationRequest('thread-1', 'wrong-id');
    expect(useChatStore.getState().pendingProposalImplementationRequests['thread-1']).toEqual(request);

    useChatStore.getState().consumeProposalImplementationRequest('thread-1', request.id);
    expect(useChatStore.getState().pendingProposalImplementationRequests['thread-1']).toBeUndefined();
  });

  it('collapses the guided card when implementation is queued', async () => {
    const { useChatStore } = await loadFreshChatStore();
    useChatStore.getState().setGuidedTaskExpanded('thread-1', true);

    useChatStore.getState().enqueueProposalImplementationRequest('thread-1', {
      proposalPath: '.agents/proposals/demo.md',
      approvedItemIds: ['item-1'],
      mode: 'implement',
    });

    expect(useChatStore.getState().guidedTaskExpandedByThread['thread-1']).toBe(false);
  });
});
