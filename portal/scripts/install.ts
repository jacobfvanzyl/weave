const pathFromFileUrl = (url: URL) => {
  if (url.protocol !== 'file:') throw new Error(`Expected file URL: ${url.href}`);
  return decodeURIComponent(url.pathname);
};

const copyFile = async (source: string, target: string) => {
  await Deno.copyFile(source, target);
  await Deno.chmod(target, 0o755).catch(() => undefined);
};

const main = async () => {
  const home = Deno.env.get('HOME');
  if (!home) throw new Error('HOME is required to install Portal.');

  const binDir = Deno.env.get('WEAVE_PORTAL_INSTALL_DIR') ?? `${home}/.local/bin`;
  await Deno.mkdir(binDir, { recursive: true });

  const portalRoot = pathFromFileUrl(new URL('..', import.meta.url));
  await copyFile(`${portalRoot}/dist/portal`, `${binDir}/portal`);

  if (Deno.build.os === 'darwin') {
    const helper = `${portalRoot}/dist/weave-window-capture-sck`;
    const stat = await Deno.stat(helper).catch(() => undefined);
    if (stat?.isFile) {
      await copyFile(helper, `${binDir}/weave-window-capture-sck`);
    }

    const nativeHost = `${portalRoot}/dist/weave-window-stream-native`;
    const nativeHostStat = await Deno.stat(nativeHost).catch(() => undefined);
    if (nativeHostStat?.isFile) {
      await copyFile(nativeHost, `${binDir}/weave-window-stream-native`);
    }
  }
};

if (import.meta.main) await main();
