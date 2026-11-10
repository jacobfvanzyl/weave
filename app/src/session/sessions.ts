// The person's Sessions, as the sidebar lists them (ADR 0031, WVE-203): one for every directory
// of a Host that has a thread, a terminal or a layout its Host keeps, under the Project it's in
// (WVE-189) or else under its Host.
import {
  type AppModel,
  type HostSummary,
  type KnownSession,
  type ProjectSummary,
  type SessionSummary,
  type ThreadSummary,
  sessionKey,
} from '@/app/app-controller';

/** The last name in a path. */
export const directoryName = (path: string) => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || '/';
};

/**
 * The directory whose Session a thread is in: its worktree, or outside a repository its own
 * directory, as the Host places it (`sessions/get`).
 */
export const threadDirectory = (thread: Pick<ThreadSummary, 'cwd' | 'git'>) => thread.git?.worktree ?? thread.cwd;

/** The Session a thread is in, going by the thread alone. */
export const sessionOfThread = (thread: Pick<ThreadSummary, 'hostId' | 'cwd' | 'git'>) => sessionKey(thread.hostId, threadDirectory(thread));

/** The Session that lists the thread `key`, among `sessions`. */
export const sessionWith = (sessions: readonly SessionSummary[], key: string) => sessions.find(({ threads }) => threads.includes(key));

const recency = (thread: ThreadSummary) => thread.lastActivityAt ?? 0;

/** What places a thread in a Session: where it runs. */
type Located = Pick<ThreadSummary, 'key' | 'hostId' | 'cwd' | 'git'>;

/**
 * The directory of the Session each thread is in, by thread key. A thread is in its worktree's
 * Session, or outside a repository its own directory's, as its Host places it. Where a Host
 * lists a Session under another name for a thread's directory, as for one reached through a
 * symbolic link, every thread of that directory is in that Session.
 */
export function threadDirectories(threads: readonly Located[], known: readonly KnownSession[] = []): Map<string, string> {
  const listed = new Set(known.map(({ hostId, directory }) => sessionKey(hostId, directory)));
  // The worktrees known on each Host: a thread whose journal is from before Hosts recorded where
  // in a repository it ran is in the deepest one that holds its directory, as its Host would say.
  const worktrees = new Map<string, Set<string>>();
  const worktree = (hostId: string, path: string) => {
    const paths = worktrees.get(hostId) ?? new Set<string>();
    paths.add(path);
    worktrees.set(hostId, paths);
  };
  for (const session of known) if (session.git) worktree(session.hostId, session.directory);
  for (const thread of threads) if (thread.git) worktree(thread.hostId, thread.git.worktree);
  const own = (thread: Located) => {
    if (thread.git) return thread.git.worktree;
    let deepest: string | undefined;
    for (const path of worktrees.get(thread.hostId) ?? []) {
      if ((thread.cwd === path || thread.cwd.startsWith(`${path}/`)) && path.length > (deepest?.length ?? -1)) deepest = path;
    }
    return deepest ?? thread.cwd;
  };
  // A thread the Host placed in a Session stays there, whatever its directory reads as here,
  // and its directory's other name is that Session's for the threads the Host hasn't said of.
  const placed = new Map<string, string>();
  for (const session of known) for (const threadId of session.threads) placed.set(`${session.hostId}/${threadId}`, session.directory);
  const names = new Map<string, string>();
  for (const thread of threads) {
    const directory = placed.get(thread.key);
    const read = own(thread);
    if (directory && directory !== read && !listed.has(sessionKey(thread.hostId, read))) names.set(sessionKey(thread.hostId, read), directory);
  }
  return new Map(threads.map((thread) => {
    const read = own(thread);
    const key = sessionKey(thread.hostId, read);
    return [thread.key, listed.has(key) ? read : placed.get(thread.key) ?? names.get(key) ?? read];
  }));
}

/**
 * Every Session: those the Hosts list, and one for each directory a listed thread is in that its
 * Host hasn't made a Session of yet, as for threads from before Hosts kept Sessions. The most
 * recently active first.
 */
export function sessionSummaries(model: Pick<AppModel, 'threads' | 'known' | 'unread'>): SessionSummary[] {
  const sessions = new Map<string, SessionSummary & { members: ThreadSummary[] }>();
  const session = (hostId: string, directory: string) => {
    const key = sessionKey(hostId, directory);
    let found = sessions.get(key);
    if (!found) {
      found = { key, hostId, directory, name: directoryName(directory), threads: [], waiting: 0, running: 0, unread: false, members: [] };
      sessions.set(key, found);
    }
    return found;
  };
  for (const known of model.known ?? []) {
    const found = session(known.hostId, known.directory);
    if (known.git) found.git = known.git;
    if (known.updatedAt) found.lastActivityAt = known.updatedAt;
  }
  const directories = threadDirectories(model.threads, model.known);
  for (const thread of model.threads) {
    const directory = directories.get(thread.key) ?? threadDirectory(thread);
    const found = session(thread.hostId, directory);
    found.members.push(thread);
    if (thread.git && directory === thread.git.worktree && !found.git) {
      found.git = { repo: thread.git.repo, ...(thread.git.branch ? { branch: thread.git.branch } : {}) };
    }
  }
  return [...sessions.values()].map(({ members, ...found }) => {
    const live = members.filter(({ state }) => state !== 'closed');
    const latest = Math.max(found.lastActivityAt ?? 0, ...members.map(recency));
    return {
      ...found,
      name: directoryName(found.git?.repo ?? found.directory),
      threads: [...members].sort((left, right) => recency(right) - recency(left)).map(({ key }) => key),
      waiting: live.filter(({ activity }) => activity === 'waiting').length,
      running: live.filter(({ activity }) => activity === 'running').length,
      unread: members.some(({ key }) => model.unread.has(key)),
      ...(latest > 0 ? { lastActivityAt: latest } : {}),
    };
  }).sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0) || left.directory.localeCompare(right.directory));
}

