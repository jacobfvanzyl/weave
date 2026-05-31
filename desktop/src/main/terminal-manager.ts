import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import * as nodePty from 'node-pty';
import type { TerminalHostEvent, TerminalSessionKind, TerminalStartInput, TerminalStartResult } from '../shared/terminal';

type Disposable = {
  dispose: () => void;
};

type PtyExitEvent = {
  exitCode: number;
  signal?: number | string;
};

export type TerminalPty = {
  pid?: number;
  process?: string;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  onData: (listener: (data: string) => void) => Disposable;
  onExit: (listener: (event: PtyExitEvent) => void) => Disposable;
};

export type TerminalPtySpawnOptions = {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
};

export type TerminalPtySpawner = (
  file: string,
  args: string[],
  options: TerminalPtySpawnOptions,
) => TerminalPty;

export type TerminalWebContents = {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, event: TerminalHostEvent) => void;
};

type TerminalTarget = {
  cwd: string;
};

type NormalizedTerminalStartInput = TerminalStartInput & {
  cols: number;
  rows: number;
};

type TerminalSession = {
  sessionId: string;
  kind: TerminalSessionKind;
  terminalId: string;
  planeId?: string;
  demiplaneId?: string;
  cwd: string;
  pty: TerminalPty;
  cols: number;
  rows: number;
  replay: string;
  pendingOutput: string;
  outputTimer?: ReturnType<typeof setTimeout>;
  subscribers: Map<number, TerminalWebContents>;
  disposables: Disposable[];
  exited: boolean;
};

type TerminalManagerOptions = {
  resolveDemiplane: (input: NormalizedTerminalStartInput) => Promise<TerminalTarget>;
  resolveGeneralTerminal?: (input: NormalizedTerminalStartInput) => Promise<TerminalTarget>;
  spawner?: TerminalPtySpawner;
  replayLimitBytes?: number;
  outputBatchMs?: number;
  env?: NodeJS.ProcessEnv;
};

const terminalEventChannel = 'terminal:event';
const defaultReplayLimitBytes = 200 * 1024;
const defaultOutputBatchMs = 16;

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const parseIdentifier = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
};

const parseDimension = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
};

export const parseTerminalStartInput = (input: unknown): NormalizedTerminalStartInput => {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const isGeneralTerminalRequest = record.kind === 'general'
    || (
      record.kind !== 'demiplane'
      && record.planeId === undefined
      && record.demiplaneId === undefined
      && (record.terminalId === 'weave-general-terminal' || typeof record.cwd === 'string')
    );
  const kind: TerminalSessionKind = isGeneralTerminalRequest ? 'general' : 'demiplane';
  const parsedDimensions = {
    cols: parseDimension(record.cols, 80, 10, 400),
    rows: parseDimension(record.rows, 24, 3, 200),
  };

  if (kind === 'general') {
    return {
      kind,
      terminalId: parseIdentifier(record.terminalId ?? 'weave-general-terminal', 'terminalId'),
      cwd: typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd.trim() : undefined,
      ...parsedDimensions,
    };
  }

  const demiplaneId = parseIdentifier(record.demiplaneId, 'demiplaneId');
  return {
    kind,
    terminalId: parseIdentifier(record.terminalId ?? demiplaneId, 'terminalId'),
    planeId: parseIdentifier(record.planeId, 'planeId'),
    demiplaneId,
    ...parsedDimensions,
  };
};

export const parseTerminalId = (value: unknown) => parseIdentifier(value, 'terminalId');
export const parseTerminalDemiplaneId = parseTerminalId;

export const parseTerminalInputData = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('terminal input data must be a string.');
  return value;
};

export const parseTerminalResize = (cols: unknown, rows: unknown) => ({
  cols: parseDimension(cols, 80, 10, 400),
  rows: parseDimension(rows, 24, 3, 200),
});

const defaultSpawner: TerminalPtySpawner = (file, args, options) =>
  nodePty.spawn(file, args, options) as TerminalPty;

const getDefaultShell = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => {
  if (platform === 'win32') return { file: env.WEAVE_TERMINAL_SHELL || 'powershell.exe', args: ['-NoLogo'] };
  return {
    file: env.WEAVE_TERMINAL_SHELL || env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash'),
    args: [] as string[],
  };
};

const getProcessEnv = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));

export class TerminalManager {
  private readonly resolveDemiplane: (input: NormalizedTerminalStartInput) => Promise<TerminalTarget>;
  private readonly resolveGeneralTerminal: (input: NormalizedTerminalStartInput) => Promise<TerminalTarget>;
  private readonly spawner: TerminalPtySpawner;
  private readonly replayLimitBytes: number;
  private readonly outputBatchMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(options: TerminalManagerOptions) {
    this.resolveDemiplane = options.resolveDemiplane;
    this.resolveGeneralTerminal = options.resolveGeneralTerminal ?? (async input => ({
      cwd: input.cwd || os.homedir() || process.cwd(),
    }));
    this.spawner = options.spawner ?? defaultSpawner;
    this.replayLimitBytes = options.replayLimitBytes ?? defaultReplayLimitBytes;
    this.outputBatchMs = options.outputBatchMs ?? defaultOutputBatchMs;
    this.env = options.env ?? process.env;
  }

