import { TERMINAL_CODEC } from '@weave/product-protocol';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type {
  TerminalAttachment,
  TerminalErrorCode,
  TerminalNotification,
  TerminalRpcMethod,
  TerminalRpcParams,
  TerminalRpcResult,
  TerminalSnapshot,
  TerminalSummary,
} from '@weave/product-protocol';

export type TerminalExecutionContext = { executionContextId: string; path: string };

export type TerminalExecutionRecord = TerminalSummary;

export type TerminalExecutionEvent =
  | { terminalId: string; backendSequence: number; type: 'unavailable' }
  | { terminalId: string; backendSequence: number; type: 'directory'; currentDirectory: string }
  | { terminalId: string; backendSequence: number; type: 'output'; data: Uint8Array }
  | { terminalId: string; backendSequence: number; type: 'title'; title: string; processName?: string }
  | { terminalId: string; backendSequence: number; type: 'exit'; exitCode?: number };

export type TerminalExecutionCapture = {
  history?: Uint8Array[];
  data: Uint8Array;
  /** Last backend event known to be represented by `data`. */
  boundary: number;
};

export interface TerminalExecution {
  list(): Promise<TerminalExecutionRecord[]>;
  create(input: {
    terminalId: string;
    executionContextId: string;
    cwd: string;
    cols: number;
    rows: number;
    env: Record<string, string>;
  }): Promise<TerminalExecutionRecord>;
  capture(terminalId: string): Promise<TerminalExecutionCapture>;
  input(terminalId: string, data: Uint8Array): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  close(terminalId: string): Promise<void>;
  stopGracefully?(terminalId: string): Promise<void>;
  subscribe(listener: (event: TerminalExecutionEvent) => void): () => void;
  dispose(): void | Promise<void>;
}

export class PortalTerminalError extends Error {
  readonly data: {
    domain: 'terminal';
    code: TerminalErrorCode;
    executionContextId?: string;
    terminalId?: string;
    retainedFrom?: number;
  };

  constructor(
    code: TerminalErrorCode,
    message: string,
    resource: { executionContextId?: string; terminalId?: string; retainedFrom?: number } = {},
  ) {
    super(message);
    this.name = 'PortalTerminalError';
    this.data = { domain: 'terminal', code, ...resource };
  }
}

type RetainedOutput = { sequence: number; data: Uint8Array; bytes: number };

type TerminalRuntime = {
  terminalId: string;
  executionContextId: string;
  generation: string;
  sequence: number;
  retainedFrom: number;
  retainedBytes: number;
  retained: RetainedOutput[];
  pendingBackendEvents: TerminalExecutionEvent[];
  resizeAttachmentId?: string;
  attachments: Set<string>;
  queue: Promise<unknown>;
};

type AttachmentState = TerminalAttachment & {
  history?: { token: string; pages: Uint8Array[]; next: number; expires: number };
  size?: { cols: number; rows: number };
  connectionId: string;
  terminalId: string;
  executionContextId: string;
  send: (notification: TerminalNotification) => unknown;
  pending: TerminalNotification[];
  pendingBytes: number;
  flushScheduled: boolean;
  absorbedBackendThrough?: number;
};

type TerminalServiceOptions = {
  backend: TerminalExecution;
  onTerminalExit?: (terminalId: string) => void;
  resolveWorkspace: (executionContextId: string) => TerminalExecutionContext | undefined;
  assertWorkspaceAvailable?: (executionContextId: string) => Promise<unknown>;
  retentionLimitBytes?: number;
  attachmentQueueLimitBytes?: number;
  env?: Record<string, string | undefined>;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_RETENTION_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_ATTACHMENT_QUEUE_LIMIT_BYTES = 256 * 1024;

const byteLength = (value: Uint8Array) => value.byteLength;

const cleanEnvironment = (source: Record<string, string | undefined>) => {
  const blocked = new Set([
    'NO_COLOR',
    'TMUX',
    'TMUX_PANE',
    'WEAVE_TERMINAL_ID',
    'WEAVE_WORKSPACE_ID',
    'WEAVE_WORKSPACE',
    'WEAVE_EXECUTION_CONTEXT_ID',
    'WEAVE_EXECUTION_DIRECTORY',
  ]);
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && !blocked.has(entry[0])
    ),
  );
};

