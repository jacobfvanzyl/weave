import type { PortalEditorHost } from './editor.ts';
import type { PortalLspClientMessage, PortalLspHost } from './lsp.ts';
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

type Disposable = {
  dispose: () => void;
};

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
type PortalLspControlHost = Pick<PortalLspHost, 'createSession' | 'handleClientMessage' | 'detachClient' | 'dispose'>;

type TerminalSession = {
  sessionId: string;
  kind: TerminalSessionKind;
  terminalId: string;
  window: PortalTmuxWindowRecord;
  windowId: string;
  paneId: string;
  projectId?: string;
  workspaceId?: string;
  cwd: string;
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
  tmux?: PortalTmuxController;
  replayLimitBytes?: number;
  outputBatchMs?: number;
  replayCaptureSettleMs?: number;
  env?: Record<string, string | undefined>;
};

const defaultReplayLimitBytes = 200 * 1024;
const defaultOutputBatchMs = 16;
const defaultReplayCaptureSettleMs = 100;

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

export type PortalTmuxWindowRecord = TerminalWindowRecord & {
  windowIndex: string;
  windowId: string;
  paneId: string;
  target: string;
};

export type PortalTmuxControlClientHandlers = {
  onOutput: (paneId: string, data: string) => void;
  onWindowClose: (windowId: string) => void;
  onExit: (reason?: string) => void;
  onError: (error: Error) => void;
};

export type PortalTmuxControlClient = {
  start: () => Promise<void>;
  input: (paneId: string, data: string) => Promise<void>;
  resize: (windowId: string, cols: number, rows: number) => Promise<void>;
  close: () => void;
};

export type PortalTmuxController = {
  listAllWindows: () => Promise<TerminalWindowRecord[]>;
  listWindows: (target: ResolvedTerminalTarget) => Promise<TerminalWindowRecord[]>;
  createWindow: (
    target: ResolvedTerminalTarget,
    input: { slot?: number; env: Record<string, string>; shell: { file: string; args: string[] } },
  ) => Promise<PortalTmuxWindowRecord>;
  ensureWindow: (
    target: ResolvedTerminalTarget,
    input: { terminalId: string; env: Record<string, string>; shell: { file: string; args: string[] } },
  ) => Promise<PortalTmuxWindowRecord>;
  findWindow: (terminalId: string) => Promise<PortalTmuxWindowRecord | undefined>;
  openControlClient: (handlers: PortalTmuxControlClientHandlers) => Promise<PortalTmuxControlClient>;
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
const targetScopeIds = (target: ResolvedTerminalTarget) => target.scopeIds?.length ? target.scopeIds : [target.scopeId];

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

type TmuxCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
};

type TmuxWindowDetails = PortalTmuxWindowRecord;

type TmuxPaneScreenState = {
  alternateOn: boolean;
  cursor?: { x: number; y: number };
};

export type PortalTmuxRunner = (
  args: string[],
  options?: { cwd?: string; env?: Record<string, string> },
) => Promise<TmuxCommandResult>;

type TmuxControlClientFactoryOptions = {
  args: string[];
  env: Record<string, string>;
  handlers: PortalTmuxControlClientHandlers;
  debug: (event: string, details?: Record<string, unknown>) => void;
};

const terminalDebugEnabled = (env: Record<string, string | undefined>) =>
  /^(1|true|yes|on)$/i.test(env.WEAVE_PORTAL_TERMINAL_DEBUG?.trim() ?? '');

const terminalWindowDiagnosticRecord = (
  window: TerminalWindowRecord & { target?: string; windowIndex?: string; windowId?: string; paneId?: string },
) => ({
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
  target: window.target,
  windowIndex: window.windowIndex,
  windowId: window.windowId,
  paneId: window.paneId,
});

const toTerminalWindowRecord = (window: TerminalWindowRecord): TerminalWindowRecord => ({
  terminalId: window.terminalId,
  scopeId: window.scopeId,
  slot: window.slot,
  kind: window.kind,
  cwd: window.cwd,
  title: window.title,
  ...(window.processName ? { processName: window.processName } : {}),
  ...(window.portalId ? { portalId: window.portalId } : {}),
  ...(window.rootId ? { rootId: window.rootId } : {}),
  ...(window.projectId ? { projectId: window.projectId } : {}),
  ...(window.workspaceId ? { workspaceId: window.workspaceId } : {}),
});

