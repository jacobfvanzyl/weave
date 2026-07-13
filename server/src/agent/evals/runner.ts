import { dirname, fromFileUrl, join, resolve } from 'jsr:@std/path@1.0.9';
import { loadEvalCatalog, loadEvalTrials } from './catalog.ts';
import { type EvalFixtureExecutorInput, executeEvalFixture } from './fixture.ts';
import { compareEvalTrials, summarizeEvalTrials } from './report.ts';
import { evalTrialScorers } from './scorers.ts';
import { type EvalTaskV1, evalTaskV1Schema, type EvalTrialV1, evalTrialV1Schema } from './schema.ts';

type EvalExecutor = (input: EvalFixtureExecutorInput) => Promise<EvalTrialV1> | EvalTrialV1;

const root = resolve(dirname(fromFileUrl(import.meta.url)), '../../../..');
const defaultCatalog = join(root, 'server', 'evals', 'coding-agent-v1.json');

const flag = (name: string) => {
  const index = Deno.args.indexOf(`--${name}`);
  return index >= 0 ? Deno.args[index + 1] : undefined;
};

const command = Deno.args.find((arg) => !arg.startsWith('--')) ?? 'validate';

const ensureDataset = async (catalog: Awaited<ReturnType<typeof loadEvalCatalog>>) => {
  const { mastra } = await import('../mastra/index.ts');
  const listed = await mastra.datasets.list({ perPage: 1_000 });
  const existing = listed.datasets.find((dataset) => dataset.name === catalog.name);
  const dataset = existing
    ? await mastra.datasets.get({ id: existing.id })
    : await mastra.datasets.create({ name: catalog.name, description: catalog.description });
  if (!dataset) throw new Error('Mastra dataset could not be loaded.');
  const listedItems = await dataset.listItems({ page: 0, perPage: 1000 });
  const items = Array.isArray(listedItems) ? listedItems : listedItems.items;
  const byTaskId = new Map(items.map((item) => [(item.input as { id?: string } | undefined)?.id, item]));
  const existingIds = new Set(byTaskId.keys());
  const missing = catalog.tasks.filter((task) => !existingIds.has(task.id));
  const present = catalog.tasks.filter((task) => existingIds.has(task.id));
  const catalogIds = new Set(catalog.tasks.map((task) => task.id));
  const stale = items.filter((item) => {
    const taskId = (item.input as { id?: string } | undefined)?.id;
    return !taskId || !catalogIds.has(taskId);
  });
  if (missing.length) {
    await dataset.addItems({
      items: missing.map((task) => ({
        input: task,
        groundTruth: { graders: task.graders, critical: task.critical },
      })),
    });
  }
  await Promise.all(present.map((task) => {
    const item = byTaskId.get(task.id);
    if (!item) return Promise.resolve();
    return dataset.updateItem({
      itemId: item.id,
      input: task,
      groundTruth: { graders: task.graders, critical: task.critical },
    });
  }));
  if (stale.length) await dataset.deleteItems({ itemIds: stale.map((item) => item.id) });
  return { dataset, added: missing.length, updated: present.length, removed: stale.length };
};

const syncDataset = async () => {
  const catalog = await loadEvalCatalog(flag('catalog') ?? defaultCatalog);
  const { dataset, ...changes } = await ensureDataset(catalog);
  console.log(JSON.stringify({ datasetId: dataset.id, tasks: catalog.tasks.length, ...changes }, null, 2));
};

const runSuite = async () => {
  const catalog = await loadEvalCatalog(flag('catalog') ?? defaultCatalog);
  const executorPath = flag('executor') ?? Deno.env.get('WEAVE_EVAL_EXECUTOR');
  if (!executorPath) throw new Error('Run requires --executor <module> or WEAVE_EVAL_EXECUTOR.');
  const module = await import(resolve(executorPath));
  const execute = module.executeEvalTask as EvalExecutor | undefined;
  if (!execute) throw new Error('Evaluation executor must export executeEvalTask(input).');
  const trials = Math.max(1, Number(flag('trials') ?? 3));
  const configuration = flag('configuration') ?? 'default';
  const results: EvalTrialV1[] = [];
  const { dataset } = await ensureDataset(catalog);
  const maxConcurrency = Math.max(1, Number(flag('concurrency') ?? 1));
  for (let trial = 1; trial <= trials; trial += 1) {
    const experiment = await dataset.startExperiment<EvalTaskV1, EvalTrialV1>({
      name: `${configuration}-trial-${trial}`,
      description: `Weave coding-agent harness evaluation trial ${trial}/${trials}`,
      metadata: { suite: catalog.name, configuration, trial, harness: 'weave-mastra-v1' },
      maxConcurrency,
      maxRetries: 0,
      scorers: evalTrialScorers,
      itemTimeout: Math.max(...catalog.tasks.map((task) => task.resources.timeoutSeconds)) * 1000,
      task: async ({ input }) => {
        const task = evalTaskV1Schema.parse(input);
        const result = await executeEvalFixture({
          task,
          trial,
          suite: catalog.name,
          configuration,
          repositoryRoot: root,
          execute,
        });
        return evalTrialV1Schema.parse({
          ...result,
          suite: catalog.name,
          configuration,
          taskId: task.id,
          category: task.category,
          trial,
        });
      },
    });
    for (const item of experiment.results) {
      if (item.error || !item.output) {
        throw new Error(
          `Experiment ${experiment.experimentId} failed item ${item.itemId}: ${item.error?.message ?? 'no output'}`,
        );
      }
      const output = evalTrialV1Schema.parse(item.output);
      results.push({
        ...output,
        graderEvidence: [
          ...output.graderEvidence,
          ...item.scores.map((score) => ({
            grader: `mastra:${score.scorerId}`,
            passed: score.score === 1,
            detail: score.error ?? score.reason ?? `score=${score.score ?? 'null'}`,
          })),
        ],
      });
    }
  }
  const output = flag('output') ?? join(root, '.weave-evals', `${Date.now()}-${configuration}.json`);
  await Deno.mkdir(dirname(output), { recursive: true });
  await Deno.writeTextFile(output, `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify({ output, summary: summarizeEvalTrials(results) }, null, 2));
};

if (command === 'validate') {
  const catalog = await loadEvalCatalog(flag('catalog') ?? defaultCatalog);
  console.log(JSON.stringify({ name: catalog.name, tasks: catalog.tasks.length }, null, 2));
} else if (command === 'sync') {
  await syncDataset();
} else if (command === 'run') {
  await runSuite();
} else if (command === 'report') {
  const path = flag('input');
  if (!path) throw new Error('report requires --input <results.json|jsonl>.');
  console.log(JSON.stringify(summarizeEvalTrials(await loadEvalTrials(path)), null, 2));
} else if (command === 'compare') {
  const baseline = flag('baseline');
  const candidate = flag('candidate');
  if (!baseline || !candidate) throw new Error('compare requires --baseline and --candidate.');
  const comparison = compareEvalTrials(await loadEvalTrials(baseline), await loadEvalTrials(candidate));
  console.log(JSON.stringify(comparison, null, 2));
  if (Deno.args.includes('--enforce') && !comparison.promotion.eligible) Deno.exit(2);
} else {
  throw new Error(`Unknown eval command: ${command}`);
}
