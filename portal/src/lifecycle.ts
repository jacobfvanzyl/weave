export type PortalRuntimeFile = {
  version: 2;
  pid: number;
  instanceId: string;
  portalId: string;
  configPath: string;
  serverUrl: string;
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'rejected' | 'stopped';
  connectedAt?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
};

export type PortalRuntimeHealth = {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
};

export type PortalRuntimeIdentity = Pick<PortalRuntimeFile, 'pid' | 'startedAt' | 'instanceId'>;

export type PortalRuntimeLock = {
  path: string;
  release: () => Promise<void>;
};

const joinPath = (...parts: string[]) => {
  const joined = parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');
  return joined === '' ? '.' : joined;
};

const normalizePath = (path: string) => {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
};

export const resolvePortalHome = (env: Record<string, string | undefined> = Deno.env.toObject()) => {
  const explicit = env.WEAVE_PORTAL_HOME?.trim();
  if (explicit) return normalizePath(explicit);
  const home = env.HOME?.trim() || '.';
  const configHome = env.XDG_CONFIG_HOME?.trim() || joinPath(home, '.config');
  return normalizePath(joinPath(configHome, 'weave', 'portal'));
};

export const getPortalConfigPath = (env?: Record<string, string | undefined>) =>
  joinPath(resolvePortalHome(env), 'config.json');

export const getPortalRuntimePath = (env?: Record<string, string | undefined>) =>
  joinPath(resolvePortalHome(env), 'runtime.json');

export const getPortalRuntimeLockPath = (runtimePath = getPortalRuntimePath()) => `${runtimePath}.lock`;

export const resolveHostStateHome = (env: Record<string, string | undefined> = Deno.env.toObject()) => {
  const explicit = env.WEAVE_HOST_HOME?.trim();
  if (explicit) return normalizePath(explicit);
  const home = env.HOME?.trim() || '.';
  const stateHome = env.XDG_STATE_HOME?.trim() || joinPath(home, '.local', 'state');
  return normalizePath(joinPath(stateHome, 'weave-host'));
};

export const getHostSocketPath = (env?: Record<string, string | undefined>) =>
  joinPath(resolveHostStateHome(env), 'host.sock');

export const getHostThreadCatalogPath = (env?: Record<string, string | undefined>) =>
  joinPath(resolveHostStateHome(env), 'threads.json');

export const ensureParentDir = async (path: string) => {
  const slashIndex = path.lastIndexOf('/');
  if (slashIndex <= 0) return;
  await Deno.mkdir(path.slice(0, slashIndex), { recursive: true });
};

export const readPortalRuntime = async (path = getPortalRuntimePath()): Promise<PortalRuntimeFile | undefined> => {
  try {
    const runtime = JSON.parse(await Deno.readTextFile(path)) as Partial<PortalRuntimeFile>;
    if (
      runtime.version !== 2 ||
      typeof runtime.pid !== 'number' ||
      typeof runtime.instanceId !== 'string' ||
      typeof runtime.portalId !== 'string' ||
      typeof runtime.configPath !== 'string' ||
      typeof runtime.serverUrl !== 'string' ||
      typeof runtime.connectionState !== 'string'
    ) {
      return undefined;
    }
    return runtime as PortalRuntimeFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    return undefined;
  }
};

export const writePortalRuntime = async (path: string, runtime: PortalRuntimeFile) => {
  await ensureParentDir(path);
  const temporaryPath = `${path}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temporaryPath, `${JSON.stringify(runtime, null, 2)}\n`, {
      createNew: true,
      mode: 0o600,
    });
    await Deno.chmod(temporaryPath, 0o600).catch(() => undefined);
    await Deno.rename(temporaryPath, path);
  } finally {
    await Deno.remove(temporaryPath).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
  }
};

const runtimeMatchesIdentity = (
  runtime: PortalRuntimeFile | undefined,
  expected: PortalRuntimeIdentity,
) =>
  Boolean(
    runtime &&
      runtime.pid === expected.pid &&
      runtime.startedAt === expected.startedAt &&
      runtime.instanceId === expected.instanceId,
  );

export const removePortalRuntime = async (
  path = getPortalRuntimePath(),
  expected?: PortalRuntimeIdentity,
) => {
  if (expected && !runtimeMatchesIdentity(await readPortalRuntime(path), expected)) return false;
  await Deno.remove(path).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  return true;
};

export const tryAcquirePortalRuntimeLock = async (
  runtimePath = getPortalRuntimePath(),
): Promise<PortalRuntimeLock | undefined> => {
  const path = getPortalRuntimeLockPath(runtimePath);
  await ensureParentDir(path);
  const file = await Deno.open(path, {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  await Deno.chmod(path, 0o600).catch(() => undefined);
  const acquired = await file.tryLock(true).catch(() => false);
  if (!acquired) {
    file.close();
    return undefined;
  }

  let released = false;
  return {
    path,
    release: async () => {
      if (released) return;
      released = true;
      await file.unlock().catch(() => undefined);
      file.close();
    },
  };
};

export const maskSecret = (value: string | undefined) => {
  if (!value) return value;
  return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`;
};

export const maskPortalRuntime = (runtime: PortalRuntimeFile | undefined) => runtime ? { ...runtime } : undefined;

export const normalizeHttpUrl = (server: string) => server.replace(/\/+$/, '');

export const normalizeWsUrl = (server: string) => {
  const url = new URL(server);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString().replace(/\/+$/, '');
};

export const runtimeMatchesServer = (runtime: PortalRuntimeFile, serverUrl: string) =>
  normalizeHttpUrl(runtime.serverUrl) === normalizeHttpUrl(serverUrl);

export const checkPortalRuntimeHealth = async (
  runtime: PortalRuntimeFile | undefined,
): Promise<PortalRuntimeHealth> => {
  if (!runtime) return { ok: false, error: 'runtime file is missing' };
  const updatedAt = Date.parse(runtime.updatedAt);
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > 45_000) {
    return { ok: false, error: 'runtime heartbeat is stale', body: runtime };
  }
  return { ok: runtime.connectionState !== 'stopped', body: runtime };
};

export const verifyPortalProcessInstance = async (
  runtime: PortalRuntimeFile,
  runtimePath = getPortalRuntimePath(),
) => {
  try {
    const command = new Deno.Command('ps', {
      args: ['-p', String(runtime.pid), '-o', 'command='],
      stdout: 'piped',
      stderr: 'null',
    });
    const output = await command.output();
    if (!output.success) return false;
    const commandLine = new TextDecoder().decode(output.stdout);
    return commandLine.includes(runtimePath) && commandLine.includes(runtime.instanceId);
  } catch {
    return false;
  }
};
