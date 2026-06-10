import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { formatToolModelOutput } from './model-output';

const stepStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

const planItemSchema = z.object({
  step: z.string().min(1).max(120).describe('Short plan step'),
  status: stepStatusSchema.describe('One of: pending, in_progress, completed'),
}).strict();

const updatePlanInputSchema = z.object({
  plan: z.array(planItemSchema).min(1).max(12).describe('The list of steps'),
}).strict().refine(
  value => value.plan.filter(item => item.status === 'in_progress').length <= 1,
  { message: 'At most one step can be in_progress at a time', path: ['plan'] },
);

const updatePlanOutputSchema = z.object({
  plan: z.array(planItemSchema),
  completed: z.number(),
  total: z.number(),
  updated: z.boolean(),
});

const cleanStep = (step: string) =>
  step
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

export const updatePlanTool = createTool({
  id: 'update_plan',
  description: [
    'Updates the task plan.',
    'Provide only a list of plan items, each with a step and status.',
    'Do not include rationale, commentary, notes, or explanatory text in this tool call.',
    'At most one step can be in_progress at a time.',
  ].join('\n'),
  inputSchema: updatePlanInputSchema,
  outputSchema: updatePlanOutputSchema,
  execute: async (input, context) => {
    const threadId = context.agent?.threadId;
    const resourceId = context.agent?.resourceId;
    const plan = input.plan.map(item => ({ ...item, step: cleanStep(item.step) }));
    const completed = plan.filter(item => item.status === 'completed').length;
    const total = plan.length;

    if (!threadId || !resourceId) {
      return { plan, completed, total, updated: false };
    }

    const agent = await context.mastra?.getAgent('mageHandAgent');
    const memory = await agent?.getMemory();
    if (!memory) {
      return { plan, completed, total, updated: false };
    }

    const thread = await memory.getThreadById({ threadId });
    if (!thread || thread.resourceId !== resourceId) {
      return { plan, completed, total, updated: false };
    }

    const metadata = {
      ...(thread.metadata as Record<string, unknown> | undefined),
      latestPlan: {
        plan,
        completed,
        total,
        updatedAt: new Date().toISOString(),
      },
    };

    await (memory as any).updateThread({
      id: threadId,
      title: thread.title,
      metadata,
    });

    return { plan, completed, total, updated: true };
  },
  toModelOutput: output => {
    const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
    const plan = Array.isArray(result.plan) ? result.plan as Array<Record<string, unknown>> : [];
    return formatToolModelOutput(
      'update_plan',
      [
        ['updated', result.updated],
        ['completed', result.completed],
        ['total', result.total],
      ],
      plan.map((item, index) => `${index + 1}. [${item.status ?? 'unknown'}] ${item.step ?? ''}`).join('\n'),
    );
  },
});
