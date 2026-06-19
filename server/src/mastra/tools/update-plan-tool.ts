import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { formatToolModelOutput } from './model-output';
import {
  applyChecklistUpdates,
  applyPlanSectionUpdates,
  normalizeChecklist,
  overallPlanStatusSchema,
  parsePlanArtifact,
  planChecklistItemSchema,
  planDirectory,
  planFrontmatterSchema,
  planSnapshotFromFrontmatter,
  planStatusSchema,
  renderPlanArtifact,
  resolveUniquePlanPath,
  slugifyPlanId,
  validatePlanPath,
  type PlanChecklistItem,
  type PlanSections,
  type PlanStatus,
} from './plan-artifacts';
import { getThreadBinding, offlineMessage, routePortalTool } from './portal-tools';

const planStepCompatSchema = z.object({
  step: z.string().min(1).max(240),
  status: planStatusSchema,
}).strict();

const planToolOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  updated: z.boolean(),
  version: z.number().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  status: overallPlanStatusSchema.optional(),
  checklist: z.array(planChecklistItemSchema).optional(),
  completed: z.number().optional(),
  total: z.number().optional(),
  updatedAt: z.string().optional(),
  contentHash: z.string().optional(),
  plan: z.array(planStepCompatSchema).optional(),
  bytes: z.number().optional(),
}).strict();

const checklistInputSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  text: z.string().min(1).max(240),
  status: planStatusSchema.optional(),
}).strict();

const writePlanInputSchema = z.object({
  title: z.string().min(1).max(160).describe('Human-readable plan title. Use the feature, migration, refactor, or spike name.'),
  planPath: z.string().optional().describe(`Optional existing or requested artifact path. Must be ${planDirectory}/<docker-style-name>.md.`),
  shared: z.boolean().optional().describe('Set true when more than one thread is expected to collaborate on the same artifact.'),
  status: overallPlanStatusSchema.optional().describe('Overall plan status. Usually in_progress for active implementation plans.'),
  checklist: z.array(checklistInputSchema).min(1).max(80).describe('Canonical UI checklist. Keep items concrete and stable; at most one may be in_progress.'),
  sections: z.object({
    purpose: z.string().min(1).describe('Purpose / Big Picture. Explain the outcome and why it matters.'),
    context: z.string().min(1).describe('Context and Orientation. Name concrete files, modules, commands, schemas, routes, interfaces, conventions, and local plan standards found during inspection.'),
    requirements: z.string().min(1).describe('Requirements. Include explicit user requirements and acceptance criteria.'),
    planOfWork: z.string().min(1).describe('Plan of Work. High-level implementation strategy.'),
    concreteSteps: z.string().min(1).describe('Concrete Steps. Ordered, repo-specific steps an agent can execute.'),
    validation: z.string().min(1).describe('Validation and Acceptance. Commands, tests, manual checks, and expected results.'),
    nonGoals: z.string().optional().describe('Non-goals. Boundaries and things intentionally not changing.'),
    assumptions: z.string().optional().describe('Assumptions. Record non-blocking ambiguity instead of leaving it implicit.'),
    idempotence: z.string().optional().describe('Idempotence and Recovery. How to resume, retry, or recover safely.'),
    artifacts: z.string().optional().describe('Artifacts and Notes. Related branches, PRs, logs, docs, or generated assets.'),
    interfaces: z.string().optional().describe('Interfaces and Dependencies. APIs, tool contracts, package boundaries, schemas, and external dependencies.'),
    progress: z.string().optional().describe('Additional progress notes. The rendered checklist is generated from frontmatter.'),
    surprises: z.string().optional().describe('Surprises & Discoveries found during planning.'),
    decisions: z.string().optional().describe('Decision Log entries made during planning.'),
    outcomes: z.string().optional().describe('Outcomes & Retrospective, usually left as None yet while authoring.'),
  }).strict(),
}).strict().refine(
  value => value.checklist.filter(item => item.status === 'in_progress').length <= 1,
  { message: 'At most one checklist item can be in_progress', path: ['checklist'] },
);

const checklistUpdateInputSchema = z.object({
  id: z.string().min(1).max(80).describe('Existing checklist item id from the artifact frontmatter.'),
  status: planStatusSchema.describe('New status for the checklist item.'),
  text: z.string().min(1).max(240).optional().describe('Optional replacement text for this checklist item.'),
}).strict();