const logTerminalDebug = (
  env: Record<string, string | undefined>,
  event: string,
  details: Record<string, unknown> = {},
) => {
  if (!terminalDebugEnabled(env)) return;
  console.log(`[portal:terminal] ${JSON.stringify({ event, ...details })}`);
};

const tmuxCommandQuote = (value: string) =>
  /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;

const normalizeCapturedTerminalReplay = (data: string) => data.replace(/\r?\n/g, '\r\n');

const terminalCursorPositionSequence = (cursor: { x: number; y: number } | undefined) => {
  if (!cursor) return '';
  if (!Number.isInteger(cursor.x) || !Number.isInteger(cursor.y) || cursor.x < 0 || cursor.y < 0) return '';
  return `\x1b[${cursor.y + 1};${cursor.x + 1}H`;
};

export const encodeTerminalInputHex = (data: string) =>
  [...textEncoder.encode(data)].map((byte) => byte.toString(16).padStart(2, '0'));

export const decodeTmuxControlOutputValue = (value: string) => {
  const bytes: number[] = [];
  for (let index = 0; index < value.length;) {
    const char = value[index];
    if (char !== '\\') {
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) break;
      bytes.push(...textEncoder.encode(String.fromCodePoint(codePoint)));
      index += codePoint > 0xffff ? 2 : 1;
      continue;
    }

    const octal = value.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }

    const escaped = value[index + 1];
    if (escaped === undefined) {
      bytes.push(...textEncoder.encode('\\'));
      index += 1;
      continue;
    }
    bytes.push(...textEncoder.encode(escaped));
    index += 2;
  }
  return textDecoder.decode(new Uint8Array(bytes));
};

export type TmuxControlNotification =
  | { type: 'output'; paneId: string; data: string }
  | { type: 'window-close'; windowId: string }
  | { type: 'exit'; reason?: string }
  | { type: 'other' };

export const parseTmuxControlNotification = (line: string): TmuxControlNotification => {
  if (line.startsWith('%output ')) {
    const match = /^%output\s+(\S+)\s?(.*)$/.exec(line);
    return match
      ? { type: 'output', paneId: match[1], data: decodeTmuxControlOutputValue(match[2] ?? '') }
      : { type: 'other' };
  }

  if (line.startsWith('%extended-output ')) {
    const match = /^%extended-output\s+(\S+)\s+.*?\s:\s?(.*)$/.exec(line);
    return match
      ? { type: 'output', paneId: match[1], data: decodeTmuxControlOutputValue(match[2] ?? '') }
      : { type: 'other' };
  }

  if (line.startsWith('%window-close ') || line.startsWith('%unlinked-window-close ')) {
    const [, windowId = ''] = line.split(/\s+/, 2);
    return windowId ? { type: 'window-close', windowId } : { type: 'other' };
  }

  if (line.startsWith('%exit')) {
    const reason = line.slice('%exit'.length).trim() || undefined;
    return { type: 'exit', reason };
  }

  return { type: 'other' };
};

class TmuxControlModeClient implements PortalTmuxControlClient {
  private process?: Deno.ChildProcess;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private commandQueue = Promise.resolve();
  private pendingCommand?: { resolve: () => void; reject: (error: Error) => void };
  private attachReady?: { resolve: () => void };
  private commandBlockDepth = 0;
  private closing = false;

  constructor(private readonly options: TmuxControlClientFactoryOptions) {}

