import type { ThreadPlan } from '../stores/chat-store';

const planUpdatedAtMillis = (plan: Pick<ThreadPlan, 'updatedAt'>) => {
  const millis = Date.parse(plan.updatedAt);
  return Number.isFinite(millis) ? millis : undefined;
};

export const shouldAcceptThreadPlanUpdate = (
  current: Pick<ThreadPlan, 'updatedAt' | 'isBusy'> | undefined,
  incoming: Pick<ThreadPlan, 'updatedAt' | 'isBusy'>,
) => {
  if (!current) return true;
  if (current.isBusy && !incoming.isBusy) return true;

  const currentUpdatedAt = planUpdatedAtMillis(current);
  const incomingUpdatedAt = planUpdatedAtMillis(incoming);
  if (currentUpdatedAt !== undefined && incomingUpdatedAt !== undefined) {
    return incomingUpdatedAt >= currentUpdatedAt;
  }

  return true;
};

export const selectPreferredThreadPlan = (
  current: ThreadPlan | undefined,
  incoming: ThreadPlan | undefined,
  options: { preserveBusy?: boolean } = {},
) => {
  if (!current) return incoming;
  if (!incoming) return current;
  if (options.preserveBusy && current.isBusy && !incoming.isBusy) return current;
  return shouldAcceptThreadPlanUpdate(current, incoming) ? incoming : current;
};
