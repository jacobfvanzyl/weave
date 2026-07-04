import {
  assertPortalWorkspaceFilePathWithinRoot,
  joinPortalWorkspaceFilePath,
  parseWorkspaceFilePath,
  type PortalWorkspaceFileConfig,
  type PortalWorkspaceFileTarget,
  resolvePortalWorkspaceFileRoot,
} from './workspace-files.ts';

export type PortalJupyterTarget = PortalWorkspaceFileTarget;

export type PortalJupyterStatusInput = {
  target?: PortalJupyterTarget;
} & PortalJupyterTarget;

export type PortalJupyterKernelspecsInput = PortalJupyterStatusInput;

export type PortalJupyterSessionInput = {
  target?: PortalJupyterTarget;
  path: string;
  kernelName?: string;
  language?: string;
} & PortalJupyterTarget;

export type PortalJupyterExecuteInput = {
  sessionId: string;
  requestId?: string;
  cellId?: string;
  code: string;
  silent?: boolean;
  storeHistory?: boolean;
  allowStdin?: boolean;
};

export type PortalJupyterStatusResult = {
  ok: true;
  available: boolean;
  status: 'ready' | 'missing' | 'error';
  command?: string;
  rootPath?: string;
  url?: string;
  uvAvailable?: boolean;
  uvCommand?: string;
  workspaceKernelName?: string;
  venvPath?: string;
  pythonPath?: string;
  error?: string;
};

export type PortalJupyterKernelSpec = {
  name: string;
  displayName: string;
  language?: string;
  argv?: string[];
};

export type PortalJupyterKernelspecsResult = {
  ok: true;
  available: boolean;
  defaultKernelName?: string;
  kernelspecs: PortalJupyterKernelSpec[];
  error?: string;
};

export type PortalJupyterSessionResult = {
  ok: true;
  available: boolean;
  sessionId: string;
  kernelId: string;
  kernelName: string;
  rootPath: string;
  path: string;
  venvPath?: string;
  pythonPath?: string;
};

export type PortalJupyterMimeBundle = Record<string, unknown>;

export type PortalJupyterOutput =
  | { output_type: 'stream'; name: 'stdout' | 'stderr' | string; text: string }
  | {
    output_type: 'display_data';
    data: PortalJupyterMimeBundle;
    metadata?: Record<string, unknown>;
    transient?: Record<string, unknown>;
  }
  | {
    output_type: 'execute_result';
    execution_count?: number | null;
    data: PortalJupyterMimeBundle;
    metadata?: Record<string, unknown>;
  }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] };

export type PortalJupyterHostEvent =
  | { type: 'ready'; sessionId: string; kernelId: string; kernelName: string }
  | { type: 'status'; sessionId: string; requestId?: string; cellId?: string; executionState: string }
  | { type: 'execution_input'; sessionId: string; requestId?: string; cellId?: string; executionCount: number }
  | { type: 'output'; sessionId: string; requestId?: string; cellId?: string; output: PortalJupyterOutput }
  | { type: 'clear_output'; sessionId: string; requestId?: string; cellId?: string; wait: boolean }
  | {
    type: 'complete';
    sessionId: string;
    requestId?: string;
    cellId?: string;
    status: 'ok' | 'error' | 'interrupted';
    executionCount?: number | null;
  }
  | { type: 'error'; sessionId?: string; requestId?: string; cellId?: string; error: string };

export type PortalJupyterClientMessage =
  | {
    type: 'execute';
    sessionId: string;
    requestId?: string;
    cellId?: string;
    code: string;
    silent?: boolean;
    storeHistory?: boolean;
    allowStdin?: boolean;
  }
  | { type: 'detach'; sessionId?: string };

export type PortalJupyterClientEnvelope = {
  type: 'jupyter.client';
  clientId: string;
  message: PortalJupyterClientMessage;
};

export type PortalJupyterEventEnvelope = {
  type: 'jupyter.event';
  clientId: string;
  event: PortalJupyterHostEvent;
};

export type PortalJupyterRuntime = {
  status: (input: PortalJupyterStatusInput) => Promise<PortalJupyterStatusResult>;
  kernelspecs: (input: PortalJupyterKernelspecsInput) => Promise<PortalJupyterKernelspecsResult>;
  createSession: (input: PortalJupyterSessionInput) => Promise<PortalJupyterSessionResult>;
  execute: (input: PortalJupyterExecuteInput, send: (event: PortalJupyterHostEvent) => void) => Promise<void>;
  detachSession?: (sessionId: string) => void;
  dispose?: () => Promise<void> | void;
};

