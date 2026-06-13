export type PortalWindowConfig = {
  portalId?: string;
};

export type PortalWindowInfo = {
  id: string;
  title?: string;
  appName?: string;
  pid?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
};

export type WindowClientMessage =
  | {
    type: 'start';
    sessionId: string;
    windowId?: string;
    iceServers?: unknown[];
  }
  | { type: 'answer'; sessionId: string; answer: { type: 'answer'; sdp: string } }
  | { type: 'ice-candidate'; sessionId: string; candidate: unknown }
  | { type: 'ready'; sessionId: string }
  | { type: 'stop'; sessionId: string };

export type WindowHostEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'offer'; sessionId: string; offer: { type: 'offer'; sdp: string } }
  | { type: 'ice-candidate'; sessionId: string; candidate: unknown }
  | { type: 'stopped'; sessionId: string }
  | { type: 'error'; sessionId?: string; error: string }
  | { type: 'stats'; sessionId: string; stats: Record<string, unknown> };

export type WindowClientEnvelope = {
  type: 'window.client';
  clientId: string;
  sessionId?: string;
  message: WindowClientMessage;
};

type WindowSession = {
  clientId: string;
  send: (event: WindowHostEvent) => void;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const defaultHelperRequestTimeoutMs = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

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

const defaultElectronPath = () =>
  helperPathFromFileUrl(new URL('../../desktop/node_modules/.bin/electron', import.meta.url));

const defaultWindowHostAppPath = () =>
  helperPathFromFileUrl(new URL('../window-host-electron/main.cjs', import.meta.url));

const defaultWindowCaptureHelperPaths = () =>
  [
    helperPathFromFileUrl(
      new URL('../native/window-capture-sck/.build/release/weave-window-capture-sck', import.meta.url),
    ),
    helperPathFromFileUrl(new URL('../dist/weave-window-capture-sck', import.meta.url)),
    joinPath(dirname(Deno.execPath()), 'weave-window-capture-sck'),
  ].filter((candidate): candidate is string => Boolean(candidate));

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

const appPathExists = async (path: string) => {
  const stat = await Deno.stat(path).catch(() => undefined);
  return Boolean(stat?.isFile || stat?.isDirectory);
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
  fallback: string | undefined,
  env: Record<string, string | undefined>,
) => {
  if (configured) {
    if (!isPathLike(configured)) return await findExecutableOnPath(configured, env) ?? configured;
    return await executableExists(configured) ? configured : undefined;
  }
  return fallback && await executableExists(fallback) ? fallback : undefined;
};

const resolveExecutableFromCandidates = async (
  configured: string | undefined,
  fallbacks: string[],
  env: Record<string, string | undefined>,
) => {
  if (configured) return await resolveExecutable(configured, undefined, env);
  for (const fallback of fallbacks) {
    if (await executableExists(fallback)) return fallback;
  }
  return undefined;
};

const resolveAppPath = async (configured: string | undefined, fallback: string | undefined) => {
  for (const candidate of [configured, fallback]) {
    if (candidate && await appPathExists(candidate)) return candidate;
  }
  return undefined;
};

type WindowCaptureBackend = 'screencapturekit' | 'electron';
type WindowStreamBackend = 'electron-sck' | 'native-webrtc';

const resolveWindowCaptureBackend = (env: Record<string, string | undefined>): WindowCaptureBackend => {
  const configured = optionalString(env.WEAVE_WINDOW_CAPTURE_BACKEND)?.toLowerCase();
  return configured === 'electron' ? 'electron' : 'screencapturekit';
};

const resolveWindowStreamBackend = (env: Record<string, string | undefined>): WindowStreamBackend => {
  const configured = optionalString(env.WEAVE_WINDOW_STREAM_BACKEND)?.toLowerCase();
  return configured === 'electron-sck' ? 'electron-sck' : 'native-webrtc';
};

export type WindowHostRuntime = {
  label: string;
  command: string;
  args: string[];
  streamBackend: WindowStreamBackend;
  env: Record<string, string>;
  electronPath?: string;
  appPath?: string;
  captureBackend?: WindowCaptureBackend;
  captureHelperPath?: string;
  nativeHostPath?: string;
};

export const resolveWindowHostRuntime = async (
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<WindowHostRuntime | undefined> => {
  if (Deno.build.os !== 'darwin') return undefined;
  const streamBackend = resolveWindowStreamBackend(env);
  if (streamBackend === 'native-webrtc') {
    const nativeHostPath = await resolveExecutableFromCandidates(
      optionalString(env.WEAVE_WINDOW_STREAM_HOST),
      defaultNativeWindowStreamHostPaths(),
      env,
    );
    if (!nativeHostPath) return undefined;
    return {
      label: 'Native window stream host',
      command: nativeHostPath,
      args: [],
      streamBackend,
      nativeHostPath,
      env: {
        WEAVE_WINDOW_HOST_PROTOCOL: '1',
        WEAVE_WINDOW_STREAM_BACKEND: 'native-webrtc',
      },
    };
  }

  const electronPath = await resolveExecutable(
    optionalString(env.WEAVE_WINDOW_HOST_ELECTRON),
    defaultElectronPath(),
    env,
  );
  const appPath = await resolveAppPath(optionalString(env.WEAVE_WINDOW_HOST_APP), defaultWindowHostAppPath());
  const captureBackend = resolveWindowCaptureBackend(env);
  const captureHelperPath = captureBackend === 'screencapturekit'
    ? await resolveExecutableFromCandidates(
      optionalString(env.WEAVE_WINDOW_CAPTURE_HELPER),
      defaultWindowCaptureHelperPaths(),
      env,
    )
    : undefined;
  if (!electronPath || !appPath) return undefined;
  if (captureBackend === 'screencapturekit' && !captureHelperPath) return undefined;
  return {
    label: 'Electron window host',
    command: electronPath,
    args: [appPath],
    streamBackend,
    electronPath,
    appPath,
    captureBackend,
    captureHelperPath,
    env: {
      WEAVE_WINDOW_HOST_PROTOCOL: '1',
      WEAVE_WINDOW_STREAM_BACKEND: 'electron-sck',
      WEAVE_WINDOW_CAPTURE_BACKEND: captureBackend,
      ...(captureHelperPath ? { WEAVE_WINDOW_CAPTURE_HELPER: captureHelperPath } : {}),
    },
  };
};

export const isWindowHostAvailable = async (env?: Record<string, string | undefined>) =>
  Boolean(await resolveWindowHostRuntime(env));

const windowHostRuntimeError = (env: Record<string, string | undefined>) =>
  [
    'Window streaming host is unavailable.',
    'Install desktop dependencies and build the ScreenCaptureKit helpers, or set WEAVE_WINDOW_STREAM_BACKEND, WEAVE_WINDOW_STREAM_HOST, WEAVE_WINDOW_HOST_ELECTRON, WEAVE_WINDOW_HOST_APP, WEAVE_WINDOW_CAPTURE_HELPER, or WEAVE_WINDOW_CAPTURE_BACKEND=electron.',
    `WEAVE_WINDOW_STREAM_BACKEND=${env.WEAVE_WINDOW_STREAM_BACKEND ?? 'native-webrtc'}`,
    `WEAVE_WINDOW_STREAM_HOST=${env.WEAVE_WINDOW_STREAM_HOST ?? defaultNativeWindowStreamHostPaths()[0] ?? ''}`,
    `WEAVE_WINDOW_HOST_ELECTRON=${env.WEAVE_WINDOW_HOST_ELECTRON ?? defaultElectronPath() ?? ''}`,
    `WEAVE_WINDOW_HOST_APP=${env.WEAVE_WINDOW_HOST_APP ?? defaultWindowHostAppPath() ?? ''}`,
    `WEAVE_WINDOW_CAPTURE_BACKEND=${env.WEAVE_WINDOW_CAPTURE_BACKEND ?? 'screencapturekit'}`,
    `WEAVE_WINDOW_CAPTURE_HELPER=${env.WEAVE_WINDOW_CAPTURE_HELPER ?? defaultWindowCaptureHelperPaths()[0] ?? ''}`,
  ].join(' ');

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message;
  const direct = optionalString(error);
  if (direct) return direct;
  if (isRecord(error)) {
    const nested = optionalString(error.message) ?? optionalString(error.error) ?? optionalString(error.reason);
    if (nested) return nested;
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to String().
    }
  }
  return String(error);
};

