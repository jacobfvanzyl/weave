import { describe, expect, it } from 'vitest';
import { lastUsedFirst, loadLastChoices, saveLastChoices } from './last-choices';

const storage = () => {
  const kept = new Map<string, string>();
  return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
};

describe('what this device chose last', () => {
  it('is kept a choice at a time, and read back', () => {
    const kept = storage();
    expect(loadLastChoices(kept)).toEqual({});
    saveLastChoices({ agentId: 'codex' }, kept);
    saveLastChoices({ terminal: true, hostId: 'h-1' }, kept);
    expect(loadLastChoices(kept)).toEqual({ agentId: 'codex', terminal: true, hostId: 'h-1' });
    // A thread started since: the terminal isn't the default any more.
    saveLastChoices({ agentId: 'claude', terminal: false }, kept);
    expect(loadLastChoices(kept)).toEqual({ agentId: 'claude', hostId: 'h-1' });
  });

  it('is nothing when what was kept is no use, or storage is away', () => {
    const kept = storage();
    kept.setItem('weave.last-choices', '[1');
    expect(loadLastChoices(kept)).toEqual({});
    kept.setItem('weave.last-choices', '{"agentId":3,"terminal":"yes"}');
    expect(loadLastChoices(kept)).toEqual({});
    expect(loadLastChoices(undefined)).toEqual({});
    expect(() => saveLastChoices({ agentId: 'claude' }, undefined)).not.toThrow();
  });

  it('puts the agent used last first, where the Host has it', () => {
    const agents = [{ id: 'claude' }, { id: 'codex' }, { id: 'gemini' }];
    expect(lastUsedFirst(agents, 'codex').map(({ id }) => id)).toEqual(['codex', 'claude', 'gemini']);
    expect(lastUsedFirst(agents, 'gone').map(({ id }) => id)).toEqual(['claude', 'codex', 'gemini']);
    expect(lastUsedFirst(agents, undefined)).toEqual(agents);
  });
});