type PortalJupyterHostOptions = {
  config: PortalWorkspaceFileConfig;
  runtime?: PortalJupyterRuntime;
};

type PortalJupyterCommandOptions = {
  cwd?: string;
  env?: Record<string, string>;
  stdout?: 'piped' | 'null';
  stderr?: 'piped' | 'null';
};

type PortalJupyterCommandResult = {
  code: number;
  stderr: string;
  stdout: string;
  success: boolean;
};

type PortalJupyterCommandRunner = (
  command: string,
  args: string[],
  options?: PortalJupyterCommandOptions,
) => Promise<PortalJupyterCommandResult>;

type WorkspacePythonEnvironmentDeps = {
  commandRunner?: PortalJupyterCommandRunner;
  env?: Record<string, string | undefined>;
  mkdir?: (path: string, options?: Deno.MkdirOptions) => Promise<void>;
  stat?: (path: string) => Promise<Deno.FileInfo>;
  writeTextFile?: (path: string, data: string, options?: Deno.WriteFileOptions) => Promise<void>;
};

type LocalJupyterRuntimeOptions = WorkspacePythonEnvironmentDeps;

type LocalJupyterServer = {
  baseUrl: string;
  process: Deno.ChildProcess;
  pythonEnvironment: WorkspacePythonEnvironment;
  rootPath: string;
  token: string;
};

type WorkspacePythonEnvironment = {
  binPath: string;
  jupyterDataPath: string;
  kernelEnv: Record<string, string>;
  kernelName: string;
  kernelspecDir: string;
  kernelspecPath: string;
  pythonPath: string;
  rootPath: string;
  venvPath: string;
};

type LocalJupyterKernelSession = {
  clientSessionId: string;
  kernelId: string;
  kernelName: string;
  path: string;
  pythonEnvironment: WorkspacePythonEnvironment;
  rootPath: string;
  server: LocalJupyterServer;
  sessionId: string;
};

type JupyterMessage = {
  channel?: string;
  header?: {
    msg_id?: string;
    msg_type?: string;
    session?: string;
    username?: string;
    version?: string;
    date?: string;
  };
  parent_header?: {
    msg_id?: string;
  };
  metadata?: Record<string, unknown>;
  content?: Record<string, unknown>;
  buffers?: unknown[];
};

const command = 'jupyter';
const uvCommand = 'uv';
const defaultKernelName = 'python3';
const workspacePythonKernelName = 'coppermind-python';
const workspacePythonKernelDisplayName = 'Coppermind Python';
const websocketExecutionTimeoutMs = 10 * 60_000;
const textDecoder = new TextDecoder();
const pathDelimiter = Deno.build.os === 'windows' ? ';' : ':';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const targetFromInput = (input: Record<string, unknown>) => {
  const target = isRecord(input.target) ? input.target : input;
  return {
    projectId: optionalString(target.projectId),
    workspaceId: optionalString(target.workspaceId),
    portalId: optionalString(target.portalId),
    rootId: optionalString(target.rootId),
    repoPath: optionalString(target.repoPath),
    workspacePath: optionalString(target.workspacePath),
  };
};

const toText = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => String(item)).join('');
  return value === undefined || value === null ? '' : String(value);
};

const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const ensureNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const trimRightSlashes = (value: string) => value.replace(/[\\/]+$/, '');

const trimLeftSlashes = (value: string) => value.replace(/^[\\/]+/, '');

const joinPath = (first: string, ...rest: string[]) =>
  rest.reduce((path, part) => {
    if (!part) return path;
    if (!path) return part;
    return `${trimRightSlashes(path)}/${trimLeftSlashes(part)}`;
  }, first);

const getEnvValue = (env: Record<string, string | undefined> | undefined, key: string) =>
  env ? env[key] : Deno.env.get(key);

const uniqueStrings = (items: Array<string | undefined>) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
};

const envPathEntries = (env: Record<string, string | undefined> | undefined) =>
  (getEnvValue(env, 'PATH') ?? '').split(pathDelimiter).filter(Boolean);

