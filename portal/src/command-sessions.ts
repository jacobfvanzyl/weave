import {
  cleanupSandboxInvocation,
  type ExecutionProfile,
  prepareSandboxInvocation,
  type SandboxInvocation,
} from './execution-policy.ts';
import { terminateProcessTree } from './process-tree.ts';
import { resolvePortalHome } from './lifecycle.ts';

export type CommandOutputEvent = {
  offset: number;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  at: string;
};

export type CommandSessionSnapshot = {
  id: string;
  command: string;
  cwd: string;
  profile: ExecutionProfile;
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  exitCode?: number;
  timedOut: boolean;
  sandboxed: boolean;
  network: 'denied' | 'host';
  nextOffset: number;
  baseOffset: number;
  outputChars: number;
  outputBytes: number;
  outputLines: number;
  artifactHandle: string;
  omittedRanges: Array<{ startOffset: number; endOffset: number }>;
  hasMore: boolean;
  pty: boolean;
  validation?: 'test' | 'typecheck' | 'lint' | 'build' | 'other';
  events: CommandOutputEvent[];
};

type SnapshotSession = Omit<CommandSessionSnapshot, 'events' | 'artifactHandle' | 'omittedRanges' | 'hasMore'> & {
  events: CommandOutputEvent[];
};

type CommandSession = SnapshotSession & {
  workspaceRoot: string;
  child: Deno.ChildProcess;
  invocation: SandboxInvocation;
  events: CommandOutputEvent[];
  stdin?: WritableStreamDefaultWriter<Uint8Array>;
  timeout?: ReturnType<typeof setTimeout>;
  cleanup?: ReturnType<typeof setTimeout>;
  completion: Promise<void>;
  artifactPath: string;
  artifactChain: Promise<void>;
  outputNewlines: number;
  outputEndsWithNewline: boolean;
};

type CommandArtifactMetadata = {
  kind: 'metadata';
  version: 1;
  id: string;
  workspaceRoot: string;
  command: string;
  cwd: string;
  profile: ExecutionProfile;
  startedAt: string;
  sandboxed: boolean;
  network: 'denied' | 'host';
  pty: boolean;
  validation?: CommandSessionSnapshot['validation'];
};

type CommandArtifactTerminal = {
  kind: 'terminal';
  status: CommandSessionSnapshot['status'];
  finishedAt: string;
  exitCode?: number;
  timedOut: boolean;
};

const encoder = new TextEncoder();
const maxRetainedOutputChars = 2_000_000;
const completedRetentionMs = 5 * 60 * 1000;
const maxResponseOutputChars = 100_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const sliceEvents = (session: SnapshotSession, startOffset: number, endOffset: number) =>
  session.events.flatMap((event): CommandOutputEvent[] => {
    const eventEnd = event.offset + event.text.length;
    if (eventEnd <= startOffset || event.offset >= endOffset) return [];
    const start = Math.max(0, startOffset - event.offset);
    const end = Math.min(event.text.length, endOffset - event.offset);
    return [{ ...event, offset: event.offset + start, text: event.text.slice(start, end) }];
  });

const publicSnapshot = (
  session: SnapshotSession,
  afterOffset?: number,
  requestedLimit = maxResponseOutputChars,
): CommandSessionSnapshot => {
  const limit = Math.max(1, Math.min(requestedLimit, maxResponseOutputChars));
  const explicitRange = afterOffset !== undefined;
  const start = Math.max(session.baseOffset, afterOffset ?? session.baseOffset);
  const available = Math.max(0, session.nextOffset - start);
  let events: CommandOutputEvent[];
  let omittedRanges: Array<{ startOffset: number; endOffset: number }> = [];
  let hasMore = false;
  if (!explicitRange && available > limit) {
    const headEnd = start + Math.floor(limit / 2);
    const tailStart = session.nextOffset - Math.ceil(limit / 2);
    events = [...sliceEvents(session, start, headEnd), ...sliceEvents(session, tailStart, session.nextOffset)];
    omittedRanges = [{ startOffset: headEnd, endOffset: tailStart }];
  } else {
    const end = Math.min(session.nextOffset, start + limit);
    events = sliceEvents(session, start, end);
    hasMore = end < session.nextOffset;
    if (hasMore) omittedRanges = [{ startOffset: end, endOffset: session.nextOffset }];
  }
  return {
    id: session.id,
    command: session.command,
    cwd: session.cwd,
    profile: session.profile,
    status: session.status,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    ...(session.finishedAt ? { finishedAt: session.finishedAt } : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.validation ? { validation: session.validation } : {}),
    timedOut: session.timedOut,
    sandboxed: session.sandboxed,
    network: session.network,
    nextOffset: session.nextOffset,
    baseOffset: session.baseOffset,
    outputChars: session.outputChars,
    outputBytes: session.outputBytes,
    outputLines: session.outputLines,
    artifactHandle: session.id,
    omittedRanges,
    hasMore,
    pty: session.pty,
    events,
  };
};

