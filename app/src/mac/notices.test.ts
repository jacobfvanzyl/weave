import { describe, expect, it } from 'vitest';
import type { ThreadSummary } from '@/app/app-controller';
import { noticesFor, threadLink } from './notices';

const thread = (key: string, change: Partial<ThreadSummary> = {}): ThreadSummary => ({
  key,
  hostId: key.split('/')[0],
  threadId: key.split('/')[1],
  agentId: 'claude',
  agentName: 'Claude',
  cwd: '/Users/me/weave',
  state: 'open',
  clients: 1,
  headless: false,
  ...change,
});

describe('the notices the Mac shows', () => {
  it('tells of a thread that starts waiting on the person, and a turn that ends', () => {
    const before = [thread('h/1', { activity: 'running', title: 'Fix the build' }), thread('h/2', { activity: 'running' })];
    const after = [thread('h/1', { activity: 'waiting', title: 'Fix the build', waitingOn: 'permission' }), thread('h/2', { activity: 'idle' })];
    expect(noticesFor(before, after)).toEqual([
      { key: 'h/1', title: 'Fix the build', body: 'Waiting on you: permission' },
      { key: 'h/2', title: 'Claude in weave', body: 'Claude finished its turn.' },
    ]);
  });

  it('says nothing of threads it sees for the first time, or that change otherwise', () => {
    expect(noticesFor([], [thread('h/1', { activity: 'waiting' })])).toEqual([]);
    expect(noticesFor([thread('h/1', { activity: 'idle' })], [thread('h/1', { activity: 'running' })])).toEqual([]);
    expect(noticesFor([thread('h/1', { activity: 'waiting' })], [thread('h/1', { activity: 'running' })])).toEqual([]);
    expect(noticesFor([thread('h/1', { activity: 'idle' })], [thread('h/1', { activity: 'idle', title: 'Renamed' })])).toEqual([]);
  });
});

describe('a link that opens a thread', () => {
  it('names its Host and thread', () => {
    expect(threadLink('weave://thread/h-1/t-2')).toBe('h-1/t-2');
  });

  it("isn't any other link", () => {
    expect(threadLink('weave://pair-dispatcher?url=wss://x&code=1')).toBeUndefined();
    expect(threadLink('weave://thread/h-1')).toBeUndefined();
    expect(threadLink('weave://thread/h-1/t-2/more')).toBeUndefined();
    expect(threadLink('https://thread/h-1/t-2')).toBeUndefined();
    expect(threadLink('not a link')).toBeUndefined();
  });
});
