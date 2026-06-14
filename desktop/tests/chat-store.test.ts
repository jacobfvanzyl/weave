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
          reasoningEffort: 'low',
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
      reasoningEffort: 'low',
      followWrites: false,
      showToolCalls: false,
      showReasoning: false,
      showPlanPanel: false,
      toolActivityCollapsed: { 'message-1:0': true },
    });
  });
});