  async start() {
    if (this.process) return;
    try {
      this.process = new Deno.Command('tmux', {
        args: this.options.args,
        env: this.options.env,
        clearEnv: true,
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
      }).spawn();
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) throw new Error(tmuxRequiredMessage);
      throw error;
    }
    this.writer = this.process.stdin.getWriter();
    const attachReady = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.attachReady = undefined;
        resolve();
      }, 250);
      this.attachReady = {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
      };
    });
    void this.readStdout(this.process.stdout);
    void this.readStderr(this.process.stderr);
    void this.process.status.then((status) => {
      const reason = status.success ? undefined : `tmux control client exited with code ${status.code}`;
      this.finishAttachReady();
      if (!this.closing) this.options.handlers.onExit(reason);
    }).catch((error) => {
      this.finishAttachReady();
      if (!this.closing) this.options.handlers.onError(error instanceof Error ? error : new Error(String(error)));
    });
    await attachReady;
  }

  async input(paneId: string, data: string) {
    const hex = encodeTerminalInputHex(data);
    for (let index = 0; index < hex.length; index += 256) {
      await this.sendCommand(['send-keys', '-H', '-t', paneId, ...hex.slice(index, index + 256)]);
    }
  }

  async resize(windowId: string, cols: number, rows: number) {
    await this.sendCommand(['refresh-client', '-C', `${windowId}:${cols}x${rows}`]);
  }

  close() {
    if (this.closing) return;
    this.closing = true;
    this.finishPendingCommand(new Error('tmux control client closed.'));
    const writer = this.writer;
    if (writer) {
      void writer.write(textEncoder.encode('detach-client\n')).catch(() => undefined).finally(() => {
        void writer.close().catch(() => undefined);
      });
    }
    setTimeout(() => {
      try {
        this.process?.kill('SIGTERM');
      } catch {
        // Process may have already exited after detach-client.
      }
    }, 500);
  }

  private async sendCommand(args: string[]) {
    if (!args.length || this.closing) return;
    const commandPromise = this.commandQueue.catch(() => undefined).then(() => this.writeCommandAndWait(args));
    this.commandQueue = commandPromise.catch(() => undefined);
    await commandPromise;
  }

  private async writeCommandAndWait(args: string[]) {
    const writer = this.writer;
    if (!writer) throw new Error('tmux control client is not running.');
    const command = `${args.map(tmuxCommandQuote).join(' ')}\n`;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingCommand === pending) this.pendingCommand = undefined;
        reject(new Error(`Timed out waiting for tmux command: ${args[0] ?? 'unknown'}`));
      }, 5_000);
      const pending = {
        resolve: () => {
          clearTimeout(timeout);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
      this.pendingCommand = pending;
      writer.write(textEncoder.encode(command)).catch((error) => {
        if (this.pendingCommand === pending) this.pendingCommand = undefined;
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async readStdout(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        buffered = this.handleBufferedOutput(buffered);
      }
      buffered += decoder.decode();
      this.handleBufferedOutput(`${buffered}\n`);
    } catch (error) {
      if (!this.closing) this.options.handlers.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
      }
      buffered += decoder.decode();
      if (buffered.trim()) this.options.debug('tmux.control.stderr', { stderr: buffered.trim() });
    } catch {
      // Stderr diagnostics are best-effort only.
    }
  }

  private handleBufferedOutput(buffered: string) {
    const lines = buffered.split(/\r?\n/);
    const trailing = lines.pop() ?? '';
    for (const line of lines) this.handleLine(line);
    return trailing;
  }

  private handleLine(line: string) {
    if (!line) return;
    if (line.startsWith('%begin ')) {
      this.commandBlockDepth += 1;
      return;
    }
    if (line.startsWith('%end ')) {
      this.commandBlockDepth = Math.max(0, this.commandBlockDepth - 1);
      this.finishPendingCommand();
      return;
    }
    if (line.startsWith('%error ')) {
      this.commandBlockDepth = Math.max(0, this.commandBlockDepth - 1);
      this.finishPendingCommand(new Error(line.slice('%error'.length).trim() || 'tmux command failed.'));
      return;
    }
    if (this.commandBlockDepth > 0) return;

    this.finishAttachReady();
    const notification = parseTmuxControlNotification(line);
    if (notification.type === 'output') {
      this.options.handlers.onOutput(notification.paneId, notification.data);
      return;
    }
    if (notification.type === 'window-close') {
      this.options.handlers.onWindowClose(notification.windowId);
      return;
    }
    if (notification.type === 'exit') {
      this.options.handlers.onExit(notification.reason);
    }
  }

  private finishPendingCommand(error?: Error) {
    const pending = this.pendingCommand;
    if (!pending) return;
    this.pendingCommand = undefined;
    if (error) {
      pending.reject(error);
      return;
    }
    pending.resolve();
  }

  private finishAttachReady() {
    const attachReady = this.attachReady;
    if (!attachReady) return;
    this.attachReady = undefined;
    attachReady.resolve();
  }
}

