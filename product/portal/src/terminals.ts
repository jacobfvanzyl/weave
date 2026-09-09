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

export type TerminalWorkspace = { workspaceId: string; path: string };

export type TerminalBackendRecord = TerminalSummary & {
  paneId?: string;
  windowId?: string;
};

export type TerminalBackendEvent =
  | { terminalId: string; backendSequence: number; type: 'output'; data: string }
  | { terminalId: string; backendSequence: number; type: 'title'; title: string; processName?: string }
  | { terminalId: string; backendSequence: number; type: 'exit'; exitCode?: number };

export type TerminalBackendCapture = {
  data: string;
  /** Last backend event known to be represented by `data`. */
  boundary: number;
};

export interface TerminalBackend {
  list(): Promise<TerminalBackendRecord[]>;
  create(input: {
    terminalId: string;
    workspaceId: string;
    cwd: string;
    cols: number;
    rows: number;
    env: Record<string, string>;
  }): Promise<TerminalBackendRecord>;
  capture(terminalId: string): Promise<TerminalBackendCapture>;
  input(terminalId: string, data: string): Promise<void>;
  resize(terminalId: string, cols: number, rows: number): Promise<void>;
  close(terminalId: string): Promise<void>;
  subscribe(listener: (event: TerminalBackendEvent) => void): () => void;
  dispose(): void | Promise<void>;
}

export class PortalTerminalError extends Error {
  readonly data: {
    domain: 'terminal';
    code: TerminalErrorCode;
    workspaceId?: string;
    terminalId?: string;
    retainedFrom?: number;
  };

  constructor(
    code: TerminalErrorCode,
    message: string,
    resource: { workspaceId?: string; terminalId?: string; retainedFrom?: number } = {},
  ) {
    super(message);
    this.name = 'PortalTerminalError';
    this.data = { domain: 'terminal', code, ...resource };
  }
}

type RetainedOutput = { sequence: number; data: string; bytes: number };

type TerminalRuntime = {
  terminalId: string;
  workspaceId: string;
  generation: string;
  sequence: number;
  retainedFrom: number;
  retainedBytes: number;
  retained: RetainedOutput[];
  pendingBackendEvents: TerminalBackendEvent[];
  controllerAttachmentId?: string;
  attachments: Set<string>;
  queue: Promise<unknown>;
};

type AttachmentState = TerminalAttachment & {
  connectionId: string;
  terminalId: string;
  workspaceId: string;
  send: (notification: TerminalNotification) => unknown;
  pending: TerminalNotification[];
  pendingBytes: number;
  flushScheduled: boolean;
  absorbedBackendThrough?: number;
};

type TerminalServiceOptions = {
  backend: TerminalBackend;
  resolveWorkspace: (workspaceId: string) => TerminalWorkspace | undefined;
  assertWorkspaceAvailable?: (workspaceId: string) => Promise<unknown>;
  retentionLimitBytes?: number;
  attachmentQueueLimitBytes?: number;
  env?: Record<string, string | undefined>;
};

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const DEFAULT_RETENTION_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_ATTACHMENT_QUEUE_LIMIT_BYTES = 256 * 1024;

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const cleanEnvironment = (source: Record<string, string | undefined>) => {
  const blocked = new Set([
    'NO_COLOR',
    'TMUX',
    'TMUX_PANE',
    'WEAVE_TERMINAL_ID',
    'WEAVE_WORKSPACE_ID',
    'WEAVE_WORKSPACE',
  ]);
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && !blocked.has(entry[0])
    ),
  );
};

const publicRecord = (record: TerminalBackendRecord): TerminalSummary => ({
  terminalId: record.terminalId,
  workspaceId: record.workspaceId,
  title: record.title,
  status: record.status,
  cols: record.cols,
  rows: record.rows,
  ...(record.processName ? { processName: record.processName } : {}),
  ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
});

export class TerminalService {
  readonly #backend: TerminalBackend;
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

