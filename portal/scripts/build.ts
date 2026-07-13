const pathFromFileUrl = (url: URL) => {
  if (url.protocol !== 'file:') throw new Error(`Expected file URL: ${url.href}`);
  return decodeURIComponent(url.pathname);
};

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
  await run([
    'compile',
    '--allow-net',
    '--allow-read',
    '--allow-write',
    '--allow-env',
    '--allow-run',
    '--output',
    'dist/portal',
    'src/main.ts',
  ]);
};

if (import.meta.main) await main();
