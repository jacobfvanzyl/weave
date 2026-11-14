import { describe, expect, it } from 'vitest';
import type { HostSummary, KnownSession, ProjectSummary, ThreadSummary } from '@/app/app-controller';
import { containing, projectAt, projectLocation, projectsByUse, projectsOfRepository, sessionLabel, sessionListView, sessionOfThread, sessionSummaries,
  sessionWith,
  sessionsActivity,
  threadSessions,
  threadTabs,
  ownThreads, waitingSessions } from './sessions';
import { threadBlock, terminalBlock } from './blocks';
import { LAYOUT_VERSION } from './layout';

const MAC = 'h-mac';
const HOMELAB = 'h-homelab';

const project = (name: string, locations: [string, string][]): ProjectSummary =>
  ({ id: `p-${name}`, name, locations: locations.map(([hostId, path]) => ({ hostId, path })) });

const thread = (hostId: string, id: string, cwd: string, change: Partial<ThreadSummary> = {}): ThreadSummary => ({
  key: `${hostId}/${id}`,
  hostId,
  threadId: id,
  agentId: 'claude',
  agentName: 'Claude',
  cwd,
  state: 'open',
  clients: 0,
  headless: false,
  ...change,
});

const worktree = (repo: string, path: string, branch?: string) => ({ git: { repo, worktree: path, ...(branch ? { branch } : {}) } });

// The cases `weave_host_protocol::projects::containing` is tested with, in the same order.
describe('the Project a directory is in', () => {
  const named = (found?: ProjectSummary) => found?.name;

  it('has every worktree of a registered repository', () => {
    const projects = [project('odin', [[MAC, '/code/odin']])];
    for (const [cwd, repo] of [['/code/odin', '/code/odin'], ['/code/odin/src/parser', '/code/odin'], ['/code/odin.feature-auth', '/code/odin']]) {
      expect(named(containing(projects, MAC, cwd, repo)), cwd).toBe('odin');
    }
    // Another repository beside it, whose name only starts the same.
    expect(containing(projects, MAC, '/code/odin-docs', '/code/odin-docs')).toBeUndefined();
  });

  it('is the one in a subdirectory of another, there', () => {
    const projects = [project('mono', [[MAC, '/code/mono']]), project('vendored', [[MAC, '/code/mono/vendor/lib']])];
    expect(named(containing(projects, MAC, '/code/mono/vendor/lib/src', '/code/mono/vendor/lib'))).toBe('vendored');
    // Even listed first.
    expect(named(containing([projects[1], projects[0]], MAC, '/code/mono/vendor/lib/src', '/code/mono/vendor/lib'))).toBe('vendored');
    // The rest of the outer repository stays the outer Project's.
    expect(named(containing(projects, MAC, '/code/mono/packages/app', '/code/mono'))).toBe('mono');
  });

  it('holds the subdirectories of a directory outside any repository', () => {
    const projects = [project('notes', [[MAC, '/Users/jaco/notes']])];
    for (const cwd of ['/Users/jaco/notes', '/Users/jaco/notes/2026/november']) {
      expect(named(containing(projects, MAC, cwd)), cwd).toBe('notes');
    }
    expect(containing(projects, MAC, '/Users/jaco')).toBeUndefined();
  });

  it('counts only the directory’s own Host', () => {
    const projects = [
      project('odin', [[MAC, '/Users/jaco/odin'], [HOMELAB, '/home/jaco/odin']]),
      project('lab', [[HOMELAB, '/srv/lab']]),
    ];
    expect(containing(projects, MAC, '/srv/lab')).toBeUndefined();
    expect(containing(projects, HOMELAB, '/Users/jaco/odin', '/Users/jaco/odin')).toBeUndefined();
    expect(named(containing(projects, HOMELAB, '/home/jaco/odin', '/home/jaco/odin'))).toBe('odin');
    expect(containing(projects, 'h-elsewhere', '/srv/lab')).toBeUndefined();
  });
});

/** A Session a Host keeps. */
const kept = (hostId: string, directory: string, change: Partial<KnownSession> = {}): KnownSession => ({ hostId, directory, threads: [], ...change });