const publicRecord = (record: TerminalExecutionRecord): TerminalSummary => ({
  terminalId: record.terminalId,
  executionContextId: record.executionContextId,
  title: record.title,
  initialDirectory: record.initialDirectory,
  currentDirectory: record.currentDirectory,
  status: record.status,
  cols: record.cols,
  rows: record.rows,
  ...(record.processName ? { processName: record.processName } : {}),
  ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
});

export class TerminalAccess {
  readonly #onTerminalExit: TerminalServiceOptions['onTerminalExit'];
  readonly #backend: TerminalExecution;
  readonly #resolveWorkspace: TerminalServiceOptions['resolveWorkspace'];
  readonly #assertWorkspaceAvailable: TerminalServiceOptions['assertWorkspaceAvailable'];
  readonly #retentionLimitBytes: number;
  readonly #attachmentQueueLimitBytes: number;
  readonly #env: Record<string, string | undefined>;
  readonly #generation = crypto.randomUUID();
  readonly #runtimes = new Map<string, TerminalRuntime>();
  readonly #attachments = new Map<string, AttachmentState>();
  readonly #sessions = new Set<PortalTerminalSession>();
  readonly #unsubscribe: () => void;
  #closed = false;

  constructor(options: TerminalServiceOptions) {
    this.#backend = options.backend;
    this.#onTerminalExit = options.onTerminalExit;
    this.#resolveWorkspace = options.resolveWorkspace;
    this.#assertWorkspaceAvailable = options.assertWorkspaceAvailable;
    this.#retentionLimitBytes = options.retentionLimitBytes ?? DEFAULT_RETENTION_LIMIT_BYTES;
    this.#attachmentQueueLimitBytes = options.attachmentQueueLimitBytes ?? DEFAULT_ATTACHMENT_QUEUE_LIMIT_BYTES;
    this.#env = options.env ?? { ...process.env };
    this.#unsubscribe = this.#backend.subscribe((event) => this.#acceptBackendEvent(event));
  }

