import {
  assertPortalPathWithinRoot,
  joinPortalEditorPath,
  parseEditorPath,
  type PortalEditorConfig,
  type PortalEditorTarget,
  resolvePortalEditorWorkspaceRoot,
} from './editor.ts';

export type LspLanguageId =
  | 'javascript'
  | 'javascriptreact'
  | 'typescript'
  | 'typescriptreact'
  | 'json'
  | 'jsonc'
  | 'css'
  | 'html'
  | 'markdown'
  | 'graphql'
  | string;

export type PortalLspTarget = PortalEditorTarget;

export type PortalLspSessionInput = {
  target?: PortalLspTarget;
  path: string;
  languageId?: LspLanguageId;
  serverId?: string;
} & PortalLspTarget;

export type PortalLspSessionStatus = 'ready' | 'missing' | 'disabled' | 'unsupported' | 'error';

export type PortalLspSessionResult = {
  ok: true;
  sessionId: string;
  status: PortalLspSessionStatus;
  serverId?: string;
  languageId?: LspLanguageId;
  documentUri?: string;
  rootUri?: string;
  rootPath?: string;
  command?: string;
  args?: string[];
  capabilities?: unknown;
  error?: string;
};

export type PortalLspClientMessage =
  | ({ type: 'start'; sessionId?: string } & Partial<PortalLspSessionInput>)
  | { type: 'jsonrpc'; sessionId: string; message: string }
  | { type: 'detach'; sessionId?: string };

export type PortalLspHostEvent =
  | (PortalLspSessionResult & { type: 'ready' })
  | { type: 'jsonrpc'; sessionId: string; message: string }
  | { type: 'error'; sessionId?: string; error: string };

export type PortalLspClientEnvelope = {
  type: 'lsp.client';
  clientId: string;
  message: PortalLspClientMessage;
};

export type PortalLspEventEnvelope = {
  type: 'lsp.event';
  clientId: string;
  event: PortalLspHostEvent;
};

type JsonRpcId = string | number | null;