describe('the Sessions there are', () => {
  it('hold the threads their Hosts say are their own, and nothing else in their directories', () => {
    const threads = [
      thread(MAC, 'own', '/code/odin', { lastActivityAt: 30, activity: 'waiting' }),
      thread(MAC, 'started', '/code/odin/src', { lastActivityAt: 40 }),
      // Started from a terminal and from a schedule, in the Session's directory and in one with no Session.
      thread(MAC, 'tui', '/code/odin', { lastActivityAt: 50, activity: 'waiting' }),
      thread(MAC, 'nightly', '/code/other', { lastActivityAt: 60, activity: 'waiting' }),
    ];
    const known = [kept(MAC, '/code/odin', { threads: ['started', 'own', 'gone'], keepsOwn: true })];
    const model = { threads, known, unread: new Set(['h-mac/tui']) };
    const sessions = sessionSummaries(model);
    expect(sessions.map(({ key, threads: members, waiting, unread }) => [key, members, waiting, unread])).toEqual([
      ['h-mac:/code/odin', ['h-mac/started', 'h-mac/own'], 1, false],
    ]);
    expect([...threadSessions(model)]).toEqual([['h-mac/started', 'h-mac:/code/odin'], ['h-mac/own', 'h-mac:/code/odin'], ['h-mac/gone', 'h-mac:/code/odin']]);
    // The app tells the person only of those: the others wait where they were started.
    expect(ownThreads(model).map(({ key }) => key)).toEqual(['h-mac/own', 'h-mac/started']);
    expect(sessionWith(sessions, 'h-mac/tui')).toBeUndefined();
  });

  it('on a Host from before it kept what’s theirs, hold the threads in their directory: a worktree’s, or outside a repository the thread’s own', () => {
    const threads = [
      thread(MAC, 't1', '/code/odin', { ...worktree('/code/odin', '/code/odin', 'main'), lastActivityAt: 30 }),
      thread(MAC, 't2', '/code/odin/src', { ...worktree('/code/odin', '/code/odin', 'main'), lastActivityAt: 40 }),
      thread(MAC, 't3', '/code/odin.auth', { ...worktree('/code/odin', '/code/odin.auth', 'auth'), lastActivityAt: 10 }),
      thread(MAC, 't4', '/notes/2026/', { lastActivityAt: 20 }),
      thread(HOMELAB, 't5', '/code/odin', { ...worktree('/code/odin', '/code/odin', 'main'), lastActivityAt: 5 }),
    ];
    const known = [
      kept(MAC, '/code/odin', { git: { repo: '/code/odin', branch: 'main' } }),
      kept(MAC, '/code/odin.auth', { git: { repo: '/code/odin', branch: 'auth' } }),
      kept(MAC, '/notes/2026'),
      kept(HOMELAB, '/code/odin', { git: { repo: '/code/odin', branch: 'main' } }),
    ];
    const sessions = sessionSummaries({ threads, known, unread: new Set() });
    expect(sessions.map(({ key, name, threads: members }) => [key, name, members])).toEqual([
      ['h-mac:/code/odin', 'odin', ['h-mac/t2', 'h-mac/t1']],
      ['h-mac:/notes/2026', '2026', ['h-mac/t4']],
      ['h-mac:/code/odin.auth', 'odin', ['h-mac/t3']],
      ['h-homelab:/code/odin', 'odin', ['h-homelab/t5']],
    ]);
    expect(sessions.map(sessionLabel)).toEqual(['main', '/notes/2026', 'auth', 'main']);
    expect(sessionOfThread(threads[1])).toBe('h-mac:/code/odin');
  });

  it('aren’t made up from threads: a directory its Host keeps no Session for has none, however many threads it had', () => {
    const threads = [
      thread(MAC, 't1', '/code/odin', { ...worktree('/code/odin', '/code/odin', 'main'), lastActivityAt: 30 }),
      // Worktrees that closed, or went, before the Host kept Sessions.
      thread(MAC, 't2', '/code/odin.old', { ...worktree('/code/odin', '/code/odin.old', 'old'), state: 'closed', lastActivityAt: 10 }),
      thread(MAC, 't3', '/scratch', { state: 'closed', lastActivityAt: 5 }),
    ];
    const known = [kept(MAC, '/code/odin', { git: { repo: '/code/odin', branch: 'main' } })];
    expect(sessionSummaries({ threads, known, unread: new Set() }).map(({ key }) => key)).toEqual(['h-mac:/code/odin']);
    expect(sessionSummaries({ threads, unread: new Set() })).toEqual([]);
  });

  it('show the one being started here before its Host has made it, which its first Block does', () => {
    const threads = [thread(MAC, 'new', '/code/fresh', { lastActivityAt: 9 })];
    expect(sessionSummaries({ threads, unread: new Set() }, { also: 'h-mac:/code/fresh' }).map(({ key, name, threads: members }) => [key, name, members]))
      .toEqual([['h-mac:/code/fresh', 'fresh', []]]);
    expect(sessionSummaries({ threads, unread: new Set() })).toEqual([]);
  });

  it('include one with nothing listed in it, and keep a thread where its Host placed it, with the others of its directory', () => {
    const sessions = sessionSummaries({
      threads: [thread(MAC, 't1', '/tmp/work', { lastActivityAt: 5 }), thread(MAC, 't2', '/tmp/work', { lastActivityAt: 3 })],
      known: [
        // The Host names the directory by where its symbolic link leads, and has said so of one thread.
        kept(MAC, '/private/tmp/work', { threads: ['t1'], updatedAt: 9 }),
        kept(MAC, '/code/empty', { git: { repo: '/code/empty', branch: 'main' } }),
      ],
      unread: new Set(),
    });
    expect(sessions.map(({ key, threads: members }) => [key, members])).toEqual([
      ['h-mac:/private/tmp/work', ['h-mac/t1', 'h-mac/t2']],
      ['h-mac:/code/empty', []],
    ]);
    expect(sessions[1].git).toEqual({ repo: '/code/empty', branch: 'main' });
  });

  it('place a thread from before Hosts recorded its repository in the worktree that holds its directory', () => {
    const sessions = sessionSummaries({
      threads: [thread(MAC, 'old', '/code/odin/src/parser', { lastActivityAt: 1 })],
      known: [kept(MAC, '/code/odin', { git: { repo: '/code/odin', branch: 'main' } })],
      unread: new Set(),
    });
    expect(sessions.map(({ key, threads: members }) => [key, members])).toEqual([['h-mac:/code/odin', ['h-mac/old']]]);
  });

  it('count what waits and runs among threads that aren’t closed, and what’s unread', () => {
    const [session] = sessionSummaries({
      threads: [
        thread(MAC, 't1', '/work', { activity: 'waiting' }),
        thread(MAC, 't2', '/work', { activity: 'running' }),
        thread(MAC, 't3', '/work', { activity: 'waiting', state: 'closed' }),
      ],
      known: [kept(MAC, '/work')],
      unread: new Set(['h-mac/t2']),
    });
    expect(session).toMatchObject({ waiting: 1, running: 1, unread: true });
    expect(waitingSessions([session])).toBe(1);
    expect(waitingSessions([session], session.key)).toBe(0);
  });
});