export class TmuxTerminalController implements PortalTmuxController {
  private readonly socketPath: string;
  private readonly configPath: string;
  private readonly sessionName: string;
  private readonly env: Record<string, string | undefined>;
  private readonly runner?: PortalTmuxRunner;
  private readonly controlClientFactory: (options: TmuxControlClientFactoryOptions) => PortalTmuxControlClient;
  private ensured = false;
  private configWritten = false;

  constructor(options: {
    env?: Record<string, string | undefined>;
    portalHome?: string;
    socketPath?: string;
    configPath?: string;
    sessionName?: string;
    runner?: PortalTmuxRunner;
    controlClientFactory?: (options: TmuxControlClientFactoryOptions) => PortalTmuxControlClient;
  } = {}) {
    const portalHome = options.portalHome ?? resolvePortalHome();
    this.socketPath = options.socketPath ?? `${portalHome}/tmux/_weave.sock`;
    this.configPath = options.configPath ?? `${portalHome}/tmux/tmux.conf`;
    this.sessionName = options.sessionName ?? '_weave';
    this.env = options.env ?? Deno.env.toObject();
    this.runner = options.runner;
    this.controlClientFactory = options.controlClientFactory ??
      ((controlOptions) => new TmuxControlModeClient(controlOptions));
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
        left.scopeId.localeCompare(right.scopeId) ||
        left.slot - right.slot ||
        left.terminalId.localeCompare(right.terminalId)
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
      if (duplicate) return duplicate;

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
      if (details) return details;
    }

