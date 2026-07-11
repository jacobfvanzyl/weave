import { describe, expect, it } from 'vitest';
import { guidedTaskDisplay, hasVisibleGuidedTask } from '../../packages/client/src/components/chat/guided-task-card-display';
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

  it('uses the plan name when expanded even while a step is running', () => {
    expect(guidedTaskDisplay(plan({
      plan: [
        { id: 'schema', step: 'Confirm Trap Readings base and transactional data models', status: 'completed' },
        { id: 'screens', step: 'Implement Trap Readings screens', status: 'in_progress' },
      ],
    }), undefined, true)).toMatchObject({
      titleRow: 'Trap Readings Module',
      bodyTitle: undefined,
    });
  });

  it('uses the current task when collapsed and running', () => {
    expect(guidedTaskDisplay(plan({
      plan: [
        { id: 'schema', step: 'Confirm Trap Readings base and transactional data models', status: 'completed' },
        { id: 'screens', step: 'Implement Trap Readings screens', status: 'in_progress' },
      ],
    }), undefined, false)).toMatchObject({
      titleRow: 'Implement Trap Readings screens',
      bodyTitle: 'Trap Readings Module',
    });
  });

  it('does not show proposal status counts in the card body summary', () => {
    expect(guidedTaskDisplay(plan(), proposal({
      counts: { approved: 2, pending: 12, changes_requested: 1 },
    }), true)).toMatchObject({
      summary: undefined,
    });
  });

  it('hides proposal-only guided cards while the proposal workflow is disabled', () => {
    expect(hasVisibleGuidedTask(undefined, proposal())).toBe(false);
    expect(hasVisibleGuidedTask(plan(), proposal())).toBe(true);
  });
});
