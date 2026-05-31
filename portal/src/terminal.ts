export type TerminalSessionKind = 'demiplane' | 'general';

export type TerminalStartInput = {
  kind: TerminalSessionKind;
  terminalId: string;
  planeId?: string;
  demiplaneId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type TerminalClientMessage =
  | ({ type: 'start' } & TerminalStartInput)
  | { type: 'input'; terminalId: string; data: string }
  | { type: 'resize'; terminalId: string; cols: number; rows: number }
  | { type: 'close'; terminalId: string }
  | { type: 'detach'; terminalId: string };

export type TerminalStartedEvent = {
  type: 'started';
  terminalId: string;
  demiplaneId?: string;
  sessionId: string;
  cwd: string;
  pid?: number;
  cols: number;
  rows: number;
};

export type TerminalHostEvent =
  | TerminalStartedEvent
  | { type: 'output'; terminalId: string; demiplaneId?: string; data: string }
  | { type: 'replay'; terminalId: string; demiplaneId?: string; data: string }
  | { type: 'title'; terminalId: string; demiplaneId?: string; title: string }
  | { type: 'exit'; terminalId: string; demiplaneId?: string; exitCode?: number; signal?: number | string }
  | { type: 'error'; terminalId: string; demiplaneId?: string; error: string };

export type TerminalClientEnvelope = {
  type: 'terminal.client';
  clientId: string;
  message: TerminalClientMessage;
};

export type TerminalEventEnvelope = {
  type: 'terminal.event';
  clientId: string;
  event: TerminalHostEvent;
};

export type TerminalPortalRoot = {
  id: string;
  name?: string;
  path: string;
};

export type TerminalPortalMount = {
  planeId: string;
  localPath: string;
};

export type TerminalPortalConfig = {
  mounts?: TerminalPortalMount[];
  roots?: TerminalPortalRoot[];
};

export type PortalPtyExitEvent = {
  exitCode?: number;
  signal?: number | string;
};

type Disposable = {
  dispose: () => void;
};

export type PortalPty = {
  pid?: number;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
  onData: (listener: (data: string) => void) => Disposable;
  onExit: (listener: (event: PortalPtyExitEvent) => void) => Disposable;
};

export type PortalPtySpawnOptions = {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
};

export type PortalPtySpawner = (
  file: string,
  args: string[],
  options: PortalPtySpawnOptions,
) => PortalPty | Promise<PortalPty>;

type NormalizedTerminalStartInput = TerminalStartInput & {
  cols: number;
  rows: number;
};

type TerminalSubscriber = {
  send: (event: TerminalHostEvent) => void;
};

type TerminalSession = {
  sessionId: string;
  kind: TerminalSessionKind;
  terminalId: string;
  planeId?: string;
  demiplaneId?: string;
  cwd: string;
  pty: PortalPty;
  cols: number;
  rows: number;
  replay: string;
  pendingOutput: string;
  outputTimer?: ReturnType<typeof setTimeout>;
  subscribers: Map<string, TerminalSubscriber>;
  disposables: Disposable[];
  exited: boolean;
};

export type PortalTerminalHostOptions = {
  config: TerminalPortalConfig;
  spawner?: PortalPtySpawner;
  replayLimitBytes?: number;
  outputBatchMs?: number;
  env?: Record<string, string | undefined>;
};

const defaultReplayLimitBytes = 200 * 1024;
const defaultOutputBatchMs = 16;

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const parseIdentifier = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseDimension = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
};

export const parseTerminalStartInput = (input: unknown): NormalizedTerminalStartInput => {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const isGeneralTerminalRequest = record.kind === 'general' ||
    (
      record.kind !== 'demiplane' &&
      record.planeId === undefined &&
      record.demiplaneId === undefined &&
      (record.terminalId === 'weave-general-terminal' || typeof record.cwd === 'string')
    );
  const kind: TerminalSessionKind = isGeneralTerminalRequest ? 'general' : 'demiplane';
  const parsedDimensions = {
    cols: parseDimension(record.cols, 80, 10, 400),
    rows: parseDimension(record.rows, 24, 3, 200),
  };

  const common = {
    portalId: optionalString(record.portalId),
    rootId: optionalString(record.rootId),
    repoPath: optionalString(record.repoPath),
    workspacePath: optionalString(record.workspacePath),
    cwd: optionalString(record.cwd),
    ...parsedDimensions,
  };

  if (kind === 'general') {
    return {
      kind,
      terminalId: parseIdentifier(record.terminalId ?? 'weave-general-terminal', 'terminalId'),
      ...common,
    };
  }

  const demiplaneId = parseIdentifier(record.demiplaneId, 'demiplaneId');
  return {
    kind,
    terminalId: parseIdentifier(record.terminalId ?? demiplaneId, 'terminalId'),
    planeId: parseIdentifier(record.planeId, 'planeId'),
    demiplaneId,
    ...common,
  };
};

