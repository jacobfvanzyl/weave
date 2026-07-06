import type { ProposalItemStatus, ThreadProposal, ThreadProposalItem } from '../stores/chat-store';

export const getPendingProposalReviewCount = (
  proposal: Pick<ThreadProposal, 'counts' | 'items'> | undefined,
) => proposal?.counts.pending ?? proposal?.items.filter(item => item.status === 'pending').length ?? 0;

export const canViewProposalReview = (
  proposal: Pick<ThreadProposal, 'path' | 'status' | 'counts' | 'items'> | undefined,
) => Boolean(proposal?.path && proposal.items.length > 0);

export const canSubmitProposalReview = (
  proposal: Pick<ThreadProposal, 'path' | 'status' | 'items'> | undefined,
) => Boolean(proposal?.path && proposal.status && proposal.status !== 'draft' && proposal.items.length > 0);

const reviewedProposalItemStatuses = new Set<ProposalItemStatus>([
  'approved',
  'changes_requested',
  'applied',
  'rejected',
]);

export const isProposalItemAwaitingReview = (
  item: Pick<ThreadProposalItem, 'status'>,
) => !reviewedProposalItemStatuses.has(item.status);

export const getNextProposalReviewItemId = (
  items: Array<Pick<ThreadProposalItem, 'id' | 'status'>>,
  currentItemId: string | undefined,
) => {
  if (items.length === 0) return undefined;

  const currentIndex = currentItemId ? items.findIndex(item => item.id === currentItemId) : -1;
  const startIndex = currentIndex >= 0 ? currentIndex : -1;

  for (let offset = 1; offset <= items.length; offset += 1) {
    const item = items[(startIndex + offset) % items.length];
    if (!item || item.id === currentItemId) continue;
    if (isProposalItemAwaitingReview(item)) return item.id;
  }

  return undefined;
};
