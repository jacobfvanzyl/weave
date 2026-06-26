const pathFromFileUrl = (url: URL) => {
  if (url.protocol !== 'file:') throw new Error(`Expected file URL: ${url.href}`);
  return decodeURIComponent(url.pathname);
};

const runOutput = async (command: string, args: string[], env?: Record<string, string>) => {
  try {
    const output = await new Deno.Command(command, {
      args,
      stdout: 'piped',
      stderr: 'piped',
      env,
    }).output();
    if (!output.success) return undefined;
    return new TextDecoder().decode(output.stdout).trim();
  } catch {
    return undefined;
  }
};

const findCmake = async () => {
  const explicit = Deno.env.get('CMAKE')?.trim();
  if (explicit && await runOutput(explicit, ['--version'])) return explicit;
  if (await runOutput('cmake', ['--version'])) return 'cmake';

  const candidates = [
    '/opt/homebrew/opt/cmake/bin/cmake',
    '/opt/homebrew/bin/cmake',
    '/usr/local/opt/cmake/bin/cmake',
    '/usr/local/bin/cmake',
  ];
  for (const candidate of candidates) {
    if (await runOutput(candidate, ['--version'])) return candidate;
  }

  throw new Error('Could not find cmake. Install CMake or set CMAKE=/path/to/cmake.');
};

const runInherited = async (
  command: string,
  options: { cwd: string; args: string[]; env?: Record<string, string> },
) => {
  const child = new Deno.Command(command, {
    cwd: options.cwd,
    args: options.args,
    env: options.env,
    stdout: 'inherit',
    stderr: 'inherit',
  }).spawn();
  const status = await child.status;
  if (!status.success) Deno.exit(status.code || 1);
};

const main = async () => {
  const portalRoot = pathFromFileUrl(new URL('..', import.meta.url));
  if (Deno.build.os === 'darwin') {
    const cmake = await findCmake();
    const sourceDir = `${portalRoot}/native/window-stream-native`;
    const buildDir = `${sourceDir}/build`;
    await runInherited(cmake, {
      cwd: portalRoot,
      args: [
        '-S',
        sourceDir,
        '-B',
        buildDir,
        '-DCMAKE_BUILD_TYPE=Release',
      ],
    });
    await runInherited(cmake, {
      cwd: portalRoot,
      args: ['--build', buildDir, '--config', 'Release'],
    });
  }
};

if (import.meta.main) await main();