const parseTerminalId = (value: unknown) => parseIdentifier(value, 'terminalId');

const parseTerminalInputData = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('terminal input data must be a string.');
  return value;
};

const parseTerminalResize = (cols: unknown, rows: unknown) => ({
  cols: parseDimension(cols, 80, 10, 400),
  rows: parseDimension(rows, 24, 3, 200),
});

const getDefaultShell = (env: Record<string, string | undefined>) => {
  if (Deno.build.os === 'windows') return { file: env.WEAVE_TERMINAL_SHELL || 'powershell.exe', args: ['-NoLogo'] };
  return {
    file: env.WEAVE_TERMINAL_SHELL || env.SHELL || (Deno.build.os === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    args: [] as string[],
  };
};

const getProcessEnv = (env: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

const textEncoder = new TextEncoder();

const nativePtyLibraryName = Deno.build.os === 'darwin'
  ? 'libweave_portal_pty.dylib'
  : Deno.build.os === 'linux'
  ? 'libweave_portal_pty.so'
  : undefined;

const nativePtyReadNone = 0;
const nativePtyReadData = 1;
const nativePtyReadExit = 2;
const nativePtyReadError = -1;

type PointerValue = NonNullable<ReturnType<typeof Deno.UnsafePointer.create>>;

const nativePtySymbols = {
  weave_pty_create: { parameters: ['buffer', 'usize', 'buffer'], result: 'pointer' },
  weave_pty_pid: { parameters: ['pointer'], result: 'u32' },
  weave_pty_read: { parameters: ['pointer', 'buffer', 'buffer', 'buffer', 'buffer'], result: 'i32' },
  weave_pty_write: { parameters: ['pointer', 'buffer', 'usize', 'buffer'], result: 'i32' },
  weave_pty_resize: { parameters: ['pointer', 'u16', 'u16', 'buffer'], result: 'i32' },
  weave_pty_close: { parameters: ['pointer'], result: 'void' },
  weave_pty_dispose: { parameters: ['pointer'], result: 'void' },
  weave_pty_free_data: { parameters: ['pointer', 'usize'], result: 'void' },
  weave_pty_free_string: { parameters: ['pointer'], result: 'void' },
} as const;

type NativePtyLibrary = Deno.DynamicLibrary<typeof nativePtySymbols>;

let nativePtyLibraryPromise: Promise<NativePtyLibrary> | undefined;

const pointerOut = (): BigUint64Array<ArrayBuffer> => new BigUint64Array(new ArrayBuffer(8));

const pathFromFileUrl = (url: URL) => {
  if (url.protocol !== 'file:') throw new Error('Portal native PTY library must be loaded from a file URL.');
  return decodeURIComponent(url.pathname);
};

const fileExists = async (path: string) => {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
};

const materializeNativePtyLibrary = async (libraryUrl: URL) => {
  const bytes = await Deno.readFile(libraryUrl).catch((error) => {
    throw new Error(
      `Portal native PTY library was not found. Run "deno task --config portal/deno.json native" first. ${
        toErrorMessage(error)
      }`,
    );
  });
  const directory = await Deno.makeTempDir({ prefix: 'weave-portal-pty-' });
  const path = `${directory}/${nativePtyLibraryName}`;
  await Deno.writeFile(path, bytes, { mode: 0o700 });
  return path;
};

const resolveNativePtyLibraryPath = async () => {
  if (!nativePtyLibraryName) throw new Error(`Portal native PTY is not supported on ${Deno.build.os}.`);
  const override = Deno.env.get('WEAVE_PORTAL_PTY_LIB_PATH')?.trim();
  if (override) return override;

  const libraryUrl = new URL(`../native/pty/target/release/${nativePtyLibraryName}`, import.meta.url);
  const libraryPath = pathFromFileUrl(libraryUrl);
  if (await fileExists(libraryPath)) return libraryPath;
  return await materializeNativePtyLibrary(libraryUrl);
};

const loadNativePtyLibrary = () => {
  nativePtyLibraryPromise ??= resolveNativePtyLibraryPath().then((path) => Deno.dlopen(path, nativePtySymbols));
  return nativePtyLibraryPromise;
};

const pointerFromOut = (out: BigUint64Array) => out[0] === 0n ? null : Deno.UnsafePointer.create(out[0]);

const readNativeError = (library: NativePtyLibrary, errorOut: BigUint64Array, fallback: string) => {
  const pointer = pointerFromOut(errorOut);
  if (!pointer) return fallback;
  try {
    return Deno.UnsafePointerView.getCString(pointer);
  } finally {
    library.symbols.weave_pty_free_string(pointer);
    errorOut[0] = 0n;
  }
};

const throwNativeError = (library: NativePtyLibrary, errorOut: BigUint64Array, fallback: string): never => {
  throw new Error(readNativeError(library, errorOut, fallback));
};

const createNativePty: PortalPtySpawner = async (file, args, options) => {
  const library = await loadNativePtyLibrary();
  const config = textEncoder.encode(JSON.stringify({
    file,
    args,
    cwd: options.cwd,
    env: options.env,
    cols: options.cols,
    rows: options.rows,
  }));
  const errorOut = pointerOut();
  const pty = library.symbols.weave_pty_create(config, BigInt(config.byteLength), errorOut) as PointerValue | null;
  if (!pty) throwNativeError(library, errorOut, 'native PTY create failed');

  const pid = library.symbols.weave_pty_pid(pty);
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: PortalPtyExitEvent) => void>();
  const decoder = new TextDecoder();
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let exited = false;
  let disposed = false;

  const emitData = (data: string) => {
    if (!data) return;
    for (const listener of [...dataListeners]) listener(data);
  };

  const disposeNative = () => {
    if (disposed) return;
    disposed = true;
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    library.symbols.weave_pty_dispose(pty);
  };

  const emitExit = (event: PortalPtyExitEvent) => {
    if (exited) return;
    exited = true;
    const trailing = decoder.decode();
    if (trailing) emitData(trailing);
    for (const listener of [...exitListeners]) listener(event);
    disposeNative();
  };

  const poll = () => {
    if (disposed || exited) return;
    let reads = 0;
    while (reads < 64) {
      reads += 1;
      const dataOut = pointerOut();
      const lenOut = pointerOut();
      const exitCodeOut = new Int32Array(1);
      const readErrorOut = pointerOut();
      const result = library.symbols.weave_pty_read(pty, dataOut, lenOut, exitCodeOut, readErrorOut);

      if (result === nativePtyReadNone) break;
      if (result === nativePtyReadError) {
        emitExit({ signal: readNativeError(library, readErrorOut, 'native PTY read failed') });
        return;
      }
      if (result === nativePtyReadExit) {
        emitExit({ exitCode: exitCodeOut[0] });
        return;
      }
      if (result !== nativePtyReadData) {
        emitExit({ signal: `native PTY returned unknown read status: ${result}` });
        return;
      }

      const dataPointer = pointerFromOut(dataOut);
      const byteLength = Number(lenOut[0]);
      if (!dataPointer || byteLength <= 0) continue;
      try {
        const buffer = new Deno.UnsafePointerView(dataPointer).getArrayBuffer(byteLength);
        emitData(decoder.decode(new Uint8Array(buffer).slice(), { stream: true }));
      } finally {
        library.symbols.weave_pty_free_data(dataPointer, BigInt(byteLength));
      }
    }

    pollTimer = setTimeout(poll, reads >= 64 ? 0 : 8);
  };

  pollTimer = setTimeout(poll, 0);

  const callWithError = (callback: (nextErrorOut: BigUint64Array<ArrayBuffer>) => number, fallback: string) => {
    if (disposed || exited) return;
    const nextErrorOut = pointerOut();
    const result = callback(nextErrorOut);
    if (result !== 0) emitExit({ signal: readNativeError(library, nextErrorOut, fallback) });
  };

  return {
    pid,
    write: (data) => {
      const bytes = textEncoder.encode(data);
      callWithError(
        (nextErrorOut) => library.symbols.weave_pty_write(pty, bytes, BigInt(bytes.byteLength), nextErrorOut),
        'native PTY write failed',
      );
    },
    resize: (cols, rows) => {
      callWithError(
        (nextErrorOut) => library.symbols.weave_pty_resize(pty, cols, rows, nextErrorOut),
        'native PTY resize failed',
      );
    },
    close: () => {
      if (disposed || exited) return;
      library.symbols.weave_pty_close(pty);
      setTimeout(() => {
        if (!exited) emitExit({});
      }, 2_000);
    },
    onData: (listener) => {
      dataListeners.add(listener);
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
  };
};

const defaultRoots = (): TerminalPortalRoot[] => [{
  id: 'default',
  name: 'Default',
  path: Deno.env.get('HOME') ?? Deno.cwd(),
}];

export class PortalTerminalHost {
  private readonly config: TerminalPortalConfig;
  private readonly spawner: PortalPtySpawner;
  private readonly replayLimitBytes: number;
  private readonly outputBatchMs: number;
  private readonly env: Record<string, string | undefined>;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly clientSessions = new Map<string, Set<string>>();

  constructor(options: PortalTerminalHostOptions) {
    this.config = options.config;
    this.env = options.env ?? Deno.env.toObject();
    this.spawner = options.spawner ?? createNativePty;
    this.replayLimitBytes = options.replayLimitBytes ?? defaultReplayLimitBytes;
    this.outputBatchMs = options.outputBatchMs ?? defaultOutputBatchMs;
  }

  async handleClientMessage(
    clientId: string,
    message: TerminalClientMessage,
    send: (event: TerminalHostEvent) => void,
  ) {
    try {
      if (message.type === 'start') {
        await this.start(message, clientId, send);
        return;
      }

      if (message.type === 'input') {
        this.input(parseTerminalId(message.terminalId), parseTerminalInputData(message.data));
        return;
      }

      if (message.type === 'resize') {
        const size = parseTerminalResize(message.cols, message.rows);
        this.resize(parseTerminalId(message.terminalId), size.cols, size.rows);
        return;
      }

      if (message.type === 'close') {
        this.close(parseTerminalId(message.terminalId));
        return;
      }

      if (message.type === 'detach') {
        this.detach(parseTerminalId(message.terminalId), clientId);
      }
    } catch (error) {
      const terminalId = 'terminalId' in message && typeof message.terminalId === 'string'
        ? message.terminalId
        : 'unknown';
      send({ type: 'error', terminalId, error: toErrorMessage(error) });
    }
  }

  detachClient(clientId: string) {
    const terminalIds = this.clientSessions.get(clientId);
    if (!terminalIds) return;
    for (const terminalId of terminalIds) this.detach(terminalId, clientId);
  }

  detachClientsByPrefix(prefix: string) {
    for (const clientId of [...this.clientSessions.keys()]) {
      if (clientId.startsWith(prefix)) this.detachClient(clientId);
    }
  }

  dispose() {
    for (const session of this.sessions.values()) {
      this.disposeSession(session);
      if (!session.exited) session.pty.close();
    }
    this.sessions.clear();
    this.clientSessions.clear();
  }

  private async start(input: TerminalStartInput, clientId: string, send: (event: TerminalHostEvent) => void) {
    const normalizedInput = parseTerminalStartInput(input);

    try {
      const existing = this.sessions.get(normalizedInput.terminalId);
      if (existing && !existing.exited) {
        this.attach(existing, clientId, send);
        this.resize(normalizedInput.terminalId, normalizedInput.cols, normalizedInput.rows);
        this.sendStarted(existing, send);
        this.sendReplay(existing, send);
        return;
      }

      const cwd = await this.resolveCwd(normalizedInput);
      await this.assertDirectory(cwd);

      const shell = getDefaultShell(this.env);
      const weaveEnv: Record<string, string> = {
        WEAVE_WORKSPACE: cwd,
      };
      if (normalizedInput.kind === 'demiplane') {
        if (normalizedInput.planeId) weaveEnv.WEAVE_PLANE_ID = normalizedInput.planeId;
        if (normalizedInput.demiplaneId) weaveEnv.WEAVE_DEMIPLANE_ID = normalizedInput.demiplaneId;
      }
      const pty = await this.spawner(shell.file, shell.args, {
        cols: normalizedInput.cols,
        rows: normalizedInput.rows,
        cwd,
        env: {
          ...getProcessEnv(this.env),
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          WEAVE_TERMINAL_KIND: normalizedInput.kind,
          WEAVE_TERMINAL_ID: normalizedInput.terminalId,
          ...weaveEnv,
        },
      });

      const session: TerminalSession = {
        sessionId: crypto.randomUUID(),
        kind: normalizedInput.kind,
        terminalId: normalizedInput.terminalId,
        planeId: normalizedInput.planeId,
        demiplaneId: normalizedInput.demiplaneId,
        cwd,
        pty,
        cols: normalizedInput.cols,
        rows: normalizedInput.rows,
        replay: '',
        pendingOutput: '',
        subscribers: new Map([[clientId, { send }]]),
        disposables: [],
        exited: false,
      };

      this.trackClientSession(clientId, normalizedInput.terminalId);
      session.disposables.push(
        pty.onData((data) => this.queueOutput(session, data)),
        pty.onExit((event) => this.handleExit(session, event)),
      );
      this.sessions.set(normalizedInput.terminalId, session);
      this.sendStarted(session, send);
    } catch (error) {
      send({
        type: 'error',
        terminalId: normalizedInput.terminalId,
        demiplaneId: normalizedInput.demiplaneId,
        error: toErrorMessage(error),
      });
    }
  }

  private input(terminalId: string, data: string) {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) throw new Error('Terminal session is not running.');
    session.pty.write(data);
  }

  private resize(terminalId: string, cols: number, rows: number) {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return;
    const nextCols = parseDimension(cols, session.cols, 10, 400);
    const nextRows = parseDimension(rows, session.rows, 3, 200);
    if (session.cols === nextCols && session.rows === nextRows) return;

    session.cols = nextCols;
    session.rows = nextRows;
    session.pty.resize(nextCols, nextRows);
  }

  private close(terminalId: string) {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return;
    session.pty.close();
  }

  private detach(terminalId: string, clientId: string) {
    this.sessions.get(terminalId)?.subscribers.delete(clientId);
    const terminalIds = this.clientSessions.get(clientId);
    terminalIds?.delete(terminalId);
    if (terminalIds?.size === 0) this.clientSessions.delete(clientId);
  }

  private async resolveCwd(input: NormalizedTerminalStartInput) {
    if (input.kind === 'general') {
      if (input.workspacePath) return await Deno.realPath(input.workspacePath);
      if (input.rootId) return await this.resolveRootPath(input.rootId, '').then((result) => result.target);
      if (input.cwd) return await Deno.realPath(input.cwd);
      return await Deno.realPath(Deno.env.get('HOME') ?? Deno.cwd());
    }

    if (input.workspacePath) return await Deno.realPath(input.workspacePath);
    const mount = (this.config.mounts ?? []).find((item) => item.planeId === input.planeId);
    if (mount) return await Deno.realPath(mount.localPath);
    if (input.rootId && input.repoPath) {
      return await this.resolveRootPath(input.rootId, input.repoPath).then((result) => result.target);
    }
    throw new Error(`Plane is not mounted: ${String(input.planeId)}`);
  }

  private async resolveRootPath(rootId: string, path = '') {
    const root = (this.config.roots?.length ? this.config.roots : defaultRoots()).find((item) => item.id === rootId);
    if (!root) throw new Error(`Unknown root: ${rootId}`);
    const rootPath = await Deno.realPath(root.path);
    const target = path ? await Deno.realPath(`${rootPath}/${path}`) : rootPath;
    if (target !== rootPath && !target.startsWith(`${rootPath}/`)) throw new Error('Path escapes Portal root');
    return { rootPath, target };
  }

  private async assertDirectory(cwd: string) {
    const details = await Deno.stat(cwd);
    if (!details.isDirectory) throw new Error('Terminal path is not a directory.');
  }

  private trackClientSession(clientId: string, terminalId: string) {
    const terminalIds = this.clientSessions.get(clientId) ?? new Set<string>();
    terminalIds.add(terminalId);
    this.clientSessions.set(clientId, terminalIds);
  }

  private attach(session: TerminalSession, clientId: string, send: (event: TerminalHostEvent) => void) {
    session.subscribers.set(clientId, { send });
    this.trackClientSession(clientId, session.terminalId);
  }

  private sendStarted(session: TerminalSession, send: (event: TerminalHostEvent) => void) {
    send({
      type: 'started',
      terminalId: session.terminalId,
      demiplaneId: session.demiplaneId,
      sessionId: session.sessionId,
      cwd: session.cwd,
      pid: session.pty.pid,
      cols: session.cols,
      rows: session.rows,
    });
  }

  private sendReplay(session: TerminalSession, send: (event: TerminalHostEvent) => void) {
    if (!session.replay) return;
    send({
      type: 'replay',
      terminalId: session.terminalId,
      demiplaneId: session.demiplaneId,
      data: session.replay,
    });
  }

  private queueOutput(session: TerminalSession, data: string) {
    session.pendingOutput += data;
    if (session.outputTimer) return;

    session.outputTimer = setTimeout(() => {
      session.outputTimer = undefined;
      this.flushOutput(session);
    }, this.outputBatchMs);
  }

  private flushOutput(session: TerminalSession) {
    if (!session.pendingOutput) return;
    const data = session.pendingOutput;
    session.pendingOutput = '';
    this.appendReplay(session, data);
    this.broadcast(session, {
      type: 'output',
      terminalId: session.terminalId,
      demiplaneId: session.demiplaneId,
      data,
    });
  }

  private appendReplay(session: TerminalSession, data: string) {
    session.replay += data;
    if (byteLength(session.replay) <= this.replayLimitBytes) return;

    session.replay = session.replay.slice(Math.max(0, session.replay.length - this.replayLimitBytes));
    while (byteLength(session.replay) > this.replayLimitBytes) {
      session.replay = session.replay.slice(Math.ceil(session.replay.length * 0.1));
    }
  }

  private handleExit(session: TerminalSession, event: PortalPtyExitEvent) {
    this.flushOutput(session);
    session.exited = true;
    this.broadcast(session, {
      type: 'exit',
      terminalId: session.terminalId,
      demiplaneId: session.demiplaneId,
      exitCode: event.exitCode,
      signal: event.signal,
    });
    this.disposeSession(session);
    this.sessions.delete(session.terminalId);
  }

  private disposeSession(session: TerminalSession) {
    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
      session.outputTimer = undefined;
    }
    for (const disposable of session.disposables) disposable.dispose();
    session.disposables = [];
  }

  private broadcast(session: TerminalSession, event: TerminalHostEvent) {
    for (const [clientId, subscriber] of session.subscribers) {
      try {
        subscriber.send(event);
      } catch {
        session.subscribers.delete(clientId);
      }
    }
  }
}

