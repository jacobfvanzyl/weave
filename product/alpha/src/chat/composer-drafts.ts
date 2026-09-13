export type ComposerDraft = {
  revision: number;
  text: string;
};

export const composerDrafts = new Map<string, ComposerDraft>();
export const composerDraftListeners = new Map<string, Set<(draft: ComposerDraft) => void>>();

export const writeComposerDraft = (sessionId: string, draft: ComposerDraft) => {
  composerDrafts.set(sessionId, draft);
  composerDraftListeners.get(sessionId)?.forEach((listener) => listener(draft));
};

export function moveComposerDraft(from: string, to: string) {
  const draft = composerDrafts.get(from);
  if (draft) writeComposerDraft(to, draft);
  composerDrafts.delete(from);
}
