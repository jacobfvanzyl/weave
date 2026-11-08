import { describe, expect, it } from 'vitest';
import type { PairedHost, ThreadSummary } from './app-controller';
import { knownDirectories, subdirectory, threadListView, waitingCount } from './thread-list';

const host = (id: string, name: string): PairedHost => ({ id, name, url: `https://${name}`, status: 'connected' });

const thread = (hostId: string, threadId: string, cwd: string, at: number, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  key: `${hostId}/${threadId}`,
  hostId,
  threadId,
  title: threadId,
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

describe('threadListView', () => {
  const mac = host('mac', 'mac.example.ts.net');
  const threads = [
    thread('mac', 'old', '/code/weave', 10),
    thread('mac', 'new', '/code/weave', 50),
    thread('mac', 'pad', '/code/trackpad', 40, { activity: 'waiting' }),
    thread('mac', 'gone', '/code/weave', 60, { state: 'closed', activity: undefined }),
  ];

  /** The view's directories, across Hosts, in order. */
  const directories = (view: ReturnType<typeof threadListView>) => view.hosts.flatMap(({ directories: listed }) => listed);

  it('groups by directory, newest groups and threads first, waiting threads in place', () => {
    const view = threadListView(threads, [mac]);
    expect(directories(view).map(({ name }) => name)).toEqual(['weave', 'trackpad']);
    expect(directories(view)[0].threads.map(({ threadId }) => threadId)).toEqual(['new', 'old']);
  });

  it('hides closed threads unless asked for them', () => {
    expect(directories(threadListView(threads, [mac]))[0].threads).toHaveLength(2);
    expect(directories(threadListView(threads, [mac], { showClosed: true }))[0].threads.map(({ threadId }) => threadId))
      .toEqual(['gone', 'new', 'old']);
  });

  it('groups by Host first, in pairing order, keeping the same directory on two Hosts apart', () => {
    const server = host('server', 'server.example.ts.net');
    const idle = host('idle', 'idle.example.ts.net');
    const both = [...threads, thread('server', 'remote', '/code/weave', 70)];
    const view = threadListView(both, [mac, server, idle]);
    expect(view.hosts.map(({ host: paired, directories: listed }) => [paired.name, listed.map(({ name }) => name)])).toEqual([
      ['mac.example.ts.net', ['weave', 'trackpad']],
      ['server.example.ts.net', ['weave']],
      ['idle.example.ts.net', []],
    ]);
    // Filtered, a Host with nothing matching goes.
    expect(threadListView(both, [mac, server, idle], { query: 'remote' }).hosts.map(({ host: paired }) => paired.id)).toEqual(['server']);
  });

  it('groups threads in a repository under it, across worktrees, and places the repository by its latest activity', () => {
    const git = (worktree: string, branch?: string) => ({ repo: '/code/weave', worktree, ...(branch ? { branch } : {}) });
    const inRepo = [
      thread('mac', 'tui', '/code/weave/tui', 30, { git: git('/code/weave', 'main') }),
      thread('mac', 'root', '/code/weave', 20, { git: git('/code/weave', 'main') }),
      thread('mac', 'auth', '/code/weave.feature-auth', 50, { git: git('/code/weave.feature-auth', 'feature/auth') }),
      thread('mac', 'review', '/code/weave.review', 10, { git: git('/code/weave.review') }),
      thread('mac', 'notes', '/code/notes', 40),
      // From a journal written before the Host recorded repositories: it joins the worktree it's in.
      thread('mac', 'older', '/code/weave.feature-auth/src', 5),
    ];
    const view = threadListView(inRepo, [mac]);
    expect(directories(view).map(({ name, cwd, threads: grouped }) => ({ name, cwd, threads: grouped.map(({ threadId }) => threadId) })))
      .toEqual([
        { name: 'weave', cwd: '/code/weave', threads: ['auth', 'tui', 'root', 'review', 'older'] },
        { name: 'notes', cwd: '/code/notes', threads: ['notes'] },
      ]);
    const older = directories(view)[0].threads[4];
    expect(older.git).toEqual({ repo: '/code/weave', worktree: '/code/weave.feature-auth', branch: 'feature/auth' });
    expect(subdirectory(older)).toBe('src');
    expect(inRepo.map(subdirectory)).toEqual(['tui', undefined, undefined, undefined, undefined, undefined]);
    expect(directories(threadListView(inRepo, [mac], { query: 'feature/' }))[0].threads.map(({ threadId }) => threadId))
      .toEqual(['auth', 'older']);
  });

  it('filters by title, directory and agent', () => {
    const codex = thread('mac', 'docs', '/code/site', 5, { agentId: 'codex', agentName: 'Codex', title: 'Write docs' });
    const all = [...threads, codex];
    expect(directories(threadListView(all, [mac], { query: 'TRACK' })).map(({ name }) => name)).toEqual(['trackpad']);
    expect(directories(threadListView(all, [mac], { query: 'codex' })).map(({ name }) => name)).toEqual(['site']);
    expect(directories(threadListView(all, [mac], { query: 'write' }))[0].threads[0].threadId).toBe('docs');
    expect(threadListView(all, [mac], { query: 'nothing' }).hosts).toEqual([]);
  });
});

it('counts the threads waiting other than the one on screen', () => {
  const threads = [
    thread('mac', 'a', '/a', 1, { activity: 'waiting' }),
    thread('mac', 'b', '/b', 2, { activity: 'waiting' }),
    thread('mac', 'c', '/c', 3, { activity: 'running' }),
  ];
  expect(waitingCount(threads)).toBe(2);
  expect(waitingCount(threads, 'mac/a')).toBe(1);
});

it('lists a Host\'s known directories once each, most recent first', () => {
  const threads = [
    thread('mac', 'a', '/a', 1),
    thread('mac', 'b', '/b', 3),
    thread('mac', 'c', '/a', 2),
    thread('server', 'd', '/d', 9),
  ];
  expect(knownDirectories(threads, 'mac')).toEqual(['/b', '/a']);
});
