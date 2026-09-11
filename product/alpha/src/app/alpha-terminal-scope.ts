import type { AlphaViewModel } from './alpha-controller';

export type AlphaTerminalScope = {
  hostId: string;
  contextId: string;
  executionContextId: string;
};

export const alphaTerminalScopeKey = (scope: AlphaTerminalScope) =>
  JSON.stringify([
    scope.hostId,
    scope.executionContextId,
  ]);

export const selectedTerminalScope = (
  model: AlphaViewModel,
): AlphaTerminalScope | undefined => {
  const thread = (model.threads ?? model.executionContexts.flatMap((context) => context.threads)).find((thread) => thread.id === model.selectedThreadId);
  return thread ? { hostId: thread.hostId, contextId: thread.executionContextId, executionContextId: thread.executionContextId } : undefined;
};
