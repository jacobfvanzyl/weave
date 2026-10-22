export type ComposerDraft = {
  revision: number;
  text: string;
};

const STORAGE_KEY = 'weave.composerDrafts';

/**
 * Drafts by session, kept in the web view's storage too: iOS may discard the web view while the
 * app is in the background, and the draft should be there when it comes back.
 */
function storedDrafts(): Map<string, ComposerDraft> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return new Map();
    return new Map(Object.entries(parsed).flatMap(([key, text]) => typeof text === 'string' ? [[key, { revision: 0, text }]] : []));
  } catch {
    return new Map();
  }
}

function store() {
  try {
    const texts = Object.fromEntries([...composerDrafts].flatMap(([key, { text }]) => text ? [[key, text]] : []));
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(texts));
  } catch {
    // Full or unavailable: the draft is kept in memory still.
  }
}

export const composerDrafts = storedDrafts();
export const composerDraftListeners = new Map<string, Set<(draft: ComposerDraft) => void>>();

export const writeComposerDraft = (sessionId: string, draft: ComposerDraft) => {
  composerDrafts.set(sessionId, draft);
  store();
  composerDraftListeners.get(sessionId)?.forEach((listener) => listener(draft));
};

export function discardComposerDraft(sessionId: string) {
  composerDrafts.delete(sessionId);
  store();
}

export function moveComposerDraft(from: string, to: string) {
  const draft = composerDrafts.get(from);
  if (draft) writeComposerDraft(to, draft);
  discardComposerDraft(from);
}
