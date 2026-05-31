export type PortalRuntimeFile = {
  version: 1;
  pid: number;
  portalId: string;
  configPath: string;
  httpServerUrl: string;
  wsServerUrl: string;
  controlHost?: string;
  controlPort?: number;
  controlToken?: string;
  startedAt: string;
  updatedAt: string;
};

export type PortalRuntimeHealth = {
  ok: boolean;
  status?: number;
  body?: unknown;
  error?: string;
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

export const ensureParentDir = async (path: string) => {
  const slashIndex = path.lastIndexOf('/');
  if (slashIndex <= 0) return;
  await Deno.mkdir(path.slice(0, slashIndex), { recursive: true });
};

export const readPortalRuntime = async (path = getPortalRuntimePath()): Promise<PortalRuntimeFile | undefined> => {
  try {
    const runtime = JSON.parse(await Deno.readTextFile(path)) as Partial<PortalRuntimeFile>;
    if (
      runtime.version !== 1 ||
      typeof runtime.pid !== 'number' ||
      typeof runtime.portalId !== 'string' ||
      typeof runtime.configPath !== 'string' ||
      typeof runtime.httpServerUrl !== 'string' ||
      typeof runtime.wsServerUrl !== 'string'
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
  await Deno.writeTextFile(path, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });
  await Deno.chmod(path, 0o600).catch(() => undefined);
};

export const removePortalRuntime = async (path = getPortalRuntimePath()) => {
  await Deno.remove(path).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
};

export const maskSecret = (value: string | undefined) => {
  if (!value) return value;
  return value.length <= 8 ? '********' : `${value.slice(0, 4)}...${value.slice(-4)}`;
};

export const maskPortalRuntime = (runtime: PortalRuntimeFile | undefined) =>
  runtime ? { ...runtime, controlToken: maskSecret(runtime.controlToken) } : undefined;

export const normalizeHttpUrl = (server: string) => server.replace(/\/+$/, '');

export const normalizeWsUrl = (server: string) => {
  const url = new URL(server);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  return url.toString().replace(/\/+$/, '');
};

export const runtimeMatchesServer = (runtime: PortalRuntimeFile, httpServerUrl: string, wsServerUrl: string) =>
  normalizeHttpUrl(runtime.httpServerUrl) === normalizeHttpUrl(httpServerUrl) &&
  normalizeWsUrl(runtime.wsServerUrl) === normalizeWsUrl(wsServerUrl);

export const checkPortalRuntimeHealth = async (
  runtime: PortalRuntimeFile | undefined,
): Promise<PortalRuntimeHealth> => {
  if (!runtime?.controlHost || !runtime.controlPort || !runtime.controlToken) {
    return { ok: false, error: 'runtime has no local control endpoint' };
  }

  try {
    const url = new URL(`http://${runtime.controlHost}:${runtime.controlPort}/health`);
    url.searchParams.set('token', runtime.controlToken);
    const response = await fetch(url);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // Plain-text response bodies are fine for diagnostics.
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};