describe('the sidebar’s list', () => {
  const hosts: HostSummary[] = [{ id: MAC, name: 'Mac', status: 'connected' }, { id: HOMELAB, name: 'homelab', status: 'connected' }];
  const sessions = sessionSummaries({
    threads: [
      thread(MAC, 't1', '/code/odin', { ...worktree('/code/odin', '/code/odin', 'main'), lastActivityAt: 30 }),
      thread(MAC, 't2', '/code/odin.auth', { ...worktree('/code/odin', '/code/odin.auth', 'auth'), lastActivityAt: 10 }),
      thread(HOMELAB, 't3', '/home/jaco/odin', { ...worktree('/home/jaco/odin', '/home/jaco/odin', 'main'), lastActivityAt: 20 }),
      thread(MAC, 't4', '/scratch', { lastActivityAt: 1 }),
    ],
    known: [
      kept(MAC, '/code/odin', { git: { repo: '/code/odin', branch: 'main' } }),
      kept(MAC, '/code/odin.auth', { git: { repo: '/code/odin', branch: 'auth' } }),
      kept(HOMELAB, '/home/jaco/odin', { git: { repo: '/home/jaco/odin', branch: 'main' } }),
      kept(MAC, '/scratch'),
    ],
    unread: new Set(),
  });
  const projects = [project('odin', [[MAC, '/code/odin'], [HOMELAB, '/home/jaco/odin']])];

  it('puts a Project’s Sessions on every Host together, and the rest under their Hosts, every Host listed', () => {
    const view = sessionListView(sessions, hosts, projects);
    expect(view.projects.map(({ project: listed, sessions: under }) => [listed.name, under.map(({ session, host }) => `${host?.name} ${sessionLabel(session)}`)]))
      .toEqual([['odin', ['Mac main', 'homelab main', 'Mac auth']]]);
    expect(view.hosts.map(({ host, sessions: under }) => [host.name, under.map(({ key }) => key)]))
      .toEqual([['Mac', ['h-mac:/scratch']], ['homelab', []]]);
  });

  it('says what a heading’s Sessions are doing, the most pressing first', () => {
    const [first, second] = sessions;
    expect(sessionsActivity([])).toEqual({ unread: false });
    expect(sessionsActivity([{ ...first, running: 1 }, { ...second, unread: true }])).toEqual({ activity: 'running', unread: true });
    expect(sessionsActivity([{ ...first, running: 1 }, { ...second, waiting: 2 }])).toEqual({ activity: 'waiting', unread: false });
  });

  it('lists a Project with no Session yet, for starting one, unless the list is filtered', () => {
    const both = [...projects, project('notes', [[MAC, '/notes']])];
    expect(sessionListView(sessions, hosts, both).projects.map(({ project: listed, sessions: under }) => [listed.name, under.length]))
      .toEqual([['notes', 0], ['odin', 3]]);
    expect(sessionListView(sessions, hosts, both, { query: 'odin' }).projects.map(({ project: listed }) => listed.name)).toEqual(['odin']);
  });

  it('puts every Session under its Host without Projects', () => {
    const view = sessionListView(sessions, hosts);
    expect(view.projects).toEqual([]);
    expect(view.hosts.map(({ sessions: under }) => under.length)).toEqual([3, 1]);
  });

  it('filters by name, branch, directory or Project', () => {
    expect(sessionListView(sessions, hosts, projects, { query: 'AUTH' }).projects[0].sessions.map(({ session }) => session.key)).toEqual(['h-mac:/code/odin.auth']);
    const scratch = sessionListView(sessions, hosts, projects, { query: 'scratch' });
    expect(scratch.projects).toEqual([]);
    expect(scratch.hosts.map(({ host }) => host.name)).toEqual(['Mac']);
    // By the Host a Session is on, too.
    expect(sessionListView(sessions, hosts, projects, { query: 'homelab' }).projects[0].sessions.map(({ session }) => session.key)).toEqual(['h-homelab:/home/jaco/odin']);
    expect(sessionListView(sessions, hosts, projects, { query: 'odin' }).projects[0].sessions).toHaveLength(3);
  });
});

