import type { PairedHost, ThreadGit, ThreadSummary } from './app-controller';
import { directoryName } from '@/lib/display-path';

/** The threads one Host runs in one directory, or in one git repository's worktrees. */
export type DirectoryGroup = {
  key: string;
  hostId: string;
  /** The directory, or the repository's primary worktree: where its new threads start. */
  cwd: string;
  /** The directory's name, or the repository's. */
  name: string;
  /** Its threads, the most recently active first; a repository's across its worktrees. */
  threads: ThreadSummary[];
};

/** A paired Host and its directories and repositories that have threads shown. */
export type HostGroup = {
  host: PairedHost;
  /** The most recently active first. */
  directories: DirectoryGroup[];
};

export type ThreadListView = {
  /** In pairing order; a Host with nothing shown only while the list isn't filtered. */
  hosts: HostGroup[];
};

const recency = (thread: ThreadSummary) => thread.lastActivityAt ?? 0;
const newestFirst = (left: ThreadSummary, right: ThreadSummary) => recency(right) - recency(left);

const matches = (thread: ThreadSummary, query: string) =>
  [thread.title ?? '', thread.cwd, thread.agentName, thread.git?.branch ?? '', thread.git?.repo ?? ''].some((value) =>
    value.toLocaleLowerCase().includes(query));

/** Where a thread runs inside its worktree, when that isn't the worktree's top directory: `tui` for `…/weave/tui`. */
export function subdirectory(thread: ThreadSummary): string | undefined {
  const { git, cwd } = thread;
  if (!git || cwd === git.worktree || !cwd.startsWith(`${git.worktree}/`)) return undefined;
  return cwd.slice(git.worktree.length + 1);
}

/** The deepest worktree `cwd` is in, among those `known` (by path). */
const within = (known: ReadonlyMap<string, ThreadGit>, cwd: string) => {
  let found: ThreadGit | undefined;
  for (const [path, git] of known) {
    if ((cwd === path || cwd.startsWith(`${path}/`)) && path.length > (found?.worktree.length ?? -1)) found = git;
  }
  return found;
};

/**
 * Each thread with where in a repository it is: its own `git`, or for a thread from a journal
 * written before the Host recorded one, the worktree another of the Host's threads places its
 * directory in.
 */
function located(threads: readonly ThreadSummary[]): ThreadSummary[] {
  const worktrees = new Map<string, Map<string, ThreadGit>>();
  for (const { hostId, git } of [...threads].sort(newestFirst)) {
    if (!git) continue;
    const known = worktrees.get(hostId) ?? new Map<string, ThreadGit>();
    if (!known.has(git.worktree)) known.set(git.worktree, { repo: git.repo, worktree: git.worktree, ...(git.branch ? { branch: git.branch } : {}) });
    worktrees.set(hostId, known);
  }
  return threads.map((thread) => {
    if (thread.git) return thread;
    const git = within(worktrees.get(thread.hostId) ?? new Map(), thread.cwd);
    return git ? { ...thread, git } : thread;
  });
}

/**
 * The thread list: closed threads only when asked for, one group per Host in pairing order,
 * then one per directory, the most recently active first. Threads in a git repository group by
 * repository, across its worktrees; a repository's place is its latest activity in any of them.
 */
export function threadListView(
  threads: readonly ThreadSummary[],
  hosts: readonly PairedHost[],
  options: { query?: string; showClosed?: boolean } = {},
): ThreadListView {
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  const shown = located(threads).filter((thread) =>
    (options.showClosed || thread.state !== 'closed') && (!query || matches(thread, query)));
  const groups = new Map<string, DirectoryGroup>();
  for (const thread of [...shown].sort(newestFirst)) {
    const { git } = thread;
    const cwd = git?.repo ?? thread.cwd;
    // A repository and a directory outside one never share a group, even at one path.
    const key = `${thread.hostId}\u0000${git ? 'repo' : 'dir'}\u0000${cwd}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, hostId: thread.hostId, cwd, name: directoryName(cwd), threads: [] };
      groups.set(key, group);
    }
    group.threads.push(thread);
  }
  // Threads were added newest first, so groups already follow their latest activity.
  const directories = [...groups.values()];
  return {
    hosts: hosts
      .map((host) => ({ host, directories: directories.filter(({ hostId }) => hostId === host.id) }))
      .filter(({ directories: shownHere }) => !query || shownHere.length > 0),
  };
}

/** How many threads other than `except` wait on the person. */
export const waitingCount = (threads: readonly ThreadSummary[], except?: string) =>
  threads.filter(({ key, activity }) => activity === 'waiting' && key !== except).length;

/** The directories a Host's threads use, most recently active first, for new threads. */
export const knownDirectories = (threads: readonly ThreadSummary[], hostId: string) =>
  [...new Set([...threads].filter((thread) => thread.hostId === hostId).sort(newestFirst).map(({ cwd }) => cwd))];
