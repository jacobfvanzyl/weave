import type { PairedHost, SessionGit, SessionSummary } from './app-controller';
import { directoryName } from '@/lib/display-path';

/** The sessions one Host runs in one worktree of a git repository. */
export type WorktreeGroup = {
  key: string;
  /** The worktree's top directory: where its new sessions start. */
  cwd: string;
  /** As its latest session last saw it; none when its HEAD is detached. */
  branch?: string;
  /** The repository's own checkout, which can't be removed. */
  primary: boolean;
  sessions: SessionSummary[];
};

/** The sessions one Host runs in one directory, or in one git repository's worktrees. */
export type DirectoryGroup = {
  key: string;
  hostId: string;
  /** Set only when more than one Host is paired. */
  hostName?: string;
  /** The directory, or the repository's primary worktree: where its new sessions start. */
  cwd: string;
  /** The directory's name, or the repository's. */
  name: string;
  /** Its sessions; a repository's across its worktrees. */
  sessions: SessionSummary[];
  /** A repository's worktrees that have sessions, the most recently active first; none for a directory outside one. */
  worktrees?: WorktreeGroup[];
};

export type SessionListView = {
  /** Sessions waiting on the person, across Hosts and directories. */
  needsYou: SessionSummary[];
  groups: DirectoryGroup[];
};

const recency = (session: SessionSummary) => session.lastActivityAt ?? 0;
const newestFirst = (left: SessionSummary, right: SessionSummary) => recency(right) - recency(left);

const matches = (session: SessionSummary, query: string) =>
  [session.title ?? '', session.cwd, session.agentName, session.git?.branch ?? '', session.git?.repo ?? ''].some((value) =>
    value.toLocaleLowerCase().includes(query));

/** Where a session runs inside its worktree, when that isn't the worktree's top directory: `tui` for `…/weave/tui`. */
export function subdirectory(session: SessionSummary): string | undefined {
  const { git, cwd } = session;
  if (!git || cwd === git.worktree || !cwd.startsWith(`${git.worktree}/`)) return undefined;
  return cwd.slice(git.worktree.length + 1);
}

/** The deepest worktree `cwd` is in, among those `known` (by path). */
const within = (known: ReadonlyMap<string, SessionGit>, cwd: string) => {
  let found: SessionGit | undefined;
  for (const [path, git] of known) {
    if ((cwd === path || cwd.startsWith(`${path}/`)) && path.length > (found?.worktree.length ?? -1)) found = git;
  }
  return found;
};

/**
 * Each session with where in a repository it is: its own `git`, or for a session from a journal
 * written before the Host recorded one, the worktree another of the Host's sessions places its
 * directory in.
 */
function located(sessions: readonly SessionSummary[]): SessionSummary[] {
  const worktrees = new Map<string, Map<string, SessionGit>>();
  for (const { hostId, git } of [...sessions].sort(newestFirst)) {
    if (!git) continue;
    const known = worktrees.get(hostId) ?? new Map<string, SessionGit>();
    if (!known.has(git.worktree)) known.set(git.worktree, { repo: git.repo, worktree: git.worktree, ...(git.branch ? { branch: git.branch } : {}) });
    worktrees.set(hostId, known);
  }
  return sessions.map((session) => {
    if (session.git) return session;
    const git = within(worktrees.get(session.hostId) ?? new Map(), session.cwd);
    return git ? { ...session, git } : session;
  });
}

/**
 * The session list: closed sessions only when asked for, "Needs you" on top, then one group per
 * Host and directory, the most recently active first. Sessions in a git repository group by
 * repository, then by worktree under it, each named for its branch; a repository's place is its
 * latest activity in any worktree.
 */
export function sessionListView(
  sessions: readonly SessionSummary[],
  hosts: readonly PairedHost[],
  options: { query?: string; showClosed?: boolean } = {},
): SessionListView {
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  const shown = located(sessions).filter((session) =>
    (options.showClosed || session.state !== 'closed') && (!query || matches(session, query)));
  const named = hosts.length > 1;
  const groups = new Map<string, DirectoryGroup>();
  for (const session of [...shown].sort(newestFirst)) {
    const { git } = session;
    const cwd = git?.repo ?? session.cwd;
    // A repository and a directory outside one never share a group, even at one path.
    const key = `${session.hostId}\u0000${git ? 'repo' : 'dir'}\u0000${cwd}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        hostId: session.hostId,
        hostName: named ? hosts.find(({ id }) => id === session.hostId)?.name : undefined,
        cwd,
        name: directoryName(cwd),
        sessions: [],
        ...(git ? { worktrees: [] } : {}),
      };
      groups.set(key, group);
    }
    group.sessions.push(session);
    if (git && group.worktrees) {
      let worktree = group.worktrees.find(({ cwd: path }) => path === git.worktree);
      if (!worktree) {
        worktree = {
          key: `${key}\u0000${git.worktree}`,
          cwd: git.worktree,
          ...(git.branch ? { branch: git.branch } : {}),
          primary: git.worktree === git.repo,
          sessions: [],
        };
        group.worktrees.push(worktree);
      }
      worktree.sessions.push(session);
    }
  }
  return {
    needsYou: shown.filter(({ activity }) => activity === 'waiting').sort(newestFirst),
    // Sessions were added newest first, so groups and worktrees already follow their latest activity.
    groups: [...groups.values()],
  };
}

/** How many sessions other than `except` wait on the person. */
export const waitingCount = (sessions: readonly SessionSummary[], except?: string) =>
  sessions.filter(({ key, activity }) => activity === 'waiting' && key !== except).length;

/** The directories a Host's sessions use, most recently active first, for new sessions. */
export const knownDirectories = (sessions: readonly SessionSummary[], hostId: string) =>
  [...new Set([...sessions].filter((session) => session.hostId === hostId).sort(newestFirst).map(({ cwd }) => cwd))];
