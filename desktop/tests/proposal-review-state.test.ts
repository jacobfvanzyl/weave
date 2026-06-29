import { describe, expect, it } from 'vitest';
import { getPendingProposalReviewCount, shouldShowProposalReview } from '../../packages/client/src/lib/proposal-review-state';
import type { ThreadProposal } from '../../packages/client/src/stores/chat-store';

const proposal = (overrides: Partial<ThreadProposal> = {}): ThreadProposal => ({
  path: '.agents/proposals/demo.md',
  items: [
    {
      id: 'item-1',
      kind: 'file_edit',
      status: 'pending',
      title: 'Edit file',
      path: 'src/file.ts',
      additions: 1,
      deletions: 0,
      viewed: false,
    },
  ],
  counts: { pending: 1 },
  updatedAt: '2026-06-29T10:00:00.000Z',
  ...overrides,
});

describe('proposal review state', () => {
  it('shows review only for proposals with pending approvals and an artifact path', () => {
    expect(shouldShowProposalReview(proposal())).toBe(true);
    expect(shouldShowProposalReview(proposal({ path: undefined }))).toBe(false);
    expect(shouldShowProposalReview(proposal({
      counts: { approved: 1, pending: 0 },
      items: [{ ...proposal().items[0], status: 'approved' }],
      status: 'approved',
    }))).toBe(false);
    expect(shouldShowProposalReview(proposal({
      counts: { changes_requested: 1, pending: 0 },
      items: [{ ...proposal().items[0], status: 'changes_requested' }],
      status: 'changes_requested',
    }))).toBe(false);
    expect(shouldShowProposalReview(proposal({
      counts: { stale: 1, pending: 0 },
      items: [{ ...proposal().items[0], status: 'stale' }],
      status: 'stale',
    }))).toBe(false);
  });

  it('falls back to item status counts when frontmatter counts omit pending', () => {
    expect(getPendingProposalReviewCount(proposal({
      counts: {},
      items: [
        { ...proposal().items[0], status: 'approved' },
        { ...proposal().items[0], id: 'item-2', status: 'pending' },
      ],
    }))).toBe(1);
  });
});
