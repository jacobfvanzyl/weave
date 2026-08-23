import { type JsonRpcMessage, jsonRpcMessageSchema } from '@weave/protocol';
import { AcpSessionTracker } from './session-tracker.ts';
import type { ThreadCatalog } from './thread-catalog.ts';
import type { AgentWorkspaceSelection, ResolvedAgentWorkspace } from './workspace.ts';

export type AgentDefinition = {
  id: string;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type AgentAttachInput = AgentWorkspaceSelection & {
  agentId: string;
  acpSessionId?: string;
  principalId: string;
  transport: 'stdio' | 'remote-acp';
};

export type AgentAttachmentExit = {
  readonly success: boolean;
  readonly code: number;
  readonly signal?: string;
  readonly error?: string;
  readonly stderrTail: string;
};

export type AgentAttachment = {
  readonly agentId: string;
  readonly workspaceId: string;
  receive(message: JsonRpcMessage): Promise<void>;
  close(reason?: string): Promise<void>;
  readonly messages: ReadableStream<JsonRpcMessage>;
  readonly stderrTail: () => string;
  readonly finished: Promise<AgentAttachmentExit>;
};

export interface AgentRuntimePort {
  listDefinitions(): Omit<AgentDefinition, 'env'>[];
  attach(input: AgentAttachInput): Promise<AgentAttachment>;
}

type SpawnedAgentProcess = {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  status: Promise<{ success: boolean; code: number; signal?: string }>;
  kill(signal?: Deno.Signal): void;
};

type AgentRuntimeDependencies = {
  resolveWorkspace(selection: AgentWorkspaceSelection, principalId: string): Promise<ResolvedAgentWorkspace>;
  threadCatalog?: ThreadCatalog;
  spawn?(definition: AgentDefinition, cwd: string): SpawnedAgentProcess;
  maxMessageBytes?: number;
  maxStderrBytes?: number;
  closeGraceMs?: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const readLines = async function* (
  stream: ReadableStream<Uint8Array>,
  maxLineBytes: number,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  let pending = new Uint8Array();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const merged = new Uint8Array(pending.byteLength + value.byteLength);
      merged.set(pending);
      merged.set(value, pending.byteLength);
      let start = 0;
      for (let index = 0; index < merged.byteLength; index += 1) {
        if (merged[index] !== 0x0a) continue;
        const line = merged.subarray(start, index);
        if (line.byteLength > maxLineBytes) throw new Error('ACP message exceeds the configured limit.');
        yield decoder.decode(line.byteLength && line[line.byteLength - 1] === 0x0d ? line.subarray(0, -1) : line);
        start = index + 1;
      }
      pending = merged.slice(start);
      if (pending.byteLength > maxLineBytes) throw new Error('ACP message exceeds the configured limit.');
    }
    if (pending.byteLength) yield decoder.decode(pending);
  } finally {
    reader.releaseLock();
  }
};

