// The person's Sessions, as the sidebar lists them (ADR 0031, WVE-203): those their Hosts keep,
// each with the threads that are its own, under the Project it's in (WVE-189) or else under its
// Host. A thread is a Session's when it was given a Block there, or a thread of the Session
// started it: one started from a terminal or a schedule in the same directory is in none, and
// the app says nothing of it.
import {
  type AppModel,
  type BotSummary,
  type HostSummary,
  type KnownSession,
  type ProjectLocation,
  type ProjectSummary,
  type RepositoryListing,
  type SessionSummary,
  type ThreadSummary,
  sessionKey,
  sessionOfKey,
  threadKey,
} from '@/app/app-controller';
import { threadOf } from './blocks';
import { tabBlocks } from './layout';

/** A directory as a Session is keyed by it: without a slash at its end, which a thread's may have. */
const plain = (path: string) => path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;

/** The last name in a path. */
export const directoryName = (path: string) => {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed || '/';
};

/**
 * The directory whose Session a thread is in: its worktree, or outside a repository its own
 * directory, as the Host places it (`sessions/get`).
 */
export const threadDirectory = (thread: Pick<ThreadSummary, 'cwd' | 'git'>) => plain(thread.git?.worktree ?? thread.cwd);

/** The Session a thread is in, going by the thread alone. */
export const sessionOfThread = (thread: Pick<ThreadSummary, 'hostId' | 'cwd' | 'git'>) => sessionKey(thread.hostId, threadDirectory(thread));

/** The Session that lists the thread `key`, among `sessions`. */
export const sessionWith = (sessions: readonly SessionSummary[], key: string) => sessions.find(({ threads }) => threads.includes(key));

const recency = (thread: ThreadSummary) => thread.lastActivityAt ?? 0;

/**
 * The directory of a Bot's Session (WVE-178): its home, which its Dispatcher gives whole, as its
 * Host names it. From a Dispatcher that gives it under `~`, the directory its threads run in, once
 * one is listed. None until then.
 */
export function botDirectory(bot: Pick<BotSummary, 'hostId' | 'home' | 'thread' | 'threads'>, threads: readonly ThreadSummary[]): string | undefined {
  if (bot.home.startsWith('/')) return plain(bot.home);
  const ids = [...(bot.thread ? [bot.thread] : []), ...[...bot.threads].reverse().map(({ threadId }) => threadId)];
  for (const id of ids) {
    const listed = threads.find(({ key }) => key === threadKey(bot.hostId, id));
    if (listed) return threadDirectory(listed);
  }
  return undefined;
}

/** A Bot's Session, by key, where its directory is known. */
export const botSessionKey = (bot: Pick<BotSummary, 'hostId' | 'home' | 'thread' | 'threads'>, threads: readonly ThreadSummary[]) => {
  const directory = botDirectory(bot, threads);
  return directory === undefined ? undefined : sessionKey(bot.hostId, directory);
};

/** The Bots' Sessions, by key: listed under Bots, never under a Project or a Host. */
export const botSessionKeys = (model: Pick<AppModel, 'bots' | 'threads'>) =>
  new Set((model.bots ?? []).flatMap((bot) => botSessionKey(bot, model.threads) ?? []));