export class CommandSessionManager {
  private readonly sessions = new Map<string, CommandSession>();

  constructor(
    private readonly artifactRoot = `${resolvePortalHome()}/command-artifacts`,
  ) {}

  private artifactPath(id: string) {
    if (!/^exec_[0-9a-f-]{36}$/i.test(id)) throw new Error('Command artifact handle is invalid.');
    return `${this.artifactRoot}/${id}.jsonl`;
  }

  private async createArtifact(path: string, metadata: CommandArtifactMetadata) {
    await Deno.mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(path, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  }

  private appendArtifact(session: CommandSession, value: unknown) {
    session.artifactChain = session.artifactChain.then(() =>
      Deno.writeTextFile(session.artifactPath, `${JSON.stringify(value)}\n`, { append: true })
    ).catch((error) => {
      console.error('[portal] failed to persist command artifact', { sessionId: session.id, error });
    });
  }

  private async readArtifact(workspaceRoot: string, id: string, afterOffset?: number, limit?: number) {
    const lines = (await Deno.readTextFile(this.artifactPath(id))).split('\n').filter(Boolean).map((line) =>
      JSON.parse(line) as Record<string, unknown>
    );
    const metadata = lines.find((line) => line.kind === 'metadata') as CommandArtifactMetadata | undefined;
    if (!metadata || metadata.workspaceRoot !== workspaceRoot) throw new Error('Command session was not found.');
    const events = lines.filter((line) => line.kind === 'event').map((line) => line.event as CommandOutputEvent);
    const terminal = [...lines].reverse().find((line) => line.kind === 'terminal') as
      | CommandArtifactTerminal
      | undefined;
    const nextOffset = events.reduce((maximum, event) => Math.max(maximum, event.offset + event.text.length), 0);
    const outputBytes = events.reduce((total, event) => total + encoder.encode(event.text).byteLength, 0);
    const outputNewlines = events.reduce((total, event) => total + (event.text.match(/\n/g)?.length ?? 0), 0);
    const outputEndsWithNewline = events.at(-1)?.text.endsWith('\n') ?? false;
    const restored: SnapshotSession = {
      id: metadata.id,
      command: metadata.command,
      cwd: metadata.cwd,
      profile: metadata.profile,
      status: terminal?.status ?? 'failed',
      startedAt: metadata.startedAt,
      updatedAt: terminal?.finishedAt ?? metadata.startedAt,
      ...(terminal?.finishedAt ? { finishedAt: terminal.finishedAt } : {}),
      ...(terminal?.exitCode !== undefined ? { exitCode: terminal.exitCode } : {}),
      ...(metadata.validation ? { validation: metadata.validation } : {}),
      timedOut: terminal?.timedOut ?? false,
      sandboxed: metadata.sandboxed,
      network: metadata.network,
      nextOffset,
      baseOffset: 0,
      outputChars: nextOffset,
      outputBytes,
      outputLines: nextOffset ? outputNewlines + (outputEndsWithNewline ? 0 : 1) : 0,
      pty: metadata.pty,
      events: terminal ? events : [...events, {
        offset: nextOffset,
        stream: 'system',
        text: 'Portal restarted before the command reported a terminal status.',
        at: new Date().toISOString(),
      }],
    };
    if (!terminal) {
      restored.nextOffset += restored.events.at(-1)!.text.length;
      restored.outputChars = restored.nextOffset;
      restored.outputBytes += encoder.encode(restored.events.at(-1)!.text).byteLength;
      restored.outputLines += nextOffset === 0 || outputEndsWithNewline ? 1 : 0;
    }
    return publicSnapshot(restored, afterOffset, limit);
  }

  async start(input: {
    workspaceRoot: string;
    cwd: string;
    command: string;
    profile: ExecutionProfile;
    timeoutMs?: number;
    yieldMs?: number;
    validation?: CommandSessionSnapshot['validation'];
    pty?: boolean;
  }) {
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const ptyCommand = input.pty
      ? Deno.build.os === 'darwin'
        ? `script -q /dev/null bash -lc ${shellQuote(input.command)}`
        : `script -qefc ${shellQuote(`bash -lc ${shellQuote(input.command)}`)} /dev/null`
      : input.command;
    const invocation = await prepareSandboxInvocation({
      profile: input.profile,
      workspaceRoot: input.workspaceRoot,
      cwd: input.cwd,
      shellCommand: ptyCommand,
    });
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(invocation.command, {
        cwd: invocation.cwd,
        args: invocation.args,
        stdin: 'piped',
        stdout: 'piped',
        stderr: 'piped',
        env: invocation.env,
        clearEnv: invocation.clearEnv,
      }).spawn();
    } catch (error) {
      await cleanupSandboxInvocation(invocation);
      throw error;
    }

    const now = new Date().toISOString();
    const id = `exec_${crypto.randomUUID()}`;
    const artifactPath = this.artifactPath(id);
    const session = {
      id,
      workspaceRoot: input.workspaceRoot,
      command: input.command,
      cwd: input.cwd,
      profile: input.profile,
      status: 'running' as const,
      startedAt: now,
      updatedAt: now,
      timedOut: false,
      sandboxed: invocation.sandboxed,
      network: invocation.network,
      nextOffset: 0,
      baseOffset: 0,
      outputChars: 0,
      outputBytes: 0,
      outputLines: 0,
      validation: input.validation,
      pty: input.pty === true,
      child,
      invocation,
      events: [],
      stdin: child.stdin.getWriter(),
      completion: Promise.resolve(),
      artifactPath,
      artifactChain: this.createArtifact(artifactPath, {
        kind: 'metadata',
        version: 1,
        id,
        workspaceRoot: input.workspaceRoot,
        command: input.command,
        cwd: input.cwd,
        profile: input.profile,
        startedAt: now,
        sandboxed: invocation.sandboxed,
        network: invocation.network,
        pty: input.pty === true,
        ...(input.validation ? { validation: input.validation } : {}),
      }),
      outputNewlines: 0,
      outputEndsWithNewline: false,
    } satisfies Omit<CommandSession, 'completion'> & { completion: Promise<void> };
    this.sessions.set(session.id, session as CommandSession);

    const active = session as CommandSession;
    active.completion = this.pump(active);
    const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : undefined;
    if (timeoutMs) {
      active.timeout = setTimeout(() => {
        if (active.status !== 'running') return;
        active.timedOut = true;
        active.status = 'timed_out';
        this.append(active, 'system', `Command timed out after ${timeoutMs}ms.`);
        void terminateProcessTree(active.child);
      }, timeoutMs);
    }

    const yieldMs = Math.max(0, Math.min(input.yieldMs ?? 1_000, 30_000));
    await Promise.race([active.completion, wait(yieldMs)]);
    return publicSnapshot(active);
  }

