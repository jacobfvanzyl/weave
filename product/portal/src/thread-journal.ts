import { dirname, join } from 'jsr:@std/path@1.1.2';
import { type JsonRpcMessage, parseJsonRpcMessage } from './json-rpc.ts';

export type ThreadEventRecord = {
  threadId: string;
  sequence: number;
  eventId: string;
  createdAt: string;
  message: JsonRpcMessage;
};

type StoredJournal = {
  version: 2;
  compactedThrough: Record<string, number>;
  events: ThreadEventRecord[];
};

type LoadedJournal = {
  compactedThrough: Map<string, number>;
  events: ThreadEventRecord[];
};

const DEFAULT_RETENTION_LIMIT = 10_000;

const NON_CONVERSATIONAL_SESSION_UPDATES = new Set([
  'available_commands_update',
  'config_option_update',
  'current_mode_update',
  'session_info_update',
  'usage_update',
]);

const isNonConversationalEvent = (event: ThreadEventRecord) => {
  if (event.message.method !== 'session/update') return false;
  const params = event.message.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  const update = (params as { update?: unknown }).update;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return false;
  const sessionUpdate = (update as { sessionUpdate?: unknown }).sessionUpdate;
  return typeof sessionUpdate === 'string' && NON_CONVERSATIONAL_SESSION_UPDATES.has(sessionUpdate);
};

const eventRecordFrom = (value: unknown): ThreadEventRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Thread event record must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.threadId !== 'string' || !record.threadId) {
    throw new Error('Thread event record has no Thread ID.');
  }
  if (!Number.isInteger(record.sequence) || Number(record.sequence) < 1) {
    throw new Error('Thread event record has an invalid sequence.');
  }
  if (typeof record.eventId !== 'string' || !record.eventId) {
    throw new Error('Thread event record has no event ID.');
  }
  if (typeof record.createdAt !== 'string' || Number.isNaN(Date.parse(record.createdAt))) {
    throw new Error('Thread event record has an invalid timestamp.');
  }
  return {
    threadId: record.threadId,
    sequence: Number(record.sequence),
    eventId: record.eventId,
    createdAt: record.createdAt,
    message: parseJsonRpcMessage(JSON.stringify(record.message)),
  };
};

