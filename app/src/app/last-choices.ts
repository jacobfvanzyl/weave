// What this device chose last when it started something (WVE-220): the defaults New Session and
// New Block open with. The device's own, as its view of a layout is, and never written to one.

/** What a Session starts with: a thread of an agent, or a terminal. */
export type StartWith = { kind: 'thread'; agentId: string } | { kind: 'terminal' };

export type LastChoices = {
  /** The agent last given a thread. */
  agentId?: string;
  /** Whether the last Session started with a terminal. */
  terminal?: boolean;
  /** The Host last started on outside a Project. */
  hostId?: string;
};

const STORAGE_KEY = 'weave.last-choices';

export function loadLastChoices(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): LastChoices {
  try {
    const kept: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? '{}');
    if (typeof kept !== 'object' || kept === null) return {};
    const { agentId, terminal, hostId } = kept as Record<string, unknown>;
    return {
      ...(typeof agentId === 'string' ? { agentId } : {}),
      ...(terminal === true ? { terminal } : {}),
      ...(typeof hostId === 'string' ? { hostId } : {}),
    };
  } catch {
    return {};
  }
}

export function saveLastChoices(change: LastChoices, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ ...loadLastChoices(storage), ...change }));
  } catch {
    // Full or unavailable: the defaults are the first of each list.
  }
}

/** `agents` with the one last used first, when it's among them. */
export const lastUsedFirst = <Agent extends { id: string }>(agents: readonly Agent[], agentId: string | undefined): Agent[] =>
  [...agents.filter(({ id }) => id === agentId), ...agents.filter(({ id }) => id !== agentId)];
