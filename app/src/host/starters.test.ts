import { describe, expect, it } from 'vitest';
import type { PairedHost, SessionSummary } from '@/app/app-controller';
import { labelStarters } from './host-store';

const host = (id: string, name: string): PairedHost => ({ id, name, url: `https://${name}`, status: 'connected' });

const session = (hostId: string, sessionId: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  key: `${hostId}/${sessionId}`,
  hostId,
  sessionId,
  agentId: 'codex',
  agentName: 'Codex',
  cwd: '/work',
  state: 'open',
  clients: 0,
  headless: true,
  ...extra,
});

describe('labelStarters', () => {
  it('names the thread that started one, and its Host when that is another', () => {
    const parent = session('mini', 's1', { title: 'Plan the release' });
    const here = session('mini', 's2', { startedBy: { key: 'mini/s1', label: '' } });
    const there = session('studio', 's3', { startedBy: { key: 'mini/s1', label: '' } });
    const sessions = [parent, here, there];
    labelStarters(sessions, [host('mini', 'mini'), host('studio', 'studio')]);
    expect(here.startedBy).toEqual({ key: 'mini/s1', label: 'from “Plan the release”' });
    expect(there.startedBy).toEqual({ key: 'mini/s1', label: 'from “Plan the release” on mini' });
  });

  it('names a starter it can’t list as well as it can', () => {
    const orphan = session('studio', 's3', { startedBy: { key: 'laptop/s9', label: '' } });
    labelStarters([orphan], [host('studio', 'studio')]);
    expect(orphan.startedBy?.label).toBe('from another thread on another Host');
  });

  it('names the thread one continues in', () => {
    const old = session('mini', 's1', { continuedIn: { key: 'mini/s2', label: '' } });
    const successor = session('mini', 's2', { title: 'Daily, week 2' });
    const gone = session('mini', 's3', { continuedIn: { key: 'mini/s9', label: '' } });
    labelStarters([old, successor, gone], [host('mini', 'mini')]);
    expect(old.continuedIn).toEqual({ key: 'mini/s2', label: '“Daily, week 2”' });
    expect(gone.continuedIn?.label).toBe('another thread');
  });
});