const updatePlanInputSchema = z.object({
  planPath: z.string().optional().describe(`Optional artifact path to update. Omit to use the thread's latest plan. Must be ${planDirectory}/<docker-style-name>.md.`),
  status: overallPlanStatusSchema.optional().describe('New overall plan status. Set blocked before asking the user a blocking question.'),
  checklist: z.array(checklistUpdateInputSchema).max(80).optional().describe('Checklist updates by existing id. Unknown ids are rejected.'),
  progress: z.array(z.string().min(1)).max(40).optional().describe('Progress notes to append at meaningful stopping points.'),
  surprises: z.array(z.string().min(1)).max(40).optional().describe('Surprises & Discoveries to append.'),
  decisions: z.array(z.string().min(1)).max(40).optional().describe('Decision Log entries to append.'),
  validation: z.array(z.string().min(1)).max(40).optional().describe('Validation and Acceptance notes to append, including commands and outcomes.'),
  blockers: z.array(z.string().min(1)).max(40).optional().describe('Blocking issues to record before asking a specific question.'),
  outcomes: z.array(z.string().min(1)).max(40).optional().describe('Outcomes & Retrospective entries to append.'),
  artifacts: z.array(z.string().min(1)).max(40).optional().describe('Artifact or note references to append.'),
}).strict().refine(value => Boolean(
  value.status
  || value.checklist?.length
  || value.progress?.length
  || value.surprises?.length
  || value.decisions?.length
  || value.validation?.length
  || value.blockers?.length
  || value.outcomes?.length
  || value.artifacts?.length
), { message: 'Provide at least one plan update' });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const toolError = (error: unknown, path?: string) => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
  updated: false,
  ...(path ? { path } : {}),
});

const portalError = (result: unknown, fallback: string) => {
  const record = isRecord(result) ? result : {};
  return typeof record.error === 'string' && record.error ? record.error : fallback;
};

const readPortalFile = async (path: string, context: any) => {
  const result = await routePortalTool('read', { path }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok !== true) return { ok: false as const, error: portalError(result, `Unable to read ${path}`) };
  if (typeof record.content !== 'string') return { ok: false as const, error: `Portal read returned no content for ${path}` };
  return { ok: true as const, content: record.content };
};

const writePortalFile = async (path: string, content: string, context: any) => {
  const result = await routePortalTool('write', { path, content }, context);
  const record = isRecord(result) ? result : {};
  if (record.ok !== true) return { ok: false as const, error: portalError(result, `Unable to write ${path}`) };
  return { ok: true as const, bytes: typeof record.bytes === 'number' ? record.bytes : undefined };
};

const getThreadRecord = async (context: any) => {
  const threadId = context.agent?.threadId;
  const resourceId = context.agent?.resourceId;
  if (!threadId || !resourceId) throw new Error(offlineMessage);

  const agent = await context.mastra?.getAgent('mageHandAgent');
  const memory = await agent?.getMemory();
  if (!memory) throw new Error('mageHandAgent has no memory configured');

  const thread = await memory.getThreadById({ threadId });
  if (!thread || thread.resourceId !== resourceId) throw new Error(offlineMessage);
  return { threadId, resourceId, memory, thread };
};

const getGitPlanBinding = async (context: any) => {
  const binding = await getThreadBinding(context);
  if (binding.projectKind !== 'git') {
    throw new Error('Plan artifacts are only available in Git Project Workspace threads.');
  }
  return binding;
};

const threadIdsWith = (threadIds: string[], threadId: string) =>
  Array.from(new Set([...threadIds, threadId].filter(Boolean)));

const latestPlanPathFromThread = (thread: any) => {
  const metadata = isRecord(thread?.metadata) ? thread.metadata : {};
  const latestPlan = isRecord(metadata.latestPlan) ? metadata.latestPlan : undefined;
  if (typeof latestPlan?.path !== 'string') return undefined;
  try {
    return validatePlanPath(latestPlan.path);
  } catch {
    return undefined;
  }
};

