const pathFromFileUrl = (url: URL) => {
  if (url.protocol !== 'file:') throw new Error(`Expected file URL: ${url.href}`);
  return decodeURIComponent(url.pathname);
};

const nativeLibraryName = Deno.build.os === 'darwin'
  ? 'libweave_portal_pty.dylib'
  : Deno.build.os === 'linux'
  ? 'libweave_portal_pty.so'
  : undefined;

const nativeWindowStreamHostName = Deno.build.os === 'darwin' ? 'weave-window-stream-native' : undefined;

const run = async (args: string[]) => {
  const child = new Deno.Command(Deno.execPath(), {
    cwd: pathFromFileUrl(new URL('..', import.meta.url)),
    args,
    stdout: 'inherit',
    stderr: 'inherit',
  }).spawn();
  const status = await child.status;
  if (!status.success) Deno.exit(status.code || 1);
};

const main = async () => {
  if (!nativeLibraryName) throw new Error(`Portal native PTY is not supported on ${Deno.build.os}.`);

  const portalRoot = pathFromFileUrl(new URL('..', import.meta.url));
  await run(['run', '--allow-run', '--allow-env', '--allow-read', 'scripts/build-native.ts']);
  if (nativeWindowStreamHostName) {
    const nativeHost = `${portalRoot}/native/window-stream-native/build/${nativeWindowStreamHostName}`;
    const stat = await Deno.stat(nativeHost).catch(() => undefined);
    if (stat?.isFile) {
      await Deno.mkdir(`${portalRoot}/dist`, { recursive: true });
      await Deno.copyFile(nativeHost, `${portalRoot}/dist/${nativeWindowStreamHostName}`);
      await Deno.chmod(`${portalRoot}/dist/${nativeWindowStreamHostName}`, 0o755);
    }
  }
  await run([
    'compile',
    '--allow-net',
    '--allow-read',
    '--allow-write',
    '--allow-env',
    '--allow-ffi',
    '--allow-run',
    '--include',
    `native/pty/target/release/${nativeLibraryName}`,
    '--output',
    'dist/portal',
    'src/main.ts',
  ]);
};

if (import.meta.main) await main();