  async knownTerminalIds(workspaceId: string) {
    return new Set((await this.#backend.list()).filter((terminal) => terminal.workspaceId === workspaceId).map((terminal) => terminal.terminalId));
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
    const workspace = this.#workspace(params.workspaceId);
    switch (method) {
      case 'terminal.list':
        return {
          terminals: (await this.#backend.list())
            .filter((terminal) => terminal.workspaceId === workspace.workspaceId)
            .map(publicRecord),
        } as TerminalRpcResult<Method>;
      case 'terminal.create': {
        await this.#assertWorkspaceAvailable?.(workspace.workspaceId);
        const input = params as TerminalRpcParams<'terminal.create'>;
        const terminalId = crypto.randomUUID();
        const record = await this.#backend.create({
          terminalId,
          workspaceId: workspace.workspaceId,
          cwd: workspace.path,
          cols: input.cols ?? DEFAULT_COLS,
          rows: input.rows ?? DEFAULT_ROWS,
          env: {
            ...cleanEnvironment(this.#env),
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            WEAVE_TERMINAL_ID: terminalId,
            WEAVE_WORKSPACE_ID: workspace.workspaceId,
            WEAVE_WORKSPACE: workspace.path,
          },
        });
        this.#runtime(record);
        return { terminal: publicRecord(record) } as TerminalRpcResult<Method>;
      }
      case 'terminal.snapshot': {
        const input = params as TerminalRpcParams<'terminal.snapshot'>;
        const record = await this.#terminal(workspace.workspaceId, input.terminalId);
        return { snapshot: await this.#snapshot(record) } as TerminalRpcResult<Method>;
      }
      case 'terminal.attach': {
        const input = params as TerminalRpcParams<'terminal.attach'>;
        const record = await this.#terminal(workspace.workspaceId, input.terminalId);
        const runtime = this.#runtime(record);
        return await this.#serialized(runtime, async () => {
          if (input.cursor !== undefined && input.cursor < runtime.retainedFrom - 1) {
            throw new PortalTerminalError(
              'TERMINAL_REPLAY_GAP',
              'Requested Terminal retained output is no longer available; request a fresh snapshot.',
              {
                workspaceId: workspace.workspaceId,
                terminalId: record.terminalId,
                retainedFrom: runtime.retainedFrom,
              },
            );
          }
          if (input.mode === 'control' && runtime.controllerAttachmentId) {
            throw new PortalTerminalError(
              'TERMINAL_CONTROLLED',
              'Terminal is controlled by another attachment.',
              { workspaceId: workspace.workspaceId, terminalId: record.terminalId },
            );
          }
          const attachment: AttachmentState = {
            attachmentId: crypto.randomUUID(),
            mode: input.mode,
            connectionId: session.connectionId,
            terminalId: record.terminalId,
            workspaceId: workspace.workspaceId,
            send: session.send,
            pending: [],
            pendingBytes: 0,
            flushScheduled: false,
          };
          this.#attachments.set(attachment.attachmentId, attachment);
          runtime.attachments.add(attachment.attachmentId);
          session.addAttachment(attachment.attachmentId);
          if (attachment.mode === 'control') {
            runtime.controllerAttachmentId = attachment.attachmentId;
            this.#publish(runtime, {
              type: 'control',
              controlled: true,
              attachmentId: attachment.attachmentId,
            });
          }
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
      case 'terminal.input': {
        const input = params as TerminalRpcParams<'terminal.input'>;
        const { runtime } = await this.#controlledAttachment(session, workspace.workspaceId, input);
        await this.#serialized(runtime, () => this.#backend.input(input.terminalId, input.data));
        return { accepted: true } as TerminalRpcResult<Method>;
      }
      case 'terminal.resize': {
        const input = params as TerminalRpcParams<'terminal.resize'>;
        const { runtime } = await this.#controlledAttachment(session, workspace.workspaceId, input);
        await this.#serialized(runtime, () => this.#backend.resize(input.terminalId, input.cols, input.rows));
        return { accepted: true } as TerminalRpcResult<Method>;
      }
      case 'terminal.detach': {
        const input = params as TerminalRpcParams<'terminal.detach'>;
        await this.#terminal(workspace.workspaceId, input.terminalId);
        this.detach(session, input.attachmentId, input.terminalId);
        return { detached: true } as TerminalRpcResult<Method>;
      }
      case 'terminal.close': {
        const input = params as TerminalRpcParams<'terminal.close'>;
        const { runtime } = await this.#controlledAttachment(session, workspace.workspaceId, input);
        await this.#serialized(runtime, async () => {
          await this.#backend.close(input.terminalId);
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
    workspaceId: string,
    input: { terminalId: string; attachmentId: string },
  ) {
    const record = await this.#terminal(workspaceId, input.terminalId);
    const runtime = this.#runtime(record);
    const attachment = this.#attachments.get(input.attachmentId);
    if (
      !attachment || attachment.connectionId !== session.connectionId ||
      attachment.terminalId !== input.terminalId
    ) {
      throw new PortalTerminalError(
        'TERMINAL_ATTACHMENT_UNAVAILABLE',
        'Terminal attachment is unavailable.',
        { workspaceId, terminalId: input.terminalId },
      );
    }
    if (attachment.mode !== 'control' || runtime.controllerAttachmentId !== attachment.attachmentId) {
      throw new PortalTerminalError(
        'TERMINAL_CONTROL_REQUIRED',
        'A live control attachment is required for this Terminal operation.',
        { workspaceId, terminalId: input.terminalId },
      );
    }
    return { attachment, runtime };
  }

  #workspace(workspaceId: string) {
    const workspace = this.#resolveWorkspace(workspaceId);
    if (!workspace) {
      throw new PortalTerminalError(
        'TERMINAL_UNAVAILABLE',
        'Terminal resource is unavailable.',
        { workspaceId },
      );
    }
    return workspace;
  }

  async #terminal(workspaceId: string, terminalId: string) {
    const terminal = (await this.#backend.list()).find((candidate) =>
      candidate.terminalId === terminalId && candidate.workspaceId === workspaceId
    );
    if (!terminal) {
      throw new PortalTerminalError(
        'TERMINAL_UNAVAILABLE',
        'Terminal resource is unavailable.',
        { workspaceId, terminalId },
      );
    }
    return terminal;
  }

  #runtime(record: TerminalBackendRecord) {
    let runtime = this.#runtimes.get(record.terminalId);
    if (!runtime) {
      runtime = {
        terminalId: record.terminalId,
        workspaceId: record.workspaceId,
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

  async #snapshot(record: TerminalBackendRecord) {
    const runtime = this.#runtime(record);
    return await this.#serialized(runtime, () => this.#captureSnapshot(record, runtime));
  }

  async #captureSnapshot(
    record: TerminalBackendRecord,
    runtime: TerminalRuntime,
    attachment?: AttachmentState,
  ): Promise<TerminalSnapshot> {
    const captured = await this.#backend.capture(record.terminalId);
    // The backend supplies a watermark from the same ordered stream that
    // samples the terminal screen. Events through this point are represented
    // by this attachment's snapshot. Existing attachments still receive those
    // events, while later events remain live output for every attachment.
    if (attachment) attachment.absorbedBackendThrough = captured.boundary;
    this.#drainBackendEvents(runtime, captured.boundary);
    if (this.#runtimes.get(record.terminalId) !== runtime) {
      throw new PortalTerminalError(
        'TERMINAL_UNAVAILABLE',
        'Terminal resource is unavailable.',
        { workspaceId: record.workspaceId, terminalId: record.terminalId },
      );
    }
    const latest = await this.#terminal(record.workspaceId, record.terminalId);
    return {
      terminal: publicRecord(latest),
      generation: runtime.generation,
      cursor: runtime.sequence,
      retainedFrom: runtime.retainedFrom,
      data: captured.data,
      controller: runtime.controllerAttachmentId
        ? { controlled: true, attachmentId: runtime.controllerAttachmentId }
        : { controlled: false },
    };
  }

  #serialized<Result>(runtime: TerminalRuntime, operation: () => Result | Promise<Result>) {
    const result = runtime.queue.then(operation, operation);
    runtime.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #acceptBackendEvent(event: TerminalBackendEvent) {
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
      if (event.type === 'title') {
        this.#notify(
          runtime,
          ++runtime.sequence,
          { type: 'title', title: event.title },
          event.backendSequence,
        );
        continue;
      }
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
        workspaceId: runtime.workspaceId,
        generation: runtime.generation,
        sequence,
        event,
      });
    }
  }

  #enqueueNotification(attachment: AttachmentState, notification: TerminalNotification) {
    const bytes = byteLength(JSON.stringify(notification));
    if (attachment.pendingBytes + bytes > this.#attachmentQueueLimitBytes) {
      const runtime = this.#runtimes.get(attachment.terminalId);
      attachment.pending = [];
      attachment.pendingBytes = 0;
      try {
        attachment.send({
          attachmentId: attachment.attachmentId,
          terminalId: attachment.terminalId,
          workspaceId: attachment.workspaceId,
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
            workspaceId: runtime.workspaceId,
            generation: runtime.generation,
            sequence,
            event: { type: 'exit', ...event },
          });
        }
      } catch {
        // One failed transport must not prevent the remaining attachments
        // from receiving the terminal's final lifecycle notification.
      } finally {
        this.#removeAttachment(attachmentId, false);
      }
    }
    runtime.controllerAttachmentId = undefined;
  }

  #removeAttachment(attachmentId: string, publishControl = true) {
    const attachment = this.#attachments.get(attachmentId);
    if (!attachment) return;
    this.#attachments.delete(attachmentId);
    const runtime = this.#runtimes.get(attachment.terminalId);
    runtime?.attachments.delete(attachmentId);
    const session = [...this.#sessions].find((candidate) => candidate.connectionId === attachment.connectionId);
    session?.removeAttachment(attachmentId);
    if (runtime?.controllerAttachmentId === attachmentId) {
      runtime.controllerAttachmentId = undefined;
      if (publishControl) this.#publish(runtime, { type: 'control', controlled: false });
    }
  }
}