const defaultSpawn = (definition: AgentDefinition, cwd: string): SpawnedAgentProcess => {
  const child = new Deno.Command(definition.command, {
    args: definition.args ?? [],
    cwd,
    env: definition.env ?? {},
    clearEnv: true,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  return child as SpawnedAgentProcess;
};

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export class AgentRuntimeManager implements AgentRuntimePort {
  private readonly definitions = new Map<string, AgentDefinition>();
  private readonly spawn: NonNullable<AgentRuntimeDependencies['spawn']>;
  private readonly maxMessageBytes: number;
  private readonly maxStderrBytes: number;
  private readonly closeGraceMs: number;

  constructor(
    definitions: AgentDefinition[],
    private readonly dependencies: AgentRuntimeDependencies,
  ) {
    for (const definition of definitions) {
      if (!definition.id.trim()) throw new Error('Agent definition id is required.');
      if (this.definitions.has(definition.id)) throw new Error(`Duplicate Agent definition: ${definition.id}`);
      this.definitions.set(definition.id, definition);
    }
    this.spawn = dependencies.spawn ?? defaultSpawn;
    this.maxMessageBytes = dependencies.maxMessageBytes ?? 4 * 1024 * 1024;
    this.maxStderrBytes = dependencies.maxStderrBytes ?? 64 * 1024;
    this.closeGraceMs = dependencies.closeGraceMs ?? 500;
  }

  listDefinitions() {
    return [...this.definitions.values()].map(({ env: _env, ...definition }) => definition);
  }

  async attach(input: AgentAttachInput): Promise<AgentAttachment> {
    const definition = this.definitions.get(input.agentId);
    if (!definition) throw new Error(`Unknown or unavailable Agent: ${input.agentId}`);
    const workspace = await this.dependencies.resolveWorkspace({
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
    }, input.principalId);
    const sessionTracker = this.dependencies.threadCatalog
      ? new AcpSessionTracker(this.dependencies.threadCatalog, {
        agentId: input.agentId,
        workspaceId: workspace.workspaceId,
        principalId: input.principalId,
      })
      : undefined;
    const process = this.spawn(definition, workspace.path);
    const stdin = process.stdin.getWriter();
    let writeQueue = Promise.resolve();
    let closed = false;
    let streamController: ReadableStreamDefaultController<JsonRpcMessage> | undefined;
    let stderr = new Uint8Array();
    let streamError: string | undefined;

    const messages = new ReadableStream<JsonRpcMessage>({
      start(controller) {
        streamController = controller;
      },
    });

    const stdoutTask = (async () => {
      try {
        for await (const line of readLines(process.stdout, this.maxMessageBytes)) {
          if (!line.trim()) throw new Error('ACP agent emitted an empty stdout line.');
          const message = jsonRpcMessageSchema.parse(JSON.parse(line));
          await sessionTracker?.observeAgentMessage(message);
          streamController?.enqueue(message);
        }
        try {
          streamController?.close();
        } catch {
          // The attachment owner may already have cancelled the stream.
        }
      } catch (error) {
        streamError = error instanceof Error ? error.message : String(error);
        try {
          streamController?.error(error);
        } catch {
          // The attachment owner may already have cancelled the stream.
        }
      }
    })();

    const stderrTask = (async () => {
      const reader = process.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const merged = new Uint8Array(Math.min(this.maxStderrBytes, stderr.byteLength + value.byteLength));
          const source = new Uint8Array(stderr.byteLength + value.byteLength);
          source.set(stderr);
          source.set(value, stderr.byteLength);
          merged.set(source.subarray(source.byteLength - merged.byteLength));
          stderr = merged;
        }
      } finally {
        reader.releaseLock();
      }
    })();

    const status = process.status.finally(() => {
      closed = true;
    });
    const finished = status.then(async (result) => {
      await Promise.allSettled([stdoutTask, stderrTask]);
      return {
        success: result.success,
        code: result.code,
        ...(result.signal ? { signal: result.signal } : {}),
        ...(streamError ? { error: streamError } : {}),
        stderrTail: decoder.decode(stderr),
      };
    });

    const close = async (reason = 'ACP attachment closed.') => {
      if (closed) {
        await Promise.allSettled([stdoutTask, stderrTask, status]);
        return;
      }
      closed = true;
      await writeQueue.catch(() => undefined);
      await stdin.close().catch(() => undefined);
      const exited = await Promise.race([status.then(() => true), delay(this.closeGraceMs).then(() => false)]);
      if (!exited) {
        try {
          process.kill('SIGTERM');
        } catch {
          // The process exited between the status check and signal.
        }
      }
      const terminated = await Promise.race([status.then(() => true), delay(this.closeGraceMs).then(() => false)])
        .catch(() => true);
      if (!terminated) {
        try {
          process.kill('SIGKILL');
        } catch {
          // The process exited between the status check and signal.
        }
      }
      await status.catch(() => undefined);
      try {
        streamController?.error(new Error(reason));
      } catch {
        // The stdout task may already have closed the stream.
      }
      await Promise.allSettled([stdoutTask, stderrTask]);
    };

    return {
      agentId: input.agentId,
      workspaceId: workspace.workspaceId,
      messages,
      stderrTail: () => decoder.decode(stderr),
      finished,
      receive: async (message) => {
        if (closed) throw new Error('ACP attachment is closed.');
        const parsed = jsonRpcMessageSchema.parse(message);
        sessionTracker?.observeClientMessage(parsed);
        const encoded = encoder.encode(`${JSON.stringify(parsed)}\n`);
        if (encoded.byteLength > this.maxMessageBytes) throw new Error('ACP message exceeds the configured limit.');
        const write = writeQueue.then(() => stdin.write(encoded));
        writeQueue = write.then(() => undefined, () => undefined);
        await write;
      },
      close,
    };
  }
}

export const acpRuntimeInternals = { readLines };
