import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadPortalConfig } from './config.ts';
import { hostVersion } from './version.ts';

type Installation = { format: 1; unit: string; config: string; current: string; previous?: string; stateFormat: number; adopted?: string };
const option = (args: string[], name: string) => { const n = args.indexOf(name); return n < 0 ? undefined : args[n + 1]; };
const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
const quote = (value: string) => { if (/[\n\r\0]/.test(value)) throw new Error('Invalid service path'); return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$')}"`; };
const systemctl = async (...args: string[]) => {
  const child = Bun.spawn(['systemctl', '--user', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`systemctl ${args[0]} failed: ${err.trim() || out.trim()}`);
  return out.trim();
};
const atomicJson = async (path: string, value: unknown) => { const temporary = `${path}.new`; await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, path); };
const pointTo = async (root: string, release: string) => { const temporary = join(root, 'current.new'); await rm(temporary, { force: true }); await symlink(join(root, 'releases', release, 'weave-portal'), temporary); await rename(temporary, join(root, 'current')); };

export function serviceUnit(binary: string, config: string, path: string) {
  return `[Unit]\nDescription=Weave Alpha Host\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${quote(binary)} serve --config ${quote(config)}\nEnvironment=${quote(`PATH=${path}`)}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=10\nKillMode=process\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

export async function manageService(action: string | undefined, args: string[]) {
  if (process.platform !== 'linux') throw new Error('Per-user services currently target Linux systemd; macOS runs the packaged Host directly.');
  if (process.getuid?.() === 0) throw new Error('Run the Host service as the intended user, without sudo.');
  const name = option(args, '--name');
  if (!name || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('--name must be a lowercase service name.');
  if (!['install', 'upgrade', 'rollback', 'start', 'stop', 'restart', 'status', 'uninstall'].includes(action ?? '')) throw new Error('Unknown service action.');
  const root = join(homedir(), '.local/share/weave/hosts', name);
  const manifest = join(root, 'installation.json');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const lock = join(root, '.operation');
  try { await mkdir(lock, { mode: 0o700 }); } catch { throw new Error(`Another service operation is active. If its process died, inspect and remove ${lock}.`); }
  try {
    let installed: Installation | undefined = await exists(manifest) ? JSON.parse(await readFile(manifest, 'utf8')) : undefined;
    if (installed && installed.format !== 1) throw new Error('Unsupported installation metadata.');
    if (action !== 'install' && !installed) throw new Error('Install this named service first.');
    if (action === 'status') {
      console.log(JSON.stringify({ ...installed, status: await systemctl('show', installed!.unit, '--property=ActiveState,SubState,ExecMainStatus,FragmentPath') }, null, 2));
      return;
    }
    if (action === 'start' || action === 'stop' || action === 'restart') { await systemctl(action, installed!.unit); console.log(`${installed!.unit}: ${action}`); return; }
    if (action === 'uninstall') {
      await systemctl('disable', '--now', installed!.unit);
      await rm(join(homedir(), '.config/systemd/user', installed!.unit));
      await systemctl('daemon-reload');
      await rename(manifest, join(root, 'uninstalled.json'));
      console.log('Service removed. Configuration, credentials, Threads, journals, terminals, releases and adoption backup are retained.');
      return;
    }
    if (action === 'rollback') {
      if (!installed!.previous || installed!.stateFormat !== hostVersion.stateFormat) throw new Error('No compatible previous release.');
      const previous = installed!.current;
      await pointTo(root, installed!.previous);
      try { await systemctl('restart', installed!.unit); await Bun.sleep(500); await systemctl('is-active', installed!.unit); }
      catch (error) { await pointTo(root, previous); await systemctl('restart', installed!.unit); throw error; }
      installed = { ...installed!, current: installed!.previous, previous };
      await atomicJson(manifest, installed);
      console.log(JSON.stringify(installed));
      return;
    }
    if (action === 'install' && installed) throw new Error('Already installed; use upgrade.');
    const configPath = installed?.config ?? resolve(option(args, '--config') ?? '');
    if (!installed && !option(args, '--config')) throw new Error('Install requires --config.');
    await loadPortalConfig(configPath);
    const source = resolve(option(args, '--binary') ?? process.execPath);
    const inspection = Bun.spawn([source, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => inspection.kill('SIGKILL'), 5000);
    let version;
    try { version = JSON.parse(await new Response(inspection.stdout).text()); if (await inspection.exited !== 0) throw new Error('Version probe failed'); }
    finally { clearTimeout(timer); }
    if (version.product !== 'weave-host' || version.stateFormat !== hostVersion.stateFormat || version.protocolVersion !== hostVersion.protocolVersion || version.platform !== 'linux' || version.arch !== process.arch) throw new Error('Binary is not a compatible packaged Host for this machine.');
    const digest = createHash('sha256').update(await readFile(source)).digest('hex');
    const release = join(root, 'releases', digest);
    await mkdir(release, { recursive: true, mode: 0o700 });
    const binary = join(release, 'weave-portal');
    if (!await exists(binary)) { await copyFile(source, binary); await chmod(binary, 0o700); }
    await atomicJson(join(release, 'version.json'), version);
    const unit = installed?.unit ?? option(args, '--unit') ?? `weave-host-${name}.service`;
    if (!/^weave-[a-z0-9-]+\.service$/.test(unit)) throw new Error('Unit name must be a weave-*.service basename.');
    const unitPath = join(homedir(), '.config/systemd/user', unit);
    await mkdir(dirname(unitPath), { recursive: true });
    let adopted = installed?.adopted;
    if (!installed && await exists(unitPath)) {
      if (!args.includes('--adopt')) throw new Error('Existing unit is not managed by this installation. Use --adopt only for the intended Alpha service.');
      adopted = join(root, `adopted-${Date.now()}.service`);
      await copyFile(unitPath, adopted);
      await chmod(adopted, 0o600);
      await systemctl('stop', unit);
    }
    if (installed?.current === digest) { console.log('This artifact is already installed.'); return; }
    await pointTo(root, digest);
    await writeFile(unitPath, serviceUnit(join(root, 'current'), configPath, process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'), { mode: 0o644 });
    try {
      await systemctl('daemon-reload');
      await systemctl('enable', unit);
      await systemctl('restart', unit);
      await Bun.sleep(500);
      await systemctl('is-active', unit);
    } catch (error) {
      if (installed) { await pointTo(root, installed.current); await systemctl('restart', unit); }
      else if (adopted) { await copyFile(adopted, unitPath); await systemctl('daemon-reload'); await systemctl('start', unit); }
      throw error;
    }
    installed = { format: 1, unit, config: configPath, current: digest, ...(installed ? { previous: installed.current } : {}), stateFormat: version.stateFormat, ...(adopted ? { adopted } : {}) };
    await atomicJson(manifest, installed);
    console.log(JSON.stringify(installed));
  } finally { await rm(lock, { recursive: true }); }
}