  async poll(workspaceRoot: string, id: string, afterOffset?: number, limit?: number) {
    const session = this.sessions.get(id);
    if (!session) return await this.readArtifact(workspaceRoot, id, afterOffset, limit);
    if (session.workspaceRoot !== workspaceRoot) throw new Error('Command session was not found.');
    return publicSnapshot(
      session,
      afterOffset === undefined ? undefined : Math.max(session.baseOffset, afterOffset),
      limit,
    );
  }

  async wait(workspaceRoot: string, id: string) {
    const session = this.requireSession(workspaceRoot, id);
    await session.completion;
    return publicSnapshot(session);
  }

  async write(workspaceRoot: string, id: string, data: string, close = false) {
    const session = this.requireSession(workspaceRoot, id);
    if (session.status !== 'running' || !session.stdin) throw new Error('Command session is not accepting input.');
    if (data) await session.stdin.write(encoder.encode(data));
    if (close) {
      await session.stdin.close();
      session.stdin = undefined;
    }
    return publicSnapshot(session, session.nextOffset);
  }

  stop(workspaceRoot: string, id: string) {
    const session = this.requireSession(workspaceRoot, id);
    if (session.status === 'running') {
      session.status = 'cancelled';
      this.append(session, 'system', 'Command cancelled.');
      void terminateProcessTree(session.child);
    }
    return publicSnapshot(session);
  }