    throw new Error('Could not allocate a deterministic tmux window slot.');
  }

  async ensureWindow(
    target: ResolvedTerminalTarget,
    input: { terminalId: string; env: Record<string, string>; shell: { file: string; args: string[] } },
  ) {
    await this.ensureSession(target.cwd);
    const existing = await this.findWindowByTerminalId(input.terminalId);
    if (existing) return existing;
    const parsed = parseDeterministicTerminalId(input.terminalId);
    const slot = parsed && targetScopeIds(target).includes(parsed.scopeId) ? parsed.slot : 1;
    return await this.createWindow(target, { slot, env: input.env, shell: input.shell });
  }

  async findWindow(terminalId: string) {
    await this.ensureSession(Deno.env.get('HOME') ?? Deno.cwd());
    return await this.findWindowByTerminalId(terminalId);
  }

  async openControlClient(handlers: PortalTmuxControlClientHandlers) {
    const env = getTerminalProcessEnv(this.env);
    await this.ensureSession(Deno.env.get('HOME') ?? Deno.cwd());
    const client = this.controlClientFactory({
      args: [...this.tmuxBaseArgs(), '-C', 'attach-session', '-t', this.sessionName],
      env,
      handlers,
      debug: (event, details) => this.debug(event, details),
    });
    await client.start();
    return client;
  }

  async killWindow(terminalId: string) {
    const window = await this.findWindowByTerminalId(terminalId);
    if (!window) return;
    await this.run(['kill-window', '-t', window.windowId], { cwd: window.cwd, env: getTerminalProcessEnv(this.env) }, [
      0,
      1,
    ]);
  }

  async captureWindow(terminalId: string) {
    const window = await this.findWindowByTerminalId(terminalId);
    if (!window) return '';
    const screenState = await this.readPaneScreenState(window).catch((): TmuxPaneScreenState => ({
      alternateOn: false,
    }));
    const captureArgs = ['capture-pane', '-p', '-e', '-J'];
    if (screenState.alternateOn) {
      captureArgs.push('-a');
    } else {
      captureArgs.push('-S', '0');
    }
    captureArgs.push('-t', window.paneId);

    const result = await this.run(captureArgs, { cwd: window.cwd, env: getTerminalProcessEnv(this.env) }, [0, 1]);
    return `${result.stdout}${terminalCursorPositionSequence(screenState.cursor)}`;
  }

  private async readPaneScreenState(window: TmuxWindowDetails): Promise<TmuxPaneScreenState> {
    const result = await this.run(
      [
        'display-message',
        '-p',
        '-t',
        window.paneId,
        '#{alternate_on}\t#{cursor_x}\t#{cursor_y}',
      ],
      { cwd: window.cwd, env: getTerminalProcessEnv(this.env) },
      [0, 1],
    );
    const [alternateText = '', xText = '', yText = ''] = result.stdout.trim().split('\t');
    const x = Number(xText);
    const y = Number(yText);
    const cursor = Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 ? { x, y } : undefined;
    return { alternateOn: alternateText === '1', cursor };
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

  private async listAllWindowDetails(options: { suppressDebug?: boolean } = {}) {
    const result = await this.run(
      [
        'list-windows',
        '-t',
        this.sessionName,
        '-F',
        [
          '#{window_index}',
          '#{window_id}',
          '#{pane_id}',
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
    if (result.code !== 0) {
      if (!options.suppressDebug) {
        this.debug('tmux.windows.list', { code: result.code, stderr: result.stderr, count: 0, windows: [] });
      }
      return [];
    }

    const windows = result.stdout.split('\n').map((line): TmuxWindowDetails | undefined => {
      const columns = line.split('\t');
      const hasTmuxIds = columns.length >= 13;
      const [
        index = '',
        windowId = '',
        paneId = '',
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
      ] = hasTmuxIds ? columns : [
        columns[0],
        columns[0] ? `@${columns[0]}` : '',
        columns[0] ? `%${columns[0]}` : '',
        ...columns.slice(1),
      ];
      const parsed = parseDeterministicTerminalId(terminalId);
      const effectiveScopeId = scopeId || parsed?.scopeId || '';
      const scope = effectiveScopeId ? parseTerminalScope(effectiveScopeId) : undefined;
      const metadataSlot = Number(slotText);
      const slot = Number.isInteger(metadataSlot) && metadataSlot > 0 ? metadataSlot : parsed?.slot;
      if (
        !terminalId ||
        !effectiveScopeId ||
        !scope ||
        typeof slot !== 'number' ||
        !Number.isInteger(slot) ||
        slot < 1 ||
        parsed?.scopeId !== effectiveScopeId ||
        !windowId ||
        !paneId
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
        windowId,
        paneId,
        target: windowId || `${this.sessionName}:${index}`,
      };
    }).filter((window): window is TmuxWindowDetails => Boolean(window));
    const sorted = this.sortAndDedupeWindows(windows);
    if (!options.suppressDebug) {
      this.debug('tmux.windows.list', {
        count: sorted.length,
        windows: sorted.map(terminalWindowDiagnosticRecord),
      });
    }
    return sorted;
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
    return toTerminalWindowRecord(window);
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

  private debug(event: string, details: Record<string, unknown> = {}) {
    logTerminalDebug(this.env, event, details);
  }

  private async debugDurableWindowSnapshot(event: string, details: Record<string, unknown> = {}) {
    if (!terminalDebugEnabled(this.env)) return;
    try {
      const windows = await this.listAllWindowDetails({ suppressDebug: true });
      this.debug(event, {
        ...details,
        count: windows.length,
        windows: windows.map(terminalWindowDiagnosticRecord),
      });
    } catch (error) {
      this.debug(event, {
        ...details,
        error: toErrorMessage(error),
      });
    }
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
  private readonly tmux: PortalTmuxController;
  private readonly replayLimitBytes: number;
  private readonly outputBatchMs: number;
  private readonly replayCaptureSettleMs: number;
  private readonly env: Record<string, string | undefined>;
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly terminalIdsByPaneId = new Map<string, string>();
  private readonly terminalIdsByWindowId = new Map<string, string>();
  private readonly clientSessions = new Map<string, Set<string>>();
  private controlClient?: PortalTmuxControlClient;
  private closingControlClient = false;

  constructor(options: PortalTerminalHostOptions) {
    this.config = options.config;
    this.env = options.env ?? Deno.env.toObject();
    this.tmux = options.tmux ?? new TmuxTerminalController({ env: this.env });
    this.replayLimitBytes = options.replayLimitBytes ?? defaultReplayLimitBytes;
    this.outputBatchMs = options.outputBatchMs ?? defaultOutputBatchMs;
    this.replayCaptureSettleMs = options.replayCaptureSettleMs ?? defaultReplayCaptureSettleMs;
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
        await this.input(parseTerminalId(message.terminalId), parseTerminalInputData(message.data));
        return;
      }

      if (message.type === 'resize') {
        const size = parseTerminalResize(message.cols, message.rows);
        await this.resize(parseTerminalId(message.terminalId), size.cols, size.rows);
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

  getPerfSnapshot() {
    const sessions = [...this.sessions.values()];
    return {
      sessionCount: sessions.length,
      liveSessionCount: sessions.filter(session => !session.exited).length,
      exitedSessionCount: sessions.filter(session => session.exited).length,
      clientCount: this.clientSessions.size,
      subscriberCount: sessions.reduce((count, session) => count + session.subscribers.size, 0),
      paneMapCount: this.terminalIdsByPaneId.size,
      windowMapCount: this.terminalIdsByWindowId.size,
      controlClientActive: Boolean(this.controlClient),
      controlClientClosing: this.closingControlClient,
      replayBytes: sessions.reduce((count, session) => count + byteLength(session.replay), 0),
      pendingOutputBytes: sessions.reduce((count, session) => count + byteLength(session.pendingOutput), 0),
      pendingOutputSessionCount: sessions.filter(session => Boolean(session.pendingOutput)).length,
      outputTimerCount: sessions.filter(session => Boolean(session.outputTimer)).length,
    };
  }

  dispose() {
    for (const session of this.sessions.values()) {
      this.disposeSession(session);
    }
    this.sessions.clear();
    this.terminalIdsByPaneId.clear();
    this.terminalIdsByWindowId.clear();
    this.clientSessions.clear();
    this.closeControlClient();
  }

  private async list(input: TerminalTargetInput & { requestId?: string }, send: (event: TerminalHostEvent) => void) {
    const target = await this.resolveTarget(parseTerminalTargetInput(input));
    const windows = await this.tmux.listWindows(target);
    this.debug('host.windows.list', {
      requestId: input.requestId,
      kind: target.kind,
      scopeId: target.scopeId,
      count: windows.length,
      windows: windows.map(terminalWindowDiagnosticRecord),
    });
    send({ type: 'windows', requestId: input.requestId, windows });
  }

  private async snapshot(input: { requestId?: string }, send: (event: TerminalHostEvent) => void) {
    const windows = await this.tmux.listAllWindows();
    this.debug('host.windows.snapshot', {
      requestId: input.requestId,
      count: windows.length,
      windows: windows.map(terminalWindowDiagnosticRecord),
    });
    send({ type: 'windows', requestId: input.requestId, windows });
  }

  private async create(input: TerminalTargetInput & { requestId?: string }, send: (event: TerminalHostEvent) => void) {
    const target = await this.resolveTarget(parseTerminalTargetInput(input));
    const window = await this.tmux.createWindow(target, {
      env: this.getWeaveEnv(target),
      shell: getDefaultShell(this.env),
    });
    this.debug('host.window.created', {
      requestId: input.requestId,
      window: terminalWindowDiagnosticRecord(window),
    });
    const publicWindow = toTerminalWindowRecord(window);
    send({
      type: 'created',
      requestId: input.requestId,
      terminalId: window.terminalId,
      workspaceId: window.workspaceId,
      window: publicWindow,
    });
  }

  private async start(input: TerminalStartInput, clientId: string, send: (event: TerminalHostEvent) => void) {
    const normalizedInput = parseTerminalStartInput(input);
    this.debug('host.start.requested', {
      clientId,
      terminalId: normalizedInput.terminalId,
      kind: normalizedInput.kind,
      workspaceId: normalizedInput.workspaceId,
      projectId: normalizedInput.projectId,
    });

    try {
      const existing = this.sessions.get(normalizedInput.terminalId);
      if (existing && !existing.exited) {
        this.flushOutput(existing);
        this.attach(existing, clientId, send);
        await this.resize(normalizedInput.terminalId, normalizedInput.cols, normalizedInput.rows);
        this.debug('host.start.reused-session', {
          clientId,
          terminalId: existing.terminalId,
          subscribers: existing.subscribers.size,
        });
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
      await this.ensureControlClient();
      await this.controlClient?.resize(window.windowId, normalizedInput.cols, normalizedInput.rows);
      const replay = await this.captureReplay(window) ?? '';
      this.debug('host.start.control-session', {
        clientId,
        window: terminalWindowDiagnosticRecord(window),
      });

      const session: TerminalSession = {
        sessionId: window.terminalId,
        kind: window.kind,
        terminalId: window.terminalId,
        window,
        windowId: window.windowId,
        paneId: window.paneId,
        projectId: window.projectId,
        workspaceId: window.workspaceId,
        cwd: window.cwd,
        cols: normalizedInput.cols,
        rows: normalizedInput.rows,
        replay: replay ?? '',
        pendingOutput: '',
        subscribers: new Map([[clientId, { send }]]),
        disposables: [],
        exited: false,
      };

      this.trackClientSession(clientId, window.terminalId);
      this.sessions.set(window.terminalId, session);
      this.terminalIdsByPaneId.set(window.paneId, window.terminalId);
      this.terminalIdsByWindowId.set(window.windowId, window.terminalId);
      this.sendStarted(session, send);
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

  private async input(terminalId: string, data: string) {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) throw new Error('Terminal session is not running.');
    await this.ensureControlClient();
    await this.controlClient?.input(session.paneId, data);
  }

  private async resize(terminalId: string, cols: number, rows: number) {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return;
    const nextCols = parseDimension(cols, session.cols, 10, 400);
    const nextRows = parseDimension(rows, session.rows, 3, 200);
    if (session.cols === nextCols && session.rows === nextRows) return;

    session.cols = nextCols;
    session.rows = nextRows;
    await this.ensureControlClient();
    await this.controlClient?.resize(session.windowId, nextCols, nextRows);
  }

  private async captureReplay(window: PortalTmuxWindowRecord) {
    if (!this.tmux.captureWindow) return undefined;
    if (this.replayCaptureSettleMs > 0) await delay(this.replayCaptureSettleMs);
    const capturedReplay = await this.tmux.captureWindow(window.terminalId).catch(() => undefined);
    if (capturedReplay === undefined) return undefined;
    return normalizeCapturedTerminalReplay(capturedReplay);
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
    this.debug('host.detach.requested', {
      clientId,
      terminalId,
      hasSession: Boolean(session),
      subscribers: session?.subscribers.size ?? 0,
    });
    session?.subscribers.delete(clientId);
    const terminalIds = this.clientSessions.get(clientId);
    terminalIds?.delete(terminalId);
    if (terminalIds?.size === 0) this.clientSessions.delete(clientId);
    if (session && session.subscribers.size === 0) {
      this.debug('host.detach.unsubscribed-session', {
        clientId,
        terminalId,
      });
    }
  }

  private async resolveTarget(input: NormalizedTerminalTargetInput): Promise<ResolvedTerminalTarget> {
    const cwd = await this.resolveCwd(input);
    await this.assertDirectory(cwd);
    const canonicalPortalId = input.kind === 'general' ? input.portalId ?? this.config.portalId : input.portalId;
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
      PROMPT_EOL_MARK: '',
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
      pid: undefined,
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

  private handleExit(session: TerminalSession, event: { exitCode?: number; signal?: number | string }) {
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
    this.closeControlClientIfIdle();
  }

  private disposeSession(session: TerminalSession) {
    if (session.outputTimer) {
      clearTimeout(session.outputTimer);
      session.outputTimer = undefined;
    }
    this.terminalIdsByPaneId.delete(session.paneId);
    this.terminalIdsByWindowId.delete(session.windowId);
    for (const disposable of session.disposables) disposable.dispose();
    session.disposables = [];
  }

  private debug(event: string, details: Record<string, unknown> = {}) {
    logTerminalDebug(this.env, event, details);
  }

  private async ensureControlClient() {
    if (this.controlClient) return;
    this.closingControlClient = false;
    this.controlClient = await this.tmux.openControlClient({
      onOutput: (paneId, data) => this.handleControlOutput(paneId, data),
      onWindowClose: (windowId) => this.handleControlWindowClose(windowId),
      onExit: (reason) => this.handleControlExit(reason),
      onError: (error) => this.handleControlError(error),
    });
  }

  private handleControlOutput(paneId: string, data: string) {
    if (!data) return;
    const terminalId = this.terminalIdsByPaneId.get(paneId);
    if (!terminalId) return;
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return;
    this.queueOutput(session, data);
  }

  private handleControlWindowClose(windowId: string) {
    const terminalId = this.terminalIdsByWindowId.get(windowId);
    if (!terminalId) return;
    const session = this.sessions.get(terminalId);
    if (session) {
      this.handleExit(session, {});
      return;
    }
    this.terminalIdsByWindowId.delete(windowId);
  }

  private handleControlExit(reason?: string) {
    this.controlClient = undefined;
    if (this.closingControlClient) return;
    const sessions = [...this.sessions.values()].filter((session) => !session.exited);
    for (const session of sessions) {
      this.flushOutput(session);
      this.broadcast(session, {
        type: 'error',
        terminalId: session.terminalId,
        workspaceId: session.workspaceId,
        error: reason || 'tmux control client exited.',
      });
      this.disposeSession(session);
      this.sessions.delete(session.terminalId);
    }
  }

  private handleControlError(error: Error) {
    this.debug('host.control.error', { error: error.message });
    this.handleControlExit(error.message);
  }

  private closeControlClientIfIdle() {
    if (this.sessions.size > 0) return;
    this.closeControlClient();
  }

  private closeControlClient() {
    const controlClient = this.controlClient;
    if (!controlClient) return;
    this.closingControlClient = true;
    this.controlClient = undefined;
    controlClient.close();
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
  lsp?: PortalLspControlHost;
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
        void Promise.resolve(input.onShutdown?.()).finally(async () => {
          input.host.dispose();
          await input.lsp?.dispose();
          await server.shutdown().catch(() => undefined);
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

    if (url.pathname === '/lsp/session') {
      if (!input.lsp) return new Response('not found', { status: 404 });
      if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
      try {
        const body = await request.json().catch(() => ({})) as Parameters<PortalLspControlHost['createSession']>[0];
        return Response.json(await input.lsp.createSession(body));
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

    if (url.pathname === '/lsp') {
      if (!input.lsp) return new Response('not found', { status: 404 });
      const { socket, response } = Deno.upgradeWebSocket(request);
      const socketClientId = `local-lsp:${crypto.randomUUID()}`;
      const socketClientIds = new Set([socketClientId]);

      socket.onmessage = (event) => {
        const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
        const clientId = typeof parsed.clientId === 'string' ? parsed.clientId : socketClientId;
        socketClientIds.add(clientId);
        const message = parsed.message && typeof parsed.message === 'object'
          ? parsed.message as PortalLspClientMessage
          : parsed as PortalLspClientMessage;
        void input.lsp?.handleClientMessage(clientId, message, (lspEvent) => {
          socket.send(JSON.stringify({ type: 'lsp.event', clientId, event: lspEvent }));
        }).catch((error) => {
          socket.send(JSON.stringify({
            type: 'lsp.event',
            clientId,
            event: { type: 'error', error: error instanceof Error ? error.message : String(error) },
          }));
        });
      };

      socket.onclose = () => {
        for (const clientId of socketClientIds) input.lsp?.detachClient(clientId);
      };
      socket.onerror = () => {
        for (const clientId of socketClientIds) input.lsp?.detachClient(clientId);
      };

      return response;
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