class ProcessWindowHostClient {
  private readonly env: Record<string, string | undefined>;
  private readonly requestTimeoutMs: number;
  private process?: Deno.ChildProcess;
  private stdin?: WritableStreamDefaultWriter<Uint8Array>;
  private runtime?: WindowHostRuntime;
  private nextRequestId = 0;
  private buffer = '';
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessionListeners = new Map<string, Set<(event: WindowHostEvent) => void>>();

  constructor(options: {
    env?: Record<string, string | undefined>;
    requestTimeoutMs?: number;
  } = {}) {
    this.env = options.env ?? Deno.env.toObject();
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultHelperRequestTimeoutMs;
  }

  async request(payload: Record<string, unknown>) {
    await this.ensureStarted();
    if (!this.stdin) throw new Error(`${this.runtime?.label ?? 'Window host'} is not writable.`);
    const id = `window_req_${++this.nextRequestId}`;
    const message = { id, ...payload };
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.runtime?.label ?? 'Window host'} timed out: ${String(payload.type)}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
    await this.stdin.write(textEncoder.encode(`${JSON.stringify(message)}\n`));
    return result;
  }

  onSessionEvent(sessionId: string, listener: (event: WindowHostEvent) => void) {
    const listeners = this.sessionListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.sessionListeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.sessionListeners.delete(sessionId);
    };
  }

  dispose() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`${this.runtime?.label ?? 'Window host'} stopped.`));
    }
    this.pending.clear();
    this.sessionListeners.clear();
    this.stdin?.close().catch(() => undefined);
    this.process?.kill('SIGTERM');
    this.process = undefined;
    this.stdin = undefined;
  }

  private async ensureStarted() {
    if (this.process && this.stdin) return;
    this.runtime = await resolveWindowHostRuntime(this.env);
    if (!this.runtime) throw new Error(windowHostRuntimeError(this.env));

    const command = new Deno.Command(this.runtime.command, {
      args: this.runtime.args,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
      env: this.runtime.env,
    });
    this.process = command.spawn();
    this.stdin = this.process.stdin.getWriter();
    void this.readStdout(this.process.stdout);
    void this.readStderr(this.process.stderr);
    void this.process.status.then((status) => {
      this.rejectAll(new Error(`${this.runtime?.label ?? 'Window host'} exited with code ${status.code}.`));
      this.process = undefined;
      this.stdin = undefined;
    }).catch((error) => {
      this.rejectAll(new Error(`${this.runtime?.label ?? 'Window host'} failed: ${toErrorMessage(error)}`));
      this.process = undefined;
      this.stdin = undefined;
    });
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async readStdout(stdout: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of stdout) {
        this.buffer += textDecoder.decode(chunk, { stream: true });
        let newlineIndex = this.buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = this.buffer.slice(0, newlineIndex).trim();
          this.buffer = this.buffer.slice(newlineIndex + 1);
          if (line) this.handleLine(line);
          newlineIndex = this.buffer.indexOf('\n');
        }
      }
    } catch (error) {
      this.rejectAll(new Error(`${this.runtime?.label ?? 'Window host'} stdout failed: ${toErrorMessage(error)}`));
    }
  }

  private async readStderr(stderr: ReadableStream<Uint8Array>) {
    try {
      for await (const chunk of stderr) {
        const text = textDecoder.decode(chunk).trim();
        if (text) console.error(`[window-host] ${text}`);
      }
    } catch {
      // Stderr is diagnostic only.
    }
  }

  private handleLine(line: string) {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      console.error(`[window-host] invalid json: ${line}`);
      return;
    }

    if (typeof message.id === 'string') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.ok === false) {
        pending.reject(
          new Error(
            message.error === undefined
              ? `${this.runtime?.label ?? 'Window host'} request failed.`
              : toErrorMessage(message.error),
          ),
        );
      } else {
        pending.resolve(message);
      }
      return;
    }

    if (message.type === 'session.event') {
      const event = isRecord(message.event) ? message.event as WindowHostEvent : undefined;
      const sessionId = optionalString(message.sessionId) ?? optionalString(event?.sessionId);
      if (!event || !sessionId) return;
      for (const listener of this.sessionListeners.get(sessionId) ?? []) listener(event);
    }
  }
}

