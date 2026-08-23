import { z } from 'zod';
import { ensureParentDir } from '../lifecycle.ts';

export const hostThreadStatusSchema = z.enum(['active', 'closed', 'deleted']);
export type HostThreadStatus = z.infer<typeof hostThreadStatusSchema>;

export const hostThreadRecordSchema = z.object({
  threadId: z.string().min(1),
  agentId: z.string().min(1),
  workspaceId: z.string().min(1),
  acpSessionId: z.string().min(1),
  creatorPrincipalId: z.string().min(1),
  title: z.string().min(1).optional(),
  status: hostThreadStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastEventSequence: z.number().int().nonnegative(),
}).strict();

export type HostThreadRecord = z.infer<typeof hostThreadRecordSchema>;

const persistedCatalogSchema = z.object({
  version: z.literal(1),
  threads: z.array(hostThreadRecordSchema),
}).strict();

export type ThreadCatalogAccess = {
  workspaceIds: ReadonlySet<string>;
};

export type UpsertAcpSessionInput = {
  agentId: string;
  workspaceId: string;
  acpSessionId: string;
  creatorPrincipalId: string;
  title?: string;
};

export interface ThreadCatalog {
  upsertAcpSession(input: UpsertAcpSessionInput): Promise<HostThreadRecord>;
  touchAcpSession(agentId: string, workspaceId: string, acpSessionId: string): Promise<void>;
  setAcpSessionStatus(
    agentId: string,
    workspaceId: string,
    acpSessionId: string,
    status: HostThreadStatus,
  ): Promise<void>;
  list(access: ThreadCatalogAccess): Promise<HostThreadRecord[]>;
  get(threadId: string, access: ThreadCatalogAccess): Promise<HostThreadRecord | undefined>;
}

type FileThreadCatalogOptions = {
  now?: () => Date;
  createId?: () => string;
};

const sessionKey = (agentId: string, workspaceId: string, acpSessionId: string) =>
  `${agentId}\u0000${workspaceId}\u0000${acpSessionId}`;

export class FileThreadCatalog implements ThreadCatalog {
  private readonly threads = new Map<string, HostThreadRecord>();
  private readonly sessionIndex = new Map<string, string>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private mutationQueue = Promise.resolve();

  private constructor(
    readonly path: string,
    records: HostThreadRecord[],
    options: FileThreadCatalogOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    for (const record of records) {
      if (this.threads.has(record.threadId)) throw new Error(`Duplicate Host Thread id: ${record.threadId}`);
      const key = sessionKey(record.agentId, record.workspaceId, record.acpSessionId);
      if (this.sessionIndex.has(key)) throw new Error(`Duplicate Host ACP session: ${record.acpSessionId}`);
      this.threads.set(record.threadId, record);
      this.sessionIndex.set(key, record.threadId);
    }
  }

  static async open(path: string, options: FileThreadCatalogOptions = {}): Promise<FileThreadCatalog> {
    let records: HostThreadRecord[] = [];
    try {
      const parsed = persistedCatalogSchema.parse(JSON.parse(await Deno.readTextFile(path)));
      records = parsed.threads;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(`Host Thread catalog is invalid: ${path}`, { cause: error });
      }
    }
    return new FileThreadCatalog(path, records, options);
  }

  async upsertAcpSession(input: UpsertAcpSessionInput): Promise<HostThreadRecord> {
    return await this.mutate(async () => {
      const key = sessionKey(input.agentId, input.workspaceId, input.acpSessionId);
      const existingId = this.sessionIndex.get(key);
      const timestamp = this.now().toISOString();
      if (existingId) {
        const existing = this.threads.get(existingId)!;
        const updated = hostThreadRecordSchema.parse({
          ...existing,
          status: 'active',
          updatedAt: timestamp,
          ...(input.title ? { title: input.title } : {}),
        });
        this.threads.set(existingId, updated);
        await this.persist();
        return updated;
      }
      const created = hostThreadRecordSchema.parse({
        threadId: this.createId(),
        ...input,
        status: 'active',
        createdAt: timestamp,
        updatedAt: timestamp,
        lastEventSequence: 0,
      });
      this.threads.set(created.threadId, created);
      this.sessionIndex.set(key, created.threadId);
      await this.persist();
      return created;
    });
  }

  async touchAcpSession(agentId: string, workspaceId: string, acpSessionId: string): Promise<void> {
    await this.updateAcpSession(agentId, workspaceId, acpSessionId, (record) => ({
      ...record,
      updatedAt: this.now().toISOString(),
    }));
  }

  async setAcpSessionStatus(
    agentId: string,
    workspaceId: string,
    acpSessionId: string,
    status: HostThreadStatus,
  ): Promise<void> {
    await this.updateAcpSession(agentId, workspaceId, acpSessionId, (record) => ({
      ...record,
      status,
      updatedAt: this.now().toISOString(),
    }));
  }

  async list(access: ThreadCatalogAccess): Promise<HostThreadRecord[]> {
    await this.mutationQueue;
    return [...this.threads.values()]
      .filter((thread) => thread.status !== 'deleted' && access.workspaceIds.has(thread.workspaceId))
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.threadId.localeCompare(right.threadId)
      )
      .map((thread) => ({ ...thread }));
  }

  async get(threadId: string, access: ThreadCatalogAccess): Promise<HostThreadRecord | undefined> {
    await this.mutationQueue;
    const thread = this.threads.get(threadId);
    if (!thread || thread.status === 'deleted' || !access.workspaceIds.has(thread.workspaceId)) return undefined;
    return { ...thread };
  }

  private async updateAcpSession(
    agentId: string,
    workspaceId: string,
    acpSessionId: string,
    update: (record: HostThreadRecord) => HostThreadRecord,
  ) {
    await this.mutate(async () => {
      const threadId = this.sessionIndex.get(sessionKey(agentId, workspaceId, acpSessionId));
      if (!threadId) return;
      this.threads.set(threadId, hostThreadRecordSchema.parse(update(this.threads.get(threadId)!)));
      await this.persist();
    });
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return await result;
  }

  private async persist() {
    await ensureParentDir(this.path);
    const temporaryPath = `${this.path}.${Deno.pid}.${crypto.randomUUID()}.tmp`;
    try {
      const value = persistedCatalogSchema.parse({ version: 1, threads: [...this.threads.values()] });
      await Deno.writeTextFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
        createNew: true,
        mode: 0o600,
      });
      await Deno.chmod(temporaryPath, 0o600).catch(() => undefined);
      await Deno.rename(temporaryPath, this.path);
    } finally {
      await Deno.remove(temporaryPath).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
}
