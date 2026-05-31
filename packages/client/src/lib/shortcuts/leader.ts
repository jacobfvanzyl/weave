import { findLeaderShortcutBinding, isModifierOnlyShortcutKey } from './matcher';
import type { NormalizedShortcutEvent, ShortcutBinding, ShortcutCommandId, ShortcutContext } from './types';

export type ShortcutLeaderState = {
  active: boolean;
  message?: string;
  sequence: NormalizedShortcutEvent[];
};

export type ShortcutLeaderResult = {
  commandId?: ShortcutCommandId;
  consumed: boolean;
  state: ShortcutLeaderState;
};

export const inactiveShortcutLeaderState: ShortcutLeaderState = { active: false, sequence: [] };

export const startShortcutLeader = (): ShortcutLeaderState => ({
  active: true,
  sequence: [],
});

export const reduceShortcutLeaderKey = ({
  bindings,
  context,
  event,
  state,
}: {
  bindings: readonly ShortcutBinding[];
  context: ShortcutContext;
  event: NormalizedShortcutEvent;
  state: ShortcutLeaderState;
}): ShortcutLeaderResult => {
  if (!state.active) return { consumed: false, state };

  if (isModifierOnlyShortcutKey(event)) return { consumed: false, state };
  if (event.key === 'escape') return { consumed: true, state: inactiveShortcutLeaderState };

  const sequence = [...state.sequence, event];
  const match = findLeaderShortcutBinding(bindings, sequence, context);
  if (match.type === 'exact') {
    return {
      commandId: match.binding.commandId,
      consumed: true,
      state: inactiveShortcutLeaderState,
    };
  }

  if (match.type === 'partial') {
    return {
      consumed: true,
      state: {
        active: true,
        sequence,
      },
    };
  }

  return {
    consumed: true,
    state: {
      active: true,
      message: 'No command',
      sequence: [],
    },
  };
};