const commonCommandDirectories = (env: Record<string, string | undefined> | undefined) => {
  const home = getEnvValue(env, 'HOME');
  return uniqueStrings([
    home ? joinPath(home, '.local', 'bin') : undefined,
    home ? joinPath(home, '.cargo', 'bin') : undefined,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]);
};

const commandPathEntries = (env: Record<string, string | undefined> | undefined) =>
  uniqueStrings([...envPathEntries(env), ...commonCommandDirectories(env)]);

const executablePath = (env: Record<string, string | undefined> | undefined, prepend: string[] = []) =>
  uniqueStrings([...prepend, ...commandPathEntries(env)]).join(pathDelimiter);

const prependEnvPath = (value: string | undefined, entry: string) =>
  [entry, value].filter((part): part is string => Boolean(part)).join(pathDelimiter);

const commandBasename = (command: string) =>
  Deno.build.os === 'windows' && !/\.(exe|cmd|bat)$/i.test(command) ? `${command}.exe` : command;

const commandCandidates = (command: string, env?: Record<string, string | undefined>) => {
  if (command.includes('/') || command.includes('\\')) return [command];
  const name = commandBasename(command);
  return uniqueStrings([command, ...commandPathEntries(env).map((directory) => joinPath(directory, name))]);
};

const defaultCommandRunner: PortalJupyterCommandRunner = async (command, args, options = {}) => {
  const stdout = options.stdout ?? 'piped';
  const stderr = options.stderr ?? 'piped';
  const output = await new Deno.Command(command, {
    args,
    cwd: options.cwd,
    env: options.env,
    stdout,
    stderr,
  }).output();
  return {
    code: output.code,
    stderr: stderr === 'piped' ? textDecoder.decode(output.stderr) : '',
    stdout: stdout === 'piped' ? textDecoder.decode(output.stdout) : '',
    success: output.success,
  };
};

const resolveCommand = async (
  command: string,
  runner: PortalJupyterCommandRunner = defaultCommandRunner,
  env?: Record<string, string | undefined>,
) => {
  for (const candidate of commandCandidates(command, env)) {
    try {
      const output = await runner(candidate, ['--version'], {
        stdout: 'null',
        stderr: 'null',
      });
      if (output.success) return candidate;
    } catch {
      // Try the next candidate. GUI-launched Portal processes often have a sparse PATH.
    }
  }
  return undefined;
};

const commandAvailable = async (
  command: string,
  runner: PortalJupyterCommandRunner = defaultCommandRunner,
  env?: Record<string, string | undefined>,
) => {
  return Boolean(await resolveCommand(command, runner, env));
};

const requireCommand = async (
  command: string,
  runner: PortalJupyterCommandRunner,
  message: string,
  env?: Record<string, string | undefined>,
) => {
  const resolved = await resolveCommand(command, runner, env);
  if (!resolved) throw new Error(message);
  return resolved;
};

const runRequired = async (
  runner: PortalJupyterCommandRunner,
  command: string,
  args: string[],
  options: PortalJupyterCommandOptions | undefined,
  fallbackMessage: string,
) => {
  const output = await runner(command, args, options);
  if (output.success) return output;
  throw new Error(output.stderr.trim() || output.stdout.trim() || fallbackMessage);
};

const pathExists = async (
  path: string,
  stat: (path: string) => Promise<Deno.FileInfo> = Deno.stat,
) => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

const workspacePythonEnvironmentPaths = (
  rootPath: string,
  env?: Record<string, string | undefined>,
): WorkspacePythonEnvironment => {
  const venvPath = joinPath(rootPath, '.venv');
  const binPath = Deno.build.os === 'windows' ? joinPath(venvPath, 'Scripts') : joinPath(venvPath, 'bin');
  const pythonPath = Deno.build.os === 'windows' ? joinPath(binPath, 'python.exe') : joinPath(binPath, 'python');
  const jupyterDataPath = joinPath(venvPath, 'share', 'jupyter');
  const kernelspecDir = joinPath(jupyterDataPath, 'kernels', workspacePythonKernelName);
  return {
    binPath,
    jupyterDataPath,
    kernelEnv: {
      VIRTUAL_ENV: venvPath,
      PATH: executablePath(env, [binPath]),
      PYTHONNOUSERSITE: '1',
    },
    kernelName: workspacePythonKernelName,
    kernelspecDir,
    kernelspecPath: joinPath(kernelspecDir, 'kernel.json'),
    pythonPath,
    rootPath,
    venvPath,
  };
};