type JsonRpcMessage = {
  jsonrpc?: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type ToolRegistryEntry = {
  id: string;
  binary: string;
  package?: string;
  categories: Array<'lsp' | 'linter' | 'formatter'>;
  detectionHints?: string[];
};

type ServerAdapter = {
  id: string;
  toolId: string;
  command: string;
  args: string[];
  languages: LspLanguageId[];
  rootMarkers: string[];
  configFiles?: string[];
  initializationOptions?: unknown;
  settings?: Record<string, unknown>;
  exposeToAgent?: Record<string, unknown>;
  enabled: boolean;
  priority: number;
  knownQuirks?: string[];
};

export type PortalLspQueryInput = PortalLspSessionInput & {
  feature:
    | 'capabilities'
    | 'diagnostics'
    | 'hover'
    | 'definition'
    | 'references'
    | 'symbols'
    | 'workspaceSymbols'
    | 'codeActions'
    | 'codeActionPreview'
    | 'renamePreview'
    | 'formatPreview';
  line?: number;
  character?: number;
  query?: string;
  newName?: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  action?: unknown;
  actionIndex?: number;
};

type NormalizedSession = {
  sessionId: string;
  target: PortalLspTarget;
  path: string;
  documentPath?: string;
  documentUri?: string;
  languageId?: LspLanguageId;
  serverId?: string;
  rootPath?: string;
  rootUri?: string;
  adapter?: ServerAdapter;
  command?: string;
  args?: string[];
  status: PortalLspSessionStatus;
  error?: string;
};

type RuntimeKey = string;

type RuntimeSubscriber = {
  send: (event: PortalLspHostEvent) => void;
};

type PendingClientRequest = {
  kind: 'client';
  method: string;
  clientId: string;
  sessionId: string;
  originalId: JsonRpcId;
};

type PendingInternalRequest = {
  kind: 'internal';
  method: string;
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PendingRequest = PendingClientRequest | PendingInternalRequest;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const defaultIdleShutdownMs = 10 * 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const defaultToolRegistry: Record<string, ToolRegistryEntry> = {
  typescript: {
    id: 'typescript',
    binary: 'typescript-language-server',
    package: 'typescript-language-server',
    categories: ['lsp'],
    detectionHints: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  },
  'vscode-json': {
    id: 'vscode-json',
    binary: 'vscode-json-language-server',
    package: 'vscode-langservers-extracted',
    categories: ['lsp'],
    detectionHints: ['package.json'],
  },
  'vscode-css': {
    id: 'vscode-css',
    binary: 'vscode-css-language-server',
    package: 'vscode-langservers-extracted',
    categories: ['lsp'],
    detectionHints: ['package.json'],
  },
  'vscode-html': {
    id: 'vscode-html',
    binary: 'vscode-html-language-server',
    package: 'vscode-langservers-extracted',
    categories: ['lsp'],
    detectionHints: ['package.json'],
  },
  'vscode-markdown': {
    id: 'vscode-markdown',
    binary: 'vscode-markdown-language-server',
    package: 'vscode-langservers-extracted',
    categories: ['lsp'],
    detectionHints: ['package.json'],
  },
  biome: {
    id: 'biome',
    binary: 'biome',
    package: '@biomejs/biome',
    categories: ['lsp', 'linter', 'formatter'],
    detectionHints: ['biome.json', 'biome.jsonc'],
  },
};

const defaultServerAdapters: Record<string, ServerAdapter> = {
  typescript: {
    id: 'typescript',
    toolId: 'typescript',
    command: 'typescript-language-server',
    args: ['--stdio'],
    languages: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
    rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json', '.git'],
    configFiles: ['tsconfig.json', 'jsconfig.json'],
    enabled: true,
    priority: 100,
  },
  json: {
    id: 'json',
    toolId: 'vscode-json',
    command: 'vscode-json-language-server',
    args: ['--stdio'],
    languages: ['json', 'jsonc'],
    rootMarkers: ['package.json', '.git'],
    enabled: true,
    priority: 100,
  },
  css: {
    id: 'css',
    toolId: 'vscode-css',
    command: 'vscode-css-language-server',
    args: ['--stdio'],
    languages: ['css'],
    rootMarkers: ['package.json', '.git'],
    enabled: true,
    priority: 100,
  },
  html: {
    id: 'html',
    toolId: 'vscode-html',
    command: 'vscode-html-language-server',
    args: ['--stdio'],
    languages: ['html'],
    rootMarkers: ['package.json', '.git'],
    enabled: true,
    priority: 100,
  },
  markdown: {
    id: 'markdown',
    toolId: 'vscode-markdown',
    command: 'vscode-markdown-language-server',
    args: ['--stdio'],
    languages: ['markdown'],
    rootMarkers: ['package.json', '.git'],
    enabled: true,
    priority: 100,
  },
  biome: {
    id: 'biome',
    toolId: 'biome',
    command: 'biome',
    args: ['lsp-proxy'],
    languages: ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'json', 'jsonc', 'css', 'graphql'],
    rootMarkers: ['biome.json', 'biome.jsonc', 'package.json', '.git'],
    configFiles: ['biome.json', 'biome.jsonc'],
    enabled: false,
    priority: 200,
    settings: {
      require_configuration: true,
      configuration_path: null,
    },
    exposeToAgent: {
      diagnostics: true,
      symbols: true,
      navigation: true,
      codeActions: 'preview',
      formatting: 'preview',
    },
  },
};

const languageByExtension: Array<[RegExp, LspLanguageId]> = [
  [/\.tsx$/i, 'typescriptreact'],
  [/\.ts$/i, 'typescript'],
  [/\.jsx$/i, 'javascriptreact'],
  [/\.mjs$/i, 'javascript'],
  [/\.cjs$/i, 'javascript'],
  [/\.js$/i, 'javascript'],
  [/\.jsonc$/i, 'jsonc'],
  [/\.json$/i, 'json'],
  [/\.css$/i, 'css'],
  [/\.html?$/i, 'html'],
  [/\.mdx?$/i, 'markdown'],
  [/\.graphql$/i, 'graphql'],
  [/\.gql$/i, 'graphql'],
];

export const detectLspLanguageId = (path: string): LspLanguageId | undefined =>
  languageByExtension.find(([pattern]) => pattern.test(path))?.[1];

const flattenSessionInput = (input: PortalLspSessionInput | Partial<PortalLspSessionInput>) => {
  const target = isRecord(input.target) ? input.target : {};
  const { target: _target, ...rest } = input;
  return { ...rest, ...target } as Record<string, unknown>;
};

const pathToFileUri = (path: string) => `file://${path.split('/').map(encodeURIComponent).join('/')}`;

const fileUriToPath = (uri: string) => {
  const url = new URL(uri);
  if (url.protocol !== 'file:') throw new Error(`Unsupported URI: ${uri}`);
  return decodeURIComponent(url.pathname);
};

const dirname = (path: string) => {
  const normalized = path.replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
};

const statMaybe = async (path: string) => {
  try {
    return await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
};

const fileExists = async (path: string) => Boolean(await statMaybe(path));

const stripJsonComments = (input: string) => {
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (inString) {
      output += char;
      escaped = char === '\\' ? !escaped : false;
      if (char === '"' && !escaped) inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < input.length && input[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < input.length && !(input[index] === '*' && input[index + 1] === '/')) index += 1;
      index += 1;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, '$1');
};

const readProjectConfig = async (rootPath: string) => {
  for (const name of ['.weave/language-servers.jsonc', '.weave/language-servers.json']) {
    const configPath = joinPortalEditorPath(rootPath, name);
    const text = await Deno.readTextFile(configPath).catch((error) => {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    });
    if (text === undefined) continue;
    const parsed = JSON.parse(stripJsonComments(text)) as Record<string, unknown>;
    return isRecord(parsed.servers) ? parsed.servers : {};
  }
  return {};
};

const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;

const mergeProjectAdapters = async (workspaceRoot: string): Promise<Record<string, ServerAdapter>> => {
  const adapters = Object.fromEntries(Object.entries(defaultServerAdapters).map(([key, value]) => [key, { ...value }]));
  const servers = await readProjectConfig(workspaceRoot);

  for (const [serverId, raw] of Object.entries(servers)) {
    if (!isRecord(raw)) continue;
    const base = adapters[serverId] ?? {
      id: serverId,
      toolId: serverId,
      command: serverId,
      args: [],
      languages: [],
      rootMarkers: ['package.json', '.git'],
      enabled: true,
      priority: 250,
    };
    adapters[serverId] = {
      ...base,
      id: serverId,
      toolId: optionalString(raw.toolId) ?? base.toolId,
      command: optionalString(raw.command) ?? base.command,
      args: stringArray(raw.args) ?? base.args,
      languages: stringArray(raw.languages) ?? base.languages,
      rootMarkers: stringArray(raw.rootMarkers) ?? base.rootMarkers,
      configFiles: stringArray(raw.configFiles) ?? base.configFiles,
      initializationOptions: raw.initializationOptions ?? base.initializationOptions,
      settings: isRecord(raw.settings) ? raw.settings : base.settings,
      exposeToAgent: isRecord(raw.exposeToAgent) ? raw.exposeToAgent : base.exposeToAgent,
      enabled: raw.enabled === undefined ? base.enabled : raw.enabled === true,
      priority: typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : base.priority,
      knownQuirks: stringArray(raw.knownQuirks) ?? base.knownQuirks,
    };
  }

  return adapters;
};

const findRootPath = async (workspaceRoot: string, documentPath: string, markers: string[]) => {
  let current = dirname(documentPath);
  while (true) {
    for (const marker of markers) {
      if (await fileExists(joinPortalEditorPath(current, marker))) return { rootPath: current, marker };
    }
    if (current === workspaceRoot || current === '/' || !current.startsWith(`${workspaceRoot}/`)) {
      return { rootPath: workspaceRoot, marker: undefined };
    }
    current = dirname(current);
  }
};

const adapterRequiresConfiguration = (adapter: ServerAdapter) =>
  isRecord(adapter.settings) && adapter.settings.require_configuration === true;

const isExplicitCommand = (command: string) => command.includes('/') || command.startsWith('.');

const getPathEntries = () => (Deno.env.get('PATH') ?? '').split(':').filter(Boolean);

const resolveExecutable = async (workspaceRoot: string, command: string) => {
  if (isExplicitCommand(command)) {
    const candidate = command.startsWith('/') ? command : joinPortalEditorPath(workspaceRoot, command);
    const stat = await statMaybe(candidate);
    return stat?.isFile ? candidate : undefined;
  }

  const localBin = joinPortalEditorPath(workspaceRoot, `node_modules/.bin/${command}`);
  const localStat = await statMaybe(localBin);
  if (localStat?.isFile) return localBin;

  for (const entry of getPathEntries()) {
    const candidate = joinPortalEditorPath(entry, command);
    const stat = await statMaybe(candidate);
    if (stat?.isFile) return candidate;
  }
  if (command === 'deno') {
    const denoPath = Deno.execPath();
    const stat = await statMaybe(denoPath);
    if (stat?.isFile) return denoPath;
  }
  return undefined;
};

const concatBytes = (left: Uint8Array, right: Uint8Array) => {
  const output = new Uint8Array(left.byteLength + right.byteLength);
  output.set(left, 0);
  output.set(right, left.byteLength);
  return output;
};

const headerEndIndex = (buffer: Uint8Array) => {
  for (let index = 0; index <= buffer.byteLength - 4; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10 && buffer[index + 2] === 13 && buffer[index + 3] === 10) {
      return index;
    }
  }
  return -1;
};

const frameJsonRpc = (message: string) => {
  const payload = encoder.encode(message);
  const header = encoder.encode(`Content-Length: ${payload.byteLength}\r\n\r\n`);
  return concatBytes(header, payload);
};

const parseJsonRpc = (message: string): JsonRpcMessage => {
  const parsed = JSON.parse(message);
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') throw new Error('Expected a JSON-RPC 2.0 message.');
  return parsed as JsonRpcMessage;
};

const hasJsonRpcId = (message: JsonRpcMessage): message is JsonRpcMessage & { id: JsonRpcId } =>
  Object.prototype.hasOwnProperty.call(message, 'id');

const rewriteJsonRpcId = (message: JsonRpcMessage, id: JsonRpcId) => JSON.stringify({ ...message, id });

const makeJsonRpcResponse = (id: JsonRpcId, result: unknown) => JSON.stringify({ jsonrpc: '2.0', id, result });

const makeJsonRpcError = (id: JsonRpcId, message: string, code = -32603) =>
  JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

const makePublishDiagnostics = (uri: string, diagnostics: unknown[]) =>
  JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });

const textDocumentUri = (message: JsonRpcMessage, method: string) => {
  if (message.method !== method || !isRecord(message.params)) return undefined;
  const textDocument = message.params.textDocument;
  return isRecord(textDocument) ? optionalString(textDocument.uri) : undefined;
};

const fullDiagnosticReportItems = (value: unknown) =>
  isRecord(value) && value.kind === 'full' && Array.isArray(value.items) ? value.items : undefined;

const lspSettings = (settings: Record<string, unknown> | undefined) => {
  if (!settings) return {};
  const { require_configuration: _requireConfiguration, configuration_path: _configurationPath, ...rest } = settings;
  return rest;
};

const mergeClientCapabilities = (capabilities: unknown) => {
  const base = isRecord(capabilities) ? capabilities : {};
  const textDocument = isRecord(base.textDocument) ? base.textDocument : {};
  const workspace = isRecord(base.workspace) ? base.workspace : {};
  return {
    ...base,
    textDocument: {
      ...textDocument,
      diagnostic: isRecord(textDocument.diagnostic) ? textDocument.diagnostic : {},
      publishDiagnostics: {
        ...(isRecord(textDocument.publishDiagnostics) ? textDocument.publishDiagnostics : {}),
        versionSupport: true,
      },
    },
    workspace: {
      ...workspace,
      configuration: true,
      workspaceFolders: workspace.workspaceFolders ?? true,
    },
  };
};

class LspRuntime {
  readonly key: RuntimeKey;
  readonly adapter: ServerAdapter;
  readonly rootPath: string;
  readonly rootUri: string;
  readonly command: string;
  readonly args: string[];
  private process?: Deno.ChildProcess;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private stdoutTask?: Promise<void>;
  private stderrTask?: Promise<void>;
  private exitTask?: Promise<void>;
  private startPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private disposed = false;
  private nextServerId = 1;
  private pending = new Map<JsonRpcId, PendingRequest>();
  private subscribers = new Map<string, RuntimeSubscriber>();
  private clientSessions = new Map<string, Set<string>>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private diagnosticRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private initializeResult?: unknown;
  private initializing:
    | { serverId: JsonRpcId; waiters: Array<{ clientId: string; sessionId: string; originalId: JsonRpcId }> }
    | undefined;
  private initializedNotificationSent = false;
  private diagnostics = new Map<string, unknown[]>();

  constructor(options: {
    key: RuntimeKey;
    adapter: ServerAdapter;
    rootPath: string;
    rootUri: string;
    command: string;
    args: string[];
  }) {
    this.key = options.key;
    this.adapter = options.adapter;
    this.rootPath = options.rootPath;
    this.rootUri = options.rootUri;
    this.command = options.command;
    this.args = options.args;
  }

  get capabilities() {
    return this.initializeResult && isRecord(this.initializeResult) ? this.initializeResult.capabilities : undefined;
  }

  async start() {
    if (this.startPromise) return await this.startPromise;
    this.startPromise = this.startOnce();
    return await this.startPromise;
  }

  attach(clientId: string, sessionId: string, send: (event: PortalLspHostEvent) => void) {
    this.clearIdleTimer();
    this.subscribers.set(clientId, { send });
    const sessions = this.clientSessions.get(clientId) ?? new Set<string>();
    sessions.add(sessionId);
    this.clientSessions.set(clientId, sessions);
  }

