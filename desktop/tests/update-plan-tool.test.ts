import { describe, expect, it } from 'vitest';
import { __updatePlanToolTest } from '../../server/src/agent/mastra/tools/update-plan-tool';

describe('update_plan tool', () => {
  it('builds a complete lightweight thread plan snapshot', () => {
    const input = __updatePlanToolTest.updatePlanInputSchema.parse({
      title: 'Plan simplification',
      explanation: 'Switch to thread state.',
      artifactPath: '.agents/plans/plan-simplification.md',
      plan: [
        { step: 'Inspect the current flow', status: 'completed' },
        { step: '  Replace   artifact tooling  ', status: 'in_progress' },
        { step: 'Verify the client state', status: 'pending' },
      ],
    });

    expect(__updatePlanToolTest.buildPlanSnapshot(input, '2026-07-10T12:00:00.000Z')).toEqual({
      title: 'Plan simplification',
      artifactPath: '.agents/plans/plan-simplification.md',
      status: 'in_progress',
      plan: [
        { step: 'Inspect the current flow', status: 'completed' },
        { step: 'Replace artifact tooling', status: 'in_progress' },
        { step: 'Verify the client state', status: 'pending' },
      ],
      completed: 1,
      total: 3,
      updatedAt: '2026-07-10T12:00:00.000Z',
    });
  });

  it('derives blocked and completed overall status from the current steps', () => {
    expect(__updatePlanToolTest.inferPlanStatus([
      { step: 'One', status: 'completed' },
      { step: 'Two', status: 'blocked' },
    ])).toBe('blocked');
    expect(__updatePlanToolTest.inferPlanStatus([
      { step: 'One', status: 'completed' },
      { step: 'Two', status: 'completed' },
    ])).toBe('completed');
  });

  it('rejects multiple in-progress steps and unsafe artifact paths', () => {
    expect(__updatePlanToolTest.updatePlanInputSchema.safeParse({
      title: 'Parallel work',
      plan: [
        { step: 'One', status: 'in_progress' },
        { step: 'Two', status: 'in_progress' },
      ],
    }).success).toBe(false);

    for (const artifactPath of ['/tmp/plan.md', '../plan.md', 'C:\\plan.md', '.agents/plans/plan.txt']) {
      expect(__updatePlanToolTest.validArtifactPath(artifactPath)).toBe(false);
    }
    expect(__updatePlanToolTest.validArtifactPath('PLANS.md')).toBe(true);
    expect(__updatePlanToolTest.validArtifactPath('docs/plans/migration.md')).toBe(true);
  });

  it('omits the artifact association when the complete replacement does not include one', () => {
    const input = __updatePlanToolTest.updatePlanInputSchema.parse({
      title: 'Thread-only plan',
      plan: [{ step: 'Answer the question', status: 'pending' }],
    });
    expect('artifactPath' in __updatePlanToolTest.buildPlanSnapshot(input, '2026-07-10T12:00:00.000Z')).toBe(false);
  });
});