const updateThreadPlanMetadata = async (context: any, snapshot: ReturnType<typeof planSnapshotFromFrontmatter>) => {
  const { threadId, memory, thread } = await getThreadRecord(context);
  const metadata = {
    ...(isRecord(thread.metadata) ? thread.metadata : {}),
    latestPlan: snapshot,
  };

  await (memory as any).updateThread({
    id: threadId,
    title: thread.title,
    metadata,
  });
};

const inferStatus = (checklist: PlanChecklistItem[], fallback: PlanStatus = 'pending') => {
  if (checklist.some(item => item.status === 'blocked')) return 'blocked';
  if (checklist.length > 0 && checklist.every(item => item.status === 'completed')) return 'completed';
  if (checklist.some(item => item.status === 'in_progress')) return 'in_progress';
  return fallback;
};

const basenameFromPlanPath = (path: string) =>
  path.slice(planDirectory.length + 1, -'.md'.length);

const existingPlanForPath = async (path: string, context: any) => {
  const read = await readPortalFile(path, context);
  if (!read.ok) return undefined;
  return parsePlanArtifact(read.content);
};

const uniqueGeneratedPlanPath = (context: any) =>
  resolveUniquePlanPath(async path => {
    const read = await readPortalFile(path, context);
    return read.ok;
  });

const buildSnapshotOutput = (
  snapshot: ReturnType<typeof planSnapshotFromFrontmatter>,
  bytes?: number,
) => ({
  ok: true,
  updated: true,
  ...snapshot,
  ...(bytes !== undefined ? { bytes } : {}),
});

const planModelOutput = (name: string, output: unknown) => {
  const result = isRecord(output) ? output : {};
  const checklist = Array.isArray(result.checklist) ? result.checklist as Array<Record<string, unknown>> : [];
  const body = checklist.map((item, index) => {
    const id = typeof item.id === 'string' ? item.id : `item-${index + 1}`;
    const text = typeof item.text === 'string' ? item.text : typeof item.step === 'string' ? item.step : '';
    return `${index + 1}. ${id} [${item.status ?? 'unknown'}] ${text}`;
  }).join('\n');

  return formatToolModelOutput(name, [
    ['ok', result.ok],
    ['updated', result.updated],
    ['path', result.path],
    ['status', result.status],
    ['completed', result.completed],
    ['total', result.total],
    ['contentHash', result.contentHash],
    ['error', result.error],
  ], body);
};

export const writePlanTool = createTool({
  id: 'write_plan',
  description: [
    'Create or replace a git-scoped ExecPlan artifact at .agents/plans/<docker-style-name>.md.',
    '',
    'Use this for complex features, significant refactors, migrations, cross-cutting changes, architectural changes, risky or production-sensitive work, research/spikes, multi-session tasks, handoffs, or explicit ExecPlan/execution-plan requests.',
    'Do not use this for typo fixes, small single-file edits, simple dependency bumps, mechanical renames, obvious bug fixes, or pure Q&A. If unsure inside a git workspace, create a compact plan rather than no plan.',
    '',
    'Before calling: inspect the repository, read AGENTS.md, and check .agents/PLANS.md or root PLANS.md for local plan standards. Name concrete files, modules, commands, tests, schemas, routes, interfaces, and conventions. Record assumptions instead of leaving non-blocking ambiguity implicit.',
    'This tool authors only the plan artifact; do not modify implementation files while authoring the plan. The top YAML frontmatter is the deterministic UI parse surface; the Markdown body is for humans and agents.',
    'Do not use normal write/edit tools for .agents/plans/*.md except explicit repair/debug work.',
  ].join('\n'),
  inputSchema: writePlanInputSchema,
  outputSchema: planToolOutputSchema,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitPlanBinding(context);
      const { threadId } = await getThreadRecord(context);
      path = input.planPath ? validatePlanPath(input.planPath) : await uniqueGeneratedPlanPath(context);
      const existing = input.planPath ? await existingPlanForPath(path, context).catch(() => undefined) : undefined;
      const checklist = normalizeChecklist(input.checklist);
      const now = new Date().toISOString();
      const id = slugifyPlanId(basenameFromPlanPath(path));
      const frontmatter = planFrontmatterSchema.parse({
        weave_plan_version: 1,
        id,
        title: input.title.trim(),
        status: input.status ?? inferStatus(checklist, 'in_progress'),
        scope: 'git',
        shared: input.shared ?? existing?.frontmatter.shared ?? Boolean(existing?.frontmatter.thread_ids.some(candidate => candidate !== threadId)),
        thread_ids: threadIdsWith(existing?.frontmatter.thread_ids ?? [], threadId),
        path,
        updated_at: now,
        checklist,
      });
      const sections: PlanSections = {
        purpose: input.sections.purpose,
        progress: input.sections.progress,
        surprises: input.sections.surprises,
        decisions: input.sections.decisions,
        outcomes: input.sections.outcomes,
        context: input.sections.context,
        requirements: input.sections.requirements,
        nonGoals: input.sections.nonGoals,
        assumptions: input.sections.assumptions,
        planOfWork: input.sections.planOfWork,
        concreteSteps: input.sections.concreteSteps,
        validation: input.sections.validation,
        idempotence: input.sections.idempotence,
        artifacts: input.sections.artifacts,
        interfaces: input.sections.interfaces,
      };
      const content = renderPlanArtifact(frontmatter, sections);
      const write = await writePortalFile(path, content, context);
      if (!write.ok) return toolError(write.error, path);

      const parsed = parsePlanArtifact(content);
      const snapshot = planSnapshotFromFrontmatter(parsed.frontmatter, content);
      const output = buildSnapshotOutput(snapshot, write.bytes);
      await updateThreadPlanMetadata(context, snapshot);
      return output;
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: output => planModelOutput('write_plan', output),
});

