import type { ThreadProposalItem } from '../stores/chat-store';

export type ProposalReviewUpdate = {
  expected: ThreadProposalItem;
  next: Pick<ThreadProposalItem, 'status' | 'viewed'> & { comment?: string };
};

export const sameReviewedProposalItem = (expected: ThreadProposalItem, latest: ThreadProposalItem | undefined) =>
  Boolean(
    latest
      && latest.kind === expected.kind
      && latest.path === expected.path
      && latest.currentHash === expected.currentHash
      && latest.proposedHash === expected.proposedHash,
  );

export const withReviewFields = (
  item: ThreadProposalItem,
  review: ProposalReviewUpdate['next'],
): ThreadProposalItem => {
  const next = {
    ...item,
    status: review.status,
    viewed: review.viewed,
  };
  if (review.comment !== undefined) {
    return { ...next, comment: review.comment };
  }
  const withoutComment = { ...next };
  delete withoutComment.comment;
  return withoutComment;
};

export const getProposalReviewUpdates = (
  currentItems: ThreadProposalItem[],
  nextItems: ThreadProposalItem[],
) => {
  const currentById = new Map(currentItems.map(item => [item.id, item]));
  const updates: ProposalReviewUpdate[] = [];
  for (const next of nextItems) {
    const current = currentById.get(next.id);
    if (!current) continue;
    if (
      current.status === next.status
      && current.viewed === next.viewed
      && current.comment === next.comment
    ) continue;
    updates.push({
      expected: current,
      next: {
        status: next.status,
        viewed: next.viewed,
        ...(next.comment !== undefined ? { comment: next.comment } : {}),
      },
    });
  }
  return updates;
};
