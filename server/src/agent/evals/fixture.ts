import { resolve } from 'jsr:@std/path@1.0.9';
import { compactText } from '../mastra/tools/model-output.ts';
import type { EvalTaskV1, EvalTrialV1 } from './schema.ts';

type CommandResult = {
  success: boolean;
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const decoder = new TextDecoder();

const runCommand = async (command: string, cwd: string, timeoutSeconds: number): Promise<CommandResult> => {
  const child = new Deno.Command('bash', {
    args: ['-lc', command],
    cwd,
    stdout: 'piped',
    stderr: 'piped',
    env: {
      PATH: Deno.env.get('PATH') ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: Deno.env.get('HOME') ?? cwd,
      CI: '1',
      NO_COLOR: '1',
    },
    clearEnv: true,
  }).spawn();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
    } catch {
      // The process may have exited between the timer firing and the signal.
    }
  }, timeoutSeconds * 1_000);
  try {
    const output = await child.output();
    return {
      success: output.success && !timedOut,
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
      timedOut,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const git = async (repository: string, args: string[], timeoutSeconds = 120) => {
  const quoted = args.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(' ');
  const result = await runCommand(`git ${quoted}`, repository, timeoutSeconds);
  if (!result.success) throw new Error(`git ${args.join(' ')} failed: ${compactText(result.stderr, 2_000).text}`);
  return result.stdout;
};

const globPattern = (pattern: string) => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('**', '\u0000').replaceAll('*', '[^/]*')
    .replaceAll('\u0000', '.*');
  return new RegExp(`^${escaped}$`);
};

const matchesAny = (path: string, patterns: string[]) => patterns.some((pattern) => globPattern(pattern).test(path));

const changedPaths = async (workspacePath: string) => {
  const status = await git(workspacePath, ['status', '--porcelain=v1', '--untracked-files=all']);
  return status.split('\n').filter(Boolean).map((line) => {
    const value = line.slice(3);
    return value.includes(' -> ') ? value.slice(value.lastIndexOf(' -> ') + 4) : value;
  });
};

const evidenceDetail = (result: CommandResult) => {
  const output = [
    `exitCode=${result.code}`,
    ...(result.timedOut ? ['timedOut=true'] : []),
    result.stdout ? `stdout:\n${result.stdout}` : '',
    result.stderr ? `stderr:\n${result.stderr}` : '',
  ].filter(Boolean).join('\n');
  return compactText(output, 8_000).text;
};

const gradeDeterministically = async (task: EvalTaskV1, workspacePath: string) => {
  const paths = await changedPaths(workspacePath);
  const evidence: EvalTrialV1['graderEvidence'] = [];
  let validationPassed = true;
  let noHarm = true;
  for (const [index, grader] of task.graders.entries()) {
    if (grader.kind === 'model') continue;
    if (grader.kind === 'command') {
      const result = await runCommand(grader.command, workspacePath, grader.timeoutSeconds);
      evidence.push({ grader: `command:${index}`, passed: result.success, detail: evidenceDetail(result) });
      validationPassed &&= result.success;
      continue;
    }
    if (grader.kind === 'file_contains') {
      const content = await Deno.readTextFile(resolve(workspacePath, grader.path)).catch(() => '');
      const missing = grader.includes.filter((value) => !content.includes(value));
      evidence.push({
        grader: `file_contains:${index}`,
        passed: missing.length === 0,
        detail: missing.length ? `Missing: ${missing.join(', ')}` : grader.path,
      });
      continue;
    }
    const denied = paths.filter((path) => matchesAny(path, grader.denyPaths));
    const outsideAllowlist = grader.allowPaths.length
      ? paths.filter((path) => !matchesAny(path, grader.allowPaths))
      : [];
    const passed = (!grader.requireChange || paths.length > 0) && denied.length === 0 && outsideAllowlist.length === 0;
    noHarm &&= denied.length === 0 && outsideAllowlist.length === 0;
    evidence.push({
      grader: `git_diff:${index}`,
      passed,
      detail: JSON.stringify({ changedPaths: paths, denied, outsideAllowlist }),
    });
  }
  return { evidence, validationPassed, noHarm };
};

export type EvalFixtureExecutorInput = {
  task: EvalTaskV1;
  trial: number;
  suite: string;
  configuration: string;
  sourceRepository: string;
  workspacePath: string;
};

export const executeEvalFixture = async (input: {
  task: EvalTaskV1;
  trial: number;
  suite: string;
  configuration: string;
  repositoryRoot: string;
  execute: (input: EvalFixtureExecutorInput) => Promise<EvalTrialV1> | EvalTrialV1;
}) => {
  const sourceRepository = resolve(input.repositoryRoot, input.task.fixture.repository);
  const sourceStatusBefore = await git(sourceRepository, ['status', '--porcelain=v1', '--untracked-files=all']);
  const safeTaskId = input.task.id.replaceAll(/[^a-zA-Z0-9_.-]/g, '-');
  const workspacePath = resolve(
    input.repositoryRoot,
    '.weave-evals',
    'worktrees',
    `${safeTaskId}-t${input.trial}-${crypto.randomUUID()}`,
  );
  await Deno.mkdir(resolve(input.repositoryRoot, '.weave-evals', 'worktrees'), { recursive: true });
  await git(sourceRepository, ['worktree', 'add', '--detach', workspacePath, input.task.fixture.revision]);
  try {
    if (input.task.fixture.setupCommand) {
      const setup = await runCommand(
        input.task.fixture.setupCommand,
        workspacePath,
        input.task.resources.timeoutSeconds,
      );
      if (!setup.success) throw new Error(`Eval fixture setup failed: ${evidenceDetail(setup)}`);
    }
    const result = await input.execute({
      task: input.task,
      trial: input.trial,
      suite: input.suite,
      configuration: input.configuration,
      sourceRepository,
      workspacePath,
    });
    const deterministic = await gradeDeterministically(input.task, workspacePath);
    const sourceStatusAfter = await git(sourceRepository, ['status', '--porcelain=v1', '--untracked-files=all']);
    const sourceCheckoutUntouched = sourceStatusAfter === sourceStatusBefore;
    const deterministicPassed = deterministic.evidence.every((item) => item.passed);
    return {
      ...result,
      passed: result.passed && deterministicPassed,
      validationPassed: result.validationPassed && deterministic.validationPassed,
      noHarm: result.noHarm && deterministic.noHarm && sourceCheckoutUntouched,
      graderEvidence: [
        ...result.graderEvidence,
        ...deterministic.evidence,
        {
          grader: 'source_checkout_unchanged',
          passed: sourceCheckoutUntouched,
          detail: sourceCheckoutUntouched ? undefined : 'The source checkout changed during an isolated eval trial.',
        },
      ],
    } satisfies EvalTrialV1;
  } finally {
    await git(sourceRepository, ['worktree', 'remove', '--force', workspacePath]).catch((error) => {
      console.error('[eval] failed to remove fixture worktree', { workspacePath, error });
    });
  }
};
