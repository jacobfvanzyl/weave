import type { ThreadProposal } from '../stores/chat-store';

export const getPendingProposalReviewCount = (
  proposal: Pick<ThreadProposal, 'counts' | 'items'> | undefined,
) => proposal?.counts.pending ?? proposal?.items.filter(item => item.status === 'pending').length ?? 0;

export const shouldShowProposalReview = (
  proposal: Pick<ThreadProposal, 'path' | 'counts' | 'items'> | undefined,
) => Boolean(proposal?.path && getPendingProposalReviewCount(proposal) > 0);
