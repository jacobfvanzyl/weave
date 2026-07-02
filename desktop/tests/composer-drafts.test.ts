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

const loadFreshComposerDrafts = async () => {
  vi.resetModules();
  const storage = createStorage();
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', { localStorage: storage });
  return import('../../packages/client/src/lib/composer-drafts');
};

describe('composer drafts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('stores composer drafts by thread id', async () => {
    const { loadComposerDraft, saveComposerDraft } = await loadFreshComposerDrafts();

    saveComposerDraft('thread-1', 'first draft');
    saveComposerDraft('thread-2', 'second draft');

    expect(loadComposerDraft('thread-1')).toBe('first draft');
    expect(loadComposerDraft('thread-2')).toBe('second draft');
  });

  it('clears empty drafts when no send is pending', async () => {
    const { loadComposerDraft, saveComposerDraft } = await loadFreshComposerDrafts();

    saveComposerDraft('thread-1', 'draft');
    saveComposerDraft('thread-1', '');

    expect(loadComposerDraft('thread-1')).toBe('');
  });

  it('keeps a submitted draft until the server acknowledges it', async () => {
    const { confirmComposerDraftReceived, loadComposerDraft, markComposerDraftAwaitingServerAck, saveComposerDraft } =
      await loadFreshComposerDrafts();

    markComposerDraftAwaitingServerAck('thread-1', 'send me');
    saveComposerDraft('thread-1', '');

    expect(loadComposerDraft('thread-1')).toBe('send me');

    confirmComposerDraftReceived('thread-1');

    expect(loadComposerDraft('thread-1')).toBe('');
  });

  it('does not clear a newer steering draft when an older send is acknowledged', async () => {
    const { confirmComposerDraftReceived, loadComposerDraft, markComposerDraftAwaitingServerAck, saveComposerDraft } =
      await loadFreshComposerDrafts();

    markComposerDraftAwaitingServerAck('thread-1', 'sent draft');
    saveComposerDraft('thread-1', 'next steering draft');
    confirmComposerDraftReceived('thread-1');

    expect(loadComposerDraft('thread-1')).toBe('next steering draft');
  });

  it('abandons pending acknowledgement without clearing the saved draft', async () => {
    const { abandonComposerDraftServerAck, loadComposerDraft, markComposerDraftAwaitingServerAck, saveComposerDraft } =
      await loadFreshComposerDrafts();

    markComposerDraftAwaitingServerAck('thread-1', 'send me');
    abandonComposerDraftServerAck('thread-1');

    expect(loadComposerDraft('thread-1')).toBe('send me');

    saveComposerDraft('thread-1', '');

    expect(loadComposerDraft('thread-1')).toBe('');
  });
});
