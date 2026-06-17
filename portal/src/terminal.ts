import type { PortalEditorHost } from './editor.ts';
import type { PortalVaultHost } from './vault.ts';

export type TerminalSessionKind = 'workspace' | 'general';

export type TerminalStartInput = {
  kind: TerminalSessionKind;
  terminalId: string;
  projectId?: string;
  workspaceId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type TerminalTargetInput = Omit<TerminalStartInput, 'terminalId'> & {
  terminalId?: string;
};

export type TerminalWindowRecord = {
  terminalId: string;
  scopeId: string;
  slot: number;
  kind: TerminalSessionKind;
  cwd: string;
  title: string;
  processName?: string;
  portalId?: string;
  rootId?: string;
  projectId?: string;
  workspaceId?: string;
};

export type TerminalClientMessage =
  | { type: 'snapshot'; requestId?: string }
  | ({ type: 'list'; requestId?: string } & TerminalTargetInput)
  | ({ type: 'create'; requestId?: string } & TerminalTargetInput)
  | ({ type: 'start' } & TerminalStartInput)
  | { type: 'input'; terminalId: string; data: string }
  | { type: 'resize'; terminalId: string; cols: number; rows: number }
  | { type: 'close'; terminalId: string }
  | { type: 'detach'; terminalId: string };

export type TerminalStartedEvent = {
  type: 'started';
  terminalId: string;
  workspaceId?: string;
  sessionId: string;
  cwd: string;
  pid?: number;
  cols: number;
  rows: number;
};

export type TerminalHostEvent =
  | TerminalStartedEvent
  | { type: 'windows'; requestId?: string; windows: TerminalWindowRecord[] }
  | { type: 'created'; requestId?: string; terminalId: string; workspaceId?: string; window: TerminalWindowRecord }
  | { type: 'output'; terminalId: string; workspaceId?: string; data: string }
  | { type: 'replay'; terminalId: string; workspaceId?: string; data: string }
  | { type: 'title'; terminalId: string; workspaceId?: string; title: string }
  | { type: 'exit'; terminalId: string; workspaceId?: string; exitCode?: number; signal?: number | string }
  | { type: 'error'; requestId?: string; terminalId: string; workspaceId?: string; error: string };

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
  projectId: string;
  localPath: string;
};

export type TerminalPortalConfig = {
  portalId?: string;
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

type NormalizedTerminalTargetInput = TerminalTargetInput & {
  cols: number;
  rows: number;
};

type TerminalSubscriber = {
  send: (event: TerminalHostEvent) => void;
};

type PortalEditorControlHost = Pick<PortalEditorHost, 'list' | 'read' | 'write' | 'mkdir' | 'move' | 'delete'>;

type TerminalSession = {
  sessionId: string;
  kind: TerminalSessionKind;
  terminalId: string;
  attachSessionId?: string;
  window: TerminalWindowRecord;
  projectId?: string;
  workspaceId?: string;
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
  tmux?: PortalTmuxController;
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
const isAbsolutePath = (path: string) => path.startsWith('/');
const expandHomePath = (path: string) => {
  if (path === '~') return Deno.env.get('HOME') ?? path;
  if (path.startsWith('~/')) return `${Deno.env.get('HOME') ?? '~'}${path.slice(1)}`;
  return path;
};

const parseDimension = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
};

export const parseTerminalTargetInput = (input: unknown): NormalizedTerminalTargetInput => {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const isGeneralTerminalRequest = record.kind === 'general' ||
    (
      record.kind !== 'workspace' &&
      record.projectId === undefined &&
      record.workspaceId === undefined &&
      (record.terminalId === 'weave-general-terminal' || typeof record.cwd === 'string')
    );
  const kind: TerminalSessionKind = isGeneralTerminalRequest ? 'general' : 'workspace';
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
      terminalId: optionalString(record.terminalId),
      ...common,
    };
  }

  const workspaceId = parseIdentifier(record.workspaceId, 'workspaceId');
  return {
    kind,
    terminalId: optionalString(record.terminalId),
    projectId: parseIdentifier(record.projectId, 'projectId'),
    workspaceId,
    ...common,
  };
};