export class PortalWindowHost {
  private readonly helper: ProcessWindowHostClient;
  private readonly sessions = new Map<string, WindowSession & { dispose: () => void }>();

  constructor(options: {
    config: PortalWindowConfig;
    helper?: ProcessWindowHostClient;
  }) {
    this.helper = options.helper ?? new ProcessWindowHostClient();
  }

  async list(): Promise<{ ok: true; windows: PortalWindowInfo[] }> {
    const result = await this.helper.request({ type: 'windows.list' });
    const windows = Array.isArray(result.windows)
      ? result.windows.flatMap((item) => this.normalizeWindowInfo(item))
      : [];
    return { ok: true, windows };
  }

  async handleClientMessage(
    clientId: string,
    message: WindowClientMessage,
    send: (event: WindowHostEvent) => void,
  ) {
    const sessionId = optionalString(message.sessionId);
    if (!sessionId) {
      send({ type: 'error', error: 'sessionId is required.' });
      return;
    }

    if (message.type === 'start') {
      const dispose = this.helper.onSessionEvent(sessionId, send);
      this.sessions.set(sessionId, { clientId, send, dispose });
      try {
        await this.helper.request({
          type: 'session.start',
          sessionId,
          windowId: message.windowId,
          iceServers: message.iceServers ?? [],
        });
      } catch (error) {
        send({ type: 'error', sessionId, error: toErrorMessage(error) });
      }
      return;
    }

    if (message.type === 'answer') {
      await this.forwardOrReport(sessionId, send, {
        type: 'session.answer',
        sessionId,
        answer: message.answer,
      });
      return;
    }

    if (message.type === 'ice-candidate') {
      await this.forwardOrReport(sessionId, send, {
        type: 'session.ice-candidate',
        sessionId,
        candidate: message.candidate,
      });
      return;
    }

    if (message.type === 'ready') {
      await this.forwardOrReport(sessionId, send, { type: 'session.ready', sessionId });
      return;
    }

    if (message.type === 'stop') {
      await this.stop(sessionId, send);
    }
  }

