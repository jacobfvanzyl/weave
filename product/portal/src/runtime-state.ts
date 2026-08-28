import { dirname, join } from 'jsr:@std/path@1.1.2';

export type RuntimeStatus = 'idle' | 'exited' | 'restoring' | 'uncertain' | 'unavailable';

export type RuntimeExit = {
  success: boolean;
  code: number;
  signal?: string;
  stderrTail?: string;
};

export type RuntimeStateRecord = {
  threadId: string;
  generation: number;
  state: RuntimeStatus;
  updatedAt: string;
  lastExit?: RuntimeExit;
};

type StoredRuntimeStates = { version: 1; runtimes: RuntimeStateRecord[] };

const runtimeRecordFrom = (value: unknown): RuntimeStateRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Runtime state record must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.threadId !== 'string' || !record.threadId) throw new Error('Runtime state has no Thread ID.');
  if (!Number.isInteger(record.generation) || Number(record.generation) < 1) {
    throw new Error('Runtime state generation is invalid.');
  }
  if (!['idle', 'exited', 'restoring', 'uncertain', 'unavailable'].includes(String(record.state))) {
    throw new Error('Runtime state status is invalid.');
  }
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) {
    throw new Error('Runtime state timestamp is invalid.');
  }
  let lastExit: RuntimeExit | undefined;
  if (record.lastExit !== undefined) {
    if (!record.lastExit || typeof record.lastExit !== 'object' || Array.isArray(record.lastExit)) {
      throw new Error('Runtime exit state is invalid.');
    }
    const exit = record.lastExit as Record<string, unknown>;
    if (typeof exit.success !== 'boolean' || !Number.isInteger(exit.code)) {
      throw new Error('Runtime exit status is invalid.');
    }
    if (exit.signal !== undefined && typeof exit.signal !== 'string') {
      throw new Error('Runtime exit signal is invalid.');
    }
    if (exit.stderrTail !== undefined && typeof exit.stderrTail !== 'string') {
      throw new Error('Runtime stderr tail is invalid.');
    }
    lastExit = {
      success: exit.success,
      code: Number(exit.code),
      ...(exit.signal === undefined ? {} : { signal: exit.signal as string }),
      ...(exit.stderrTail === undefined ? {} : { stderrTail: exit.stderrTail as string }),
    };
  }
  return {
    threadId: record.threadId,
    generation: Number(record.generation),
    state: record.state as RuntimeStatus,
    updatedAt: record.updatedAt,
    ...(lastExit ? { lastExit } : {}),
  };
};

export class RuntimeStateStore {
  readonly #path: string;
  #records: Map<string, RuntimeStateRecord>;
  #mutationQueue = Promise.resolve();

  private constructor(stateDirectory: string, records: RuntimeStateRecord[]) {
    this.#path = join(stateDirectory, 'runtime-states.json');
    this.#records = new Map(records.map((record) => [record.threadId, record]));
  }

  static async open(stateDirectory: string) {
    const path = join(stateDirectory, 'runtime-states.json');
    try {
      const value = JSON.parse(await Deno.readTextFile(path)) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Runtime state store must be an object.');
      }
      const stored = value as Record<string, unknown>;
      if (stored.version !== 1 || !Array.isArray(stored.runtimes)) {
        throw new Error('Runtime state store version is unsupported.');
      }
      const records = stored.runtimes.map(runtimeRecordFrom);
      if (new Set(records.map((record) => record.threadId)).size !== records.length) {
        throw new Error('Runtime state store contains duplicate Thread IDs.');
      }
      await Deno.chmod(path, 0o600).catch(() => undefined);
      return new RuntimeStateStore(stateDirectory, records);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return new RuntimeStateStore(stateDirectory, []);
      throw new Error(`Runtime state store is invalid: ${path}`, { cause });
    }
  }

  async start(threadId: string, state: 'idle' | 'restoring') {
    return await this.#mutate(async () => {
      const record: RuntimeStateRecord = {
        threadId,
        generation: (this.#records.get(threadId)?.generation ?? 0) + 1,
        state,
        updatedAt: new Date().toISOString(),
      };
      await this.#put(record);
      return record;
    });
  }

  async transition(threadId: string, generation: number, state: RuntimeStatus, lastExit?: RuntimeExit) {
    return await this.#mutate(async () => {
      const current = this.#records.get(threadId);
      if (!current || current.generation !== generation) {
        throw new Error(`Runtime generation is stale for Thread: ${threadId}`);
      }
      const record: RuntimeStateRecord = {
        ...current,
        state,
        updatedAt: new Date().toISOString(),
        ...(lastExit ? { lastExit } : {}),
      };
      await this.#put(record);
      return record;
    });
  }

  async delete(threadId: string) {
    await this.#mutate(async () => {
      if (!this.#records.has(threadId)) return;
      const records = new Map(this.#records);
      records.delete(threadId);
      await this.#write(records);
    });
  }

  async #put(record: RuntimeStateRecord) {
    const records = new Map(this.#records).set(record.threadId, record);
    await this.#write(records);
  }

  async #write(records: Map<string, RuntimeStateRecord>) {
    await Deno.mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.writeTextFile(
        temporary,
        `${JSON.stringify({ version: 1, runtimes: [...records.values()] } satisfies StoredRuntimeStates, null, 2)}\n`,
        { mode: 0o600 },
      );
      await Deno.rename(temporary, this.#path);
      await Deno.chmod(this.#path, 0o600);
      this.#records = records;
    } finally {
      await Deno.remove(temporary).catch((cause) => {
        if (!(cause instanceof Deno.errors.NotFound)) throw cause;
      });
    }
  }

  async #mutate<T>(operation: () => Promise<T>) {
    const result = this.#mutationQueue.then(operation);
    this.#mutationQueue = result.then(() => undefined, () => undefined);
    return await result;
  }
}
