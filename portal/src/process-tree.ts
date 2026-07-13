const childPids = async (pid: number) => {
  const output = await new Deno.Command('pgrep', {
    args: ['-P', String(pid)],
    stdout: 'piped',
    stderr: 'null',
  }).output().catch(() => undefined);
  if (!output?.success) return [];
  return new TextDecoder().decode(output.stdout).trim().split(/\s+/)
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value > 0);
};

const descendants = async (pid: number): Promise<number[]> => {
  const direct = await childPids(pid);
  const nested = await Promise.all(direct.map(descendants));
  return [...nested.flat(), ...direct];
};

export const terminateProcessTree = async (child: Deno.ChildProcess, signal: Deno.Signal = 'SIGTERM') => {
  const pids = await descendants(child.pid);
  for (const pid of pids) {
    try {
      Deno.kill(pid, signal);
    } catch {
      // The process may have exited between discovery and signalling.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The root process may already be complete.
  }
};
