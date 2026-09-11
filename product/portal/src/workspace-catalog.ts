import { chmod, mkdir, readText, rename, writeText, isFsError } from './host-files.ts';
import type { RepositoryIdentity, ExecutionContextSummary } from '@weave/product-protocol';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { ExecutionContextDefinition } from './config.ts';
import { resolveRepositoryIdentity } from './repository-identity.ts';
import { inspectDirectory, sameDirectoryIdentity, type DirectoryIdentity } from './directory-identity.ts';

type StoredWorkspace = ExecutionContextDefinition;
type ContextPin = DirectoryIdentity & {
  executionContextId: string;
};
type ExecutionContextCatalogState = {
  version: 2;
  executionContexts: StoredWorkspace[];
  removedConfiguredExecutionContextIds?: string[];
  /** Additive migration: keep configured and dynamic identities across restarts. */
  contextPins?: ContextPin[];
};

export type RegisteredExecutionContext = ExecutionContextDefinition & {
  canonicalPath?: string;
  availability: NonNullable<ExecutionContextSummary['availability']>;
  repositoryIdentity?: RepositoryIdentity;
};

const parseState = (value: unknown): ExecutionContextCatalogState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workspace catalog state must be an object.');
  }
  const legacy = value as any;
  if (legacy.version === 1) {
    legacy.version = 2;
    legacy.executionContexts = (legacy.workspaces ?? legacy.executionContexts).map((item: any) => { const { workspaceId, ...rest } = item; return { ...rest, executionContextId: rest.executionContextId ?? workspaceId }; });
    legacy.contextPins = legacy.contextPins?.map((item: any) => { const { workspaceId, ...rest } = item; return { ...rest, executionContextId: rest.executionContextId ?? workspaceId }; });
    legacy.removedConfiguredExecutionContextIds ??= legacy.removedConfiguredWorkspaceIds;
    delete legacy.workspaces;
    delete legacy.removedConfiguredWorkspaceIds;
  }
  const state = legacy as ExecutionContextCatalogState;
  if (state.version !== 2 || !Array.isArray(state.executionContexts)) {
    throw new Error('Workspace catalog state is unsupported.');
  }
  if (state.removedConfiguredExecutionContextIds !== undefined &&
    (!Array.isArray(state.removedConfiguredExecutionContextIds) ||
      state.removedConfiguredExecutionContextIds.some((id) => typeof id !== 'string'))) {
    throw new Error('Workspace catalog removed-project state is invalid.');
  }
  for (const workspace of state.executionContexts) {
    if (!workspace || typeof workspace.executionContextId !== 'string' ||
      typeof workspace.name !== 'string' || typeof workspace.path !== 'string') {
      throw new Error('Workspace catalog entry is invalid.');
    }
  }
  if (state.contextPins !== undefined && (!Array.isArray(state.contextPins) ||
    state.contextPins.some((pin) => !pin || typeof pin.executionContextId !== 'string' ||
      typeof pin.canonicalPath !== 'string' || !isAbsolute(pin.canonicalPath) ||
      resolve(pin.canonicalPath) !== pin.canonicalPath ||
      typeof pin.device !== 'string' || typeof pin.inode !== 'string' ||
      (pin.volumeId !== undefined && (typeof pin.volumeId !== 'string' || !/^uuid:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(pin.volumeId)))) ||
    new Set(state.contextPins.map((pin) => pin.executionContextId)).size !== state.contextPins.length)) {
    throw new Error('Workspace catalog context identity is invalid.');
  }
  return state;
};

export const workspaceSummary = (workspace: RegisteredExecutionContext): ExecutionContextSummary => ({
  executionContextId: workspace.executionContextId,
  name: workspace.name,
  rootName: basename(workspace.path) || workspace.name,
  ...(workspace.canonicalPath ? { canonicalPath: workspace.canonicalPath } : {}),
  availability: workspace.availability,
  ...(workspace.repositoryIdentity ? { repositoryIdentity: workspace.repositoryIdentity } : {}),
});

export class ExecutionContextCatalog {
  readonly #path: string;
  readonly #configuredIds: Set<string>;
  readonly #sources = new Map<string, ExecutionContextDefinition>();
  readonly #repositoryInspected = new Set<string>();
  readonly #pins = new Map<string, ContextPin>();
  readonly #executionContexts = new Map<string, RegisteredExecutionContext>();
  #state: ExecutionContextCatalogState;
  #mutation = Promise.resolve();

  private constructor(path: string, configuredIds: Set<string>, state: ExecutionContextCatalogState, private readonly inspect: typeof inspectDirectory) {
    this.#path = path;
    this.#configuredIds = configuredIds;
    this.#state = state;
    for (const pin of state.contextPins ?? []) this.#pins.set(pin.executionContextId, pin);
  }

