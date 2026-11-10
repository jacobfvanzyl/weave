import type { ThreadSummary } from '@/app/app-controller';

/** A notification the Mac shows for a thread. */
export type Notice = { key: string; title: string; body: string };

const named = (thread: ThreadSummary) => thread.title || `${thread.agentName} in ${thread.cwd.split('/').filter(Boolean).at(-1) ?? thread.cwd}`;

/**
 * What changed in the threads that the person should hear while the app isn't in front: a thread
 * that started waiting on them, as for a permission or a question, and a turn that ended. A thread
 * seen for the first time says nothing, so neither does the app's first listing, nor a Host that
 * connects again.
 */
export function noticesFor(before: readonly ThreadSummary[], after: readonly ThreadSummary[]): Notice[] {
  const previous = new Map(before.map((thread) => [thread.key, thread]));
  const notices: Notice[] = [];
  for (const thread of after) {
    const was = previous.get(thread.key);
    if (!was || was.activity === thread.activity) continue;
    if (thread.activity === 'waiting') {
      notices.push({ key: thread.key, title: named(thread), body: thread.waitingOn ? `Waiting on you: ${thread.waitingOn}` : 'Waiting on you.' });
    } else if (was.activity === 'running' && thread.activity === 'idle') {
      notices.push({ key: thread.key, title: named(thread), body: `${thread.agentName} finished its turn.` });
    }
  }
  return notices;
}

/** `weave://thread/<host>/<thread>`: a link that opens a thread, as its key. */
export function threadLink(link: string): string | undefined {
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== 'weave:' || parsed.host !== 'thread') return undefined;
    const [hostId, threadId, ...rest] = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    return hostId && threadId && rest.length === 0 ? `${hostId}/${threadId}` : undefined;
  } catch {
    return undefined;
  }
}