export const updatePlanTool = createTool({
  id: 'update_plan',
  description: [
    'Update an existing git-scoped ExecPlan artifact and refresh the thread plan snapshot.',
    '',
    'Use this after write_plan at meaningful stopping points: when checklist items change, progress is made, surprises are discovered, decisions are made, validation runs, blockers appear, or outcomes/retrospective notes become known.',
    'If blocked, record the blockage in the artifact before asking a specific question. Keep Progress, Surprises & Discoveries, Decision Log, Validation and Acceptance, blockers, and Outcomes & Retrospective current.',
    'Do not use this for trivial todo churn. Do not use normal write/edit tools for .agents/plans/*.md except explicit repair/debug work.',
    'This tool is available only in Git Project Workspace threads. The frontmatter checklist is canonical; the Markdown progress checklist is regenerated from it.',
  ].join('\n'),
  inputSchema: updatePlanInputSchema,
  outputSchema: planToolOutputSchema,
  execute: async (input, context) => {
    let path: string | undefined;
    try {
      await getGitPlanBinding(context);
      const { threadId, thread } = await getThreadRecord(context);
      path = input.planPath ? validatePlanPath(input.planPath) : latestPlanPathFromThread(thread);
      if (!path) throw new Error('No planPath provided and this thread has no latest plan artifact.');

      const read = await readPortalFile(path, context);
      if (!read.ok) return toolError(read.error, path);

      const parsed = parsePlanArtifact(read.content);
      const now = new Date().toISOString();
      const checklist = applyChecklistUpdates(parsed.frontmatter.checklist, input.checklist);
      const status = input.status ?? (input.checklist?.length ? inferStatus(checklist, parsed.frontmatter.status) : parsed.frontmatter.status);
      const frontmatter = planFrontmatterSchema.parse({
        ...parsed.frontmatter,
        status,
        thread_ids: threadIdsWith(parsed.frontmatter.thread_ids, threadId),
        updated_at: now,
        checklist,
      });
      const sections = applyPlanSectionUpdates(parsed.sections, {
        progress: input.progress,
        surprises: input.surprises,
        decisions: input.decisions,
        validation: input.validation,
        blockers: input.blockers,
        outcomes: input.outcomes,
        artifacts: input.artifacts,
      }, now);
      const content = renderPlanArtifact(frontmatter, sections);
      const write = await writePortalFile(path, content, context);
      if (!write.ok) return toolError(write.error, path);

      const snapshot = planSnapshotFromFrontmatter(frontmatter, content);
      const output = buildSnapshotOutput(snapshot, write.bytes);
      await updateThreadPlanMetadata(context, snapshot);
      return output;
    } catch (error) {
      return toolError(error, path);
    }
  },
  toModelOutput: output => planModelOutput('update_plan', output),
});