/** Whether `path` is `parent` or inside it, a whole name at a time. */
const inside = (path: string, parent: string) => {
  const base = parent.replace(/\/+$/, '');
  return path === base || path.startsWith(`${base}/`) || base === '';
};

const depth = (path: string) => path.split('/').filter(Boolean).length;

/**
 * The Project the directory `directory` on the Host `hostId` is in, as the Dispatcher places a
 * thread there (`weave_host_protocol::projects::containing_directory`): of the Projects with a
 * location on that Host, the one whose location is the directory's repository (`repo`, its
 * primary worktree, so every worktree of a git Project's repository is in it) or contains the
 * directory. A Project in a subdirectory of another's wins, as the deepest.
 */
export function containing(projects: readonly ProjectSummary[], hostId: string, directory: string, repo?: string): ProjectSummary | undefined {
  let found: { project: ProjectSummary; depth: number } | undefined;
  for (const project of projects) {
    const path = project.locations.find((location) => location.hostId === hostId)?.path;
    if (path === undefined || !(repo === path || inside(directory, path))) continue;
    const at = depth(path);
    // The last of the deepest, as Rust's `max_by_key` gives.
    if (!found || at >= found.depth) found = { project, depth: at };
  }
  return found?.project;
}

/** What a Session's tile says under its name: its branch in a repository, else where its directory is. */
export function sessionLabel(session: SessionSummary): string {
  if (!session.git) return session.directory;
  const worktree = directoryName(session.directory);
  return session.git.branch ?? (session.directory === session.git.repo ? 'primary worktree' : worktree);
}

/** A Session in the list, with the Host it's on: a Session is one Host's. */
export type ListedSession = { session: SessionSummary; host?: HostSummary };

export type SessionListView = {
  /** The person's Projects, by name, each with its Sessions on whichever Hosts it has them. */
  projects: { project: ProjectSummary; sessions: ListedSession[] }[];
  /**
   * The Hosts that have a Session no Project has, in the Dispatcher's order, each with those
   * Sessions, the most recently active first. A Host whose Sessions are all in Projects isn't here.
   */
  hosts: { host: HostSummary; sessions: SessionSummary[] }[];
};

const matches = (session: SessionSummary, query: string, project?: ProjectSummary, host?: HostSummary) =>
  [session.name, session.directory, session.git?.branch ?? '', project?.name ?? '', host?.name ?? ''].some((value) => value.toLocaleLowerCase().includes(query));

/**
 * The sidebar's Sessions: under their Projects, and after them, under its Host, each Session no
 * Project has (ADR 0031: a directory no Project names stays under its Host). A Host is a heading
 * only for those: one whose Sessions are all in Projects isn't listed, and a Session under a
 * Project says which Host it's on. A Project with no Session yet is listed too, for starting one,
 * except while the list is filtered. Without Projects, as from a Dispatcher that keeps none, every
 * Session is under its Host.
 */
export function sessionListView(
  sessions: readonly SessionSummary[],
  hosts: readonly HostSummary[],
  projects: readonly ProjectSummary[] = [],
  options: { query?: string } = {},
): SessionListView {
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  const byProject = new Map<string, ListedSession[]>();
  const byHost = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const project = containing(projects, session.hostId, session.directory, session.git?.repo);
    const host = hosts.find(({ id }) => id === session.hostId);
    if (query && !matches(session, query, project, host)) continue;
    if (project) byProject.set(project.id, [...(byProject.get(project.id) ?? []), { session, host }]);
    else byHost.set(session.hostId, [...(byHost.get(session.hostId) ?? []), session]);
  }
  return {
    projects: [...projects]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((project) => ({ project, sessions: byProject.get(project.id) ?? [] }))
      .filter(({ sessions: listed }) => !query || listed.length > 0),
    hosts: hosts.flatMap((host) => byHost.has(host.id) ? [{ host, sessions: byHost.get(host.id) ?? [] }] : []),
  };
}

/** How many Sessions other than `except` have a thread waiting on the person. */
export const waitingSessions = (sessions: readonly SessionSummary[], except?: string) =>
  sessions.filter(({ key, waiting }) => waiting > 0 && key !== except).length;