  static async open(stateDirectory: string, configured: ExecutionContextDefinition[], inspect = inspectDirectory) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(stateDirectory, 'workspaces.json'); // Preserve the registration store and its identity pins.
    let state: ExecutionContextCatalogState = { version: 2, executionContexts: [] };
    try { state = parseState(JSON.parse(await readText(path))); }
    catch (cause) { if (!isFsError(cause, 'ENOENT')) throw cause; }
    const catalog = new ExecutionContextCatalog(path, new Set(configured.map(({ executionContextId }) => executionContextId)), state, inspect);
    for (const [index, workspace] of [...configured, ...state.executionContexts].entries()) {
      if (index < configured.length && state.removedConfiguredExecutionContextIds?.includes(workspace.executionContextId)) continue;
      if (catalog.#sources.has(workspace.executionContextId)) continue;
      catalog.#sources.set(workspace.executionContextId, workspace);
      catalog.#executionContexts.set(workspace.executionContextId, {
        ...workspace,
        path: catalog.#pins.get(workspace.executionContextId)?.canonicalPath ?? resolve(workspace.path),
        availability: 'unavailable',
      });
    }
    // First successful resolution pins legacy records without changing their IDs.
    await catalog.refresh();
    await catalog.#persist(catalog.#state);
    return catalog;
  }

  list() { return [...this.#executionContexts.values()]; }

  async refresh(executionContextId?: string) {
    await this.#mutate(async () => {
      const previousPins = new Map<string, ContextPin | undefined>();
      for (const workspace of this.#executionContexts.values()) {
        if (executionContextId !== undefined && workspace.executionContextId !== executionContextId) continue;
        const source = this.#sources.get(workspace.executionContextId)!;
        const pin = this.#pins.get(workspace.executionContextId);
        if (pin) {
          workspace.path = pin.canonicalPath;
          workspace.canonicalPath = pin.canonicalPath;
        }
        try {
          const current = await this.inspect(source.path);
          if (pin && !sameDirectoryIdentity(pin, current)) {
            workspace.availability = 'path-changed';
            continue;
          }
          if (!pin || pin.volumeId !== current.volumeId || pin.device !== current.device) {
            previousPins.set(workspace.executionContextId, pin);
            this.#pins.set(workspace.executionContextId, { executionContextId: workspace.executionContextId, ...current });
            workspace.path = current.canonicalPath;
            workspace.canonicalPath = current.canonicalPath;
          }
          workspace.availability = 'available';
          if (!this.#repositoryInspected.has(workspace.executionContextId)) {
            workspace.repositoryIdentity = await resolveRepositoryIdentity(workspace.path);
            this.#repositoryInspected.add(workspace.executionContextId);
          }
        } catch {
          workspace.availability = 'unavailable';
        }
      }
      if (previousPins.size) {
        const next = { ...this.#state, contextPins: [...this.#pins.values()] };
        try { await this.#persist(next); } catch (cause) {
          for (const [id, previous] of previousPins) {
            if (previous) this.#pins.set(id, previous);
            else this.#pins.delete(id);
            const workspace = this.#executionContexts.get(id)!;
            if (!previous) delete workspace.canonicalPath;
            workspace.availability = 'unavailable';
          }
          throw cause;
        }
        this.#state = next;
      }
    });
    return executionContextId === undefined ? undefined : this.#executionContexts.get(executionContextId);
  }

  async requireAvailable(executionContextId: string) {
    const workspace = await this.refresh(executionContextId);
    if (!workspace || workspace.availability !== 'available') throw new Error('Workspace directory is unavailable.');
    return workspace;
  }

  async add(input: { path: string; name?: string }) {
    if (!isAbsolute(input.path)) throw new Error('Workspace path must be absolute.');
    const directory = await this.inspect(input.path);
    let result: RegisteredExecutionContext | undefined;
    await this.#mutate(async () => {
      const existing = this.list().find((workspace) => workspace.canonicalPath === directory.canonicalPath);
      if (existing) {
        const pin = this.#pins.get(existing.executionContextId)!;
        if (!sameDirectoryIdentity(pin, directory)) {
          throw new Error('Workspace directory identity has changed. Remove its registration explicitly before registering a replacement.');
        }
        result = existing;
        return;
      }
      const source = { executionContextId: crypto.randomUUID(), name: input.name?.trim() || basename(directory.canonicalPath) || 'Workspace', path: resolve(input.path) };
      const pin = { executionContextId: source.executionContextId, ...directory };
      const next = { ...this.#state, executionContexts: [...this.#state.executionContexts, source], contextPins: [...this.#pins.values(), pin] };
      await this.#persist(next);
      this.#state = next;
      this.#sources.set(source.executionContextId, source);
      this.#pins.set(source.executionContextId, pin);
      result = { ...source, path: directory.canonicalPath, canonicalPath: directory.canonicalPath, availability: 'available', repositoryIdentity: await resolveRepositoryIdentity(directory.canonicalPath) };
      this.#executionContexts.set(source.executionContextId, result);
      this.#repositoryInspected.add(source.executionContextId);
    });
    return await this.requireAvailable(result!.executionContextId);
  }

  async remove(executionContextId: string) {
    let removed: RegisteredExecutionContext | undefined;
    await this.#mutate(async () => {
      removed = this.#executionContexts.get(executionContextId);
      if (!removed) return;
      const next: ExecutionContextCatalogState = {
        ...this.#state,
        executionContexts: this.#state.executionContexts.filter((workspace) => workspace.executionContextId !== executionContextId),
        contextPins: [...this.#pins.values()].filter((pin) => pin.executionContextId !== executionContextId),
        removedConfiguredExecutionContextIds: [...new Set([
          ...this.#state.removedConfiguredExecutionContextIds ?? [],
          ...(this.#configuredIds.has(executionContextId) ? [executionContextId] : []),
        ])],
      };
      await this.#persist(next);
      this.#state = next;
      this.#executionContexts.delete(executionContextId);
      this.#sources.delete(executionContextId);
      this.#pins.delete(executionContextId);
    });
    return removed;
  }

  async #mutate(operation: () => Promise<void>) {
    const mutation = this.#mutation.then(operation);
    this.#mutation = mutation.catch(() => undefined);
    await mutation;
  }

  async #persist(state: ExecutionContextCatalogState) {
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await writeText(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
  }
}