const jupyterServerEnv = (
  environment: WorkspacePythonEnvironment,
  env?: Record<string, string | undefined>,
) => ({
  JUPYTER_PATH: prependEnvPath(getEnvValue(env, 'JUPYTER_PATH'), environment.jupyterDataPath),
});

const writeWorkspacePythonKernelspec = async (
  environment: WorkspacePythonEnvironment,
  deps: WorkspacePythonEnvironmentDeps = {},
) => {
  const mkdir = deps.mkdir ?? Deno.mkdir;
  const writeTextFile = deps.writeTextFile ?? Deno.writeTextFile;
  await mkdir(environment.kernelspecDir, { recursive: true });
  await writeTextFile(
    environment.kernelspecPath,
    `${
      JSON.stringify(
        {
          argv: [
            environment.pythonPath,
            '-m',
            'ipykernel_launcher',
            '-f',
            '{connection_file}',
          ],
          display_name: workspacePythonKernelDisplayName,
          env: environment.kernelEnv,
          language: 'python',
          metadata: {
            debugger: true,
          },
        },
        null,
        2,
      )
    }\n`,
  );
};

const prepareWorkspacePythonEnvironment = async (
  rootPath: string,
  deps: WorkspacePythonEnvironmentDeps = {},
) => {
  const commandRunner = deps.commandRunner ?? defaultCommandRunner;
  const stat = deps.stat ?? Deno.stat;
  const environment = workspacePythonEnvironmentPaths(rootPath, deps.env);

  const resolvedUvCommand = await requireCommand(
    uvCommand,
    commandRunner,
    'uv is required for Coppermind workspace Python kernels but was not found on PATH.',
    deps.env,
  );

  if (!await pathExists(environment.venvPath, stat)) {
    await runRequired(
      commandRunner,
      resolvedUvCommand,
      ['venv', '--seed', '.venv'],
      { cwd: rootPath },
      'uv failed to create the Coppermind workspace Python environment.',
    );
  }

  const ipykernelCheck = await commandRunner(environment.pythonPath, ['-c', 'import ipykernel'], {
    cwd: rootPath,
    env: environment.kernelEnv,
  }).catch(() => ({ success: false, code: 1, stdout: '', stderr: '' }));

  if (!ipykernelCheck.success) {
    await runRequired(
      commandRunner,
      resolvedUvCommand,
      ['pip', 'install', '--python', environment.pythonPath, 'ipykernel'],
      { cwd: rootPath },
      'uv failed to install ipykernel into the Coppermind workspace Python environment.',
    );
  }

  await writeWorkspacePythonKernelspec(environment, deps);
  return environment;
};

const selectJupyterKernelName = (input: { kernelName?: string; language?: string }) =>
  input.kernelName || (input.language === 'python' ? workspacePythonKernelName : defaultKernelName);

const resolveRootAndPath = async (
  config: PortalWorkspaceFileConfig,
  input: Record<string, unknown>,
) => {
  const rootPath = await resolvePortalWorkspaceFileRoot(config, targetFromInput(input));
  const path = parseWorkspaceFilePath(input.path ?? '', 'path');
  const absolutePath = joinPortalWorkspaceFilePath(rootPath, path);
  assertPortalWorkspaceFilePathWithinRoot(rootPath, absolutePath);
  return { absolutePath, path, rootPath };
};

const getFreePort = async () => {
  const listener = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const address = listener.addr;
  listener.close();
  if (address.transport !== 'tcp') throw new Error('Unable to allocate a TCP port.');
  return address.port;
};

const drainStream = async (stream: ReadableStream<Uint8Array> | null) => {
  if (!stream) return;
  try {
    await stream.pipeTo(new WritableStream<Uint8Array>({ write: () => undefined }));
  } catch {
    // Process streams may close abruptly when the process is killed.
  }
};

const withToken = (url: string, token: string) => {
  const next = new URL(url);
  next.searchParams.set('token', token);
  return next;
};

const fetchJson = async <T>(url: URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const parsed = text
    ? (() => {
      try {
        return JSON.parse(text) as T & { message?: string; error?: string };
      } catch {
        return undefined;
      }
    })()
    : undefined;
  if (!response.ok) {
    throw new Error(parsed?.message || parsed?.error || text || `Jupyter request failed: HTTP ${response.status}`);
  }
  return (parsed ?? {}) as T;
};