describe('the sidebar’s Threads view', () => {
  const hosts: HostSummary[] = [{ id: MAC, name: 'Mac', status: 'connected' }, { id: HOMELAB, name: 'homelab', status: 'connected' }];
  const projects = [project('odin', [[MAC, '/code/odin']])];
  const threads = [
    thread(MAC, 't1', '/code/odin', { title: 'Fix the parser', lastActivityAt: 10, activity: 'running' }),
    thread(MAC, 't2', '/code/odin', { title: 'Write the docs', lastActivityAt: 30 }),
    thread(MAC, 't3', '/code/odin', { title: 'Review', lastActivityAt: 5, activity: 'waiting' }),
    thread(HOMELAB, 't4', '/srv/logs', { title: 'Tail the logs', lastActivityAt: 20 }),
  ];
  const known = [
    kept(MAC, '/code/odin', {
      git: { repo: '/code/odin', branch: 'main' },
      threads: ['t1', 't2', 't3'],
      layout: {
        version: LAYOUT_VERSION,
        tabs: [
          {
            id: 'work',
            root: { kind: 'row', children: [{ kind: 'block', ...threadBlock('t1', 'b1') }, { kind: 'block', ...terminalBlock('term', 'b-term') }] },
            floating: [{ block: threadBlock('t3', 'b3'), frame: { x: 0, y: 0, width: 0.5, height: 0.5 }, minimized: true }],
          },
          { id: 'shell', root: { kind: 'block', ...terminalBlock('term-2', 'b-term-2') } },
          { id: 'docs', title: 'Docs', root: { kind: 'block', ...threadBlock('t2', 'b2') } },
        ],
      },
    }),
    kept(HOMELAB, '/srv/logs', { threads: ['t4'], layout: { version: LAYOUT_VERSION, tabs: [{ id: 'logs', root: { kind: 'block', ...threadBlock('t4', 'b4') } }] } }),
    // One nobody arranged has no tabs to list.
    kept(HOMELAB, '/srv/empty'),
  ];
  const model = { threads, known, unread: new Set(['h-mac/t2']), hosts, projects };
  const sessions = sessionSummaries(model);

  it('has an item for each tab with a Thread Block, the most recently active first', () => {
    const tabs = threadTabs(sessions, model);
    expect(tabs.map(({ name, session, host, project: under }) => [name, session.name, host?.name, under?.name])).toEqual([
      ['Docs', 'odin', 'Mac', 'odin'],
      ['Tail the logs', 'logs', 'homelab', undefined],
      ['Fix the parser', 'odin', 'Mac', 'odin'],
    ]);
    // A tab's threads are those docked and those floating, minimized or not, and it says what they're doing.
    expect(tabs[2]).toMatchObject({
      tabId: 'work',
      blocks: [{ id: 'b1', thread: 'h-mac/t1' }, { id: 'b3', thread: 'h-mac/t3' }],
      waiting: 1,
      running: 1,
      unread: false,
      lastActivityAt: 10,
    });
    expect(tabs[0]).toMatchObject({ unread: true, waiting: 0, running: 0 });
  });

  it('filters by the tab’s name, its threads’ titles, its Session, Project and Host', () => {
    const names = (query: string) => threadTabs(sessions, model, { query }).map(({ name }) => name);
    expect(names('docs')).toEqual(['Docs']);
    expect(names('write the')).toEqual(['Docs']);
    expect(names('review')).toEqual(['Fix the parser']);
    expect(names('HOMELAB')).toEqual(['Tail the logs']);
    expect(names('odin')).toEqual(['Docs', 'Fix the parser']);
    expect(names('nothing')).toEqual([]);
  });
});

