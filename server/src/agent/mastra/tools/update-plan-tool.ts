import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { toolDescription, toolInputDescription } from './instructions';
import { formatToolModelOutput } from './model-output';

const planStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'blocked']);

const planItemSchema = z.object({
  step: z.string().trim().min(1).max(240).describe(toolInputDescription('update_plan', 'plan[].step')),
  status: planStatusSchema.describe(toolInputDescription('update_plan', 'plan[].status')),
}).strict();

const validArtifactPath = (path: string) => {
  if (path.startsWith('/') || /^[a-zA-Z]:/.test(path) || path.includes('\\') || path.includes('//')) return false;
  if (path.split('/').some(part => part === '..')) return false;
  return path.toLowerCase().endsWith('.md');
};

const updatePlanInputSchema = z.object({
  title: z.string().trim().min(1).max(160).describe(toolInputDescription('update_plan', 'title')),
  explanation: z.string().trim().min(1).max(800).optional().describe(
    toolInputDescription('update_plan', 'explanation'),
  ),
  artifactPath: z.string().trim().min(1).max(512).refine(validArtifactPath, {
    message: 'artifactPath must be a workspace-relative Markdown path without traversal',
  }).optional().describe(toolInputDescription('update_plan', 'artifactPath')),
  plan: z.array(planItemSchema).min(1).max(12).describe(toolInputDescription('update_plan', 'plan')),
}).strict().refine(
  value => value.plan.filter(item => item.status === 'in_progress').length <= 1,
  { message: 'At most one plan item can be in_progress', path: ['plan'] },
);

const updatePlanOutputSchema = z.object({
  title: z.string(),
  artifactPath: z.string().optional(),
  status: planStatusSchema,
  plan: z.array(planItemSchema),
  completed: z.number(),
  total: z.number(),
  updatedAt: z.string(),
  updated: z.boolean(),
  error: z.string().optional(),
}).strict();

type PlanItem = z.infer<typeof planItemSchema>;

const inferPlanStatus = (plan: PlanItem[]) => {
  if (plan.some(item => item.status === 'blocked')) return 'blocked' as const;
  if (plan.every(item => item.status === 'completed')) return 'completed' as const;
  if (plan.some(item => item.status === 'in_progress')) return 'in_progress' as const;
  return 'pending' as const;
};

const buildPlanSnapshot = (input: z.infer<typeof updatePlanInputSchema>, updatedAt = new Date().toISOString()) => {
  const plan = input.plan.map(item => ({ ...item, step: item.step.replace(/\s+/g, ' ').trim() }));
  return {
    title: input.title,
    ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}),
    status: inferPlanStatus(plan),
    plan,
    completed: plan.filter(item => item.status === 'completed').length,
    total: plan.length,
    updatedAt,
  };
};

const updatePlanModelOutput = (output: unknown) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  const plan = Array.isArray(result.plan) ? result.plan as Array<Record<string, unknown>> : [];
  return formatToolModelOutput('update_plan', [
    ['updated', result.updated],
    ['title', result.title],
    ['status', result.status],
    ['artifactPath', result.artifactPath],
    ['completed', result.completed],
    ['total', result.total],
    ['error', result.error],
  ], plan.map((item, index) => `${index + 1}. [${item.status ?? 'unknown'}] ${item.step ?? ''}`).join('\n'));
};

export const updatePlanTool = createTool({
  id: 'update_plan',
  description: toolDescription('update_plan'),
  inputSchema: updatePlanInputSchema,
  outputSchema: updatePlanOutputSchema,
  execute: async (input, context) => {
    const snapshot = buildPlanSnapshot(input);
    const threadId = context.agent?.threadId;
    const resourceId = context.agent?.resourceId;
    if (!threadId || !resourceId) {
      return { ...snapshot, updated: false, error: 'No active thread context is available.' };
    }

    const agent = await context.mastra?.getAgent('mageHandAgent');
    const memory = await agent?.getMemory();
    if (!memory) return { ...snapshot, updated: false, error: 'mageHandAgent has no memory configured.' };

    const thread = await memory.getThreadById({ threadId });
    if (!thread || thread.resourceId !== resourceId) {
      return { ...snapshot, updated: false, error: 'The active thread could not be resolved.' };
    }

    await (memory as any).updateThread({
      id: threadId,
      title: thread.title,
      metadata: {
        ...(thread.metadata as Record<string, unknown> | undefined),
        latestPlan: snapshot,
      },
    });

    return { ...snapshot, updated: true };
  },
  toModelOutput: updatePlanModelOutput,
});

export const __updatePlanToolTest = {
  buildPlanSnapshot,
  inferPlanStatus,
  updatePlanInputSchema,
  validArtifactPath,
};