const createMessage = (
  sessionId: string,
  msgType: string,
  content: Record<string, unknown>,
): JupyterMessage => ({
  channel: 'shell',
  header: {
    msg_id: crypto.randomUUID(),
    msg_type: msgType,
    session: sessionId,
    username: 'weave',
    version: '5.3',
    date: new Date().toISOString(),
  },
  parent_header: {},
  metadata: {},
  content,
  buffers: [],
});

const normalizeTerminalStatus = (value: unknown): 'ok' | 'error' | 'interrupted' => {
  if (value === 'error') return 'error';
  if (value === 'abort' || value === 'aborted' || value === 'interrupted') return 'interrupted';
  return 'ok';
};

class LocalJupyterRuntime implements PortalJupyterRuntime {
  private readonly commandRunner: PortalJupyterCommandRunner;
  private servers = new Map<string, Promise<LocalJupyterServer>>();
  private sessions = new Map<string, Promise<LocalJupyterKernelSession>>();
  private pythonEnvironments = new Map<string, Promise<WorkspacePythonEnvironment>>();

  constructor(
    private readonly config: PortalWorkspaceFileConfig,
    private readonly options: LocalJupyterRuntimeOptions = {},
  ) {
    this.commandRunner = options.commandRunner ?? defaultCommandRunner;
  }

