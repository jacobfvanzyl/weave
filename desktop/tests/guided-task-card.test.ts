import { describe, expect, it } from 'vitest';
import { guidedTaskDisplay, proposalSummary } from '../../packages/client/src/components/chat/guided-task-card-display';
import type { ThreadPlan, ThreadProposal } from '../../packages/client/src/stores/chat-store';

const plan = (overrides: Partial<ThreadPlan> = {}): ThreadPlan => ({
  title: 'Trap Readings Module',
  plan: [
    { id: 'schema', step: 'Confirm Trap Readings base and transactional data models', status: 'completed' },
    { id: 'screens', step: 'Implement Trap Readings screens', status: 'pending' },
  ],
  completed: 1,
  total: 2,
  updatedAt: '2026-06-18T12:00:00.000Z',
  ...overrides,
});

const proposal = (overrides: Partial<ThreadProposal> = {}): ThreadProposal => ({
  title: 'Proposal review',
  items: [],
  counts: {},
  updatedAt: '2026-06-18T12:00:00.000Z',
  ...overrides,
});

describe('guided task card display', () => {
  it('moves the plan name into the title row when expanded', () => {
    expect(guidedTaskDisplay(plan(), undefined, true)).toMatchObject({
      titleRow: 'Trap Readings Module',
      bodyTitle: undefined,
    });
  });

  it('moves the plan name into the title row when complete', () => {
    expect(guidedTaskDisplay(plan({ completed: 2 }), undefined, false)).toMatchObject({
      titleRow: 'Trap Readings Module',
      bodyTitle: undefined,
    });
  });

  it('keeps the first in-progress item in the title row while running', () => {
    expect(guidedTaskDisplay(plan({
      plan: [
        { id: 'schema', step: 'Confirm Trap Readings base and transactional data models', status: 'completed' },
        { id: 'screens', step: 'Implement Trap Readings screens', status: 'in_progress' },
      ],
    }), undefined, true)).toMatchObject({
      titleRow: 'Implement Trap Readings screens',
      bodyTitle: 'Trap Readings Module',
    });
  });

  it('does not use proposal item count as body summary fallback', () => {
    expect(proposalSummary(proposal({
      items: [
        { id: 'item-1', kind: 'file_edit', status: 'applied', title: 'Update file', additions: 1, deletions: 0, viewed: false },
      ],
    }))).toBeUndefined();
  });
});
