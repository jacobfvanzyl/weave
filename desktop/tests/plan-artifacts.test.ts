import { describe, expect, it } from 'vitest';
import {
  __planArtifactTest,
  planArtifactVersion,
  type PlanFrontmatter,
} from '../../server/src/mastra/tools/plan-artifacts';

const frontmatter = (overrides: Partial<PlanFrontmatter> = {}): PlanFrontmatter => ({
  weave_plan_version: planArtifactVersion,
  id: 'bright-river',
  title: 'Plan Artifact Overhaul',
  status: 'in_progress',
  scope: 'git',
  shared: false,
  thread_ids: ['thread_abc123'],
  path: '.agents/plans/bright-river.md',
  updated_at: '2026-06-18T12:00:00.000Z',
  checklist: [
    { id: 'research', text: 'Research current plan tooling', status: 'completed' },
    { id: 'implement', text: 'Implement artifact-aware plan tools', status: 'in_progress' },
  ],
  ...overrides,
});

describe('plan artifact helpers', () => {
  it('renders and parses canonical YAML frontmatter and body sections', () => {
    const content = __planArtifactTest.renderPlanArtifact(frontmatter(), {
      purpose: 'Replace checklist-only plan state with artifact-backed ExecPlans.',
      context: 'Server tools live in server/src/mastra/tools.',
      requirements: '- Git-only\n- UI-readable frontmatter',
      planOfWork: 'Build helper, tools, UI hydration, and tests.',
      concreteSteps: '1. Add helper\n2. Replace tool\n3. Update client',
      validation: 'Run focused unit tests and build/typecheck.',
    });

    const parsed = __planArtifactTest.parsePlanArtifact(content);
    expect(parsed.frontmatter).toMatchObject({
      weave_plan_version: 1,
      id: 'bright-river',
      status: 'in_progress',
      path: '.agents/plans/bright-river.md',
    });
    expect(parsed.sections.progress).toContain('- [x] Research current plan tooling');
    expect(parsed.sections.progress).toContain('- [ ] Implement artifact-aware plan tools (in progress)');
    expect(parsed.sections.context).toContain('server/src/mastra/tools');
  });

  it('rejects paths outside .agents/plans docker-style markdown files', () => {
    expect(__planArtifactTest.validatePlanPath('.agents/plans/bright-river.md')).toBe('.agents/plans/bright-river.md');
    expect(() => __planArtifactTest.validatePlanPath('.agents/plan.md')).toThrow(/planPath/);
    expect(() => __planArtifactTest.validatePlanPath('.agents/plans/../plan.md')).toThrow(/planPath/);
    expect(() => __planArtifactTest.validatePlanPath('.agents/plans/BrightRiver.md')).toThrow(/planPath/);
  });

  it('normalizes checklist ids and rejects unknown or duplicate in-progress updates', () => {
    const checklist = __planArtifactTest.normalizeChecklist([
      { text: 'Read AGENTS.md', status: 'completed' },
      { text: 'Read AGENTS.md', status: 'pending' },
      { id: 'Wire UI', text: 'Wire UI', status: 'pending' },
    ]);

    expect(checklist.map(item => item.id)).toEqual(['read-agentsmd', 'read-agentsmd-2', 'wire-ui']);
    expect(() => __planArtifactTest.applyChecklistUpdates(checklist, [
      { id: 'missing', status: 'completed' },
    ])).toThrow(/Unknown checklist id/);
    expect(() => __planArtifactTest.applyChecklistUpdates(checklist, [
      { id: 'read-agentsmd', status: 'in_progress' },
      { id: 'wire-ui', status: 'in_progress' },
    ])).toThrow(/At most one/);
  });

  it('appends living-plan section updates with timestamps and blockers', () => {
    const updated = __planArtifactTest.applyPlanSectionUpdates({
      progress: '- [ ] Existing generated item',
      surprises: '- None yet.',
    }, {
      progress: ['Server helper parses YAML frontmatter.'],
      blockers: ['Need a concrete thread id for metadata refresh.'],
      decisions: ['Use top-level YAML as the only parse surface.'],
      validation: ['Vitest helper coverage passes.'],
    }, '2026-06-18T12:05:00.000Z');

    expect(updated.progress).toContain('Server helper parses YAML frontmatter.');
    expect(updated.surprises).toContain('Blocked: Need a concrete thread id for metadata refresh.');
    expect(updated.decisions).toContain('Use top-level YAML as the only parse surface.');
    expect(updated.validation).toContain('Vitest helper coverage passes.');
  });

  it('allocates a suffixed docker-style plan path after generated collisions', async () => {
    const occupied = new Set(['.agents/plans/bright-anchor.md']);
    const path = await __planArtifactTest.resolveUniquePlanPath(
      candidate => occupied.has(candidate),
      () => 0,
    );

    expect(path).toBe('.agents/plans/bright-anchor-1.md');
  });
});
