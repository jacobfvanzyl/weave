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

const findSwift = async () => {
  const explicit = Deno.env.get('SWIFT')?.trim();
  if (explicit && await runOutput(explicit, ['--version'])) return explicit;
  if (await runOutput('swift', ['--version'])) return 'swift';
  throw new Error('Could not find swift. Install Xcode command line tools or set SWIFT=/path/to/swift.');
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
    const swift = await findSwift();
    await runInherited(swift, {
      cwd: portalRoot,
      args: ['build', '--package-path', 'native/window-capture-sck', '-c', 'release'],
    });
  }
};

if (import.meta.main) await main();
