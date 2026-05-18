const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();

const runGit = async (cwd: string, args: string[]) => {
  const command = new Deno.Command('git', { cwd, args, stdout: 'piped', stderr: 'piped' });
  const output = await command.output();
  if (!output.success) throw new Error(decode(output.stderr) || `git ${args.join(' ')} failed`);
  return decode(output.stdout);
};

export const detectWorkspace = async () => {
  const cwd = Deno.cwd();
  const realCwd = await Deno.realPath(cwd);
  try {
    const gitTopLevel = await runGit(cwd, ['rev-parse', '--show-toplevel']);
    const gitCommonDir = await runGit(gitTopLevel, ['rev-parse', '--git-common-dir']).catch(() => undefined);
    const branch = await runGit(gitTopLevel, ['branch', '--show-current']).catch(() => undefined);
    const remote = await runGit(gitTopLevel, ['config', '--get', 'remote.origin.url']).catch(() => undefined);
    const workspacePath = await Deno.realPath(gitTopLevel);
    return { kind: 'git', cwd, workspacePath, gitTopLevel: workspacePath, gitCommonDir, branch, remote };
  } catch {
    return { kind: 'adHoc', cwd, workspacePath: realCwd };
  }
};