/** The Bots' current threads, by key: the person's as much as any thread in a Session of theirs. */
export const botThreadKeys = (model: Pick<AppModel, 'bots'>) =>
  new Set((model.bots ?? []).flatMap((bot) => bot.thread ? [threadKey(bot.hostId, bot.thread)] : []));

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
  for (const thread of threads) if (thread.git) worktree(thread.hostId, plain(thread.git.worktree));
  const own = (thread: Located) => {
    if (thread.git) return plain(thread.git.worktree);
    const cwd = plain(thread.cwd);
    let deepest: string | undefined;
    for (const path of worktrees.get(thread.hostId) ?? []) {
      if ((cwd === path || cwd.startsWith(`${path}/`)) && path.length > (deepest?.length ?? -1)) deepest = path;
    }
    return deepest ?? cwd;
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
 * The Session each listed thread is in, by thread key; a thread in none isn't here. A Session's
 * threads are the ones its Host says are its own. A Host from before it kept that
 * (`KnownSession.keepsOwn`) counts every thread in the directory, as the app then does.
 */
export function threadSessions(model: Pick<AppModel, 'threads' | 'known'>): Map<string, string> {
  const known = model.known ?? [];
  const placed = new Map<string, string>();
  const byDirectory = new Set<string>();
  for (const session of known) {
    const key = sessionKey(session.hostId, session.directory);
    if (!session.keepsOwn) byDirectory.add(key);
    else for (const threadId of session.threads) placed.set(`${session.hostId}/${threadId}`, key);
  }
  if (byDirectory.size > 0) {
    const directories = threadDirectories(model.threads, known);
    for (const thread of model.threads) {
      const key = sessionKey(thread.hostId, directories.get(thread.key) ?? threadDirectory(thread));
      if (byDirectory.has(key)) placed.set(thread.key, key);
    }
  }
  return placed;
}

/**
 * The listed threads that are in a Session, or are a Bot's current thread: the ones the app tells
 * the person about. A Bot's Session is hidden from the list of Sessions, not its thread.
 */
export function ownThreads(model: Pick<AppModel, 'threads' | 'known' | 'bots'>): ThreadSummary[] {
  const placed = threadSessions(model);
  const bots = botThreadKeys(model);
  return model.threads.filter(({ key }) => placed.has(key) || bots.has(key));
}

/**
 * The Sessions there are: those the Hosts keep, each with its own threads that are listed, the
 * most recently active first. A Session is its Host's, made when a client starts one, and the app
 * makes none up from the threads listed. `also` names one being started here, which shows before
 * its Host has made it: its first Block makes it. A Bot's Session isn't here: it's listed as the
 * Bot (WVE-178), and once the Bot is removed it's an ordinary Session again.
 */
export function sessionSummaries(model: Pick<AppModel, 'threads' | 'known' | 'unread' | 'bots'>, options: { also?: string } = {}): SessionSummary[] {
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
  if (options.also && !sessions.has(options.also)) {
    const { hostId, directory } = sessionOfKey(options.also);
    session(hostId, directory);
  }
  const placed = threadSessions(model);
  for (const thread of model.threads) {
    const key = placed.get(thread.key);
    const found = key ? sessions.get(key) : undefined;
    if (!found) continue;
    const { directory } = found;
    found.members.push(thread);
    if (thread.git && directory === plain(thread.git.worktree) && !found.git) {
      found.git = { repo: thread.git.repo, ...(thread.git.branch ? { branch: thread.git.branch } : {}) };
    }
  }
  for (const key of botSessionKeys(model)) sessions.delete(key);
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
   * The person's Hosts, in the Dispatcher's order, each with its Sessions no Project has, the most
   * recently active first: every Host, whether or not it has any (WVE-231), except while the list
   * is filtered, when only those with a match are here.
   */
  hosts: { host: HostSummary; sessions: SessionSummary[] }[];
};

const matches = (session: SessionSummary, query: string, project?: ProjectSummary, host?: HostSummary) =>
  [session.name, session.directory, session.git?.branch ?? '', project?.name ?? '', host?.name ?? ''].some((value) => value.toLocaleLowerCase().includes(query));

/**
 * The sidebar's Sessions: under their Projects, and after them, under its Host, each Session no
 * Project has (ADR 0031: a directory no Project names stays under its Host). A Session under a
 * Project says which Host it's on. Every Host is listed, with or without such Sessions (WVE-231),
 * and a Project with no Session yet is too, for starting one, except while the list is filtered.
 * Without Projects, as from a Dispatcher that keeps none, every Session is under its Host.
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
    hosts: hosts.flatMap((host) => byHost.has(host.id) || !query ? [{ host, sessions: byHost.get(host.id) ?? [] }] : []),
  };
}

/** What a group of Sessions has going on, for a heading that hides them (WVE-231). */
export function sessionsActivity(sessions: readonly SessionSummary[]): { activity?: 'waiting' | 'running'; unread: boolean } {
  const activity = sessions.some(({ waiting }) => waiting > 0) ? 'waiting' : sessions.some(({ running }) => running > 0) ? 'running' : undefined;
  return { ...(activity ? { activity } : {}), unread: sessions.some(({ unread }) => unread) };
}

/** A tab with a Thread Block, as the sidebar's Threads view lists it (WVE-231). */
export type ThreadTab = {
  /** The Session's key and the tab's id. */
  key: string;
  session: SessionSummary;
  host?: HostSummary;
  project?: ProjectSummary;
  tabId: string;
  /** The tab's name where it was given one, else its first thread's title. */
  name: string;
  /** Its Thread Blocks, in the tab's order, each with its thread's key, listed or not. */
  blocks: { id: string; thread: string }[];
  waiting: number;
  running: number;
  unread: boolean;
  lastActivityAt?: number;
};

/**
 * The sidebar's Threads view (WVE-231): one item for each tab of a Session that has a Thread
 * Block, docked or floating, minimized or not, under no Project or Host, the most recently active
 * first. Only the Sessions given are in it, so a Bot's isn't; one whose Host keeps no layout has
 * no tabs to list.
 */
export function threadTabs(
  sessions: readonly SessionSummary[],
  model: Pick<AppModel, 'known' | 'threads' | 'unread' | 'hosts' | 'projects'>,
  options: { query?: string } = {},
): ThreadTab[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? '';
  const layouts = new Map((model.known ?? []).map((known) => [sessionKey(known.hostId, known.directory), known.layout]));
  const listed = new Map(model.threads.map((thread) => [thread.key, thread]));
  const tabs: ThreadTab[] = [];
  for (const session of sessions) {
    const host = model.hosts.find(({ id }) => id === session.hostId);
    const project = containing(model.projects ?? [], session.hostId, session.directory, session.git?.repo);
    for (const tab of layouts.get(session.key)?.tabs ?? []) {
      const blocks = tabBlocks(tab).flatMap((block) => {
        const threadId = threadOf(block);
        return threadId ? [{ id: block.id, thread: threadKey(session.hostId, threadId) }] : [];
      });
      if (blocks.length === 0) continue;
      const members = blocks.flatMap(({ thread }) => listed.get(thread) ?? []);
      const titles = members.map(({ title }) => title ?? '');
      const name = tab.title || titles.find(Boolean) || 'New thread';
      if (query && ![name, ...titles, session.name, session.directory, session.git?.branch ?? '', project?.name ?? '', host?.name ?? '']
        .some((value) => value.toLocaleLowerCase().includes(query))) continue;
      const live = members.filter(({ state }) => state !== 'closed');
      const latest = Math.max(0, ...members.map(recency));
      tabs.push({
        key: `${session.key}#${tab.id}`,
        session,
        ...(host ? { host } : {}),
        ...(project ? { project } : {}),
        tabId: tab.id,
        name,
        blocks,
        waiting: live.filter(({ activity }) => activity === 'waiting').length,
        running: live.filter(({ activity }) => activity === 'running').length,
        unread: blocks.some(({ thread }) => model.unread.has(thread)),
        ...(latest > 0 ? { lastActivityAt: latest } : {}),
      });
    }
  }
  // Those with nothing listed yet keep their Session's order, after the rest.
  return tabs.sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
}

/** How many Sessions other than `except` have a thread waiting on the person. */
export const waitingSessions = (sessions: readonly SessionSummary[], except?: string) =>
  sessions.filter(({ key, waiting }) => waiting > 0 && key !== except).length;

/**
 * A directory as a Project's location (WVE-220), as `weave projects add` registers it: its
 * repository, by its primary worktree and remote, when the Host says it's in one, else the
 * directory itself.
 */
export function projectLocation(hostId: string, directory: string, repository?: RepositoryListing): ProjectLocation {
  if (!repository) return { hostId, path: directory, kind: 'directory' };
  return { hostId, path: repository.repo, kind: 'git', ...(repository.remote ? { remote: repository.remote } : {}) };
}

/** The Project whose location on its Host `location` is already. */
export const projectAt = (projects: readonly ProjectSummary[], location: Pick<ProjectLocation, 'hostId' | 'path'>): ProjectSummary | undefined =>
  projects.find((project) => project.locations.some(({ hostId, path }) => hostId === location.hostId && path === location.path));

/**
 * The Projects a clone may join instead of becoming one of its own, as the CLI offers: the git
 * Projects with its remote and no location on its Host yet.
 */
export const projectsOfRepository = (projects: readonly ProjectSummary[], location: ProjectLocation): ProjectSummary[] =>
  location.kind === 'git' && location.remote
    ? projects.filter((project) => project.kind === 'git' && project.remote === location.remote && !project.locations.some(({ hostId }) => hostId === location.hostId))
    : [];

/** The Projects, the one worked in most recently first, and after those the ones with no Session, by name. */
export function projectsByUse(projects: readonly ProjectSummary[], sessions: readonly SessionSummary[]): ProjectSummary[] {
  const used = new Map<string, number>();
  for (const session of sessions) {
    const project = containing(projects, session.hostId, session.directory, session.git?.repo);
    if (project) used.set(project.id, Math.max(used.get(project.id) ?? 0, session.lastActivityAt ?? 0));
  }
  return [...projects].sort((left, right) => (used.get(right.id) ?? -1) - (used.get(left.id) ?? -1) || left.name.localeCompare(right.name));
}