  openSession(
    connectionId: string,
    send: (notification: TerminalNotification) => unknown,
  ) {
    if (this.#closed) throw new Error('Terminal service is closed.');
    const session = new PortalTerminalSession(this, connectionId, send);
    this.#sessions.add(session);
    return session;
  }

  // Called under the workspace composition lock. A retry after a failed save
  // reuses any shell already created for this revision/pane rather than leaking one.
  async ensurePaneTerminal(executionContextId: string, revision: number, paneId: string, launchDirectory?: string) {
    const terminalId = `pane-${createHash('sha256').update(JSON.stringify([executionContextId, revision, paneId])).digest('hex')}`;
    const existing = (await this.#backend.list()).find((record) => record.executionContextId === executionContextId && record.terminalId === terminalId);
    return existing ? publicRecord(existing) : this.#createTerminal(executionContextId, terminalId, DEFAULT_COLS, DEFAULT_ROWS, launchDirectory);
  }

  async #createTerminal(executionContextId: string, terminalId: string = crypto.randomUUID(), cols = DEFAULT_COLS, rows = DEFAULT_ROWS, launchDirectory?: string) {
    if (this.#closed) throw new Error('Terminal service is closed.');
    const workspace = this.#workspace(executionContextId);
    await this.#assertWorkspaceAvailable?.(executionContextId);
    const cwd = launchDirectory ? await realpath(launchDirectory) : workspace.path;
    const within = relative(workspace.path, cwd);
    if (within === '..' || within.startsWith('../') || isAbsolute(within)) throw new Error('Launch directory is outside the execution context.');
    const record = await this.#backend.create({
      terminalId,
      executionContextId: workspace.executionContextId,
      cwd,
      cols,
      rows,
      env: {
        ...cleanEnvironment(this.#env),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ZVM_VI_HIGHLIGHT_BACKGROUND: this.#env.ZVM_VI_HIGHLIGHT_BACKGROUND || '#b4befe',
        ZVM_VI_HIGHLIGHT_FOREGROUND: this.#env.ZVM_VI_HIGHLIGHT_FOREGROUND || '#11111b',
        WEAVE_TERMINAL_ID: terminalId,
        WEAVE_EXECUTION_CONTEXT_ID: workspace.executionContextId,
        WEAVE_EXECUTION_DIRECTORY: cwd,
      },
    });
    this.#runtime(record);
    return publicRecord(record);
  }

  async closePlan(terminalIds: string[]) {
    const records = await this.#backend.list();
    return terminalIds.flatMap((terminalId) => {
      const terminal = records.find((record) => record.terminalId === terminalId && record.status === 'running');
      // No shell prompt/job/input contract exists yet. Unknown activity is
      // dirty; a foreground command name alone cannot prove an idle shell.
      return terminal ? [{ terminalId, title: terminal.title || 'Terminal', dirty: true }] : [];
    });
  }

  async stopWorkspaceTerminals(terminalIds: string[]) {
    await Promise.all(terminalIds.map(async (terminalId) => {
      const record = (await this.#backend.list()).find((record) => record.terminalId === terminalId);
      if (!record) return;
      const runtime = this.#runtime(record);
      await this.#serialized(runtime, async () => {
        if (this.#backend.stopGracefully) await this.#backend.stopGracefully(terminalId);
        else await this.#backend.close(terminalId);
        if ((await this.#backend.list()).some((record) => record.terminalId === terminalId && record.status === 'running')) throw new Error('A terminal did not stop. The workspace has been kept.');
        this.#onTerminalExit?.(terminalId);
        this.#finalizeExit(runtime, {});
        this.#runtimes.delete(terminalId);
      });
    }));
  }

  async knownTerminalIds(executionContextId?: string) {
    return new Set((await this.#backend.list()).filter((terminal) => terminal.status === 'running' && (executionContextId === undefined || terminal.executionContextId === executionContextId)).map((terminal) => terminal.terminalId));
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of [...this.#sessions]) session.close();
    this.#unsubscribe();
    await this.#backend.dispose();
  }

  async request<Method extends TerminalRpcMethod>(
    session: PortalTerminalSession,
    method: Method,
    params: TerminalRpcParams<Method>,
  ): Promise<TerminalRpcResult<Method>> {
    if (this.#closed) throw new Error('Terminal service is closed.');
    const workspace = this.#workspace(params.executionContextId);
    switch (method) {
      case 'terminal.list':
        return {
          terminals: (await this.#backend.list())
            .filter((terminal) => terminal.executionContextId === workspace.executionContextId)
            .map(publicRecord),
        } as TerminalRpcResult<Method>;
      case 'terminal.create': {
        const input = params as TerminalRpcParams<'terminal.create'>;
        return { terminal: await this.#createTerminal(workspace.executionContextId, undefined, input.cols, input.rows) } as TerminalRpcResult<Method>;
      }
      case 'terminal.snapshot': {
        const input = params as TerminalRpcParams<'terminal.snapshot'>;
        const record = await this.#terminal(workspace.executionContextId, input.terminalId);
        return { snapshot: await this.#snapshot(record) } as TerminalRpcResult<Method>;
      }
      case 'terminal.attach': {
        const input = params as TerminalRpcParams<'terminal.attach'>;
        const record = await this.#terminal(workspace.executionContextId, input.terminalId);
        const runtime = this.#runtime(record);
        return await this.#serialized(runtime, async () => {
          session.assertOpen();
          if (input.cursor !== undefined && input.cursor < runtime.retainedFrom - 1) {
            throw new PortalTerminalError(
              'TERMINAL_REPLAY_GAP',
              'Requested Terminal retained output is no longer available; request a fresh snapshot.',
              {
                executionContextId: workspace.executionContextId,
                terminalId: record.terminalId,
                retainedFrom: runtime.retainedFrom,
              },
            );
          }
          const attachment: AttachmentState = {
            attachmentId: crypto.randomUUID(),
            mode: input.mode,
            connectionId: session.connectionId,
            terminalId: record.terminalId,
            executionContextId: workspace.executionContextId,
            send: session.send,
            pending: [],
            pendingBytes: 0,
            flushScheduled: false,
          };
          this.#attachments.set(attachment.attachmentId, attachment);
          runtime.attachments.add(attachment.attachmentId);
          session.addAttachment(attachment.attachmentId);
          try {
            return {
              attachment: {
                attachmentId: attachment.attachmentId,
                mode: attachment.mode,
              },
              snapshot: await this.#captureSnapshot(record, runtime, attachment),
            } as TerminalRpcResult<Method>;
          } catch (cause) {
            this.#removeAttachment(attachment.attachmentId);
            throw cause;
          }
        });
      }
      case 'terminal.history': {
        const input = params as TerminalRpcParams<'terminal.history'>;
        const attachment = this.#attachments.get(input.attachmentId);
        if (!attachment || attachment.connectionId !== session.connectionId || attachment.terminalId !== input.terminalId || attachment.executionContextId !== input.executionContextId) throw new PortalTerminalError('TERMINAL_ATTACHMENT_UNAVAILABLE', 'Terminal history attachment unavailable');
        const history = attachment.history;
        if (!history || history.token !== input.token || history.next !== input.page || history.expires < Date.now()) throw new PortalTerminalError('TERMINAL_REPLAY_GAP', 'Terminal history was superseded or expired; resync');
        const data = history.pages[history.next]; history.pages[history.next++] = new Uint8Array();
        const finished = history.next === history.pages.length;
        if (finished) attachment.history = undefined;
        return { data, finished } as TerminalRpcResult<Method>;
      }
      case 'terminal.input': {
        const input = params as TerminalRpcParams<'terminal.input'>;
        const { attachment, runtime } = await this.#controlledAttachment(session, workspace.executionContextId, input);
        await this.#serialized(runtime, async () => {
          this.#assertAttached(session, attachment);
          if (attachment.mode === 'shared') {
            if (runtime.resizeAttachmentId !== attachment.attachmentId && attachment.size) {
              await this.#resize(runtime, attachment.size.cols, attachment.size.rows);
            }
            runtime.resizeAttachmentId = attachment.attachmentId;
          }
          await this.#backend.input(input.terminalId, input.data);
        });
        return { accepted: true } as TerminalRpcResult<Method>;
      }
      case 'terminal.resize': {
        const input = params as TerminalRpcParams<'terminal.resize'>;
        const { attachment, runtime } = await this.#controlledAttachment(session, workspace.executionContextId, input);
        await this.#serialized(runtime, async () => {
          this.#assertAttached(session, attachment);
          attachment.size = { cols: input.cols, rows: input.rows };
          if (attachment.mode === 'shared') {
            // A passive device records its viewport without resizing the shell.
            // The next input from that device applies its size before its bytes.
            if (runtime.resizeAttachmentId !== attachment.attachmentId) return;
          }
          await this.#resize(runtime, input.cols, input.rows);
        });
        return { accepted: true } as TerminalRpcResult<Method>;
      }
      case 'terminal.detach': {
        const input = params as TerminalRpcParams<'terminal.detach'>;
        await this.#terminal(workspace.executionContextId, input.terminalId);
        this.detach(session, input.attachmentId, input.terminalId);
        return { detached: true } as TerminalRpcResult<Method>;
      }
      case 'terminal.close': {
        const input = params as TerminalRpcParams<'terminal.close'>;
        const { runtime } = await this.#controlledAttachment(session, workspace.executionContextId, input);
        await this.#serialized(runtime, async () => {
          await this.#backend.close(input.terminalId);
          this.#onTerminalExit?.(input.terminalId);
          this.#finalizeExit(runtime, {});
          this.#runtimes.delete(input.terminalId);
        });
        return { closed: true } as TerminalRpcResult<Method>;
      }
    }
  }

  detach(session: PortalTerminalSession, attachmentId: string, terminalId?: string) {
    const attachment = this.#attachments.get(attachmentId);
    if (
      !attachment || attachment.connectionId !== session.connectionId ||
      (terminalId !== undefined && attachment.terminalId !== terminalId)
    ) {
      throw new PortalTerminalError(
        'TERMINAL_ATTACHMENT_UNAVAILABLE',
        'Terminal attachment is unavailable.',
        terminalId ? { terminalId } : {},
      );
    }
    this.#removeAttachment(attachmentId);
  }

  closeSession(session: PortalTerminalSession) {
    for (const attachmentId of session.attachmentIds()) {
      if (this.#attachments.has(attachmentId)) this.#removeAttachment(attachmentId);
    }
    this.#sessions.delete(session);
  }

  async #controlledAttachment(
    session: PortalTerminalSession,
    executionContextId: string,
    input: { terminalId: string; attachmentId: string },
  ) {
    const record = await this.#terminal(executionContextId, input.terminalId);
    const runtime = this.#runtime(record);
    const attachment = this.#attachments.get(input.attachmentId);
    if (
      !attachment || attachment.connectionId !== session.connectionId ||
      attachment.terminalId !== input.terminalId
    ) {
      throw new PortalTerminalError(
        'TERMINAL_ATTACHMENT_UNAVAILABLE',
        'Terminal attachment is unavailable.',
        { executionContextId, terminalId: input.terminalId },
      );
    }
    if (attachment.mode !== 'shared') {
      throw new PortalTerminalError(
        'TERMINAL_WRITE_REQUIRED',
        'A live writable attachment is required for this Terminal operation.',
        { executionContextId, terminalId: input.terminalId },
      );
    }
    return { attachment, runtime };
  }

  #assertAttached(session: PortalTerminalSession, attachment: AttachmentState) {
    session.assertOpen();
    if (this.#attachments.get(attachment.attachmentId) !== attachment) {
      throw new PortalTerminalError('TERMINAL_ATTACHMENT_UNAVAILABLE', 'Terminal attachment is unavailable.');
    }
  }

  #workspace(executionContextId: string) {
    const workspace = this.#resolveWorkspace(executionContextId);
    if (!workspace) {
      throw new PortalTerminalError(
        'TERMINAL_UNAVAILABLE',
        'Terminal resource is unavailable.',
        { executionContextId },
      );
    }
    return workspace;
  }

