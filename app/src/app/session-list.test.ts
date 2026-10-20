import { describe, expect, it } from 'vitest';
import type { PairedHost, SessionSummary } from './app-controller';
import { knownDirectories, sessionListView, waitingCount } from './session-list';

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

  it('groups by directory, newest groups and sessions first, with waiting sessions also on top', () => {
    const view = sessionListView(sessions, [mac]);
    expect(view.needsYou.map(({ sessionId }) => sessionId)).toEqual(['pad']);
    expect(view.groups.map(({ name }) => name)).toEqual(['weave', 'trackpad']);
    expect(view.groups[0].sessions.map(({ sessionId }) => sessionId)).toEqual(['new', 'old']);
  });

  it('hides closed sessions unless asked for them', () => {
    expect(sessionListView(sessions, [mac]).groups[0].sessions).toHaveLength(2);
    expect(sessionListView(sessions, [mac], { showClosed: true }).groups[0].sessions.map(({ sessionId }) => sessionId))
      .toEqual(['gone', 'new', 'old']);
  });

  it('keeps the same directory on two Hosts apart, and names Hosts only when there are several', () => {
    const server = host('server', 'server.example.ts.net');
    const both = [...sessions, session('server', 'remote', '/code/weave', 70)];
    expect(sessionListView(both, [mac]).groups.every(({ hostName }) => hostName === undefined)).toBe(true);
    const groups = sessionListView(both, [mac, server]).groups;
    expect(groups.map(({ hostName, name }) => `${hostName} ${name}`)).toEqual([
      'server.example.ts.net weave',
      'mac.example.ts.net weave',
      'mac.example.ts.net trackpad',
    ]);
  });

  it('filters by title, directory and agent', () => {
    const codex = session('mac', 'docs', '/code/site', 5, { agentId: 'codex', agentName: 'Codex', title: 'Write docs' });
    const all = [...sessions, codex];
    expect(sessionListView(all, [mac], { query: 'TRACK' }).groups.map(({ name }) => name)).toEqual(['trackpad']);
    expect(sessionListView(all, [mac], { query: 'codex' }).groups.map(({ name }) => name)).toEqual(['site']);
    expect(sessionListView(all, [mac], { query: 'write' }).groups[0].sessions[0].sessionId).toBe('docs');
    expect(sessionListView(all, [mac], { query: 'nothing' }).groups).toEqual([]);
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