  detachClientsByPrefix(prefix: string) {
    for (const [sessionId, session] of this.sessions) {
      if (session.clientId.startsWith(prefix)) void this.stop(sessionId, session.send);
    }
  }

  dispose() {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.helper.dispose();
  }

  private async stop(sessionId: string, send?: (event: WindowHostEvent) => void) {
    const session = this.sessions.get(sessionId);
    session?.dispose();
    this.sessions.delete(sessionId);
    await this.forwardOrReport(sessionId, send ?? session?.send, { type: 'session.stop', sessionId });
  }

  private async forwardOrReport(
    sessionId: string,
    send: ((event: WindowHostEvent) => void) | undefined,
    payload: Record<string, unknown>,
  ) {
    try {
      await this.helper.request(payload);
    } catch (error) {
      send?.({ type: 'error', sessionId, error: toErrorMessage(error) });
    }
  }

  private normalizeWindowInfo(value: unknown): PortalWindowInfo[] {
    if (!isRecord(value)) return [];
    const id = optionalString(value.id);
    if (!id) return [];
    return [{
      id,
      title: optionalString(value.title),
      appName: optionalString(value.appName),
      pid: typeof value.pid === 'number' ? value.pid : undefined,
      x: typeof value.x === 'number' ? value.x : undefined,
      y: typeof value.y === 'number' ? value.y : undefined,
      width: typeof value.width === 'number' ? value.width : undefined,
      height: typeof value.height === 'number' ? value.height : undefined,
    }];
  }
}

export const isWindowClientEnvelope = (message: Record<string, unknown>): message is WindowClientEnvelope =>
  message.type === 'window.client' &&
  typeof message.clientId === 'string' &&
  Boolean(message.message && typeof message.message === 'object');