  async start(input: TerminalStartInput, webContents: TerminalWebContents): Promise<TerminalStartResult> {
    const normalizedInput = parseTerminalStartInput(input);

    try {
      const existing = this.sessions.get(normalizedInput.terminalId);
      if (existing && !existing.exited) {
        this.attach(existing, webContents);
        this.resize(normalizedInput.terminalId, normalizedInput.cols, normalizedInput.rows);
        this.sendStarted(existing, webContents);
        this.sendReplay(existing, webContents);
        return { sessionId: existing.sessionId, cwd: existing.cwd };
      }

      const target = normalizedInput.kind === 'general'
        ? await this.resolveGeneralTerminal(normalizedInput)
        : await this.resolveDemiplane(normalizedInput);
      await this.assertDirectory(target.cwd);

      const shell = getDefaultShell(os.platform(), this.env);
      const weaveEnv: Record<string, string> = {
        WEAVE_WORKSPACE: target.cwd,
      };
      if (normalizedInput.kind === 'demiplane') {
        if (normalizedInput.planeId) weaveEnv.WEAVE_PLANE_ID = normalizedInput.planeId;
        if (normalizedInput.demiplaneId) weaveEnv.WEAVE_DEMIPLANE_ID = normalizedInput.demiplaneId;
      }
      const pty = this.spawner(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: normalizedInput.cols,
        rows: normalizedInput.rows,
        cwd: target.cwd,
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
        sessionId: randomUUID(),
        kind: normalizedInput.kind,
        terminalId: normalizedInput.terminalId,
        planeId: normalizedInput.planeId,
        demiplaneId: normalizedInput.demiplaneId,
        cwd: target.cwd,
        pty,
        cols: normalizedInput.cols,
        rows: normalizedInput.rows,
        replay: '',
        pendingOutput: '',
        subscribers: new Map([[webContents.id, webContents]]),
        disposables: [],
        exited: false,
      };

      session.disposables.push(
        pty.onData(data => this.queueOutput(session, data)),
        pty.onExit(event => this.handleExit(session, event)),
      );
      this.sessions.set(normalizedInput.terminalId, session);
      this.sendStarted(session, webContents);
      return { sessionId: session.sessionId, cwd: session.cwd };
    } catch (error) {
      this.sendEvent(webContents, {
        type: 'error',
        terminalId: normalizedInput.terminalId,
        demiplaneId: normalizedInput.demiplaneId,
        error: toErrorMessage(error),
      });
      throw error;
    }
  }

  input(terminalId: string, data: string) {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) throw new Error('Terminal session is not running.');
    session.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number) {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return;
    const nextCols = parseDimension(cols, session.cols, 10, 400);
    const nextRows = parseDimension(rows, session.rows, 3, 200);
    if (session.cols === nextCols && session.rows === nextRows) return;

    session.cols = nextCols;
    session.rows = nextRows;
    session.pty.resize(nextCols, nextRows);
  }

  close(terminalId: string) {
    const session = this.sessions.get(terminalId);
    if (!session || session.exited) return;
    session.pty.kill();
  }

  detach(terminalId: string, webContents: TerminalWebContents) {
    this.sessions.get(terminalId)?.subscribers.delete(webContents.id);
  }

  detachWebContents(webContentsId: number) {
    for (const session of this.sessions.values()) {
      session.subscribers.delete(webContentsId);
    }
  }

  dispose() {
    for (const session of this.sessions.values()) {
      this.disposeSession(session);
      if (!session.exited) session.pty.kill();
    }
    this.sessions.clear();
  }

  private async assertDirectory(cwd: string) {
    const details = await stat(cwd);
    if (!details.isDirectory()) throw new Error('Terminal path is not a directory.');
  }

  private attach(session: TerminalSession, webContents: TerminalWebContents) {
    session.subscribers.set(webContents.id, webContents);
  }

  private sendStarted(session: TerminalSession, webContents: TerminalWebContents) {
    this.sendEvent(webContents, {
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

  private sendReplay(session: TerminalSession, webContents: TerminalWebContents) {
    if (!session.replay) return;
    this.sendEvent(webContents, {
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
    if (Buffer.byteLength(session.replay, 'utf8') <= this.replayLimitBytes) return;

    session.replay = session.replay.slice(Math.max(0, session.replay.length - this.replayLimitBytes));
    while (Buffer.byteLength(session.replay, 'utf8') > this.replayLimitBytes) {
      session.replay = session.replay.slice(Math.ceil(session.replay.length * 0.1));
    }
  }

  private handleExit(session: TerminalSession, event: PtyExitEvent) {
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
    for (const [id, webContents] of session.subscribers) {
      if (webContents.isDestroyed()) {
        session.subscribers.delete(id);
        continue;
      }

      this.sendEvent(webContents, event);
    }
  }

  private sendEvent(webContents: TerminalWebContents, event: TerminalHostEvent) {
    if (webContents.isDestroyed()) return;
    webContents.send(terminalEventChannel, event);
  }
}