const journalFrom = (value: unknown): LoadedJournal => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Thread event journal must be an object.');
  }
  const record = value as Record<string, unknown>;
  if ((record.version !== 1 && record.version !== 2) || !Array.isArray(record.events)) {
    throw new Error('Thread event journal version is unsupported.');
  }
  const compactedThrough = new Map<string, number>();
  if (record.version === 2) {
    if (
      !record.compactedThrough || typeof record.compactedThrough !== 'object' || Array.isArray(record.compactedThrough)
    ) {
      throw new Error('Thread event journal compaction watermarks are invalid.');
    }
    for (const [threadId, sequence] of Object.entries(record.compactedThrough as Record<string, unknown>)) {
      if (!threadId || !Number.isInteger(sequence) || Number(sequence) < 0) {
        throw new Error('Thread event journal compaction watermark is invalid.');
      }
      compactedThrough.set(threadId, Number(sequence));
    }
  }
  const events = record.events.map(eventRecordFrom);
  const lastSequence = new Map(compactedThrough);
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate Thread event ID: ${event.eventId}`);
    eventIds.add(event.eventId);
    const expected = (lastSequence.get(event.threadId) ?? 0) + 1;
    if (event.sequence !== expected) {
      throw new Error(
        `Discontinuous Thread event sequence for ${event.threadId}: expected ${expected}, received ${event.sequence}.`,
      );
    }
    lastSequence.set(event.threadId, event.sequence);
  }
  return { compactedThrough, events };
};

export class ThreadEventJournal {
  readonly #path: string;
  readonly #retentionLimit: number;
  #compactedThrough: Map<string, number>;
  #events: ThreadEventRecord[];
  #mutationQueue = Promise.resolve();

  private constructor(
    stateDirectory: string,
    retentionLimit: number,
    events: ThreadEventRecord[],
    compactedThrough: Map<string, number>,
  ) {
    this.#path = join(stateDirectory, 'thread-events.json');
    this.#retentionLimit = retentionLimit;
    this.#events = events;
    this.#compactedThrough = compactedThrough;
  }

  static async open(stateDirectory: string, retentionLimit = DEFAULT_RETENTION_LIMIT) {
    if (!Number.isInteger(retentionLimit) || retentionLimit < 1) {
      throw new Error('Thread event retention limit must be a positive integer.');
    }
    const path = join(stateDirectory, 'thread-events.json');
    try {
      const journal = journalFrom(JSON.parse(await Deno.readTextFile(path)));
      await Deno.chmod(path, 0o600).catch(() => undefined);
      return new ThreadEventJournal(stateDirectory, retentionLimit, journal.events, journal.compactedThrough);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) {
        return new ThreadEventJournal(stateDirectory, retentionLimit, [], new Map());
      }
      throw new Error(`Thread event journal is invalid: ${path}`, { cause });
    }
  }

  async append(threadId: string, message: JsonRpcMessage) {
    if (!threadId) throw new Error('Thread ID is required.');
    const operation = this.#mutationQueue.then(async () => {
      const sequence = (this.#events.findLast((event) => event.threadId === threadId)?.sequence ??
        this.#compactedThrough.get(threadId) ?? 0) + 1;
      const event: ThreadEventRecord = {
        threadId,
        sequence,
        eventId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        message: parseJsonRpcMessage(JSON.stringify(message)),
      };
      let events = [...this.#events, event];
      const threadEvents = events.filter((candidate) => candidate.threadId === threadId);
      const removeCount = Math.max(0, threadEvents.length - this.#retentionLimit);
      const compactedThrough = new Map(this.#compactedThrough);
      if (removeCount > 0) {
        const removed = threadEvents.slice(0, removeCount);
        const removedIds = new Set(removed.map((candidate) => candidate.eventId));
        events = events.filter((candidate) => !removedIds.has(candidate.eventId));
        compactedThrough.set(threadId, removed.at(-1)!.sequence);
      }
      await this.#persist(events, compactedThrough);
      this.#events = events;
      this.#compactedThrough = compactedThrough;
      return event;
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async read(threadId: string, afterSequence?: number) {
    await this.#mutationQueue;
    if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
      throw new Error('Thread event cursor must be a non-negative integer.');
    }
    const threadEvents = this.#events.filter((event) => event.threadId === threadId);
    const compactedThrough = this.#compactedThrough.get(threadId) ?? 0;
    const lastSequence = threadEvents.at(-1)?.sequence ?? compactedThrough;
    if (afterSequence !== undefined && afterSequence > lastSequence) {
      throw new Error(`Thread event cursor ${afterSequence} is ahead of sequence ${lastSequence}.`);
    }
    return {
      events: afterSequence === undefined
        ? threadEvents
        : threadEvents.filter((event) => event.sequence > afterSequence),
      compactedThrough,
      cursorExpired: afterSequence !== undefined && afterSequence < compactedThrough,
      lastSequence,
    };
  }

  async clearIfNoConversation(threadId: string) {
    if (!threadId) throw new Error('Thread ID is required.');
    const operation = this.#mutationQueue.then(async () => {
      if ((this.#compactedThrough.get(threadId) ?? 0) > 0) return false;
      const threadEvents = this.#events.filter((event) => event.threadId === threadId);
      if (threadEvents.some((event) => !isNonConversationalEvent(event))) return false;
      if (threadEvents.length === 0) return true;

      const events = this.#events.filter((event) => event.threadId !== threadId);
      const compactedThrough = new Map(this.#compactedThrough);
      compactedThrough.delete(threadId);
      await this.#persist(events, compactedThrough);
      this.#events = events;
      this.#compactedThrough = compactedThrough;
      return true;
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async #persist(events: ThreadEventRecord[], compactedThrough: Map<string, number>) {
    await Deno.mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(
        temporary,
        `${
          JSON.stringify(
            {
              version: 2,
              compactedThrough: Object.fromEntries([...compactedThrough.entries()].sort()),
              events,
            } satisfies StoredJournal,
            null,
            2,
          )
        }\n`,
        { mode: 0o600 },
      );
      await Deno.rename(temporary, this.#path);
      await Deno.chmod(this.#path, 0o600);
    } finally {
      await Deno.remove(temporary).catch((cause) => {
        if (!(cause instanceof Deno.errors.NotFound)) throw cause;
      });
    }
  }
}
