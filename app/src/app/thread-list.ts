import type { ThreadSummary } from './app-controller';

// What the app works out from the threads the Hosts list. How they group is the Sessions'
// (`src/session/sessions.ts`, WVE-203): the list that grouped threads by repository went with it.

const recency = (thread: ThreadSummary) => thread.lastActivityAt ?? 0;
const newestFirst = (left: ThreadSummary, right: ThreadSummary) => recency(right) - recency(left);

/** Where a thread runs inside its worktree, when that isn't the worktree's top directory: `tui` for `…/weave/tui`. */
export function subdirectory(thread: ThreadSummary): string | undefined {
  const { git, cwd } = thread;
  if (!git || cwd === git.worktree || !cwd.startsWith(`${git.worktree}/`)) return undefined;
  return cwd.slice(git.worktree.length + 1);
}

/** How many threads other than `except` wait on the person. */
export const waitingCount = (threads: readonly ThreadSummary[], except?: string) =>
  threads.filter(({ key, activity }) => activity === 'waiting' && key !== except).length;

/** The directories a Host's threads use, most recently active first, for new threads. */
export const knownDirectories = (threads: readonly ThreadSummary[], hostId: string) =>
  [...new Set([...threads].filter((thread) => thread.hostId === hostId).sort(newestFirst).map(({ cwd }) => cwd))];