  detach(clientId: string, sessionId?: string) {
    if (sessionId) {
      const sessions = this.clientSessions.get(clientId);
      sessions?.delete(sessionId);
      if (sessions && sessions.size > 0) return;
    }
    this.clientSessions.delete(clientId);
    this.subscribers.delete(clientId);
    if (this.subscribers.size === 0) this.scheduleIdleShutdown();
  }

  async handleClientJsonRpc(clientId: string, sessionId: string, rawMessage: string) {
    await this.start();
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpc(rawMessage);
    } catch (error) {
      this.sendToClient(clientId, {
        type: 'error',
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (message.method === 'initialize' && hasJsonRpcId(message)) {
      await this.handleClientInitialize(clientId, sessionId, message);
      return;
    }

    if (message.method === 'initialized' && !hasJsonRpcId(message)) {
      if (!this.initializedNotificationSent) {
        this.initializedNotificationSent = true;
        await this.writeJson(JSON.stringify(message));
      }
      return;
    }

    if (message.method === 'shutdown' && hasJsonRpcId(message)) {
      this.sendToClient(clientId, { type: 'jsonrpc', sessionId, message: makeJsonRpcResponse(message.id, null) });
      return;
    }

    if (message.method === 'exit' && !hasJsonRpcId(message)) {
      this.detach(clientId, sessionId);
      return;
    }

    const openedUri = textDocumentUri(message, 'textDocument/didOpen');
    if (openedUri) {
      await this.writeJson(JSON.stringify(message));
      this.sendCachedDiagnostics(clientId, sessionId, openedUri);
      void this.refreshPullDiagnostics(clientId, sessionId, openedUri);
      return;
    }

    const changedUri = textDocumentUri(message, 'textDocument/didChange');
    if (changedUri) {
      await this.writeJson(JSON.stringify(message));
      this.schedulePullDiagnostics(clientId, sessionId, changedUri);
      return;
    }

    if (message.method && hasJsonRpcId(message)) {
      const serverId = this.allocateServerId();
      this.pending.set(serverId, {
        kind: 'client',
        method: message.method,
        clientId,
        sessionId,
        originalId: message.id,
      });
      await this.writeJson(rewriteJsonRpcId(message, serverId));
      return;
    }

    await this.writeJson(JSON.stringify(message));
  }

  async ensureInitialized() {
    await this.start();
    if (this.initializeResult !== undefined) return this.initializeResult;

    const response = await this.sendRequest('initialize', {
      processId: Deno.pid,
      rootUri: this.rootUri,
      workspaceFolders: [{ uri: this.rootUri, name: this.rootPath.split('/').filter(Boolean).at(-1) ?? this.rootPath }],
      capabilities: defaultClientCapabilities,
      initializationOptions: this.adapter.initializationOptions ?? this.adapter.settings,
    }, 10_000);
    this.initializeResult = response.result;
    if (!this.initializedNotificationSent) {
      this.initializedNotificationSent = true;
      await this.writeJson(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }));
    }
    return this.initializeResult;
  }