  async #terminal(executionContextId: string, terminalId: string) {
    const terminal = (await this.#backend.list()).find((candidate) =>
      candidate.terminalId === terminalId && candidate.executionContextId === executionContextId
    );
    if (!terminal) {
      throw new PortalTerminalError(
        'TERMINAL_UNAVAILABLE',
        'Terminal resource is unavailable.',
        { executionContextId, terminalId },
      );
    }
    return terminal;
  }

  #runtime(record: TerminalExecutionRecord) {
    let runtime = this.#runtimes.get(record.terminalId);
    if (!runtime) {
      runtime = {
        terminalId: record.terminalId,
        executionContextId: record.executionContextId,
        generation: this.#generation,
        sequence: 0,
        retainedFrom: 1,
        retainedBytes: 0,
        retained: [],
        pendingBackendEvents: [],
        attachments: new Set(),
        queue: Promise.resolve(),
      };
      this.#runtimes.set(record.terminalId, runtime);
    }
    return runtime;
  }

  async #snapshot(record: TerminalExecutionRecord) {
    const runtime = this.#runtime(record);
    return await this.#serialized(runtime, () => this.#captureSnapshot(record, runtime));
  }

  async #captureSnapshot(
    record: TerminalExecutionRecord,
    runtime: TerminalRuntime,
    attachment?: AttachmentState,
    replaceScreens = false,
  ): Promise<TerminalSnapshot> {
    const captured = await this.#backend.capture(record.terminalId);
    // Recount after the asynchronous capture, immediately before retaining it:
    // concurrent Terminal captures must share one hard history budget.
    const buffers = new Set<ArrayBufferLike>();
    for (const current of this.#attachments.values()) {
      if (current.history && current.history.expires < Date.now()) current.history = undefined;
      if (current === attachment || replaceScreens && runtime.attachments.has(current.attachmentId)) continue;
      for (const page of current.history?.pages ?? []) if (page.byteLength) buffers.add(page.buffer);
    }
    for (const page of captured.history ?? []) if (page.byteLength) buffers.add(page.buffer);
    if ([...buffers].reduce((total, buffer) => total + buffer.byteLength, 0) > 64 * 1024 * 1024) throw new PortalTerminalError('TERMINAL_BACKPRESSURE', 'Terminal history budget is busy; retry after active restoration');
    const historyToken = captured.history?.length ? crypto.randomUUID() : undefined;
    const history = () => historyToken ? { token: historyToken, pages: [...captured.history!], next: 0, expires: Date.now() + 120000 } : undefined;
    if (attachment) attachment.history = history();
    if (replaceScreens) for (const id of runtime.attachments) { const current = this.#attachments.get(id); if (current) current.history = history(); }
    // The backend supplies a watermark from the same ordered stream that
    // samples the terminal screen. Events through this point are represented
    // by this attachment's snapshot. Existing attachments still receive those
    // events, while later events remain live output for every attachment.
    if (attachment) attachment.absorbedBackendThrough = captured.boundary;
    if (replaceScreens) {
      for (const id of runtime.attachments) {
        const current = this.#attachments.get(id);
        if (current) current.absorbedBackendThrough = captured.boundary;
      }
    }
    this.#drainBackendEvents(runtime, captured.boundary);
    if (this.#runtimes.get(record.terminalId) !== runtime) {
      throw new PortalTerminalError(
        'TERMINAL_UNAVAILABLE',
        'Terminal resource is unavailable.',
        { executionContextId: record.executionContextId, terminalId: record.terminalId },
      );
    }
    const latest = await this.#terminal(record.executionContextId, record.terminalId);
    return {
      terminal: publicRecord(latest),
      generation: runtime.generation,
      cursor: runtime.sequence,
      retainedFrom: runtime.retainedFrom,
      data: captured.data,
      codec: TERMINAL_CODEC,
      ...(historyToken ? { historyToken, historyPages: captured.history!.length } : {}),

    };
  }

  #serialized<Result>(runtime: TerminalRuntime, operation: () => Result | Promise<Result>) {
    const result = runtime.queue.then(operation, operation);
    runtime.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #resize(runtime: TerminalRuntime, cols: number, rows: number) {
    const record = await this.#terminal(runtime.executionContextId, runtime.terminalId);
    if (record.cols === cols && record.rows === rows) return;
    try {
      await this.#backend.resize(runtime.terminalId, cols, rows);
      // A resize may redraw before its command completes. Replace every screen
      // at the capture watermark, then deliver only output after that boundary.
      const snapshot = await this.#captureSnapshot(record, runtime, undefined, true);
      runtime.retained = []; runtime.retainedBytes = 0;
      runtime.retainedFrom = runtime.sequence + 1;
      this.#publish(runtime, { type: 'screen', terminal: snapshot.terminal, data: snapshot.data, ...(snapshot.historyToken ? { historyToken: snapshot.historyToken, historyPages: snapshot.historyPages } : {}) });
    } catch (cause) {
      // The PTY may already have changed. Never leave clients on an old grid.
      this.#publish(runtime, { type: 'resync', retainedFrom: runtime.retainedFrom });
      throw cause;
    }
  }

  #acceptBackendEvent(event: TerminalExecutionEvent) {
    if (this.#closed) return;
    if (event.type === 'unavailable') {
      for (const runtime of this.#runtimes.values()) {
        this.#publish(runtime, { type: 'resync', retainedFrom: runtime.retainedFrom });
        for (const id of [...runtime.attachments]) this.#removeAttachment(id);
      }
      return;
    }
    if (event.type === 'exit') this.#onTerminalExit?.(event.terminalId);
    const runtime = this.#runtimes.get(event.terminalId);
    if (!runtime || this.#closed) return;
    runtime.pendingBackendEvents.push(event);
    void this.#serialized(runtime, () => this.#drainBackendEvents(runtime));
  }

  #drainBackendEvents(runtime: TerminalRuntime, through = Number.POSITIVE_INFINITY) {
    while (
      runtime.pendingBackendEvents.length > 0 &&
      runtime.pendingBackendEvents[0].backendSequence <= through
    ) {
      const event = runtime.pendingBackendEvents.shift()!;
      if (event.type === 'output') {
        const sequence = ++runtime.sequence;
        const retained = { sequence, data: event.data, bytes: byteLength(event.data) };
        runtime.retained.push(retained);
        runtime.retainedBytes += retained.bytes;
        while (runtime.retainedBytes > this.#retentionLimitBytes && runtime.retained.length > 0) {
          const removed = runtime.retained.shift()!;
          runtime.retainedBytes -= removed.bytes;
          runtime.retainedFrom = removed.sequence + 1;
        }
        this.#notify(runtime, sequence, { type: 'output', data: event.data }, event.backendSequence);
        continue;
      }
      if (event.type === 'directory') {
        this.#notify(runtime, ++runtime.sequence, { type: 'directory', currentDirectory: event.currentDirectory }, event.backendSequence);
        continue;
      }
      if (event.type === 'title') {
        this.#notify(
          runtime,
          ++runtime.sequence,
          { type: 'title', title: event.title },
          event.backendSequence,
        );
        continue;
      }
      if (event.type !== 'exit') continue;
      this.#finalizeExit(runtime, {
        ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
      });
      this.#runtimes.delete(event.terminalId);
    }
  }

  #publish(runtime: TerminalRuntime, event: TerminalNotification['event']) {
    this.#notify(runtime, ++runtime.sequence, event);
  }

  #notify(
    runtime: TerminalRuntime,
    sequence: number,
    event: TerminalNotification['event'],
    backendSequence?: number,
  ) {
    for (const attachmentId of runtime.attachments) {
      const attachment = this.#attachments.get(attachmentId);
      if (!attachment) continue;
      if (
        backendSequence !== undefined &&
        attachment.absorbedBackendThrough !== undefined &&
        backendSequence <= attachment.absorbedBackendThrough
      ) continue;
      this.#enqueueNotification(attachment, {
        attachmentId,
        terminalId: runtime.terminalId,
        executionContextId: runtime.executionContextId,
        generation: runtime.generation,
        sequence,
        event,
      });
    }
  }

  #enqueueNotification(attachment: AttachmentState, notification: TerminalNotification) {
    const bytes = 1024 + (notification.event.type === 'output' || notification.event.type === 'screen' ? notification.event.data.byteLength : 0);
    // A screen replacement has the same bounded payload allowance as an
    // initial snapshot; subsequent live output retains the smaller queue cap.
    const limit = notification.event.type === 'screen' ? Math.max(this.#attachmentQueueLimitBytes, 3 * 1024 * 1024) : this.#attachmentQueueLimitBytes;
    if (attachment.pendingBytes + bytes > limit) {
      const runtime = this.#runtimes.get(attachment.terminalId);
      attachment.pending = [];
      attachment.pendingBytes = 0;
      try {
        attachment.send({
          attachmentId: attachment.attachmentId,
          terminalId: attachment.terminalId,
          executionContextId: attachment.executionContextId,
          generation: runtime?.generation ?? this.#generation,
          sequence: runtime?.sequence ?? notification.sequence,
          event: { type: 'resync', retainedFrom: runtime?.retainedFrom ?? notification.sequence },
        });
      } finally {
        this.#removeAttachment(attachment.attachmentId);
      }
      return;
    }
    attachment.pending.push(notification);
    attachment.pendingBytes += bytes;
    if (attachment.flushScheduled) return;
    attachment.flushScheduled = true;
    queueMicrotask(() => {
      attachment.flushScheduled = false;
      const pending = attachment.pending;
      attachment.pending = [];
      attachment.pendingBytes = 0;
      for (const item of pending) {
        if (!this.#attachments.has(attachment.attachmentId)) break;
        try {
          if (attachment.send(item) === false) {
            this.#removeAttachment(attachment.attachmentId);
            break;
          }
        } catch {
          this.#removeAttachment(attachment.attachmentId);
          break;
        }
      }
    });
  }

  #flushAttachment(attachment: AttachmentState) {
    attachment.flushScheduled = false;
    const pending = attachment.pending;
    attachment.pending = [];
    attachment.pendingBytes = 0;
    for (const item of pending) {
      if (attachment.send(item) === false) return false;
    }
    return true;
  }

  #finalizeExit(runtime: TerminalRuntime, event: { exitCode?: number }) {
    const sequence = ++runtime.sequence;
    for (const attachmentId of [...runtime.attachments]) {
      const attachment = this.#attachments.get(attachmentId);
      if (!attachment) continue;
      try {
        if (this.#flushAttachment(attachment)) {
          attachment.send({
            attachmentId,
            terminalId: runtime.terminalId,
            executionContextId: runtime.executionContextId,
            generation: runtime.generation,
            sequence,
            event: { type: 'exit', ...event },
          });
        }
      } catch {
        // One failed transport must not prevent the remaining attachments
        // from receiving the terminal's final lifecycle notification.
      } finally {
        this.#removeAttachment(attachmentId);
      }
    }
  }

  #removeAttachment(attachmentId: string) {
    const attachment = this.#attachments.get(attachmentId);
    if (!attachment) return;
    this.#attachments.delete(attachmentId);
    const runtime = this.#runtimes.get(attachment.terminalId);
    runtime?.attachments.delete(attachmentId);
    if (runtime?.resizeAttachmentId === attachmentId) runtime.resizeAttachmentId = undefined;
    const session = [...this.#sessions].find((candidate) => candidate.connectionId === attachment.connectionId);
    session?.removeAttachment(attachmentId);

  }
}

