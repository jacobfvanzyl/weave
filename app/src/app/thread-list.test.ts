import { expect, it } from 'vitest';
import type { ThreadSummary } from './app-controller';
import { knownDirectories, subdirectory, waitingCount } from './thread-list';

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

it('says where in its worktree a thread runs, when that isn’t its top', () => {
  const git = { repo: '/code/weave', worktree: '/code/weave', branch: 'main' };
  expect(subdirectory(thread('mac', 'a', '/code/weave/tui', 1, { git }))).toBe('tui');
  expect(subdirectory(thread('mac', 'b', '/code/weave', 1, { git }))).toBeUndefined();
  expect(subdirectory(thread('mac', 'c', '/code/weave-docs', 1, { git }))).toBeUndefined();
  expect(subdirectory(thread('mac', 'd', '/notes/2026', 1))).toBeUndefined();
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
