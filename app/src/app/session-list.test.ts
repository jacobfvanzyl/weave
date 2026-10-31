import { describe, expect, it } from 'vitest';
import type { PairedHost, SessionSummary } from './app-controller';
import { knownDirectories, sessionListView, subdirectory, waitingCount } from './session-list';

const host = (id: string, name: string): PairedHost => ({ id, name, url: `https://${name}`, status: 'connected' });

const session = (hostId: string, sessionId: string, cwd: string, at: number, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  key: `${hostId}/${sessionId}`,
  hostId,
  sessionId,
  title: sessionId,
  agentId: 'claude',
  agentName: 'Claude',
  cwd,
  state: 'open',
  activity: 'idle',
  clients: 0,
  headless: false,
  lastActivityAt: at,
  ...extra,
});

describe('sessionListView', () => {
  const mac = host('mac', 'mac.example.ts.net');
  const sessions = [
    session('mac', 'old', '/code/weave', 10),
    session('mac', 'new', '/code/weave', 50),
    session('mac', 'pad', '/code/trackpad', 40, { activity: 'waiting' }),
    session('mac', 'gone', '/code/weave', 60, { state: 'closed', activity: undefined }),
  ];

  /** The view's directories, across Hosts, in order. */
  const directories = (view: ReturnType<typeof sessionListView>) => view.hosts.flatMap(({ directories: listed }) => listed);

  it('groups by directory, newest groups and sessions first, waiting sessions in place', () => {
    const view = sessionListView(sessions, [mac]);
    expect(directories(view).map(({ name }) => name)).toEqual(['weave', 'trackpad']);
    expect(directories(view)[0].sessions.map(({ sessionId }) => sessionId)).toEqual(['new', 'old']);
  });

  it('hides closed sessions unless asked for them', () => {
    expect(directories(sessionListView(sessions, [mac]))[0].sessions).toHaveLength(2);
    expect(directories(sessionListView(sessions, [mac], { showClosed: true }))[0].sessions.map(({ sessionId }) => sessionId))
      .toEqual(['gone', 'new', 'old']);
  });

  it('groups by Host first, in pairing order, keeping the same directory on two Hosts apart', () => {
    const server = host('server', 'server.example.ts.net');
    const idle = host('idle', 'idle.example.ts.net');
    const both = [...sessions, session('server', 'remote', '/code/weave', 70)];
    const view = sessionListView(both, [mac, server, idle]);
    expect(view.hosts.map(({ host: paired, directories: listed }) => [paired.name, listed.map(({ name }) => name)])).toEqual([
      ['mac.example.ts.net', ['weave', 'trackpad']],
      ['server.example.ts.net', ['weave']],
      ['idle.example.ts.net', []],
    ]);
    // Filtered, a Host with nothing matching goes.
    expect(sessionListView(both, [mac, server, idle], { query: 'remote' }).hosts.map(({ host: paired }) => paired.id)).toEqual(['server']);
  });

  it('groups sessions in a repository under it, across worktrees, and places the repository by its latest activity', () => {
    const git = (worktree: string, branch?: string) => ({ repo: '/code/weave', worktree, ...(branch ? { branch } : {}) });
    const inRepo = [
      session('mac', 'tui', '/code/weave/tui', 30, { git: git('/code/weave', 'main') }),
      session('mac', 'root', '/code/weave', 20, { git: git('/code/weave', 'main') }),
      session('mac', 'auth', '/code/weave.feature-auth', 50, { git: git('/code/weave.feature-auth', 'feature/auth') }),
      session('mac', 'review', '/code/weave.review', 10, { git: git('/code/weave.review') }),
      session('mac', 'notes', '/code/notes', 40),
      // From a journal written before the Host recorded repositories: it joins the worktree it's in.
      session('mac', 'older', '/code/weave.feature-auth/src', 5),
    ];
    const view = sessionListView(inRepo, [mac]);
    expect(directories(view).map(({ name, cwd, sessions: grouped }) => ({ name, cwd, sessions: grouped.map(({ sessionId }) => sessionId) })))
      .toEqual([
        { name: 'weave', cwd: '/code/weave', sessions: ['auth', 'tui', 'root', 'review', 'older'] },
        { name: 'notes', cwd: '/code/notes', sessions: ['notes'] },
      ]);
    const older = directories(view)[0].sessions[4];
    expect(older.git).toEqual({ repo: '/code/weave', worktree: '/code/weave.feature-auth', branch: 'feature/auth' });
    expect(subdirectory(older)).toBe('src');
    expect(inRepo.map(subdirectory)).toEqual(['tui', undefined, undefined, undefined, undefined, undefined]);
    expect(directories(sessionListView(inRepo, [mac], { query: 'feature/' }))[0].sessions.map(({ sessionId }) => sessionId))
      .toEqual(['auth', 'older']);
  });

  it('filters by title, directory and agent', () => {
    const codex = session('mac', 'docs', '/code/site', 5, { agentId: 'codex', agentName: 'Codex', title: 'Write docs' });
    const all = [...sessions, codex];
    expect(directories(sessionListView(all, [mac], { query: 'TRACK' })).map(({ name }) => name)).toEqual(['trackpad']);
    expect(directories(sessionListView(all, [mac], { query: 'codex' })).map(({ name }) => name)).toEqual(['site']);
    expect(directories(sessionListView(all, [mac], { query: 'write' }))[0].sessions[0].sessionId).toBe('docs');
    expect(sessionListView(all, [mac], { query: 'nothing' }).hosts).toEqual([]);
  });
});

it('counts the sessions waiting other than the one on screen', () => {
  const sessions = [
    session('mac', 'a', '/a', 1, { activity: 'waiting' }),
    session('mac', 'b', '/b', 2, { activity: 'waiting' }),
    session('mac', 'c', '/c', 3, { activity: 'running' }),
  ];
  expect(waitingCount(sessions)).toBe(2);
  expect(waitingCount(sessions, 'mac/a')).toBe(1);
});

it('lists a Host\'s known directories once each, most recent first', () => {
  const sessions = [
    session('mac', 'a', '/a', 1),
    session('mac', 'b', '/b', 3),
    session('mac', 'c', '/a', 2),
    session('server', 'd', '/d', 9),
  ];
  expect(knownDirectories(sessions, 'mac')).toEqual(['/b', '/a']);
});
