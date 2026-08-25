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
  version: 1;
  events: ThreadEventRecord[];
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

const journalFrom = (value: unknown): StoredJournal => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Thread event journal must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.events)) {
    throw new Error('Thread event journal version is unsupported.');
  }
  const events = record.events.map(eventRecordFrom);
  const lastSequence = new Map<string, number>();
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
  return { version: 1, events };
};

export class ThreadEventJournal {
  readonly #path: string;
  #events: ThreadEventRecord[];
  #mutationQueue = Promise.resolve();

  private constructor(stateDirectory: string, events: ThreadEventRecord[]) {
    this.#path = join(stateDirectory, 'thread-events.json');
    this.#events = events;
  }

  static async open(stateDirectory: string) {
    const path = join(stateDirectory, 'thread-events.json');
    try {
      const journal = journalFrom(JSON.parse(await Deno.readTextFile(path)));
      await Deno.chmod(path, 0o600).catch(() => undefined);
      return new ThreadEventJournal(stateDirectory, journal.events);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return new ThreadEventJournal(stateDirectory, []);
      throw new Error(`Thread event journal is invalid: ${path}`, { cause });
    }
  }

  async append(threadId: string, message: JsonRpcMessage) {
    if (!threadId) throw new Error('Thread ID is required.');
    const operation = this.#mutationQueue.then(async () => {
      const sequence = (this.#events.findLast((event) => event.threadId === threadId)?.sequence ?? 0) + 1;
      const event: ThreadEventRecord = {
        threadId,
        sequence,
        eventId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        message: parseJsonRpcMessage(JSON.stringify(message)),
      };
      const events = [...this.#events, event];
      await this.#persist(events);
      this.#events = events;
      return event;
    });
    this.#mutationQueue = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async read(threadId: string, afterSequence?: number) {
    await this.#mutationQueue;
    const threadEvents = this.#events.filter((event) => event.threadId === threadId);
    return {
      events: afterSequence === undefined
        ? threadEvents
        : threadEvents.filter((event) => event.sequence > afterSequence),
      lastSequence: threadEvents.at(-1)?.sequence ?? 0,
    };
  }

  async #persist(events: ThreadEventRecord[]) {
    await Deno.mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(
        temporary,
        `${JSON.stringify({ version: 1, events } satisfies StoredJournal, null, 2)}\n`,
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
