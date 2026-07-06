import { describe, expect, it } from 'vitest';
import {
  canSubmitProposalReview,
  canViewProposalReview,
  getNextProposalReviewItemId,
  getPendingProposalReviewCount,
  isProposalComplete,
} from '../../packages/client/src/lib/proposal-review-state';
import {
  getProposalReviewUpdates,
  sameReviewedProposalItem,
  withReviewFields,
} from '../../packages/client/src/lib/proposal-review-conflict';
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
  it('allows viewing draft or finalized proposals with items and an artifact path', () => {
    expect(canViewProposalReview(proposal())).toBe(true);
    expect(canViewProposalReview(proposal({ status: 'draft' }))).toBe(true);
    expect(canViewProposalReview(proposal({ path: undefined }))).toBe(false);
    expect(canViewProposalReview(proposal({ items: [] }))).toBe(false);
    expect(canViewProposalReview(proposal({
      counts: { approved: 1, pending: 0 },
      items: [{ ...proposal().items[0], status: 'approved' }],
      status: 'approved',
    }))).toBe(true);
    expect(canViewProposalReview(proposal({
      counts: { changes_requested: 1, pending: 0 },
      items: [{ ...proposal().items[0], status: 'changes_requested' }],
      status: 'changes_requested',
    }))).toBe(true);
    expect(canViewProposalReview(proposal({
      counts: { stale: 1, pending: 0 },
      items: [{ ...proposal().items[0], status: 'stale' }],
      status: 'stale',
    }))).toBe(true);
  });

  it('allows submission only after finalization', () => {
    expect(canSubmitProposalReview(proposal({ status: 'ready' }))).toBe(true);
    expect(canSubmitProposalReview(proposal({ status: 'draft' }))).toBe(false);
    expect(canSubmitProposalReview(proposal())).toBe(false);
    expect(canSubmitProposalReview(proposal({ path: undefined }))).toBe(false);
    expect(canSubmitProposalReview(proposal({ items: [] }))).toBe(false);
  });

  it('treats applied proposals as complete', () => {
    const appliedItem = { ...proposal().items[0], status: 'applied' as const, viewed: true };

    expect(isProposalComplete(proposal({ status: 'applied' }))).toBe(true);
    expect(isProposalComplete(proposal({ items: [appliedItem], counts: { applied: 1 } }))).toBe(true);
    expect(isProposalComplete(proposal({ status: 'approved', items: [appliedItem], counts: { approved: 1 } }))).toBe(true);
    expect(isProposalComplete(proposal({ status: 'approved' }))).toBe(false);
    expect(isProposalComplete(proposal({ status: 'draft' }))).toBe(false);
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

  it('finds the next visible proposal item that still needs review', () => {
    const items = [
      { id: 'schema', status: 'pending' as const },
      { id: 'model', status: 'approved' as const },
      { id: 'mapper', status: 'changes_requested' as const },
      { id: 'form', status: 'pending' as const },
    ];

    expect(getNextProposalReviewItemId(items, 'schema')).toBe('form');
    expect(getNextProposalReviewItemId(items, 'form')).toBe('schema');
  });

  it('skips completed review states when advancing proposal review selection', () => {
    expect(getNextProposalReviewItemId([
      { id: 'current', status: 'pending' },
      { id: 'approved', status: 'approved' },
      { id: 'feedback', status: 'changes_requested' },
      { id: 'applied', status: 'applied' },
      { id: 'rejected', status: 'rejected' },
    ], 'current')).toBeUndefined();
  });

  it('rebases review-only fields only when the reviewed item has not changed', () => {
    const current = proposal().items[0];
    const reviewed = {
      ...current,
      status: 'approved' as const,
      viewed: true,
      comment: undefined,
    };
    const [update] = getProposalReviewUpdates([current], [reviewed]);
    expect(update).toMatchObject({
      expected: current,
      next: { status: 'approved', viewed: true },
    });

    const latest = { ...current, currentHash: 'old-hash', proposedHash: 'same-hash' };
    const expected = { ...current, currentHash: 'old-hash', proposedHash: 'same-hash' };
    expect(sameReviewedProposalItem(expected, latest)).toBe(true);
    expect(sameReviewedProposalItem(expected, { ...latest, proposedHash: 'changed-hash' })).toBe(false);
    expect(withReviewFields(latest, update!.next)).toMatchObject({
      status: 'approved',
      viewed: true,
    });
  });
});