export class PortalTerminalSession {
  readonly #attachmentIds = new Set<string>();
  #closed = false;

  constructor(
    readonly service: TerminalService,
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

export class InMemoryTerminalBackend implements TerminalBackend {
  readonly inputs: Array<{ terminalId: string; data: string }> = [];
  readonly resizes: Array<{ terminalId: string; cols: number; rows: number }> = [];
  readonly closed: string[] = [];
  readonly #records = new Map<string, TerminalBackendRecord>();
  readonly #captures = new Map<string, string>();
  readonly #listeners = new Set<(event: TerminalBackendEvent) => void>();
  #eventSequence = 0;

  list() {
    return Promise.resolve([...this.#records.values()].map((record) => ({ ...record })));
  }

  create(input: {
    terminalId: string;
    workspaceId: string;
    cwd: string;
    cols: number;
    rows: number;
    env: Record<string, string>;
  }) {
    const record: TerminalBackendRecord = {
      terminalId: input.terminalId,
      workspaceId: input.workspaceId,
      title: 'Terminal',
      status: 'running',
      cols: input.cols,
      rows: input.rows,
    };
    this.#records.set(record.terminalId, record);
    this.#captures.set(record.terminalId, '');
    return Promise.resolve({ ...record });
  }

  capture(terminalId: string) {
    return Promise.resolve({
      data: this.#captures.get(terminalId) ?? '',
      boundary: this.#eventSequence,
    });
  }

  setCapture(terminalId: string, data: string) {
    this.#captures.set(terminalId, data);
  }

  input(terminalId: string, data: string) {
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

  subscribe(listener: (event: TerminalBackendEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emitOutput(terminalId: string, data: string) {
    this.#assertTerminal(terminalId);
    this.#captures.set(terminalId, `${this.#captures.get(terminalId) ?? ''}${data}`);
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
