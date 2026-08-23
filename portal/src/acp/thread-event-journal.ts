import { type JsonRpcMessage, jsonRpcMessageSchema } from '@weave/protocol';
import { z } from 'zod';
import { ensureParentDir } from '../lifecycle.ts';

export const threadEventStreamSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  acpSessionId: z.string().min(1),
}).strict();

export type ThreadEventStream = z.infer<typeof threadEventStreamSchema>;

export const threadEventRecordSchema = threadEventStreamSchema.extend({
  sequence: z.number().int().positive(),
  eventId: z.string().min(1),
  createdAt: z.string().datetime(),
  message: jsonRpcMessageSchema,
}).strict();

export type ThreadEventRecord = z.infer<typeof threadEventRecordSchema>;

const persistedCompactionSchema = threadEventStreamSchema.extend({
  throughSequence: z.number().int().nonnegative(),
}).strict();

const persistedJournalHeaderSchema = z.union([
  z.object({ version: z.literal(1) }).strict(),
  z.object({
    version: z.literal(2),
    compacted: z.array(persistedCompactionSchema),
  }).strict(),
]);

export type ThreadEventListOptions = { afterSequence?: number };

export type ThreadEventReadResult = {
  readonly events: ThreadEventRecord[];
  readonly compactedThrough: number;
  readonly lastSequence: number;
  readonly cursorExpired: boolean;
};

export interface ThreadEventJournal {
  append(stream: ThreadEventStream, message: JsonRpcMessage): Promise<ThreadEventRecord>;
  list(stream: ThreadEventStream, options?: ThreadEventListOptions): Promise<ThreadEventRecord[]>;
  read(stream: ThreadEventStream, options?: ThreadEventListOptions): Promise<ThreadEventReadResult>;
}

export type ThreadEventJournalOptions = {
  now?: () => Date;
  createId?: () => string;
  maxEventsPerStream?: number;
};

export const DEFAULT_THREAD_EVENT_RETENTION_LIMIT = 10_000;

const encoder = new TextEncoder();
const streamKey = ({ agentId, workspaceId, acpSessionId }: ThreadEventStream) =>
  `${agentId}\u0000${workspaceId}\u0000${acpSessionId}`;