  clearForTests() {
    for (const session of this.sessions.values()) {
      if (session.status === 'running') void terminateProcessTree(session.child);
      if (session.timeout) clearTimeout(session.timeout);
      if (session.cleanup) clearTimeout(session.cleanup);
    }
    this.sessions.clear();
  }

  private requireSession(workspaceRoot: string, id: string) {
    const session = this.sessions.get(id);
    if (!session || session.workspaceRoot !== workspaceRoot) throw new Error('Command session was not found.');
    return session;
  }

  private append(session: CommandSession, stream: CommandOutputEvent['stream'], text: string) {
    if (!text) return;
    const event = { offset: session.nextOffset, stream, text, at: new Date().toISOString() };
    session.events.push(event);
    session.nextOffset += text.length;
    session.outputChars += text.length;
    session.outputBytes += encoder.encode(text).byteLength;
    session.outputNewlines += text.match(/\n/g)?.length ?? 0;
    session.outputEndsWithNewline = text.endsWith('\n');
    session.outputLines = session.outputNewlines + (session.outputEndsWithNewline ? 0 : 1);
    session.updatedAt = event.at;
    this.appendArtifact(session, { kind: 'event', event });
    let retained = session.events.reduce((total, item) => total + item.text.length, 0);
    while (retained > maxRetainedOutputChars && session.events.length > 1) {
      const removed = session.events.shift()!;
      retained -= removed.text.length;
      session.baseOffset = removed.offset + removed.text.length;
    }
  }

  private async pumpStream(session: CommandSession, stream: 'stdout' | 'stderr', body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        this.append(session, stream, decoder.decode(value, { stream: true }));
      }
      const tail = decoder.decode();
      if (tail) this.append(session, stream, tail);
    } finally {
      reader.releaseLock();
    }
  }

  private async pump(session: CommandSession) {
    try {
      const streams = Promise.all([
        this.pumpStream(session, 'stdout', session.child.stdout),
        this.pumpStream(session, 'stderr', session.child.stderr),
      ]);
      const status = await session.child.status;
      await streams;
      session.exitCode = status.code;
      if (session.status === 'running') session.status = status.success ? 'completed' : 'failed';
    } catch (error) {
      if (session.status === 'running') session.status = 'failed';
      this.append(session, 'system', error instanceof Error ? error.message : String(error));
    } finally {
      if (session.timeout) clearTimeout(session.timeout);
      session.stdin?.releaseLock();
      session.stdin = undefined;
      session.finishedAt = new Date().toISOString();
      session.updatedAt = session.finishedAt;
      this.appendArtifact(
        session,
        {
          kind: 'terminal',
          status: session.status,
          finishedAt: session.finishedAt,
          ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
          timedOut: session.timedOut,
        } satisfies CommandArtifactTerminal,
      );
      await session.artifactChain;
      await cleanupSandboxInvocation(session.invocation);
      session.cleanup = setTimeout(() => this.sessions.delete(session.id), completedRetentionMs);
    }
  }
}

export const commandSessions = new CommandSessionManager();