  async sendNotification(method: string, params?: unknown) {
    await this.start();
    await this.writeJson(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }));
  }

  async sendRequest(method: string, params?: unknown, timeoutMs = 8_000) {
    await this.start();
    const serverId = this.allocateServerId();
    const message = JSON.stringify({
      jsonrpc: '2.0',
      id: serverId,
      method,
      ...(params === undefined ? {} : { params }),
    });
    const response = await new Promise<JsonRpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(serverId);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(serverId, { kind: 'internal', method, resolve, reject, timeout });
      void this.writeJson(message).catch((error) => {
        clearTimeout(timeout);
        this.pending.delete(serverId);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    if (response.error) throw new Error(response.error.message ?? `${method} failed.`);
    return response;
  }

  getDiagnostics(uri: string) {
    return this.diagnostics.get(uri) ?? [];
  }

  async waitForDiagnostics(uri: string, timeoutMs = 750) {
    if (this.diagnostics.has(uri)) return this.getDiagnostics(uri);
    await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    return this.getDiagnostics(uri);
  }

  async pullDiagnostics(uri: string) {
    const capabilities = this.capabilities;
    if (!isRecord(capabilities) || !capabilities.diagnosticProvider) return this.getDiagnostics(uri);
    try {
      const response = await this.sendRequest('textDocument/diagnostic', { textDocument: { uri } });
      const diagnostics = fullDiagnosticReportItems(response.result);
      if (diagnostics) this.diagnostics.set(uri, diagnostics);
    } catch {
      // Some servers advertise diagnostics but reject pull requests in certain projects.
    }
    return this.getDiagnostics(uri);
  }

  dispose() {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = this.disposeOnce();
    return this.disposePromise;
  }

  private async disposeOnce() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    for (const timer of this.diagnosticRefreshTimers.values()) clearTimeout(timer);
    this.diagnosticRefreshTimers.clear();
    for (const pending of this.pending.values()) {
      if (pending.kind === 'internal') {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Language server stopped.'));
      }
    }
    this.pending.clear();
    const process = this.process;
    const writer = this.writer;
    this.process = undefined;
    this.writer = undefined;

    if (writer) {
      try {
        await Promise.race([writer.close(), sleep(250)]);
      } catch {
        // The language server may have already closed stdin.
      }
      try {
        writer.releaseLock();
      } catch {
        // The writer may already be released or closed.
      }
    }

    if (process) {
      try {
        process.kill('SIGTERM');
      } catch {
        // The language server may have already exited after stdin closed.
      }
      const exited = await Promise.race([
        process.status.then(() => true).catch(() => true),
        sleep(1_500).then(() => false),
      ]);
      if (!exited) {
        try {
          process.kill('SIGKILL');
        } catch {
          // It may have exited between timeout and escalation.
        }
        await Promise.race([
          process.status.catch(() => undefined),
          sleep(500),
        ]);
      }
    }
  }

  private async startOnce() {
    if (this.disposed) throw new Error('Language server runtime was disposed.');
    const process = new Deno.Command(this.command, {
      args: this.args,
      cwd: this.rootPath,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    }).spawn();
    this.process = process;
    this.writer = process.stdin.getWriter();
    this.stdoutTask = this.readStdout(process.stdout).catch((error) => this.failAll(error));
    this.stderrTask = this.drainStderr(process.stderr);
    this.exitTask = process.status.then((status) => {
      if (!this.disposed) {
        this.failAll(
          new Error(
            `Language server exited with code ${status.code}${status.signal ? ` signal ${status.signal}` : ''}.`,
          ),
        );
      }
    });
  }

  private async readStdout(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    let buffer = new Uint8Array(0);
    while (!this.disposed) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer = concatBytes(buffer, value);
      while (true) {
        const headerEnd = headerEndIndex(buffer);
        if (headerEnd === -1) break;
        const header = decoder.decode(buffer.subarray(0, headerEnd));
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (!match) throw new Error('Language server sent a message without Content-Length.');
        const length = Number(match[1]);
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + length;
        if (buffer.byteLength < bodyEnd) break;
        const body = decoder.decode(buffer.subarray(bodyStart, bodyEnd));
        buffer = buffer.subarray(bodyEnd);
        await this.handleServerJsonRpc(body);
      }
    }
  }

  private async drainStderr(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    while (!this.disposed) {
      const { done } = await reader.read();
      if (done) break;
    }
  }

  private async handleServerJsonRpc(rawMessage: string) {
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpc(rawMessage);
    } catch {
      return;
    }

    let messageForClients = rawMessage;
    if (message.method === 'textDocument/publishDiagnostics' && isRecord(message.params)) {
      const uri = optionalString(message.params.uri);
      const diagnostics = Array.isArray(message.params.diagnostics) ? message.params.diagnostics : [];
      if (uri) {
        this.diagnostics.set(uri, diagnostics);
        messageForClients = makePublishDiagnostics(uri, diagnostics);
      }
    }

    if (message.method && hasJsonRpcId(message)) {
      await this.respondToServerRequest(message as JsonRpcMessage & { id: JsonRpcId; method: string });
      return;
    }

    if (hasJsonRpcId(message) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.kind === 'internal') {
        clearTimeout(pending.timeout);
        pending.resolve(message);
        return;
      }

      if (pending.method === 'initialize') {
        this.initializeResult = message.result;
        for (const waiter of this.initializing?.waiters ?? []) {
          this.sendToClient(waiter.clientId, {
            type: 'jsonrpc',
            sessionId: waiter.sessionId,
            message: message.error
              ? makeJsonRpcError(waiter.originalId, message.error.message ?? 'initialize failed', message.error.code)
              : makeJsonRpcResponse(waiter.originalId, message.result),
          });
        }
        this.initializing = undefined;
      }

      this.sendToClient(pending.clientId, {
        type: 'jsonrpc',
        sessionId: pending.sessionId,
        message: rewriteJsonRpcId(message, pending.originalId),
      });
      return;
    }

    for (const [clientId] of this.subscribers) {
      const sessions = this.clientSessions.get(clientId);
      const sessionId = sessions?.values().next().value;
      if (sessionId) this.sendToClient(clientId, { type: 'jsonrpc', sessionId, message: messageForClients });
    }
  }

  private sendCachedDiagnostics(clientId: string, sessionId: string, uri: string) {
    if (!this.diagnostics.has(uri)) return;
    this.sendToClient(clientId, {
      type: 'jsonrpc',
      sessionId,
      message: makePublishDiagnostics(uri, this.diagnostics.get(uri) ?? []),
    });
  }

  private schedulePullDiagnostics(clientId: string, sessionId: string, uri: string) {
    const existing = this.diagnosticRefreshTimers.get(uri);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.diagnosticRefreshTimers.delete(uri);
      void this.refreshPullDiagnostics(clientId, sessionId, uri);
    }, 350);
    this.diagnosticRefreshTimers.set(uri, timer);
  }

  private async refreshPullDiagnostics(clientId: string, sessionId: string, uri: string) {
    const diagnostics = await this.pullDiagnostics(uri);
    if (this.diagnostics.has(uri)) {
      this.sendToClient(clientId, { type: 'jsonrpc', sessionId, message: makePublishDiagnostics(uri, diagnostics) });
    }
  }

  private async handleClientInitialize(
    clientId: string,
    sessionId: string,
    message: JsonRpcMessage & { id: JsonRpcId },
  ) {
    if (this.initializeResult !== undefined) {
      this.sendToClient(clientId, {
        type: 'jsonrpc',
        sessionId,
        message: makeJsonRpcResponse(message.id, this.initializeResult),
      });
      return;
    }

    if (this.initializing) {
      this.initializing.waiters.push({ clientId, sessionId, originalId: message.id });
      return;
    }

    const serverId = this.allocateServerId();
    this.initializing = { serverId, waiters: [] };
    this.pending.set(serverId, {
      kind: 'client',
      method: 'initialize',
      clientId,
      sessionId,
      originalId: message.id,
    });
    const params = isRecord(message.params)
      ? {
        ...message.params,
        capabilities: mergeClientCapabilities(message.params.capabilities),
        rootUri: this.rootUri,
        workspaceFolders: [{
          uri: this.rootUri,
          name: this.rootPath.split('/').filter(Boolean).at(-1) ?? this.rootPath,
        }],
        initializationOptions: this.adapter.initializationOptions ?? this.adapter.settings ??
          message.params.initializationOptions,
      }
      : message.params;
    await this.writeJson(rewriteJsonRpcId({ ...message, params }, serverId));
  }

  private async respondToServerRequest(message: JsonRpcMessage & { id: JsonRpcId; method: string }) {
    const result = message.method === 'workspace/configuration'
      ? await this.workspaceConfiguration(message.params)
      : message.method === 'workspace/applyEdit'
      ? { applied: false, failureReason: 'Workspace edits are preview-only in Weave.' }
      : null;
    await this.writeJson(makeJsonRpcResponse(message.id, result));
  }

  private async workspaceConfiguration(params: unknown) {
    const items = isRecord(params) && Array.isArray(params.items) ? params.items : [{}];
    return await Promise.all(items.map((item) => this.workspaceConfigurationItem(item)));
  }

  private async workspaceConfigurationItem(item: unknown) {
    const section = isRecord(item) ? optionalString(item.section) : undefined;
    const settings = lspSettings(this.adapter.settings);

    if (this.adapter.id === 'denols' || this.adapter.toolId === 'deno' || this.adapter.command === 'deno') {
      if (section && section !== 'deno') return {};
      return {
        enable: true,
        lint: true,
        ...settings,
        config: typeof settings.config === 'string' ? settings.config : await this.resolveConfigFile(),
      };
    }

    if (!section || section === this.adapter.id || section === this.adapter.toolId) return settings;
    return {};
  }

  private async resolveConfigFile() {
    for (const name of this.adapter.configFiles ?? []) {
      const path = joinPortalEditorPath(this.rootPath, name);
      if (await fileExists(path)) return path;
    }
    return undefined;
  }

  private async writeJson(message: string) {
    if (!this.writer) throw new Error('Language server is not running.');
    await this.writer.write(frameJsonRpc(message));
  }

  private sendToClient(clientId: string, event: PortalLspHostEvent) {
    const subscriber = this.subscribers.get(clientId);
    if (!subscriber) return;
    try {
      subscriber.send(event);
    } catch {
      this.detach(clientId);
    }
  }

  private allocateServerId() {
    return this.nextServerId++;
  }

  private failAll(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    for (const pending of this.pending.values()) {
      if (pending.kind === 'internal') {
        clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error(message));
      } else {
        this.sendToClient(pending.clientId, { type: 'error', sessionId: pending.sessionId, error: message });
      }
    }
    this.pending.clear();
    this.broadcast({ type: 'error', error: message });
  }

  private broadcast(event: PortalLspHostEvent) {
    for (const [clientId] of this.subscribers) this.sendToClient(clientId, event);
  }

  private scheduleIdleShutdown() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.dispose(), defaultIdleShutdownMs);
  }

  private clearIdleTimer() {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

export type PortalLspHostOptions = {
  config: PortalEditorConfig;
};

export class PortalLspHost {
  private readonly config: PortalEditorConfig;
  private readonly sessions = new Map<string, NormalizedSession>();
  private readonly runtimes = new Map<RuntimeKey, LspRuntime>();
  private readonly clientSessions = new Map<string, Set<string>>();

  constructor(options: PortalLspHostOptions) {
    this.config = options.config;
  }

  async createSession(input: PortalLspSessionInput): Promise<PortalLspSessionResult> {
    const session = await this.resolveSession(input);
    this.sessions.set(session.sessionId, session);
    return this.sessionResult(session);
  }

  async handleClientMessage(
    clientId: string,
    message: PortalLspClientMessage,
    send: (event: PortalLspHostEvent) => void,
  ) {
    if (message.type === 'detach') {
      this.detachClient(clientId, message.sessionId);
      return;
    }

    if (message.type === 'start') {
      const session = await this.getOrCreateSession(message);
      const sessions = this.clientSessions.get(clientId) ?? new Set<string>();
      sessions.add(session.sessionId);
      this.clientSessions.set(clientId, sessions);
      if (session.status !== 'ready') {
        send({ type: 'ready', ...this.sessionResult(session) });
        return;
      }
      try {
        const runtime = this.getRuntime(session);
        runtime.attach(clientId, session.sessionId, send);
        await runtime.start();
        send({ type: 'ready', ...this.sessionResult(session, runtime.capabilities) });
      } catch (error) {
        send({
          type: 'error',
          sessionId: session.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    const session = this.sessions.get(message.sessionId);
    if (!session) {
      send({ type: 'error', sessionId: message.sessionId, error: 'Unknown LSP session.' });
      return;
    }
    if (session.status !== 'ready') {
      send({
        type: 'error',
        sessionId: session.sessionId,
        error: session.error ?? `LSP session is ${session.status}.`,
      });
      return;
    }
    const runtime = this.getRuntime(session);
    runtime.attach(clientId, session.sessionId, send);
    await runtime.handleClientJsonRpc(clientId, session.sessionId, message.message);
  }

  detachClient(clientId: string, sessionId?: string) {
    const sessions = this.clientSessions.get(clientId);
    if (!sessions) return;
    const targetSessions = sessionId ? [sessionId] : [...sessions];
    for (const id of targetSessions) {
      const session = this.sessions.get(id);
      if (session?.status === 'ready') this.getRuntime(session).detach(clientId, id);
      sessions.delete(id);
    }
    if (sessions.size === 0) this.clientSessions.delete(clientId);
  }

  detachClientsByPrefix(prefix: string) {
    for (const clientId of [...this.clientSessions.keys()]) {
      if (clientId.startsWith(prefix)) this.detachClient(clientId);
    }
  }

  async query(input: PortalLspQueryInput) {
    const session = await this.resolveSession(input);
    this.sessions.set(session.sessionId, session);
    if (session.status !== 'ready') return this.sessionResult(session);
    const runtime = this.getRuntime(session);
    await runtime.ensureInitialized();

    if (input.feature === 'capabilities') {
      return {
        ...this.sessionResult(session, runtime.capabilities),
        toolRegistry: defaultToolRegistry,
        server: session.adapter,
      };
    }

    if (!session.documentUri || !session.documentPath || !session.languageId) {
      return { ok: false, error: 'LSP document could not be resolved.' };
    }

    await this.openDocument(runtime, session);
    const textDocument = { uri: session.documentUri };
    const position = toLspPosition(input);

    if (input.feature === 'diagnostics') {
      return {
        ok: true,
        path: session.path,
        serverId: session.serverId,
        diagnostics: await runtime.pullDiagnostics(session.documentUri),
      };
    }

    if (input.feature === 'hover') {
      const response = await runtime.sendRequest('textDocument/hover', { textDocument, position });
      return { ok: true, path: session.path, hover: response.result ?? null };
    }

    if (input.feature === 'definition') {
      const response = await runtime.sendRequest('textDocument/definition', { textDocument, position });
      return { ok: true, path: session.path, locations: response.result ?? null };
    }

    if (input.feature === 'references') {
      const response = await runtime.sendRequest('textDocument/references', {
        textDocument,
        position,
        context: { includeDeclaration: true },
      });
      return { ok: true, path: session.path, locations: response.result ?? [] };
    }

    if (input.feature === 'symbols') {
      const response = await runtime.sendRequest('textDocument/documentSymbol', { textDocument });
      return { ok: true, path: session.path, symbols: response.result ?? [] };
    }

    if (input.feature === 'workspaceSymbols') {
      const response = await runtime.sendRequest('workspace/symbol', { query: input.query ?? '' });
      return { ok: true, query: input.query ?? '', symbols: response.result ?? [] };
    }

    if (input.feature === 'codeActions') {
      const response = await runtime.sendRequest('textDocument/codeAction', {
        textDocument,
        range: input.range ?? { start: position, end: position },
        context: { diagnostics: runtime.getDiagnostics(session.documentUri) },
      });
      return { ok: true, path: session.path, actions: response.result ?? [] };
    }

    if (input.feature === 'codeActionPreview') {
      const action = input.action ?? await this.resolveCodeAction(runtime, session, input);
      return {
        ok: true,
        path: session.path,
        previewOnly: true,
        action,
        editPreview: normalizeWorkspaceEdit(session.rootPath!, actionEdit(action)),
      };
    }

    if (input.feature === 'renamePreview') {
      if (!input.newName) return { ok: false, error: 'newName is required for rename_preview.' };
      const response = await runtime.sendRequest('textDocument/rename', {
        textDocument,
        position,
        newName: input.newName,
      });
      return {
        ok: true,
        path: session.path,
        previewOnly: true,
        workspaceEdit: response.result ?? null,
        editPreview: normalizeWorkspaceEdit(session.rootPath!, response.result),
      };
    }

    if (input.feature === 'formatPreview') {
      const response = await runtime.sendRequest('textDocument/formatting', {
        textDocument,
        options: { tabSize: 2, insertSpaces: true },
      });
      return {
        ok: true,
        path: session.path,
        previewOnly: true,
        edits: response.result ?? [],
        editPreview: normalizeTextEdits(session.rootPath!, session.documentUri, response.result),
      };
    }

    return { ok: false, error: `Unsupported LSP feature: ${input.feature}` };
  }

  async dispose() {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
    this.runtimes.clear();
    this.sessions.clear();
    this.clientSessions.clear();
  }

  private async getOrCreateSession(input: Partial<PortalLspSessionInput> & { sessionId?: string }) {
    if (input.sessionId && this.sessions.has(input.sessionId)) return this.sessions.get(input.sessionId)!;
    if (!input.path) throw new Error('path is required.');
    const session = await this.resolveSession(input as PortalLspSessionInput);
    this.sessions.set(session.sessionId, session);
    return session;
  }

  private getRuntime(session: NormalizedSession) {
    if (!session.adapter || !session.rootPath || !session.rootUri || !session.command || !session.serverId) {
      throw new Error('LSP runtime is not available for this session.');
    }
    const key = `${session.rootPath}:${session.serverId}`;
    const existing = this.runtimes.get(key);
    if (existing) return existing;
    const runtime = new LspRuntime({
      key,
      adapter: session.adapter,
      rootPath: session.rootPath,
      rootUri: session.rootUri,
      command: session.command,
      args: session.args ?? [],
    });
    this.runtimes.set(key, runtime);
    return runtime;
  }

  private async resolveSession(input: PortalLspSessionInput): Promise<NormalizedSession> {
    const record = flattenSessionInput(input);
    const sessionId = optionalString(record.sessionId) ?? `lsp_${crypto.randomUUID().replace(/-/g, '')}`;
    const workspaceRoot = await resolvePortalEditorWorkspaceRoot(this.config, record);
    const relativePath = parseEditorPath(record.path);
    if (!relativePath) {
      return {
        sessionId,
        target: record as PortalLspTarget,
        path: '',
        status: 'unsupported',
        error: 'path is required.',
      };
    }
    const documentPath = joinPortalEditorPath(workspaceRoot, relativePath);
    assertPortalPathWithinRoot(workspaceRoot, documentPath);
    const languageId = optionalString(record.languageId) ?? detectLspLanguageId(relativePath);
    if (!languageId) {
      return {
        sessionId,
        target: record as PortalLspTarget,
        path: relativePath,
        status: 'unsupported',
        error: 'Unsupported file type.',
      };
    }

    const adapters = await mergeProjectAdapters(workspaceRoot);
    const requestedServerId = optionalString(record.serverId);
    const languageAdapters = Object.values(adapters)
      .filter((item) => item.languages.includes(languageId))
      .filter((item) => !requestedServerId || item.id === requestedServerId)
      .sort((left, right) => right.priority - left.priority);
    const adapterCandidates = [];
    for (const adapter of languageAdapters) {
      const rootMatch = await findRootPath(workspaceRoot, documentPath, adapter.rootMarkers);
      adapterCandidates.push({
        adapter,
        rootPath: rootMatch.rootPath,
        missingRequiredConfiguration: adapterRequiresConfiguration(adapter) && !rootMatch.marker,
      });
    }
    const candidate = requestedServerId
      ? adapterCandidates[0]
      : adapterCandidates.find((item) => item.adapter.enabled && !item.missingRequiredConfiguration);
    if (!candidate) {
      return {
        sessionId,
        target: record as PortalLspTarget,
        path: relativePath,
        documentPath,
        documentUri: pathToFileUri(documentPath),
        languageId,
        status: 'unsupported',
        error: `No language server adapter is configured for ${languageId}.`,
      };
    }
    const adapter = candidate.adapter;
    if (!adapter.enabled) {
      return {
        sessionId,
        target: record as PortalLspTarget,
        path: relativePath,
        documentPath,
        documentUri: pathToFileUri(documentPath),
        languageId,
        serverId: adapter.id,
        status: 'disabled',
        error: `${adapter.id} is disabled for this project.`,
      };
    }
    if (candidate.missingRequiredConfiguration) {
      return {
        sessionId,
        target: record as PortalLspTarget,
        path: relativePath,
        documentPath,
        documentUri: pathToFileUri(documentPath),
        languageId,
        serverId: adapter.id,
        status: 'unsupported',
        error: `${adapter.id} requires one of ${adapter.rootMarkers.join(', ')}.`,
      };
    }

    const rootPath = candidate.rootPath;
    const command = await resolveExecutable(rootPath, adapter.command) ??
      await resolveExecutable(workspaceRoot, adapter.command);
    if (!command) {
      const tool = defaultToolRegistry[adapter.toolId] ?? { binary: adapter.command, package: adapter.command };
      return {
        sessionId,
        target: record as PortalLspTarget,
        path: relativePath,
        documentPath,
        documentUri: pathToFileUri(documentPath),
        languageId,
        serverId: adapter.id,
        rootPath,
        rootUri: pathToFileUri(rootPath),
        status: 'missing',
        command: adapter.command,
        args: adapter.args,
        error: `Missing language server binary "${adapter.command}". Install ${
          tool.package ?? adapter.command
        } in the project or configure .weave/language-servers.jsonc.`,
      };
    }

    return {
      sessionId,
      target: record as PortalLspTarget,
      path: relativePath,
      documentPath,
      documentUri: pathToFileUri(documentPath),
      languageId,
      serverId: adapter.id,
      rootPath,
      rootUri: pathToFileUri(rootPath),
      adapter,
      command,
      args: adapter.args,
      status: 'ready',
    };
  }

  private sessionResult(session: NormalizedSession, capabilities?: unknown): PortalLspSessionResult {
    return {
      ok: true,
      sessionId: session.sessionId,
      status: session.status,
      serverId: session.serverId,
      languageId: session.languageId,
      documentUri: session.documentUri,
      rootUri: session.rootUri,
      rootPath: session.rootPath,
      command: session.command,
      args: session.args,
      capabilities,
      error: session.error,
    };
  }

  private async openDocument(runtime: LspRuntime, session: NormalizedSession) {
    const text = await Deno.readTextFile(session.documentPath!);
    await runtime.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: session.documentUri,
        languageId: session.languageId,
        version: 1,
        text,
      },
    });
  }

  private async resolveCodeAction(runtime: LspRuntime, session: NormalizedSession, input: PortalLspQueryInput) {
    const position = toLspPosition(input);
    const response = await runtime.sendRequest('textDocument/codeAction', {
      textDocument: { uri: session.documentUri },
      range: input.range ?? { start: position, end: position },
      context: { diagnostics: runtime.getDiagnostics(session.documentUri!) },
    });
    const actions = Array.isArray(response.result) ? response.result : [];
    return actions[Math.max(0, input.actionIndex ?? 0)] ?? null;
  }
}

export const isLspClientEnvelope = (message: Record<string, unknown>): message is PortalLspClientEnvelope =>
  message.type === 'lsp.client' &&
  typeof message.clientId === 'string' &&
  Boolean(message.message && typeof message.message === 'object');

const toLspPosition = (input: { line?: number; character?: number }) => ({
  line: typeof input.line === 'number' && Number.isFinite(input.line) ? Math.max(0, Math.floor(input.line)) : 0,
  character: typeof input.character === 'number' && Number.isFinite(input.character)
    ? Math.max(0, Math.floor(input.character))
    : 0,
});

const actionEdit = (action: unknown) => isRecord(action) ? action.edit : undefined;

const normalizeTextEdits = (rootPath: string, uri: string | undefined, edits: unknown) => {
  if (!uri || !Array.isArray(edits)) return { edits: [], unsupported: [] };
  return normalizeWorkspaceEdit(rootPath, { changes: { [uri]: edits } });
};

const normalizeWorkspaceEdit = (rootPath: string, workspaceEdit: unknown) => {
  const edits: Array<{ path: string; range: unknown; newText: string }> = [];
  const unsupported: string[] = [];
  const addEdits = (uri: string, rawEdits: unknown) => {
    if (!Array.isArray(rawEdits)) return;
    const path = fileUriToPath(uri);
    assertPortalPathWithinRoot(rootPath, path, 'LSP edit escapes the workspace root.');
    const relativePath = path === rootPath ? '' : path.slice(rootPath.length + 1);
    for (const edit of rawEdits) {
      if (!isRecord(edit) || !isRecord(edit.range) || typeof edit.newText !== 'string') continue;
      edits.push({ path: relativePath, range: edit.range, newText: edit.newText });
    }
  };

  if (isRecord(workspaceEdit) && isRecord(workspaceEdit.changes)) {
    for (const [uri, rawEdits] of Object.entries(workspaceEdit.changes)) addEdits(uri, rawEdits);
  }

  if (isRecord(workspaceEdit) && Array.isArray(workspaceEdit.documentChanges)) {
    for (const change of workspaceEdit.documentChanges) {
      if (isRecord(change) && isRecord(change.textDocument) && typeof change.textDocument.uri === 'string') {
        addEdits(change.textDocument.uri, change.edits);
      } else if (isRecord(change) && typeof change.kind === 'string') {
        unsupported.push(change.kind);
      }
    }
  }

  return { edits, unsupported };
};

const defaultClientCapabilities = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
    codeAction: {
      dynamicRegistration: false,
      isPreferredSupport: true,
      dataSupport: true,
      resolveSupport: { properties: ['edit'] },
    },
    rename: { dynamicRegistration: false, prepareSupport: true },
    formatting: { dynamicRegistration: false },
    diagnostic: {},
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
      codeDescriptionSupport: true,
      dataSupport: true,
    },
  },
  workspace: {
    workspaceFolders: true,
    configuration: true,
    symbol: { dynamicRegistration: false },
    applyEdit: false,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: [],
      failureHandling: 'abort',
      normalizesLineEndings: true,
    },
  },
  window: {
    workDoneProgress: true,
  },
};
