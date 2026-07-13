import { z } from 'zod';

export const evalCategorySchema = z.enum([
  'comprehension',
  'editing',
  'debugging',
  'multi_file',
  'long_horizon',
  'interaction',
  'compaction',
  'recovery',
  'safety',
]);

const commandGraderSchema = z.object({
  kind: z.literal('command'),
  command: z.string().min(1),
  timeoutSeconds: z.number().int().positive().default(120),
});

const diffGraderSchema = z.object({
  kind: z.literal('git_diff'),
  allowPaths: z.array(z.string()).default([]),
  denyPaths: z.array(z.string()).default([]),
  requireChange: z.boolean().default(true),
});

const fileGraderSchema = z.object({
  kind: z.literal('file_contains'),
  path: z.string().min(1),
  includes: z.array(z.string()).min(1),
});

const modelGraderSchema = z.object({
  kind: z.literal('model'),
  rubric: z.string().min(1),
  calibrationLabel: z.string().optional(),
});

export const evalGraderSchema = z.discriminatedUnion('kind', [
  commandGraderSchema,
  diffGraderSchema,
  fileGraderSchema,
  modelGraderSchema,
]);

export const evalTaskV1Schema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  category: evalCategorySchema,
  description: z.string().min(1),
  prompt: z.string().min(1),
  critical: z.boolean().default(false),
  fixture: z.object({
    repository: z.string().default('.'),
    revision: z.string().default('HEAD'),
    setupCommand: z.string().optional(),
  }),
  resources: z.object({
    timeoutSeconds: z.number().int().positive().default(900),
    maxSteps: z.number().int().positive().default(64),
    memoryMb: z.number().int().positive().default(4096),
  }),
  sideEffects: z.object({
    executionProfile: z.enum(['observe', 'workspace', 'host']).default('workspace'),
    network: z.enum(['deny', 'allowlist', 'host']).default('deny'),
    allowedDomains: z.array(z.string()).default([]),
  }),
  graders: z.array(evalGraderSchema).min(1),
});

export const evalCatalogV1Schema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string().min(1),
  tasks: z.array(evalTaskV1Schema).min(1),
}).superRefine((catalog, context) => {
  const seen = new Set<string>();
  catalog.tasks.forEach((task, index) => {
    if (seen.has(task.id)) {
      context.addIssue({ code: 'custom', path: ['tasks', index, 'id'], message: 'duplicate task id' });
    }
    seen.add(task.id);
  });
});

export const evalTrialV1Schema = z.object({
  version: z.literal(1),
  suite: z.string(),
  configuration: z.string(),
  taskId: z.string(),
  category: evalCategorySchema.optional(),
  trial: z.number().int().positive(),
  startedAt: z.string(),
  finishedAt: z.string(),
  passed: z.boolean(),
  noHarm: z.boolean(),
  validationPassed: z.boolean(),
  durationMs: z.number().nonnegative(),
  tokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  steeringMessages: z.number().int().nonnegative().optional(),
  traceId: z.string().optional(),
  runId: z.string().optional(),
  graderEvidence: z.array(z.object({
    grader: z.string(),
    passed: z.boolean(),
    detail: z.string().optional(),
  })).default([]),
});

export type EvalTaskV1 = z.infer<typeof evalTaskV1Schema>;
export type EvalCatalogV1 = z.infer<typeof evalCatalogV1Schema>;
export type EvalTrialV1 = z.infer<typeof evalTrialV1Schema>;
