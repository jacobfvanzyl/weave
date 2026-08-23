import { z } from 'zod';
import { ensureParentDir } from '../lifecycle.ts';
import type { AgentAttachmentExit } from './runtime.ts';

export const hostedRuntimeStateSchema = z.enum([
  'idle',
  'prompting',
  'awaiting_client',
  'exited',
  'restoring',
  'uncertain',
  'unavailable',
]);
export type HostedRuntimeState = z.infer<typeof hostedRuntimeStateSchema>;

export const runtimeStreamSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  acpSessionId: z.string().min(1),
}).strict();
export type RuntimeStream = z.infer<typeof runtimeStreamSchema>;

const runtimeExitSchema = z.object({
  success: z.boolean(),
  code: z.number().int(),
  signal: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  stderrTail: z.string(),
  occurredAt: z.string().datetime(),
}).strict();
export type RuntimeExitRecord = z.infer<typeof runtimeExitSchema>;

export const runtimeStateRecordSchema = runtimeStreamSchema.extend({
  generation: z.number().int().positive(),
  state: hostedRuntimeStateSchema,
  updatedAt: z.string().datetime(),
  lastExit: runtimeExitSchema.optional(),
}).strict();
export type RuntimeStateRecord = z.infer<typeof runtimeStateRecordSchema>;

const persistedRuntimeStateSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(runtimeStateRecordSchema),
}).strict();

export type RuntimeStateTransition = {
  state: HostedRuntimeState;
  exit?: AgentAttachmentExit;
};

export interface RuntimeStateStore {
  start(stream: RuntimeStream, state: 'idle' | 'restoring'): Promise<RuntimeStateRecord>;
  transition(
    stream: RuntimeStream,
    generation: number,
    transition: RuntimeStateTransition,
  ): Promise<RuntimeStateRecord | undefined>;
  get(stream: RuntimeStream): Promise<RuntimeStateRecord | undefined>;
}

const streamKey = ({ agentId, workspaceId, acpSessionId }: RuntimeStream) =>
  `${agentId}\u0000${workspaceId}\u0000${acpSessionId}`;

const maxPersistedStderrBytes = 8 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const boundedTail = (value: string) => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxPersistedStderrBytes) return value;
  let tail = decoder.decode(
    bytes.subarray(bytes.byteLength - maxPersistedStderrBytes),
  );
  while (encoder.encode(tail).byteLength > maxPersistedStderrBytes) {
    tail = [...tail].slice(1).join('');
  }
  return tail;
};

const exitRecord = (
  exit: AgentAttachmentExit,
  occurredAt: string,
): RuntimeExitRecord =>
  runtimeExitSchema.parse({
    ...exit,
    stderrTail: boundedTail(exit.stderrTail),
    occurredAt,
  });

type RuntimeStateStoreOptions = {
  now?: () => Date;
};

abstract class BaseRuntimeStateStore implements RuntimeStateStore {
  protected readonly records = new Map<string, RuntimeStateRecord>();
  protected mutationQueue = Promise.resolve();
  protected readonly now: () => Date;

  constructor(records: RuntimeStateRecord[], options: RuntimeStateStoreOptions) {
    this.now = options.now ?? (() => new Date());
    for (const record of records) {
      const key = streamKey(record);
      if (this.records.has(key)) {
        throw new Error(`Duplicate Host runtime state stream: ${key}`);
      }
      this.records.set(key, runtimeStateRecordSchema.parse(record));
    }
  }

  async start(
    rawStream: RuntimeStream,
    state: 'idle' | 'restoring',
  ): Promise<RuntimeStateRecord> {
    return await this.mutate(async () => {
      const stream = runtimeStreamSchema.parse(rawStream);
      const previous = this.records.get(streamKey(stream));
      const record = runtimeStateRecordSchema.parse({
        ...stream,
        generation: (previous?.generation ?? 0) + 1,
        state,
        updatedAt: this.now().toISOString(),
        ...(previous?.lastExit ? { lastExit: previous.lastExit } : {}),
      });
      this.records.set(streamKey(stream), record);
      await this.persist();
      return { ...record };
    });
  }

  async transition(
    rawStream: RuntimeStream,
    generation: number,
    transition: RuntimeStateTransition,
  ): Promise<RuntimeStateRecord | undefined> {
    return await this.mutate(async () => {
      const stream = runtimeStreamSchema.parse(rawStream);
      const current = this.records.get(streamKey(stream));
      if (!current || current.generation !== generation) return undefined;
      const updatedAt = this.now().toISOString();
      const record = runtimeStateRecordSchema.parse({
        ...current,
        state: transition.state,
        updatedAt,
        ...(transition.exit ? { lastExit: exitRecord(transition.exit, updatedAt) } : {}),
      });
      this.records.set(streamKey(stream), record);
      await this.persist();
      return { ...record };
    });
  }

  async get(rawStream: RuntimeStream): Promise<RuntimeStateRecord | undefined> {
    await this.mutationQueue;
    const stream = runtimeStreamSchema.parse(rawStream);
    const record = this.records.get(streamKey(stream));
    return record ? { ...record } : undefined;
  }

  protected abstract persist(): Promise<void>;

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

export class InMemoryRuntimeStateStore extends BaseRuntimeStateStore {
  constructor(options: RuntimeStateStoreOptions = {}) {
    super([], options);
  }

  protected persist(): Promise<void> {
    return Promise.resolve();
  }
}

export class FileRuntimeStateStore extends BaseRuntimeStateStore {
  private constructor(
    readonly path: string,
    records: RuntimeStateRecord[],
    options: RuntimeStateStoreOptions,
  ) {
    super(records, options);
  }

  static async open(
    path: string,
    options: RuntimeStateStoreOptions = {},
  ): Promise<FileRuntimeStateStore> {
    let records: RuntimeStateRecord[] = [];
    try {
      const parsed = persistedRuntimeStateSchema.parse(
        JSON.parse(await Deno.readTextFile(path)),
      );
      records = parsed.runtimes;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(`Host runtime state is invalid: ${path}`, {
          cause: error,
        });
      }
    }
    return new FileRuntimeStateStore(path, records, options);
  }

  protected async persist(): Promise<void> {
    await ensureParentDir(this.path);
    const temporaryPath = `${this.path}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const runtimes = [...this.records.values()].sort((left, right) =>
        streamKey(left).localeCompare(streamKey(right))
      );
      const file = await Deno.open(temporaryPath, {
        write: true,
        createNew: true,
        mode: 0o600,
      });
      try {
        const bytes = encoder.encode(
          `${JSON.stringify({ version: 1, runtimes }, null, 2)}\n`,
        );
        let offset = 0;
        while (offset < bytes.byteLength) {
          const written = await file.write(bytes.subarray(offset));
          if (written === 0) {
            throw new Error('Host runtime state write made no progress.');
          }
          offset += written;
        }
        await file.syncData();
      } finally {
        file.close();
      }
      await Deno.chmod(temporaryPath, 0o600).catch(() => undefined);
      await Deno.rename(temporaryPath, this.path);
    } finally {
      await Deno.remove(temporaryPath).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
}