export const parseTerminalStartInput = (input: unknown): NormalizedTerminalStartInput => {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const target = parseTerminalTargetInput(input);
  const fallbackTerminalId = target.kind === 'general' ? 'weave-general-terminal' : target.workspaceId;
  return {
    ...target,
    terminalId: parseIdentifier(record.terminalId ?? fallbackTerminalId, 'terminalId'),
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

const getTerminalProcessEnv = (env: Record<string, string | undefined>) => {
  const processEnv = getProcessEnv(env);
  delete processEnv.NO_COLOR;
  return processEnv;
};

type TerminalScope = {
  kind: TerminalSessionKind;
  portalId?: string;
  rootId?: string;
  projectId?: string;
  workspaceId?: string;
  cwd: string;
};

type ResolvedTerminalTarget = NormalizedTerminalTargetInput & {
  cwd: string;
  scope: TerminalScope;
  scopeId: string;
  scopeIds: string[];
};

export type PortalTmuxAttachCommand = {
  attachSessionId: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export type PortalTmuxController = {
  listAllWindows: () => Promise<TerminalWindowRecord[]>;
  listWindows: (target: ResolvedTerminalTarget) => Promise<TerminalWindowRecord[]>;
  createWindow: (
    target: ResolvedTerminalTarget,
    input: { slot?: number; env: Record<string, string>; shell: { file: string; args: string[] } },
  ) => Promise<TerminalWindowRecord>;
  ensureWindow: (
    target: ResolvedTerminalTarget,
    input: { terminalId: string; env: Record<string, string>; shell: { file: string; args: string[] } },
  ) => Promise<TerminalWindowRecord>;
  getAttachCommand: (terminalId: string, clientId: string) => Promise<PortalTmuxAttachCommand>;
  killAttachment: (attachSessionId: string) => Promise<void>;
  killWindow: (terminalId: string) => Promise<void>;
  captureWindow?: (terminalId: string) => Promise<string>;
};

const terminalProtocolVersion = 'weave:terminal:v1';
const tmuxRequiredMessage = 'tmux is required for Weave terminals but was not found on PATH.';
const tmuxConfigVersion = 'weave-tmux-config-v3';
const tmuxConfigVersionOption = '@weave_config_version';
const tmuxConfig = `# Generated by Weave. Do not edit.
set-option -g status off
set-option -g prefix None
set-option -g prefix2 None
unbind-key -aT root
unbind-key -aT prefix
unbind-key -aT copy-mode
unbind-key -aT copy-mode-vi
set-option -g mouse off
set-option -g visual-activity off
set-option -g visual-bell off
set-option -g bell-action none
set-option -g detach-on-destroy on
set-option -g base-index 0
set-option -g renumber-windows off
set-window-option -g automatic-rename off
set-window-option -g allow-rename off
set-option -g set-titles off
set-option -g default-terminal "xterm-256color"
set-option -ga terminal-overrides ",xterm-256color:Tc"
set-option -g @catppuccin_flavor "mocha"
set-option -g @catppuccin_flavour "mocha"
set-option -g @catppuccin_window_status_style "rounded"
set-option -g @catppuccin_status_background "#1e1e2e"
set-option -g @catppuccin_window_current_number_color "#{@thm_peach}"
set-option -g @thm_bg "#1e1e2e"
set-option -g @thm_fg "#cdd6f4"
set-option -g @thm_rosewater "#f5e0dc"
set-option -g @thm_flamingo "#f2cdcd"
set-option -g @thm_pink "#f5c2e7"
set-option -g @thm_mauve "#cba6f7"
set-option -g @thm_red "#f38ba8"
set-option -g @thm_maroon "#eba0ac"
set-option -g @thm_peach "#fab387"
set-option -g @thm_yellow "#f9e2af"
set-option -g @thm_green "#a6e3a1"
set-option -g @thm_teal "#94e2d5"
set-option -g @thm_sky "#89dceb"
set-option -g @thm_sapphire "#74c7ec"
set-option -g @thm_blue "#89b4fa"
set-option -g @thm_lavender "#b4befe"
set-option -g @thm_subtext_1 "#a6adc8"
set-option -g @thm_subtext_0 "#bac2de"
set-option -g @thm_overlay_2 "#9399b2"
set-option -g @thm_overlay_1 "#7f849c"
set-option -g @thm_overlay_0 "#6c7086"
set-option -g @thm_surface_2 "#585b70"
set-option -g @thm_surface_1 "#45475a"
set-option -g @thm_surface_0 "#313244"
set-option -g @thm_mantle "#181825"
set-option -g @thm_crust "#11111b"
set-option -g pane-border-lines heavy
set-option -g pane-active-border-style "fg=#a6e3a1"
set-option -g pane-border-style "fg=#313244"
set-option -g message-style "fg=#89dceb,bg=#313244,align=centre"
set-window-option -g mode-style "bg=#313244,bold"
set-environment -gu NO_COLOR
set-option -g ${tmuxConfigVersionOption} ${tmuxConfigVersion}
`;

const stableJson = (value: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)));

const base64UrlEncode = (value: string) => {
  const bytes = textEncoder.encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const base64UrlDecode = (value: string) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
};

const fnv1a = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

const terminalScopeId = (scope: TerminalScope) => base64UrlEncode(stableJson(scope));
const deterministicTerminalId = (scopeId: string, slot: number) => `${terminalProtocolVersion}:${scopeId}:slot:${slot}`;

const uniqueStrings = (values: string[]) => [...new Set(values)];
const targetScopeIds = (target: ResolvedTerminalTarget) =>
  target.scopeIds?.length ? target.scopeIds : [target.scopeId];

const parseTerminalScope = (scopeId: string): TerminalScope | undefined => {
  try {
    const record = JSON.parse(base64UrlDecode(scopeId)) as Record<string, unknown>;
    const kind = record.kind === 'workspace' ? 'workspace' : record.kind === 'general' ? 'general' : undefined;
    const cwd = optionalString(record.cwd);
    if (!kind || !cwd) return undefined;
    if (kind === 'workspace') {
      const projectId = optionalString(record.projectId);
      const workspaceId = optionalString(record.workspaceId);
      if (!projectId || !workspaceId) return undefined;
      return { kind, projectId, workspaceId, cwd };
    }
    return {
      kind,
      portalId: optionalString(record.portalId),
      rootId: optionalString(record.rootId),
      cwd,
    };
  } catch {
    return undefined;
  }
};

const parseDeterministicTerminalId = (terminalId: string) => {
  const prefix = `${terminalProtocolVersion}:`;
  if (!terminalId.startsWith(prefix)) return undefined;
  const rest = terminalId.slice(prefix.length);
  const marker = ':slot:';
  const markerIndex = rest.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const scopeId = rest.slice(0, markerIndex);
  const slot = Number(rest.slice(markerIndex + marker.length));
  if (!scopeId || !Number.isInteger(slot) || slot < 1) return undefined;
  if (!parseTerminalScope(scopeId)) return undefined;
  return { scopeId, slot };
};

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

const resolvePortalHome = () => {
  const explicit = Deno.env.get('WEAVE_PORTAL_HOME')?.trim();
  if (explicit) return explicit;
  const configHome = Deno.env.get('XDG_CONFIG_HOME')?.trim() || `${Deno.env.get('HOME') ?? Deno.cwd()}/.config`;
  return `${configHome}/weave/portal`;
};

const dirname = (path: string) => {
  const index = path.lastIndexOf('/');
  return index <= 0 ? '/' : path.slice(0, index);
};

const tmuxWindowTitle = (scopeId: string, slot: number) => `weave-${slot}-${fnv1a(scopeId).slice(0, 10)}`;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const ignoredTerminalProcessNames = new Set([
  'bash',
  'cmd',
  'cmd.exe',
  'csh',
  'dash',
  'elvish',
  'fish',
  'ksh',
  'login',
  'nu',
  'pwsh',
  'powershell',
  'powershell.exe',
  'sh',
  'tcsh',
  'tmux',
  'zsh',
]);

const terminalProcessDisplayName = (command: string | undefined) => {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  const basename = trimmed.split('/').filter(Boolean).at(-1) ?? trimmed;
  const normalized = basename.toLowerCase();
  return ignoredTerminalProcessNames.has(normalized) ? undefined : basename;
};

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

type TmuxCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

type TmuxWindowDetails = TerminalWindowRecord & {
  windowIndex: string;
  target: string;
};

export type PortalTmuxRunner = (
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<TmuxCommandResult>;

export class TmuxTerminalController implements PortalTmuxController {
  private readonly socketPath: string;
  private readonly configPath: string;
  private readonly sessionName: string;
  private readonly env: Record<string, string | undefined>;
  private readonly runner?: PortalTmuxRunner;
  private ensured = false;
  private configWritten = false;

  constructor(options: {
    env?: Record<string, string | undefined>;
    portalHome?: string;
    socketPath?: string;
    configPath?: string;
    sessionName?: string;
    runner?: PortalTmuxRunner;
  } = {}) {
    const portalHome = options.portalHome ?? resolvePortalHome();
    this.socketPath = options.socketPath ?? `${portalHome}/tmux/_weave.sock`;
    this.configPath = options.configPath ?? `${portalHome}/tmux/tmux.conf`;
    this.sessionName = options.sessionName ?? '_weave';
    this.env = options.env ?? Deno.env.toObject();
    this.runner = options.runner;
  }

  async listAllWindows() {
    await this.ensureSession(Deno.env.get('HOME') ?? Deno.cwd());
    return (await this.listAllWindowDetails()).map((window) => this.toRecord(window));
  }

  async listWindows(target: ResolvedTerminalTarget) {
    await this.ensureSession(target.cwd);
    const scopeIds = new Set(targetScopeIds(target));
    return (await this.listAllWindowDetails())
      .filter((window) => scopeIds.has(window.scopeId))
      .map((window) => this.toRecord(window));
  }

  private sortAndDedupeWindows(windows: TmuxWindowDetails[]) {
    const seenTerminalIds = new Set<string>();
    return [...windows]
      .sort((left, right) =>
        left.scopeId.localeCompare(right.scopeId)
        || left.slot - right.slot
        || left.terminalId.localeCompare(right.terminalId)
      )
      .filter((window) => {
        if (seenTerminalIds.has(window.terminalId)) return false;
        seenTerminalIds.add(window.terminalId);
        return true;
      });
  }

  async createWindow(
    target: ResolvedTerminalTarget,
    input: { slot?: number; env: Record<string, string>; shell: { file: string; args: string[] } },
  ) {
    await this.ensureSession(target.cwd);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const existing = await this.listAllWindowDetails();
      const scopeIds = new Set(targetScopeIds(target));
      const scoped = existing.filter((window) => scopeIds.has(window.scopeId));
      const slot = input.slot ?? this.nextSlot(scoped);
      const terminalId = deterministicTerminalId(target.scopeId, slot);
      const duplicate = scoped.find((window) => window.terminalId === terminalId);
      if (duplicate) return this.toRecord(duplicate);

      const title = tmuxWindowTitle(target.scopeId, slot);
      const windowEnv = { ...input.env, WEAVE_TERMINAL_ID: terminalId };
      const shellCommand = [
        '/usr/bin/env',
        '-u',
        'NO_COLOR',
        ...Object.entries(windowEnv).map(([key, value]) => `${key}=${value}`),
        input.shell.file,
        ...input.shell.args,
      ].map(shellQuote).join(' ');
      const created = await this.run([
        'new-window',
        '-d',
        '-P',
        '-F',
        '#{window_index}',
        '-t',
        `${this.sessionName}:`,
        '-n',
        title,
        '-c',
        target.cwd,
        shellCommand,
      ], { cwd: target.cwd, env: windowEnv });
      const windowIndex = created.stdout.trim().split(/\s+/)[0];
      const windowTarget = `${this.sessionName}:${windowIndex}`;
      await this.setWindowMetadata(windowTarget, target, terminalId, slot, title);
      const details = await this.findWindowByTerminalId(terminalId);
      if (details) return this.toRecord(details);
    }

    throw new Error('Could not allocate a deterministic tmux window slot.');
  }

  async ensureWindow(
    target: ResolvedTerminalTarget,
    input: { terminalId: string; env: Record<string, string>; shell: { file: string; args: string[] } },
  ) {
    await this.ensureSession(target.cwd);
    const existing = await this.findWindowByTerminalId(input.terminalId);
    if (existing) return this.toRecord(existing);
    const parsed = parseDeterministicTerminalId(input.terminalId);
    const slot = parsed && targetScopeIds(target).includes(parsed.scopeId) ? parsed.slot : 1;
    return await this.createWindow(target, { slot, env: input.env, shell: input.shell });
  }

  async getAttachCommand(terminalId: string, clientId: string) {
    const window = await this.findWindowByTerminalId(terminalId);
    if (!window) throw new Error('Terminal tmux window is not running.');
    const attachSessionId = this.attachSessionName(clientId, terminalId);
    const env = getTerminalProcessEnv(this.env);
    await this.run(['kill-session', '-t', attachSessionId], { env }, [0, 1]);
    await this.run(['new-session', '-d', '-s', attachSessionId, '-n', '_weave_attach_boot', '-c', window.cwd, 'sleep 2147483647'], {
      cwd: window.cwd,
      env,
    });
    await this.run(['set-option', '-t', attachSessionId, 'detach-on-destroy', 'on'], {
      cwd: window.cwd,
      env,
    });
    await this.run(['link-window', '-k', '-s', window.target, '-t', `${attachSessionId}:0`], {
      cwd: window.cwd,
      env,
    });
    await this.run(['select-window', '-t', `${attachSessionId}:0`], {
      cwd: window.cwd,
      env,
    });
    return {
      attachSessionId,
      file: 'tmux',
      args: [...this.tmuxBaseArgs(), 'attach-session', '-t', attachSessionId],
      cwd: window.cwd,
      env: {
        ...env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    };
  }

  async killAttachment(attachSessionId: string) {
    await this.run(['kill-session', '-t', attachSessionId], { env: getTerminalProcessEnv(this.env) }, [0, 1]);
  }

  async killWindow(terminalId: string) {
    const window = await this.findWindowByTerminalId(terminalId);
    if (!window) return;
    await this.run(['kill-window', '-t', window.target], { cwd: window.cwd, env: getTerminalProcessEnv(this.env) }, [
      0,
      1,
    ]);
  }

  async captureWindow(terminalId: string) {
    const window = await this.findWindowByTerminalId(terminalId);
    if (!window) return '';
    const result = await this.run(
      [
        'capture-pane',
        '-p',
        '-e',
        '-J',
        '-S',
        '-2000',
        '-t',
        window.target,
      ],
      { cwd: window.cwd, env: getTerminalProcessEnv(this.env) },
      [0, 1],
    );
    return result.stdout;
  }

  private async ensureSession(cwd: string) {
    await Deno.mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const env = getTerminalProcessEnv(this.env);
    const hasSession = await this.run(['has-session', '-t', this.sessionName], { cwd, env }, [0, 1]);
    if (this.ensured && hasSession.code === 0) return;

    let shouldCreateSession = hasSession.code !== 0;
    if (hasSession.code === 0 && await this.readConfigVersion(cwd, env) !== tmuxConfigVersion) {
      await this.run(['kill-server'], { cwd, env }, [0, 1]);
      shouldCreateSession = true;
    }
    if (shouldCreateSession) {
      await this.run(['new-session', '-d', '-s', this.sessionName, '-n', '_weave_boot', '-c', cwd], { cwd, env });
    }
    await this.applySessionHardening(cwd, env);
    this.ensured = true;
  }

  private async readConfigVersion(cwd: string, env: Record<string, string>) {
    const global = await this.run(['show-option', '-gqv', tmuxConfigVersionOption], { cwd, env }, [0, 1]);
    if (global.stdout.trim()) return global.stdout.trim();
    const session = await this.run(['show-option', '-qv', '-t', this.sessionName, tmuxConfigVersionOption], {
      cwd,
      env,
    }, [0, 1]);
    return session.stdout.trim();
  }

  private async applySessionHardening(cwd: string, env: Record<string, string>) {
    const commands: Array<{ args: string[]; okCodes?: number[] }> = [
      { args: ['set-option', '-g', tmuxConfigVersionOption, tmuxConfigVersion] },
      { args: ['set-option', '-t', this.sessionName, tmuxConfigVersionOption, tmuxConfigVersion] },
      { args: ['set-option', '-t', this.sessionName, 'renumber-windows', 'off'] },
      { args: ['set-option', '-t', this.sessionName, 'status', 'off'] },
      { args: ['set-option', '-t', this.sessionName, 'prefix', 'None'] },
      { args: ['set-option', '-t', this.sessionName, 'prefix2', 'None'] },
      { args: ['set-option', '-t', this.sessionName, 'mouse', 'off'] },
      { args: ['set-option', '-t', this.sessionName, 'visual-activity', 'off'] },
      { args: ['set-option', '-t', this.sessionName, 'visual-bell', 'off'] },
      { args: ['set-option', '-t', this.sessionName, 'bell-action', 'none'] },
      { args: ['set-option', '-t', this.sessionName, 'detach-on-destroy', 'on'] },
      { args: ['set-option', '-t', this.sessionName, 'base-index', '0'] },
      { args: ['set-option', '-t', this.sessionName, 'set-titles', 'off'] },
      { args: ['set-option', '-g', 'default-terminal', 'xterm-256color'] },
      { args: ['set-option', '-g', 'terminal-overrides', 'xterm-256color:Tc'] },
      { args: ['set-option', '-g', '@catppuccin_flavor', 'mocha'] },
      { args: ['set-option', '-g', '@catppuccin_flavour', 'mocha'] },
      { args: ['set-option', '-g', '@catppuccin_window_status_style', 'rounded'] },
      { args: ['set-option', '-g', '@catppuccin_status_background', '#1e1e2e'] },
      { args: ['set-option', '-g', '@catppuccin_window_current_number_color', '#{@thm_peach}'] },
      { args: ['set-option', '-g', '@thm_bg', '#1e1e2e'] },
      { args: ['set-option', '-g', '@thm_fg', '#cdd6f4'] },
      { args: ['set-option', '-g', '@thm_rosewater', '#f5e0dc'] },
      { args: ['set-option', '-g', '@thm_flamingo', '#f2cdcd'] },
      { args: ['set-option', '-g', '@thm_pink', '#f5c2e7'] },
      { args: ['set-option', '-g', '@thm_mauve', '#cba6f7'] },
      { args: ['set-option', '-g', '@thm_red', '#f38ba8'] },
      { args: ['set-option', '-g', '@thm_maroon', '#eba0ac'] },
      { args: ['set-option', '-g', '@thm_peach', '#fab387'] },
      { args: ['set-option', '-g', '@thm_yellow', '#f9e2af'] },
      { args: ['set-option', '-g', '@thm_green', '#a6e3a1'] },
      { args: ['set-option', '-g', '@thm_teal', '#94e2d5'] },
      { args: ['set-option', '-g', '@thm_sky', '#89dceb'] },
      { args: ['set-option', '-g', '@thm_sapphire', '#74c7ec'] },
      { args: ['set-option', '-g', '@thm_blue', '#89b4fa'] },
      { args: ['set-option', '-g', '@thm_lavender', '#b4befe'] },
      { args: ['set-option', '-g', '@thm_subtext_1', '#a6adc8'] },
      { args: ['set-option', '-g', '@thm_subtext_0', '#bac2de'] },
      { args: ['set-option', '-g', '@thm_overlay_2', '#9399b2'] },
      { args: ['set-option', '-g', '@thm_overlay_1', '#7f849c'] },
      { args: ['set-option', '-g', '@thm_overlay_0', '#6c7086'] },
      { args: ['set-option', '-g', '@thm_surface_2', '#585b70'] },
      { args: ['set-option', '-g', '@thm_surface_1', '#45475a'] },
      { args: ['set-option', '-g', '@thm_surface_0', '#313244'] },
      { args: ['set-option', '-g', '@thm_mantle', '#181825'] },
      { args: ['set-option', '-g', '@thm_crust', '#11111b'] },
      { args: ['set-option', '-g', 'pane-border-lines', 'heavy'] },
      { args: ['set-option', '-g', 'pane-active-border-style', 'fg=#a6e3a1'] },
      { args: ['set-option', '-g', 'pane-border-style', 'fg=#313244'] },
      { args: ['set-option', '-g', 'message-style', 'fg=#89dceb,bg=#313244,align=centre'] },
      { args: ['set-window-option', '-g', 'mode-style', 'bg=#313244,bold'] },
      { args: ['set-environment', '-gu', 'NO_COLOR'], okCodes: [0, 1] },
      { args: ['set-window-option', '-g', '-t', this.sessionName, 'automatic-rename', 'off'] },
      { args: ['set-window-option', '-g', '-t', this.sessionName, 'allow-rename', 'off'] },
      { args: ['unbind-key', '-aT', 'root'], okCodes: [0, 1] },
      { args: ['unbind-key', '-aT', 'prefix'], okCodes: [0, 1] },
      { args: ['unbind-key', '-aT', 'copy-mode'], okCodes: [0, 1] },
      { args: ['unbind-key', '-aT', 'copy-mode-vi'], okCodes: [0, 1] },
    ];
    for (const command of commands) {
      await this.run(command.args, { cwd, env }, command.okCodes);
    }
  }

  private async listAllWindowDetails() {
    const result = await this.run(
      [
        'list-windows',
        '-t',
        this.sessionName,
        '-F',
        [
          '#{window_index}',
          '#{window_name}',
          '#{@weave_terminal_id}',
          '#{@weave_scope_id}',
          '#{@weave_slot}',
          '#{@weave_cwd}',
          '#{@weave_project_id}',
          '#{@weave_workspace_id}',
          '#{@weave_portal_id}',
          '#{@weave_root_id}',
          '#{pane_current_command}',
        ].join('\t'),
      ],
      { env: getTerminalProcessEnv(this.env) },
      [0, 1],
    );
    if (result.code !== 0) return [];

    const windows = result.stdout.split('\n').map((line): TmuxWindowDetails | undefined => {
      const [
        index = '',
        title = '',
        terminalId = '',
        scopeId = '',
        slotText = '',
        cwd = '',
        projectId = '',
        workspaceId = '',
        portalId = '',
        rootId = '',
        processCommand = '',
      ] = line.split('\t');
      const parsed = parseDeterministicTerminalId(terminalId);
      const effectiveScopeId = scopeId || parsed?.scopeId || '';
      const scope = effectiveScopeId ? parseTerminalScope(effectiveScopeId) : undefined;
      const metadataSlot = Number(slotText);
      const slot = Number.isInteger(metadataSlot) && metadataSlot > 0 ? metadataSlot : parsed?.slot;
      if (
        !terminalId
        || !effectiveScopeId
        || !scope
        || typeof slot !== 'number'
        || !Number.isInteger(slot)
        || slot < 1
        || parsed?.scopeId !== effectiveScopeId
      ) {
        return undefined;
      }
      return {
        terminalId,
        scopeId: effectiveScopeId,
        slot,
        kind: scope.kind,
        cwd: cwd || scope.cwd,
        title,
        processName: terminalProcessDisplayName(processCommand),
        portalId: portalId || scope.portalId || undefined,
        rootId: rootId || scope.rootId || undefined,
        projectId: projectId || scope.projectId || undefined,
        workspaceId: workspaceId || scope.workspaceId || undefined,
        windowIndex: index,
        target: `${this.sessionName}:${index}`,
      };
    }).filter((window): window is TmuxWindowDetails => Boolean(window));
    return this.sortAndDedupeWindows(windows);
  }

  private async findWindowByTerminalId(terminalId: string) {
    return (await this.listAllWindowDetails()).find((window) => window.terminalId === terminalId);
  }

  private nextSlot(windows: TerminalWindowRecord[]) {
    const slots = new Set(windows.map((window) => window.slot));
    let slot = 1;
    while (slots.has(slot)) slot += 1;
    return slot;
  }

  private toRecord(window: TmuxWindowDetails): TerminalWindowRecord {
    return {
      terminalId: window.terminalId,
      slot: window.slot,
      kind: window.kind,
      cwd: window.cwd,
      title: window.title,
      processName: window.processName,
      scopeId: window.scopeId,
      portalId: window.portalId,
      rootId: window.rootId,
      projectId: window.projectId,
      workspaceId: window.workspaceId,
    };
  }

  private async setWindowMetadata(
    windowTarget: string,
    target: ResolvedTerminalTarget,
    terminalId: string,
    slot: number,
    title: string,
  ) {
    const entries: Array<[string, string]> = [
      ['@weave_terminal_id', terminalId],
      ['@weave_scope_id', target.scopeId],
      ['@weave_slot', String(slot)],
      ['@weave_cwd', target.cwd],
      ['@weave_portal_id', target.portalId ?? ''],
      ['@weave_root_id', target.rootId ?? ''],
      ['@weave_project_id', target.projectId ?? ''],
      ['@weave_workspace_id', target.workspaceId ?? ''],
    ];
    await this.run(['rename-window', '-t', windowTarget, title], {
      cwd: target.cwd,
      env: getTerminalProcessEnv(this.env),
    });
    for (const [key, value] of entries) {
      await this.run(['set-window-option', '-t', windowTarget, key, value], {
        cwd: target.cwd,
        env: getTerminalProcessEnv(this.env),
      });
    }
  }

  private attachSessionName(clientId: string, terminalId: string) {
    return `_weave_attach_${fnv1a(`${clientId}:${terminalId}`).slice(0, 16)}`;
  }

  private async run(
    args: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
    okCodes = [0],
  ): Promise<TmuxCommandResult> {
    await this.ensureConfigFile();
    const env = { ...getTerminalProcessEnv(this.env), ...options.env };
    delete env.NO_COLOR;
    const commandOptions = {
      ...options,
      env,
    };
    let result: TmuxCommandResult;
    try {
      result = this.runner
        ? await this.runner([...this.tmuxBaseArgs(), ...args], commandOptions)
        : await this.runCommand(args, commandOptions);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new Error(tmuxRequiredMessage);
      throw error;
    }
    const ok = okCodes.includes(result.code);
    if (!ok) throw new Error(result.stderr || result.stdout || `tmux ${args.join(' ')} failed`);
    return { ...result, ok };
  }

  private async ensureConfigFile() {
    if (this.configWritten) return;
    await Deno.mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(this.configPath, tmuxConfig, { mode: 0o600 });
    await Deno.chmod(this.configPath, 0o600).catch(() => undefined);
    this.configWritten = true;
  }

  private tmuxBaseArgs() {
    return ['-f', this.configPath, '-S', this.socketPath];
  }

  private async runCommand(args: string[], options: { cwd?: string; env?: Record<string, string> }) {
    try {
      const command = new Deno.Command('tmux', {
        args: [...this.tmuxBaseArgs(), ...args],
        cwd: options.cwd,
        env: options.env,
        clearEnv: true,
        stdout: 'piped',
        stderr: 'piped',
      });
      const output = await command.output();
      return {
        ok: output.success,
        stdout: textDecoder.decode(output.stdout),
        stderr: textDecoder.decode(output.stderr).trim(),
        code: output.code,
      };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new Error(tmuxRequiredMessage);
      throw error;
    }
  }
}

const defaultRoots = (): TerminalPortalRoot[] => [{
  id: 'default',
  name: 'Default',
  path: Deno.env.get('HOME') ?? Deno.cwd(),
}];

export class PortalTerminalHost {
  private readonly config: TerminalPortalConfig;
  private readonly spawner: PortalPtySpawner;
  private readonly tmux: PortalTmuxController;
  private readonly replayLimitBytes: number;
  private readonly outputBatchMs: number;
  private readonly env: Record<string, string | undefined>;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly clientSessions = new Map<string, Set<string>>();

  constructor(options: PortalTerminalHostOptions) {
    this.config = options.config;
    this.env = options.env ?? Deno.env.toObject();
    this.spawner = options.spawner ?? createNativePty;
    this.tmux = options.tmux ?? new TmuxTerminalController({ env: this.env });
    this.replayLimitBytes = options.replayLimitBytes ?? defaultReplayLimitBytes;
    this.outputBatchMs = options.outputBatchMs ?? defaultOutputBatchMs;
  }

  async handleClientMessage(
    clientId: string,
    message: TerminalClientMessage,
    send: (event: TerminalHostEvent) => void,
  ) {
    try {
      if (message.type === 'snapshot') {
        await this.snapshot(message, send);
        return;
      }

      if (message.type === 'list') {
        await this.list(message, send);
        return;
      }

      if (message.type === 'create') {
        await this.create(message, send);
        return;
      }

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
        await this.close(parseTerminalId(message.terminalId));
        return;
      }

      if (message.type === 'detach') {
        this.detach(parseTerminalId(message.terminalId), clientId);
      }
    } catch (error) {
      const terminalId = 'terminalId' in message && typeof message.terminalId === 'string'
        ? message.terminalId
        : 'unknown';
      const requestId = 'requestId' in message && typeof message.requestId === 'string' ? message.requestId : undefined;
      send({ type: 'error', requestId, terminalId, error: toErrorMessage(error) });
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

  private async list(input: TerminalTargetInput & { requestId?: string }, send: (event: TerminalHostEvent) => void) {
    const target = await this.resolveTarget(parseTerminalTargetInput(input));
    const windows = await this.tmux.listWindows(target);
    send({ type: 'windows', requestId: input.requestId, windows });
  }

  private async snapshot(input: { requestId?: string }, send: (event: TerminalHostEvent) => void) {
    const windows = await this.tmux.listAllWindows();
    send({ type: 'windows', requestId: input.requestId, windows });
  }

  private async create(input: TerminalTargetInput & { requestId?: string }, send: (event: TerminalHostEvent) => void) {
    const target = await this.resolveTarget(parseTerminalTargetInput(input));
    const window = await this.tmux.createWindow(target, {
      env: this.getWeaveEnv(target),
      shell: getDefaultShell(this.env),
    });
    send({
      type: 'created',
      requestId: input.requestId,
      terminalId: window.terminalId,
      workspaceId: window.workspaceId,
      window,
    });
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

      const target = await this.resolveTarget(normalizedInput);
      const window = await this.tmux.ensureWindow(target, {
        terminalId: normalizedInput.terminalId,
        env: this.getWeaveEnv({ ...target, terminalId: normalizedInput.terminalId }),
        shell: getDefaultShell(this.env),
      });
      const attachCommand = await this.tmux.getAttachCommand(window.terminalId, clientId);
      const pty = await this.spawner(attachCommand.file, attachCommand.args, {
        cols: normalizedInput.cols,
        rows: normalizedInput.rows,
        cwd: attachCommand.cwd,
        env: attachCommand.env,
      });

      const session: TerminalSession = {
        sessionId: window.terminalId,
        kind: window.kind,
        terminalId: window.terminalId,
        attachSessionId: attachCommand.attachSessionId,
        window,
        projectId: window.projectId,
        workspaceId: window.workspaceId,
        cwd: window.cwd,
        pty,
        cols: normalizedInput.cols,
        rows: normalizedInput.rows,
        replay: '',
        pendingOutput: '',
        subscribers: new Map([[clientId, { send }]]),
        disposables: [],
        exited: false,
      };

      this.trackClientSession(clientId, window.terminalId);
      session.disposables.push(
        pty.onData((data) => this.queueOutput(session, data)),
        pty.onExit((event) => this.handleExit(session, event)),
      );
      this.sessions.set(window.terminalId, session);
      this.sendStarted(session, send);
      const replay = await this.tmux.captureWindow?.(window.terminalId).catch(() => '');
      if (replay) {
        send({ type: 'replay', terminalId: window.terminalId, workspaceId: window.workspaceId, data: replay });
      }
    } catch (error) {
      send({
        type: 'error',
        terminalId: normalizedInput.terminalId,
        workspaceId: normalizedInput.workspaceId,
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

  private async close(terminalId: string) {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) {
      await this.tmux.killWindow(terminalId).catch(() => undefined);
      return;
    }
    await this.tmux.killWindow(terminalId).catch(() => undefined);
    this.handleExit(session, {});
  }

  private detach(terminalId: string, clientId: string) {
    const session = this.sessions.get(terminalId);
    session?.subscribers.delete(clientId);
    const terminalIds = this.clientSessions.get(clientId);
    terminalIds?.delete(terminalId);
    if (terminalIds?.size === 0) this.clientSessions.delete(clientId);
    if (session && session.subscribers.size === 0) {
      this.disposeSession(session);
      session.exited = true;
      session.pty.close();
      this.sessions.delete(terminalId);
    }
  }

  private async resolveTarget(input: NormalizedTerminalTargetInput): Promise<ResolvedTerminalTarget> {
    const cwd = await this.resolveCwd(input);
    await this.assertDirectory(cwd);
    const canonicalPortalId = input.kind === 'general'
      ? input.portalId ?? this.config.portalId
      : input.portalId;
    const scope: TerminalScope = input.kind === 'workspace'
      ? {
        kind: input.kind,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        cwd,
      }
      : {
        kind: input.kind,
        portalId: canonicalPortalId,
        rootId: input.rootId,
        cwd,
      };
    const legacyScopes: TerminalScope[] = input.kind === 'general' && canonicalPortalId
      ? [{ kind: input.kind, rootId: input.rootId, cwd }]
      : [];
    return {
      ...input,
      portalId: canonicalPortalId,
      cwd,
      scope,
      scopeId: terminalScopeId(scope),
      scopeIds: uniqueStrings([terminalScopeId(scope), ...legacyScopes.map(terminalScopeId)]),
    };
  }

  private getWeaveEnv(input: ResolvedTerminalTarget & { terminalId?: string }) {
    const weaveEnv: Record<string, string> = {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      WEAVE_TERMINAL_KIND: input.kind,
      WEAVE_WORKSPACE: input.cwd,
    };
    if (input.terminalId) weaveEnv.WEAVE_TERMINAL_ID = input.terminalId;
    if (input.kind === 'workspace') {
      if (input.projectId) weaveEnv.WEAVE_PROJECT_ID = input.projectId;
      if (input.workspaceId) weaveEnv.WEAVE_WORKSPACE_ID = input.workspaceId;
    }
    return weaveEnv;
  }

  private async resolveCwd(input: NormalizedTerminalTargetInput) {
    if (input.kind === 'general') {
      if (input.workspacePath) return await Deno.realPath(input.workspacePath);
      if (input.rootId) return await this.resolveRootPath(input.rootId, '').then((result) => result.target);
      if (input.cwd) return await Deno.realPath(input.cwd);
      return await Deno.realPath(Deno.env.get('HOME') ?? Deno.cwd());
    }

    if (input.workspacePath) return await Deno.realPath(input.workspacePath);
    const mount = (this.config.mounts ?? []).find((item) => item.projectId === input.projectId);
    if (mount) return await Deno.realPath(mount.localPath);
    if (input.rootId && input.repoPath) {
      return await this.resolveRootPath(input.rootId, input.repoPath).then((result) => result.target);
    }
    throw new Error(`Project is not mounted: ${String(input.projectId)}`);
  }

  private async resolveRootPath(rootId: string, path = '') {
    const root = (this.config.roots?.length ? this.config.roots : defaultRoots()).find((item) => item.id === rootId);
    if (!root) throw new Error(`Unknown root: ${rootId}`);
    const rootPath = await Deno.realPath(root.path);
    const normalizedPath = expandHomePath(path.trim());
    const target = normalizedPath
      ? await Deno.realPath(isAbsolutePath(normalizedPath) ? normalizedPath : `${rootPath}/${normalizedPath}`)
      : rootPath;
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
      workspaceId: session.workspaceId,
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
      workspaceId: session.workspaceId,
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
      workspaceId: session.workspaceId,
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
    if (session.exited) return;
    this.flushOutput(session);
    session.exited = true;
    this.broadcast(session, {
      type: 'exit',
      terminalId: session.terminalId,
      workspaceId: session.workspaceId,
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
    if (session.attachSessionId) {
      void this.tmux.killAttachment(session.attachSessionId).catch(() => undefined);
      session.attachSessionId = undefined;
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
  editor?: PortalEditorControlHost;
  vault?: PortalVaultHost;
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
  server = Deno.serve({ hostname: input.hostname, port: input.port }, async (request) => {
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

    const editorAction = url.pathname === '/editor/list'
      ? 'list'
      : url.pathname === '/editor/read'
      ? 'read'
      : url.pathname === '/editor/write'
      ? 'write'
      : url.pathname === '/editor/mkdir'
      ? 'mkdir'
      : url.pathname === '/editor/move'
      ? 'move'
      : url.pathname === '/editor/delete'
      ? 'delete'
      : undefined;
    if (editorAction) {
      if (!input.editor) return new Response('not found', { status: 404 });
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const result = editorAction === 'list'
          ? await input.editor.list(body as Parameters<PortalEditorControlHost['list']>[0])
          : editorAction === 'read'
          ? await input.editor.read(body as Parameters<PortalEditorControlHost['read']>[0])
          : editorAction === 'write'
          ? await input.editor.write(body as Parameters<PortalEditorControlHost['write']>[0])
          : editorAction === 'mkdir'
          ? await input.editor.mkdir(body as Parameters<PortalEditorControlHost['mkdir']>[0])
          : editorAction === 'move'
          ? await input.editor.move(body as Parameters<PortalEditorControlHost['move']>[0])
          : await input.editor.delete(body as Parameters<PortalEditorControlHost['delete']>[0]);
        return Response.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 400 });
      }
    }

    const vaultAction = url.pathname === '/vault/index'
      ? 'index'
      : url.pathname === '/vault/read'
      ? 'read'
      : url.pathname === '/vault/write'
      ? 'write'
      : url.pathname === '/vault/mkdir'
      ? 'mkdir'
      : url.pathname === '/vault/move'
      ? 'move'
      : url.pathname === '/vault/delete'
      ? 'delete'
      : url.pathname === '/vault/upload'
      ? 'upload'
      : undefined;
    if (vaultAction) {
      if (!input.vault) return new Response('not found', { status: 404 });
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const result = vaultAction === 'index'
          ? await input.vault.index(body as Parameters<PortalVaultHost['index']>[0])
          : vaultAction === 'read'
          ? await input.vault.read(body as Parameters<PortalVaultHost['read']>[0])
          : vaultAction === 'write'
          ? await input.vault.write(body as Parameters<PortalVaultHost['write']>[0])
          : vaultAction === 'mkdir'
          ? await input.vault.mkdir(body as Parameters<PortalVaultHost['mkdir']>[0])
          : vaultAction === 'move'
          ? await input.vault.move(body as Parameters<PortalVaultHost['move']>[0])
          : vaultAction === 'delete'
          ? await input.vault.delete(body as Parameters<PortalVaultHost['delete']>[0])
          : await input.vault.upload(body as Parameters<PortalVaultHost['upload']>[0]);
        return Response.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 400 });
      }
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