export const isTerminalClientEnvelope = (message: Record<string, unknown>): message is TerminalClientEnvelope =>
  message.type === 'terminal.client' &&
  typeof message.clientId === 'string' &&
  Boolean(message.message && typeof message.message === 'object');

export const startTerminalControlServer = (input: {
  host: PortalTerminalHost;
  hostname: string;
  port: number;
  token: string;
  metadata?: Record<string, unknown>;
  onShutdown?: () => void | Promise<void>;
}) => {
  const assertToken = (request: Request) => {
    const url = new URL(request.url);
    const token = url.searchParams.get('token') ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    return token === input.token;
  };

  let server: Deno.HttpServer<Deno.NetAddr>;
  server = Deno.serve({ hostname: input.hostname, port: input.port }, (request) => {
    const url = new URL(request.url);
    if (!assertToken(request)) return new Response('unauthorized', { status: 401 });
    if (url.pathname === '/health') return Response.json({ ok: true, ...(input.metadata ?? {}) });
    if (url.pathname === '/shutdown') {
      setTimeout(() => {
        void Promise.resolve(input.onShutdown?.()).finally(() => {
          input.host.dispose();
          void server.shutdown();
        });
      }, 0);
      return Response.json({ ok: true });
    }
    if (url.pathname !== '/terminal') return new Response('not found', { status: 404 });

    const { socket, response } = Deno.upgradeWebSocket(request);
    const socketClientId = `local:${crypto.randomUUID()}`;
    const socketClientIds = new Set([socketClientId]);

    socket.onmessage = (event) => {
      const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
      const clientId = typeof parsed.clientId === 'string' ? parsed.clientId : socketClientId;
      socketClientIds.add(clientId);
      const message = parsed.message && typeof parsed.message === 'object'
        ? parsed.message as TerminalClientMessage
        : parsed as TerminalClientMessage;
      void input.host.handleClientMessage(clientId, message, (terminalEvent) => {
        socket.send(JSON.stringify({ type: 'terminal.event', clientId, event: terminalEvent }));
      });
    };

    socket.onclose = () => {
      for (const clientId of socketClientIds) input.host.detachClient(clientId);
    };
    socket.onerror = () => {
      for (const clientId of socketClientIds) input.host.detachClient(clientId);
    };

    return response;
  });
  return server;
};
