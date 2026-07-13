import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1.0.19';
import { executeEvalFixture } from './fixture.ts';
import { evalTaskV1Schema, type EvalTrialV1 } from './schema.ts';

const run = async (cwd: string, args: string[]) => {
  const output = await new Deno.Command('git', { cwd, args, stdout: 'piped', stderr: 'piped' }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  return new TextDecoder().decode(output.stdout);
};

Deno.test('eval fixtures isolate source checkout and retain deterministic grader evidence', async () => {
  const repository = await Deno.makeTempDir({ prefix: 'weave-eval-fixture-' });
  try {
    await run(repository, ['init']);
    await run(repository, ['config', 'user.email', 'eval@example.invalid']);
    await run(repository, ['config', 'user.name', 'Weave Eval']);
    await Deno.writeTextFile(`${repository}/README.md`, 'fixture\n');
    await Deno.writeTextFile(`${repository}/.gitignore`, '.weave-evals/\n');
    await run(repository, ['add', '.']);
    await run(repository, ['commit', '-m', 'fixture']);

    const task = evalTaskV1Schema.parse({
      version: 1,
      id: 'fixture.isolation',
      category: 'editing',
      description: 'fixture test',
      prompt: 'edit the isolated fixture',
      fixture: { repository: '.', revision: 'HEAD', setupCommand: "printf 'setup' > setup.txt" },
      resources: {},
      sideEffects: {},
      graders: [
        { kind: 'file_contains', path: 'setup.txt', includes: ['setup'] },
        { kind: 'git_diff', allowPaths: ['setup.txt', 'changed.txt'], denyPaths: [], requireChange: true },
      ],
    });
    const baseTrial = (workspacePath: string): EvalTrialV1 => ({
      version: 1,
      suite: 'fixture-suite',
      configuration: 'test',
      taskId: task.id,
      category: task.category,
      trial: 1,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      passed: true,
      noHarm: true,
      validationPassed: true,
      durationMs: 1,
      graderEvidence: [{ grader: 'executor', passed: workspacePath !== repository }],
    });

    const result = await executeEvalFixture({
      task,
      trial: 1,
      suite: 'fixture-suite',
      configuration: 'test',
      repositoryRoot: repository,
      execute: async ({ workspacePath }) => {
        await Deno.writeTextFile(`${workspacePath}/changed.txt`, 'changed');
        return baseTrial(workspacePath);
      },
    });

    assertEquals(result.passed, true);
    assertEquals(result.noHarm, true);
    assertEquals(await run(repository, ['status', '--porcelain=v1', '--untracked-files=all']), '');
    assertStringIncludes(JSON.stringify(result.graderEvidence), 'source_checkout_unchanged');
  } finally {
    await Deno.remove(repository, { recursive: true }).catch(() => undefined);
  }
});