const validateEvents = (events: ThreadEventRecord[], compactedThrough = new Map<string, number>()) => {
  const lastSequences = new Map(compactedThrough);
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate Host Thread event id: ${event.eventId}`);
    eventIds.add(event.eventId);
    const key = streamKey(event);
    const expected = (lastSequences.get(key) ?? 0) + 1;
    if (event.sequence !== expected) {
      throw new Error(`Discontinuous Host Thread event sequence: expected ${expected}, received ${event.sequence}`);
    }
    lastSequences.set(key, event.sequence);
  }
  return { lastSequences, eventIds };
};

const parseRetentionLimit = (value: number | undefined) => {
  const limit = value ?? DEFAULT_THREAD_EVENT_RETENTION_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('Host Thread event retention limit must be a positive integer.');
  }
  return limit;
};

const recordFor = (
  stream: ThreadEventStream,
  message: JsonRpcMessage,
  sequence: number,
  now: () => Date,
  createId: () => string,
) =>
  threadEventRecordSchema.parse({
    ...threadEventStreamSchema.parse(stream),
    sequence,
    eventId: createId(),
    createdAt: now().toISOString(),
    message: jsonRpcMessageSchema.parse(message),
  });

const matchingEvents = (
  events: ThreadEventRecord[],
  stream: ThreadEventStream,
  options: ThreadEventListOptions = {},
) => {
  const key = streamKey(threadEventStreamSchema.parse(stream));
  const afterSequence = options.afterSequence ?? 0;
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    throw new Error('Host Thread event cursor must be a non-negative integer.');
  }
  return events
    .filter((event) => streamKey(event) === key && event.sequence > afterSequence)
    .map((event) => threadEventRecordSchema.parse(event));
};

const readEvents = (
  events: ThreadEventRecord[],
  compactedThrough: Map<string, number>,
  lastSequences: Map<string, number>,
  stream: ThreadEventStream,
  options: ThreadEventListOptions = {},
): ThreadEventReadResult => {
  const parsedStream = threadEventStreamSchema.parse(stream);
  const key = streamKey(parsedStream);
  const afterSequence = options.afterSequence ?? 0;
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    throw new Error('Host Thread event cursor must be a non-negative integer.');
  }
  const lastSequence = lastSequences.get(key) ?? 0;
  if (afterSequence > lastSequence) {
    throw new Error(`Host Thread event cursor ${afterSequence} is ahead of sequence ${lastSequence}.`);
  }
  const throughSequence = compactedThrough.get(key) ?? 0;
  return {
    events: matchingEvents(events, parsedStream, { afterSequence: Math.max(afterSequence, throughSequence) }),
    compactedThrough: throughSequence,
    lastSequence,
    cursorExpired: afterSequence < throughSequence,
  };
};

const writeAll = async (file: Deno.FsFile, bytes: Uint8Array) => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = await file.write(bytes.subarray(offset));
    if (written === 0) throw new Error('Host Thread event journal write made no progress.');
    offset += written;
  }
};

const truncateAndSync = async (path: string, length: number) => {
  await Deno.truncate(path, length);
  const file = await Deno.open(path, { write: true });
  try {
    await file.syncData();
  } finally {
    file.close();
  }
};

export class InMemoryThreadEventJournal implements ThreadEventJournal {
  private events: ThreadEventRecord[] = [];
  private readonly lastSequences = new Map<string, number>();
  private readonly compactedThrough = new Map<string, number>();
  private readonly eventIds = new Set<string>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxEventsPerStream: number;

  constructor(options: ThreadEventJournalOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.maxEventsPerStream = parseRetentionLimit(options.maxEventsPerStream);
  }

  append(stream: ThreadEventStream, message: JsonRpcMessage): Promise<ThreadEventRecord> {
    const parsedStream = threadEventStreamSchema.parse(stream);
    const key = streamKey(parsedStream);
    const event = recordFor(
      parsedStream,
      message,
      (this.lastSequences.get(key) ?? 0) + 1,
      this.now,
      this.createId,
    );
    if (this.eventIds.has(event.eventId)) throw new Error(`Duplicate Host Thread event id: ${event.eventId}`);
    this.events.push(event);
    this.lastSequences.set(key, event.sequence);
    this.eventIds.add(event.eventId);
    const streamEvents = this.events.filter((candidate) => streamKey(candidate) === key);
    if (streamEvents.length > this.maxEventsPerStream) {
      const removed = streamEvents.slice(0, streamEvents.length - this.maxEventsPerStream);
      const removedIds = new Set(removed.map(({ eventId }) => eventId));
      this.events = this.events.filter(({ eventId }) => !removedIds.has(eventId));
      for (const removedEvent of removed) this.eventIds.delete(removedEvent.eventId);
      this.compactedThrough.set(key, removed.at(-1)!.sequence);
    }
    return Promise.resolve(threadEventRecordSchema.parse(event));
  }

  list(stream: ThreadEventStream, options?: ThreadEventListOptions): Promise<ThreadEventRecord[]> {
    return Promise.resolve(matchingEvents(this.events, stream, options));
  }

  read(stream: ThreadEventStream, options?: ThreadEventListOptions): Promise<ThreadEventReadResult> {
    return Promise.resolve(readEvents(this.events, this.compactedThrough, this.lastSequences, stream, options));
  }
}

export class FileThreadEventJournal implements ThreadEventJournal {
  private readonly lastSequences: Map<string, number>;
  private readonly compactedThrough: Map<string, number>;
  private readonly eventIds: Set<string>;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly maxEventsPerStream: number;
  private mutationQueue = Promise.resolve();

  private constructor(
    readonly path: string,
    private events: ThreadEventRecord[],
    compactedThrough: Map<string, number>,
    private initialized: boolean,
    options: ThreadEventJournalOptions,
  ) {
    const validated = validateEvents(events, compactedThrough);
    this.lastSequences = validated.lastSequences;
    this.compactedThrough = compactedThrough;
    this.eventIds = validated.eventIds;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.maxEventsPerStream = parseRetentionLimit(options.maxEventsPerStream);
  }

  static async open(path: string, options: ThreadEventJournalOptions = {}): Promise<FileThreadEventJournal> {
    let events: ThreadEventRecord[] = [];
    const compactedThrough = new Map<string, number>();
    let initialized = false;
    try {
      const content = await Deno.readTextFile(path);
      const lastNewline = content.lastIndexOf('\n');
      if (lastNewline < 0) throw new Error('Host Thread event journal has no durable records.');
      const durableContent = content.slice(0, lastNewline + 1);
      const lines = durableContent.slice(0, -1).split('\n');
      const header = persistedJournalHeaderSchema.parse(JSON.parse(lines.shift() ?? ''));
      if (header.version === 2) {
        for (const compacted of header.compacted) {
          const key = streamKey(compacted);
          if (compactedThrough.has(key)) throw new Error(`Duplicate Host Thread compaction stream: ${key}`);
          compactedThrough.set(key, compacted.throughSequence);
        }
      }
      events = lines.map((line) => threadEventRecordSchema.parse(JSON.parse(line)));
      validateEvents(events, compactedThrough);
      if (durableContent.length !== content.length) {
        await truncateAndSync(path, encoder.encode(durableContent).byteLength);
      }
      await Deno.chmod(path, 0o600).catch(() => undefined);
      initialized = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(`Host Thread event journal is invalid: ${path}`, { cause: error });
      }
    }
    return new FileThreadEventJournal(path, events, compactedThrough, initialized, options);
  }

  async append(stream: ThreadEventStream, message: JsonRpcMessage): Promise<ThreadEventRecord> {
    return await this.mutate(async () => {
      const parsedStream = threadEventStreamSchema.parse(stream);
      const key = streamKey(parsedStream);
      const event = recordFor(
        parsedStream,
        message,
        (this.lastSequences.get(key) ?? 0) + 1,
        this.now,
        this.createId,
      );
      if (this.eventIds.has(event.eventId)) throw new Error(`Duplicate Host Thread event id: ${event.eventId}`);
      const candidateEvents = [...this.events, event];
      const streamEvents = candidateEvents.filter((candidate) => streamKey(candidate) === key);
      const removeCount = Math.max(0, streamEvents.length - this.maxEventsPerStream);
      if (removeCount > 0) {
        const removed = streamEvents.slice(0, removeCount);
        const removedIds = new Set(removed.map(({ eventId }) => eventId));
        const retainedEvents = candidateEvents.filter(({ eventId }) => !removedIds.has(eventId));
        const throughSequence = removed.at(-1)!.sequence;
        const compacted = new Map(this.compactedThrough).set(key, throughSequence);
        await this.replacePersistedState(retainedEvents, compacted);
        this.events = retainedEvents;
        this.compactedThrough.set(key, throughSequence);
        for (const removedEvent of removed) this.eventIds.delete(removedEvent.eventId);
      } else {
        await this.ensureInitialized();
        const originalSize = (await Deno.stat(this.path)).size;
        try {
          const file = await Deno.open(this.path, { append: true, write: true });
          try {
            await writeAll(file, encoder.encode(`${JSON.stringify(event)}\n`));
            await file.syncData();
          } finally {
            file.close();
          }
        } catch (error) {
          await truncateAndSync(this.path, originalSize).catch(() => undefined);
          throw error;
        }
        this.events.push(event);
      }
      this.lastSequences.set(key, event.sequence);
      this.eventIds.add(event.eventId);
      return threadEventRecordSchema.parse(event);
    });
  }

  async list(stream: ThreadEventStream, options?: ThreadEventListOptions): Promise<ThreadEventRecord[]> {
    await this.mutationQueue;
    return matchingEvents(this.events, stream, options);
  }

  async read(stream: ThreadEventStream, options?: ThreadEventListOptions): Promise<ThreadEventReadResult> {
    await this.mutationQueue;
    return readEvents(this.events, this.compactedThrough, this.lastSequences, stream, options);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    await ensureParentDir(this.path);
    const temporaryPath = `${this.path}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const file = await Deno.open(temporaryPath, { write: true, createNew: true, mode: 0o600 });
      try {
        const header = persistedJournalHeaderSchema.parse({ version: 1 });
        await writeAll(file, encoder.encode(`${JSON.stringify(header)}\n`));
        await file.syncData();
      } finally {
        file.close();
      }
      await Deno.chmod(temporaryPath, 0o600).catch(() => undefined);
      await Deno.rename(temporaryPath, this.path);
      this.initialized = true;
    } finally {
      await Deno.remove(temporaryPath).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }

  private async replacePersistedState(events: ThreadEventRecord[], compactedThrough: Map<string, number>) {
    await ensureParentDir(this.path);
    const temporaryPath = `${this.path}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const compacted = [...compactedThrough.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, throughSequence]) => {
          const [agentId, workspaceId, acpSessionId] = key.split('\u0000');
          return persistedCompactionSchema.parse({ agentId, workspaceId, acpSessionId, throughSequence });
        });
      const header = persistedJournalHeaderSchema.parse({ version: 2, compacted });
      const content = [JSON.stringify(header), ...events.map((event) => JSON.stringify(event)), ''].join('\n');
      const file = await Deno.open(temporaryPath, { write: true, createNew: true, mode: 0o600 });
      try {
        await writeAll(file, encoder.encode(content));
        await file.syncData();
      } finally {
        file.close();
      }
      await Deno.chmod(temporaryPath, 0o600).catch(() => undefined);
      await Deno.rename(temporaryPath, this.path);
      this.initialized = true;
    } finally {
      await Deno.remove(temporaryPath).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
}
