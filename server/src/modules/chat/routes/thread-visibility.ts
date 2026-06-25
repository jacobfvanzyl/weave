const hiddenThreadPrefixes = ['__project__', '__plane__', '__portal__', '__portal_settings__'];

export const isHiddenThread = (thread: { id: string; metadata?: unknown }) => {
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  return hiddenThreadPrefixes.some(prefix => thread.id.startsWith(prefix))
    || metadata?.kind === 'project'
    || metadata?.kind === 'plane'
    || metadata?.kind === 'portal-token'
    || metadata?.kind === 'portal-settings';
};
