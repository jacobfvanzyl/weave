import {
  type ResolvedWindowStreamConfig,
  resolveWindowStreamConfig,
  type WindowStreamBackend,
} from './window_config.ts';

const helperPathFromFileUrl = (url: URL) => {
  if (url.protocol !== 'file:') return undefined;
  return decodeURIComponent(url.pathname);
};

const joinPath = (...parts: string[]) => {
  const joined = parts
    .filter(Boolean)
    .join('/')
    .replace(/\/+/g, '/');
  return joined === '' ? '.' : joined;
};

const dirname = (path: string) => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

const defaultNativeWindowStreamHostPaths = () =>
  [
    helperPathFromFileUrl(
      new URL('../native/window-stream-native/build/weave-window-stream-native', import.meta.url),
    ),
    helperPathFromFileUrl(new URL('../dist/weave-window-stream-native', import.meta.url)),
    joinPath(dirname(Deno.execPath()), 'weave-window-stream-native'),
  ].filter((candidate): candidate is string => Boolean(candidate));

const isPathLike = (value: string) => value.includes('/');

const executableExists = async (path: string) => {
  const stat = await Deno.stat(path).catch(() => undefined);
  return Boolean(stat?.isFile);
};

const findExecutableOnPath = async (command: string, env: Record<string, string | undefined>) => {
  for (const directory of (env.PATH ?? '').split(':')) {
    if (!directory) continue;
    const candidate = joinPath(directory, command);
    if (await executableExists(candidate)) return candidate;
  }
  return undefined;
};

const resolveExecutable = async (
  configured: string | undefined,
  env: Record<string, string | undefined>,
) => {
  if (!configured) return undefined;
  if (!isPathLike(configured)) return await findExecutableOnPath(configured, env) ?? configured;
  return await executableExists(configured) ? configured : undefined;
};

const resolveExecutableFromCandidates = async (
  configured: string | undefined,
  fallbacks: string[],
  env: Record<string, string | undefined>,
) => {
  if (configured) return await resolveExecutable(configured, env);
  for (const fallback of fallbacks) {
    if (await executableExists(fallback)) return fallback;
  }
  return undefined;
};

export type WindowHostRuntime = {
  label: string;
  command: string;
  args: string[];
  streamBackend: WindowStreamBackend;
  env: Record<string, string>;
  nativeHostPath: string;
};

export const resolveWindowHostRuntime = async (
  env: Record<string, string | undefined> = Deno.env.toObject(),
  config: ResolvedWindowStreamConfig = resolveWindowStreamConfig(undefined, {}, env),
): Promise<WindowHostRuntime | undefined> => {
  if (Deno.build.os !== 'darwin') return undefined;
  const nativeHostPath = await resolveExecutableFromCandidates(
    config.hostPath,
    defaultNativeWindowStreamHostPaths(),
    env,
  );
  if (!nativeHostPath) return undefined;
  return {
    label: 'Native window stream host',
    command: nativeHostPath,
    args: [],
    streamBackend: config.backend,
    nativeHostPath,
    env: {
      WEAVE_WINDOW_HOST_PROTOCOL: '1',
      WEAVE_WINDOW_STREAM_BACKEND: 'native-webrtc',
    },
  };
};

export const isWindowHostAvailable = async (
  env?: Record<string, string | undefined>,
  config?: ResolvedWindowStreamConfig,
) => Boolean(await resolveWindowHostRuntime(env, config));

export const windowHostRuntimeError = (config: ResolvedWindowStreamConfig) =>
  [
    'Window streaming host is unavailable.',
    'Build the native ScreenCaptureKit WebRTC host, or set WEAVE_WINDOW_STREAM_HOST.',
    `WEAVE_WINDOW_STREAM_BACKEND=${config.backend}`,
    `WEAVE_WINDOW_STREAM_HOST=${config.hostPath ?? defaultNativeWindowStreamHostPaths()[0] ?? ''}`,
  ].join(' ');