export class PortalTerminalSession {
  readonly #attachmentIds = new Set<string>();
  #closed = false;

  constructor(
    readonly service: TerminalAccess,
    readonly connectionId: string,
    readonly send: (notification: TerminalNotification) => unknown,
  ) {}

  request<Method extends TerminalRpcMethod>(
    method: Method,
    params: TerminalRpcParams<Method>,
  ): Promise<TerminalRpcResult<Method>> {
    if (this.#closed) throw new Error('Portal Terminal session is closed.');
    return this.service.request(this, method, params);
  }

  assertOpen() {
    if (this.#closed) throw new Error('Portal Terminal session is closed.');
  }

  addAttachment(attachmentId: string) {
    this.#attachmentIds.add(attachmentId);
  }

  removeAttachment(attachmentId: string) {
    this.#attachmentIds.delete(attachmentId);
  }

  attachmentIds() {
    return [...this.#attachmentIds];
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.service.closeSession(this);
  }
}

export class InMemoryTerminalExecution implements TerminalExecution {
  readonly inputs: Array<{ terminalId: string; data: Uint8Array }> = [];
  readonly resizes: Array<{ terminalId: string; cols: number; rows: number }> = [];
  readonly closed: string[] = [];
  readonly #records = new Map<string, TerminalExecutionRecord>();
  readonly #captures = new Map<string, Uint8Array>();
  readonly #listeners = new Set<(event: TerminalExecutionEvent) => void>();
  #eventSequence = 0;

  list() {
    return Promise.resolve([...this.#records.values()].map((record) => ({ ...record })));
  }

  create(input: {
    terminalId: string;
    executionContextId: string;
    cwd: string;
    cols: number;
    rows: number;
    env: Record<string, string>;
  }) {
    const record: TerminalExecutionRecord = {
      terminalId: input.terminalId,
      executionContextId: input.executionContextId,
      title: 'Terminal',
      status: 'running',
      cols: input.cols,
      rows: input.rows,
    };
    this.#records.set(record.terminalId, record);
    this.#captures.set(record.terminalId, new Uint8Array());
    return Promise.resolve({ ...record });
  }

  capture(terminalId: string) {
    return Promise.resolve({
      data: this.#captures.get(terminalId) ?? new Uint8Array(),
      boundary: this.#eventSequence,
    });
  }

  setCapture(terminalId: string, data: Uint8Array) {
    this.#captures.set(terminalId, data);
  }

  input(terminalId: string, data: Uint8Array) {
    this.#assertTerminal(terminalId);
    this.inputs.push({ terminalId, data });
    return Promise.resolve();
  }

  resize(terminalId: string, cols: number, rows: number) {
    const record = this.#assertTerminal(terminalId);
    record.cols = cols;
    record.rows = rows;
    this.resizes.push({ terminalId, cols, rows });
    return Promise.resolve();
  }

  close(terminalId: string) {
    if (!this.#records.delete(terminalId)) return Promise.resolve();
    this.#captures.delete(terminalId);
    this.closed.push(terminalId);
    return Promise.resolve();
  }

  subscribe(listener: (event: TerminalExecutionEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emitOutput(terminalId: string, data: Uint8Array) {
    this.#assertTerminal(terminalId);
    const previous = this.#captures.get(terminalId) ?? new Uint8Array();
    const combined = new Uint8Array(previous.length + data.length); combined.set(previous); combined.set(data, previous.length);
    this.#captures.set(terminalId, combined);
    const event = { terminalId, backendSequence: ++this.#eventSequence, type: 'output' as const, data };
    for (const listener of this.#listeners) listener(event);
  }

  emitTitle(terminalId: string, title: string) {
    const record = this.#assertTerminal(terminalId);
    record.title = title;
    const event = { terminalId, backendSequence: ++this.#eventSequence, type: 'title' as const, title };
    for (const listener of this.#listeners) listener(event);
  }

  emitExit(terminalId: string, exitCode?: number) {
    const record = this.#assertTerminal(terminalId);
    record.status = 'exited';
    record.exitCode = exitCode;
    const event = { terminalId, backendSequence: ++this.#eventSequence, type: 'exit' as const, exitCode };
    for (const listener of this.#listeners) listener(event);
  }

  dispose() {}

  #assertTerminal(terminalId: string) {
    const record = this.#records.get(terminalId);
    if (!record) throw new Error(`Terminal is unavailable: ${terminalId}`);
    return record;
  }
}
