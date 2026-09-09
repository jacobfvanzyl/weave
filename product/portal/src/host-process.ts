// Own the subprocess stream/exit contract once for ACP and tmux on Bun.
type ProcessOptions = {
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: 'pipe' | 'ignore' | 'inherit';
  stdout?: 'pipe' | 'ignore';
  stderr?: 'pipe' | 'ignore';
};
export function spawnProcess(command: string, options: ProcessOptions = {}) {
  const child = Bun.spawn([command, ...(options.args ?? [])], {
    cwd: options.cwd, env: options.env,
    stdin: options.stdin ?? 'ignore', stdout: options.stdout ?? 'pipe', stderr: options.stderr ?? 'pipe',
  });
  const sink = child.stdin;
  const stdin = new WritableStream<Uint8Array>({
    async write(data) {
      if (!sink || typeof sink === 'number') throw new Error('Process input is unavailable.');
      sink.write(data);
      await sink.flush();
    },
    async close() { if (sink && typeof sink !== 'number') await sink.end(); },
    abort() { child.kill('SIGTERM'); },
  });
  const status = child.exited.then((code) => ({ success: code === 0, code, signal: child.signalCode ?? undefined }));
  return { stdin, stdout: child.stdout ?? new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), stderr: child.stderr ?? new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), status, pid: child.pid, kill: (signal: NodeJS.Signals = 'SIGTERM') => child.kill(signal) };
}
export type HostProcess = ReturnType<typeof spawnProcess>;
export async function runProcess(command: string, options: ProcessOptions = {}) {
  const child = spawnProcess(command, options);
  const [status, stdout, stderr] = await Promise.all([
    child.status,
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
  ]);
  return { ...status, stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr) };
}