  async status(input: PortalJupyterStatusInput): Promise<PortalJupyterStatusResult> {
    const target = targetFromInput(input);
    let rootPath: string | undefined;
    try {
      rootPath = await resolvePortalWorkspaceFileRoot(this.config, target);
    } catch (error) {
      return {
        ok: true,
        available: false,
        status: 'error',
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const paths = workspacePythonEnvironmentPaths(rootPath, this.options.env);
    const resolvedUvCommand = await resolveCommand(uvCommand, this.commandRunner, this.options.env);
    const resolvedJupyterCommand = await resolveCommand(command, this.commandRunner, this.options.env);
    const uvAvailable = Boolean(resolvedUvCommand);
    if (!resolvedJupyterCommand) {
      return {
        ok: true,
        available: false,
        status: 'missing',
        command,
        rootPath,
        uvAvailable,
        uvCommand: resolvedUvCommand ?? uvCommand,
        workspaceKernelName: workspacePythonKernelName,
        ...(await pathExists(paths.venvPath).catch(() => false)
          ? { venvPath: paths.venvPath, pythonPath: paths.pythonPath }
          : {}),
      };
    }
    if (!uvAvailable) {
      return {
        ok: true,
        available: false,
        status: 'missing',
        command: resolvedJupyterCommand,
        rootPath,
        uvAvailable,
        uvCommand,
        workspaceKernelName: workspacePythonKernelName,
        error: 'uv is required for Coppermind workspace Python kernels but was not found on PATH.',
        ...(await pathExists(paths.venvPath).catch(() => false)
          ? { venvPath: paths.venvPath, pythonPath: paths.pythonPath }
          : {}),
      };
    }

    return {
      ok: true,
      available: true,
      status: 'ready',
      command: resolvedJupyterCommand,
      rootPath,
      uvAvailable,
      uvCommand: resolvedUvCommand,
      workspaceKernelName: workspacePythonKernelName,
      ...(await pathExists(paths.venvPath).catch(() => false)
        ? { venvPath: paths.venvPath, pythonPath: paths.pythonPath }
        : {}),
    };
  }

  async kernelspecs(input: PortalJupyterKernelspecsInput): Promise<PortalJupyterKernelspecsResult> {
    const status = await this.status(input);
    if (!status.available) {
      return {
        ok: true,
        available: false,
        kernelspecs: [],
        error: status.error ?? 'Jupyter is not available.',
      };
    }

    const server = await this.ensureServer(status.rootPath!);
    const response = await fetchJson<{
      default?: string;
      kernelspecs?: Record<string, {
        name?: string;
        spec?: {
          argv?: string[];
          display_name?: string;
          language?: string;
        };
      }>;
    }>(withToken(`${server.baseUrl}/api/kernelspecs`, server.token));

    const kernelspecs = Object.entries(response.kernelspecs ?? {}).map(([name, item]) => ({
      name: item.name ?? name,
      displayName: item.spec?.display_name ?? item.name ?? name,
      language: item.spec?.language,
      argv: item.spec?.argv,
    }));

    return {
      ok: true,
      available: true,
      defaultKernelName: kernelspecs.some((spec) => spec.name === workspacePythonKernelName)
        ? workspacePythonKernelName
        : response.default ?? kernelspecs[0]?.name,
      kernelspecs,
    };
  }

  async createSession(input: PortalJupyterSessionInput): Promise<PortalJupyterSessionResult> {
    const { path, rootPath } = await resolveRootAndPath(this.config, input);
    const kernelName = selectJupyterKernelName(input);
    const cacheKey = `${rootPath}\0${path}\0${kernelName}`;
    const existing = this.sessions.get(cacheKey);
    if (existing) return this.sessionResult(await existing);

    const sessionPromise = this.createKernelSession(rootPath, path, kernelName);
    this.sessions.set(cacheKey, sessionPromise);
    try {
      return this.sessionResult(await sessionPromise);
    } catch (error) {
      this.sessions.delete(cacheKey);
      throw error;
    }
  }

  async execute(input: PortalJupyterExecuteInput, send: (event: PortalJupyterHostEvent) => void): Promise<void> {
    const session = await this.findSession(input.sessionId);
    if (!session) throw new Error(`Unknown Jupyter session: ${input.sessionId}`);
    await executeOnKernel(session, input, send);
  }

  detachSession(_sessionId: string) {
    // Kernels stay alive for the document. A detached UI client should not kill the document kernel.
  }

  async dispose() {
    for (const session of this.sessions.values()) {
      await session.catch(() => undefined);
    }
    for (const server of this.servers.values()) {
      const resolved = await server.catch(() => undefined);
      try {
        resolved?.process.kill('SIGTERM');
      } catch {
        // Already exited.
      }
    }
    this.sessions.clear();
    this.servers.clear();
  }

  private sessionResult(session: LocalJupyterKernelSession): PortalJupyterSessionResult {
    return {
      ok: true,
      available: true,
      sessionId: session.sessionId,
      kernelId: session.kernelId,
      kernelName: session.kernelName,
      rootPath: session.rootPath,
      path: session.path,
      venvPath: session.pythonEnvironment.venvPath,
      pythonPath: session.pythonEnvironment.pythonPath,
    };
  }

  private async findSession(sessionId: string) {
    for (const sessionPromise of this.sessions.values()) {
      const session = await sessionPromise.catch(() => undefined);
      if (session?.sessionId === sessionId) return session;
    }
    return undefined;
  }

  private async ensureServer(rootPath: string) {
    const key = await Deno.realPath(rootPath);
    const existing = this.servers.get(key);
    if (existing) return await existing;

    const serverPromise = (async () => {
      const pythonEnvironment = await this.ensureWorkspacePythonEnvironment(key);
      return await this.startServer(key, pythonEnvironment);
    })();
    this.servers.set(key, serverPromise);
    try {
      return await serverPromise;
    } catch (error) {
      this.servers.delete(key);
      throw error;
    }
  }

  private async ensureWorkspacePythonEnvironment(rootPath: string) {
    const key = await Deno.realPath(rootPath);
    const existing = this.pythonEnvironments.get(key);
    if (existing) return await existing;

    const environmentPromise = prepareWorkspacePythonEnvironment(key, {
      ...this.options,
      commandRunner: this.commandRunner,
    });
    this.pythonEnvironments.set(key, environmentPromise);
    try {
      return await environmentPromise;
    } catch (error) {
      this.pythonEnvironments.delete(key);
      throw error;
    }
  }

  private async startServer(
    rootPath: string,
    pythonEnvironment: WorkspacePythonEnvironment,
  ): Promise<LocalJupyterServer> {
    const resolvedJupyterCommand = await requireCommand(
      command,
      this.commandRunner,
      'Jupyter is not installed or is not on PATH.',
      this.options.env,
    );

    const port = await getFreePort();
    const token = crypto.randomUUID().replace(/-/g, '');
    const baseUrl = `http://127.0.0.1:${port}`;
    const process = new Deno.Command(resolvedJupyterCommand, {
      args: [
        'server',
        '--no-browser',
        '--ServerApp.ip=127.0.0.1',
        `--ServerApp.port=${port}`,
        `--ServerApp.root_dir=${rootPath}`,
        `--ServerApp.token=${token}`,
        '--ServerApp.password=',
        '--ServerApp.disable_check_xsrf=True',
        '--ServerApp.allow_origin=*',
      ],
      env: jupyterServerEnv(pythonEnvironment, this.options.env),
      stdout: 'piped',
      stderr: 'piped',
      stdin: 'null',
    }).spawn();
    void drainStream(process.stdout);
    void drainStream(process.stderr);

    const statusUrl = withToken(`${baseUrl}/api/status`, token);
    let lastError: unknown;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        await fetchJson(statusUrl);
        return { baseUrl, process, pythonEnvironment, rootPath, token };
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 125));
      }
    }

    try {
      process.kill('SIGTERM');
    } catch {
      // Already exited.
    }
    throw new Error(
      `Jupyter Server did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private async createKernelSession(
    rootPath: string,
    path: string,
    kernelName: string,
  ): Promise<LocalJupyterKernelSession> {
    const server = await this.ensureServer(rootPath);
    const response = await fetchJson<{
      id?: string;
      name?: string;
    }>(withToken(`${server.baseUrl}/api/kernels`, server.token), {
      method: 'POST',
      body: JSON.stringify({ name: kernelName }),
    });
    const kernelId = response.id;
    if (!kernelId) throw new Error('Jupyter kernel response did not include an id.');

    return {
      clientSessionId: crypto.randomUUID(),
      kernelId,
      kernelName: response.name ?? kernelName,
      path,
      pythonEnvironment: server.pythonEnvironment,
      rootPath,
      server,
      sessionId: `jupyter:${crypto.randomUUID()}`,
    };
  }
}

const executeOnKernel = async (
  session: LocalJupyterKernelSession,
  input: PortalJupyterExecuteInput,
  send: (event: PortalJupyterHostEvent) => void,
) => {
  const url = new URL(
    `/api/kernels/${encodeURIComponent(session.kernelId)}/channels`,
    session.server.baseUrl.replace(/^http:/, 'ws:'),
  );
  url.searchParams.set('session_id', session.clientSessionId);
  url.searchParams.set('token', session.server.token);

  const socket = new WebSocket(url);
  const request = createMessage(session.clientSessionId, 'execute_request', {
    allow_stdin: input.allowStdin === true,
    code: input.code,
    silent: input.silent === true,
    store_history: input.storeHistory !== false,
    stop_on_error: true,
    user_expressions: {},
  });
  const requestMsgId = request.header?.msg_id;
  let replyStatus: 'ok' | 'error' | 'interrupted' = 'ok';
  let executionCount: number | null | undefined;
  let completed = false;

  const scoped = <T extends Record<string, unknown>>(event: T): T & {
    sessionId: string;
    requestId?: string;
    cellId?: string;
  } => ({
    sessionId: session.sessionId,
    requestId: input.requestId,
    cellId: input.cellId,
    ...event,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Ignore close failure.
      }
      reject(new Error('Jupyter execution timed out.'));
    }, websocketExecutionTimeoutMs);

    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      send(scoped({ type: 'complete', status: replyStatus, executionCount: executionCount ?? null }));
      try {
        socket.close();
      } catch {
        // Ignore close failure.
      }
      resolve();
    };

    socket.onopen = () => {
      send({ type: 'ready', sessionId: session.sessionId, kernelId: session.kernelId, kernelName: session.kernelName });
      socket.send(JSON.stringify(request));
    };

    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Jupyter kernel WebSocket failed.'));
    };

    socket.onmessage = (event) => {
      const message = parseJupyterMessage(event.data);
      if (!message) return;
      const messageType = message.header?.msg_type;
      const parentId = message.parent_header?.msg_id;
      if (requestMsgId && parentId && parentId !== requestMsgId) return;

      if (messageType === 'status') {
        const executionState = toText(message.content?.execution_state);
        send(scoped({ type: 'status', executionState }));
        if (executionState === 'idle') finish();
        return;
      }

      if (messageType === 'execute_input') {
        const count = ensureNumber(message.content?.execution_count);
        if (count !== undefined) {
          executionCount = count;
          send(scoped({ type: 'execution_input', executionCount: count }));
        }
        return;
      }

      if (messageType === 'execute_reply') {
        replyStatus = normalizeTerminalStatus(message.content?.status);
        executionCount = ensureNumber(message.content?.execution_count) ?? executionCount;
        return;
      }

      if (messageType === 'clear_output') {
        send(scoped({ type: 'clear_output', wait: message.content?.wait === true }));
        return;
      }

      const output = outputFromJupyterMessage(messageType, message.content);
      if (output) {
        if (output.output_type === 'error') replyStatus = 'error';
        if (output.output_type === 'execute_result') {
          executionCount = ensureNumber(output.execution_count) ?? executionCount;
        }
        send(scoped({ type: 'output', output }));
      }
    };

    socket.onclose = () => {
      if (!completed) {
        clearTimeout(timeout);
        reject(new Error('Jupyter kernel WebSocket closed before execution completed.'));
      }
    };
  });
};

const parseJupyterMessage = (data: unknown): JupyterMessage | undefined => {
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : undefined;
    return isRecord(parsed) ? parsed as JupyterMessage : undefined;
  } catch {
    return undefined;
  }
};

const outputFromJupyterMessage = (
  messageType: string | undefined,
  content: Record<string, unknown> | undefined,
): PortalJupyterOutput | undefined => {
  if (!content) return undefined;
  if (messageType === 'stream') {
    return {
      output_type: 'stream',
      name: toText(content.name) || 'stdout',
      text: toText(content.text),
    };
  }
  if (messageType === 'display_data' || messageType === 'execute_result') {
    const data = isRecord(content.data) ? content.data : {};
    const metadata = isRecord(content.metadata) ? content.metadata : {};
    if (messageType === 'display_data') {
      return {
        output_type: 'display_data',
        data,
        metadata,
        ...(isRecord(content.transient) ? { transient: content.transient } : {}),
      };
    }
    return {
      output_type: 'execute_result',
      execution_count: ensureNumber(content.execution_count) ?? null,
      data,
      metadata,
    };
  }
  if (messageType === 'error') {
    return {
      output_type: 'error',
      ename: toText(content.ename),
      evalue: toText(content.evalue),
      traceback: stringArray(content.traceback),
    };
  }
  return undefined;
};

export class PortalJupyterHost {
  private readonly runtime: PortalJupyterRuntime;
  private readonly clients = new Map<string, string>();

  constructor(options: PortalJupyterHostOptions) {
    this.runtime = options.runtime ?? new LocalJupyterRuntime(options.config);
  }

  async status(input: PortalJupyterStatusInput) {
    return await this.runtime.status(input);
  }

  async kernelspecs(input: PortalJupyterKernelspecsInput) {
    return await this.runtime.kernelspecs(input);
  }

  async createSession(input: PortalJupyterSessionInput) {
    return await this.runtime.createSession(input);
  }

  async handleClientMessage(
    clientId: string,
    message: PortalJupyterClientMessage,
    send: (event: PortalJupyterHostEvent) => void,
  ) {
    try {
      if (message.type === 'detach') {
        this.detachClient(clientId);
        return;
      }
      if (message.type === 'execute') {
        this.clients.set(clientId, message.sessionId);
        await this.runtime.execute(message, send);
        return;
      }
      throw new Error('Unsupported Jupyter client message.');
    } catch (error) {
      send({
        type: 'error',
        sessionId: 'sessionId' in message ? message.sessionId : undefined,
        requestId: 'requestId' in message ? message.requestId : undefined,
        cellId: 'cellId' in message ? message.cellId : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  detachClient(clientId: string) {
    const sessionId = this.clients.get(clientId);
    if (sessionId) this.runtime.detachSession?.(sessionId);
    this.clients.delete(clientId);
  }

  detachClientsByPrefix(prefix: string) {
    for (const clientId of this.clients.keys()) {
      if (clientId.startsWith(prefix)) this.detachClient(clientId);
    }
  }

  async dispose() {
    this.clients.clear();
    await this.runtime.dispose?.();
  }
}

export const isJupyterClientEnvelope = (message: Record<string, unknown>): message is PortalJupyterClientEnvelope =>
  message.type === 'jupyter.client' &&
  typeof message.clientId === 'string' &&
  isRecord(message.message);

export const __jupyterTest = {
  LocalJupyterRuntime,
  commandAvailable,
  defaultCommandRunner,
  jupyterServerEnv,
  prepareWorkspacePythonEnvironment,
  outputFromJupyterMessage,
  parseJupyterMessage,
  resolveCommand,
  selectJupyterKernelName,
  workspacePythonEnvironmentPaths,
  workspacePythonKernelName,
};