describe('a directory as a Project’s location', () => {
  const weave: ProjectSummary = { ...project('weave', [[MAC, '/code/weave']]), kind: 'git', remote: 'github.com/veezee/weave' };
  const notes: ProjectSummary = { ...project('notes', [[MAC, '/notes']]), kind: 'directory' };
  const repository = { repo: '/src/weave', remote: 'github.com/veezee/weave', worktrees: [] };

  it('is its repository, by its primary worktree and remote, or the directory itself outside one', () => {
    expect(projectLocation(HOMELAB, '/src/weave.fix/tui', repository)).toEqual({ hostId: HOMELAB, path: '/src/weave', kind: 'git', remote: 'github.com/veezee/weave' });
    expect(projectLocation(HOMELAB, '/src/weave', { repo: '/src/weave', worktrees: [] })).toEqual({ hostId: HOMELAB, path: '/src/weave', kind: 'git' });
    expect(projectLocation(HOMELAB, '/srv/odin')).toEqual({ hostId: HOMELAB, path: '/srv/odin', kind: 'directory' });
  });

  it('is a Project’s already only at the same path on the same Host', () => {
    expect(projectAt([weave, notes], { hostId: MAC, path: '/code/weave' })).toBe(weave);
    expect(projectAt([weave, notes], { hostId: HOMELAB, path: '/code/weave' })).toBeUndefined();
    expect(projectAt([weave, notes], { hostId: MAC, path: '/code/weave/tui' })).toBeUndefined();
  });

  it('may join the git Projects with its remote that have no location on its Host', () => {
    const clone = projectLocation(HOMELAB, '/src/weave', repository);
    expect(projectsOfRepository([weave, notes], clone)).toEqual([weave]);
    // Not on a Host the Project is on already, nor without a remote, nor as a directory.
    expect(projectsOfRepository([weave], { ...clone, hostId: MAC })).toEqual([]);
    expect(projectsOfRepository([weave], projectLocation(HOMELAB, '/src/weave', { repo: '/src/weave', worktrees: [] }))).toEqual([]);
    expect(projectsOfRepository([weave], projectLocation(HOMELAB, '/src/weave'))).toEqual([]);
    expect(projectsOfRepository([{ ...weave, remote: 'github.com/other/weave' }], clone)).toEqual([]);
  });
});

describe('the Projects to start a Session in', () => {
  it('come the one worked in last first, then those with no Session, by name', () => {
    const projects = [project('alpha', [[MAC, '/alpha']]), project('beta', [[MAC, '/beta']]), project('gamma', [[MAC, '/gamma']]), project('delta', [[MAC, '/delta']])];
    const session = (directory: string, lastActivityAt: number) =>
      ({ key: `${MAC}:${directory}`, hostId: MAC, directory, name: directory, threads: [], waiting: 0, running: 0, unread: false, lastActivityAt });
    expect(projectsByUse(projects, [session('/beta', 10), session('/gamma/sub', 30), session('/elsewhere', 99)]).map(({ name }) => name))
      .toEqual(['gamma', 'beta', 'alpha', 'delta']);
  });
});
