const pathFromFileUrl = (url: URL) => {
  if (url.protocol !== 'file:') throw new Error(`Expected file URL: ${url.href}`);
  return decodeURIComponent(url.pathname);
};

const dirname = (path: string) => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
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

const findCargo = async () => {
  const explicit = Deno.env.get('CARGO')?.trim();
  if (explicit && await runOutput(explicit, ['--version'])) return explicit;

  if (await runOutput('cargo', ['--version'])) return 'cargo';

  const home = Deno.env.get('HOME')?.trim();
  if (home) {
    const cargoPath = `${home}/.cargo/bin/cargo`;
    if (await runOutput(cargoPath, ['--version'])) return cargoPath;
  }

  const rustupCandidates = [
    Deno.env.get('RUSTUP')?.trim(),
    'rustup',
    home ? `${home}/.cargo/bin/rustup` : undefined,
    '/opt/homebrew/bin/rustup',
    '/usr/local/bin/rustup',
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const rustup of rustupCandidates) {
    const cargoPath = await runOutput(rustup, ['which', 'cargo']);
    if (cargoPath) return cargoPath;
  }

  throw new Error('Could not find cargo. Install Rust or set CARGO=/path/to/cargo.');
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
  const manifestPath = pathFromFileUrl(new URL('../native/pty/Cargo.toml', import.meta.url));
  const cargo = await findCargo();
  const cargoDir = dirname(cargo);
  const path = `${cargoDir}:${Deno.env.get('PATH') ?? ''}`;

  await runInherited(cargo, {
    cwd: portalRoot,
    args: ['build', '--manifest-path', manifestPath, '--release'],
    env: { PATH: path },
  });

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
