import { chmod, mkdir, readText, realpath, rename, stat, writeText, isFsError } from './host-files.ts';
import type { RepositoryIdentity, WorkspaceSummary } from '@weave/product-protocol';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { WorkspaceDefinition } from './config.ts';
import { resolveRepositoryIdentity } from './repository-identity.ts';

type StoredWorkspace = WorkspaceDefinition;
type ContextPin = {
  workspaceId: string;
  canonicalPath: string;
  device: string;
  inode: string;
};
type WorkspaceCatalogState = {
  version: 1;
  workspaces: StoredWorkspace[];
  removedConfiguredWorkspaceIds?: string[];
  /** Additive migration: keep configured and dynamic identities across restarts. */
  contextPins?: ContextPin[];
};

export type RegisteredWorkspace = WorkspaceDefinition & {
  canonicalPath?: string;
  availability: NonNullable<WorkspaceSummary['availability']>;
  repositoryIdentity?: RepositoryIdentity;
};

const parseState = (value: unknown): WorkspaceCatalogState => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Workspace catalog state must be an object.');
  }
  const state = value as WorkspaceCatalogState;
  if (state.version !== 1 || !Array.isArray(state.workspaces)) {
    throw new Error('Workspace catalog state is unsupported.');
  }
  if (state.removedConfiguredWorkspaceIds !== undefined &&
    (!Array.isArray(state.removedConfiguredWorkspaceIds) ||
      state.removedConfiguredWorkspaceIds.some((id) => typeof id !== 'string'))) {
    throw new Error('Workspace catalog removed-project state is invalid.');
  }
  for (const workspace of state.workspaces) {
    if (!workspace || typeof workspace.workspaceId !== 'string' ||
      typeof workspace.name !== 'string' || typeof workspace.path !== 'string') {
      throw new Error('Workspace catalog entry is invalid.');
    }
  }
  if (state.contextPins !== undefined && (!Array.isArray(state.contextPins) ||
    state.contextPins.some((pin) => !pin || typeof pin.workspaceId !== 'string' ||
      typeof pin.canonicalPath !== 'string' || !isAbsolute(pin.canonicalPath) ||
      resolve(pin.canonicalPath) !== pin.canonicalPath ||
      typeof pin.device !== 'string' || typeof pin.inode !== 'string') ||
    new Set(state.contextPins.map((pin) => pin.workspaceId)).size !== state.contextPins.length)) {
    throw new Error('Workspace catalog context identity is invalid.');
  }
  return state;
};

const inspectDirectory = async (path: string) => {
  const canonicalPath = await realpath(path);
  const details = await stat(canonicalPath, { bigint: true });
  if (!details.isDirectory()) throw new Error('Workspace path must be a directory.');
  return { canonicalPath, device: String(details.dev), inode: String(details.ino) };
};

export const workspaceSummary = (workspace: RegisteredWorkspace): WorkspaceSummary => ({
  workspaceId: workspace.workspaceId,
  name: workspace.name,
  rootName: basename(workspace.path) || workspace.name,
  ...(workspace.canonicalPath ? { canonicalPath: workspace.canonicalPath } : {}),
  availability: workspace.availability,
  ...(workspace.repositoryIdentity ? { repositoryIdentity: workspace.repositoryIdentity } : {}),
});

export class WorkspaceCatalog {
  readonly #path: string;
  readonly #configuredIds: Set<string>;
  readonly #sources = new Map<string, WorkspaceDefinition>();
  readonly #repositoryInspected = new Set<string>();
  readonly #pins = new Map<string, ContextPin>();
  readonly #workspaces = new Map<string, RegisteredWorkspace>();
  #state: WorkspaceCatalogState;
  #mutation = Promise.resolve();

  private constructor(path: string, configuredIds: Set<string>, state: WorkspaceCatalogState) {
    this.#path = path;
    this.#configuredIds = configuredIds;
    this.#state = state;
    for (const pin of state.contextPins ?? []) this.#pins.set(pin.workspaceId, pin);
  }

  static async open(stateDirectory: string, configured: WorkspaceDefinition[]) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(stateDirectory, 'workspaces.json');
    let state: WorkspaceCatalogState = { version: 1, workspaces: [] };
    try { state = parseState(JSON.parse(await readText(path))); }
    catch (cause) { if (!isFsError(cause, 'ENOENT')) throw cause; }
    const catalog = new WorkspaceCatalog(path, new Set(configured.map(({ workspaceId }) => workspaceId)), state);
    for (const [index, workspace] of [...configured, ...state.workspaces].entries()) {
      if (index < configured.length && state.removedConfiguredWorkspaceIds?.includes(workspace.workspaceId)) continue;
      if (catalog.#sources.has(workspace.workspaceId)) continue;
      catalog.#sources.set(workspace.workspaceId, workspace);
      catalog.#workspaces.set(workspace.workspaceId, {
        ...workspace,
        path: catalog.#pins.get(workspace.workspaceId)?.canonicalPath ?? resolve(workspace.path),
        availability: 'unavailable',
      });
    }
    // First successful resolution pins legacy records without changing their IDs.
    await catalog.refresh();
    return catalog;
  }

  list() { return [...this.#workspaces.values()]; }

  async refresh(workspaceId?: string) {
    await this.#mutate(async () => {
      const addedPins: string[] = [];
      for (const workspace of this.#workspaces.values()) {
        if (workspaceId !== undefined && workspace.workspaceId !== workspaceId) continue;
        const source = this.#sources.get(workspace.workspaceId)!;
        const pin = this.#pins.get(workspace.workspaceId);
        if (pin) {
          workspace.path = pin.canonicalPath;
          workspace.canonicalPath = pin.canonicalPath;
        }
        try {
          const current = await inspectDirectory(source.path);
          if (pin && (pin.canonicalPath !== current.canonicalPath ||
            pin.device !== current.device || pin.inode !== current.inode)) {
            workspace.availability = 'path-changed';
            continue;
          }
          if (!pin) {
            this.#pins.set(workspace.workspaceId, { workspaceId: workspace.workspaceId, ...current });
            workspace.path = current.canonicalPath;
            workspace.canonicalPath = current.canonicalPath;
            addedPins.push(workspace.workspaceId);
          }
          workspace.availability = 'available';
          if (!this.#repositoryInspected.has(workspace.workspaceId)) {
            workspace.repositoryIdentity = await resolveRepositoryIdentity(workspace.path);
            this.#repositoryInspected.add(workspace.workspaceId);
          }
        } catch {
          workspace.availability = 'unavailable';
        }
      }
      if (addedPins.length) {
        const next = { ...this.#state, contextPins: [...this.#pins.values()] };
        try { await this.#persist(next); } catch (cause) {
          for (const id of addedPins) {
            this.#pins.delete(id);
            const workspace = this.#workspaces.get(id)!;
            delete workspace.canonicalPath;
            workspace.availability = 'unavailable';
          }
          throw cause;
        }
        this.#state = next;
      }
    });
    return workspaceId === undefined ? undefined : this.#workspaces.get(workspaceId);
  }

  async requireAvailable(workspaceId: string) {
    const workspace = await this.refresh(workspaceId);
    if (!workspace || workspace.availability !== 'available') throw new Error('Workspace directory is unavailable.');
    return workspace;
  }

  async add(input: { path: string; name?: string }) {
    if (!isAbsolute(input.path)) throw new Error('Workspace path must be absolute.');
    const directory = await inspectDirectory(input.path);
    let result: RegisteredWorkspace | undefined;
    await this.#mutate(async () => {
      const existing = this.list().find((workspace) => workspace.canonicalPath === directory.canonicalPath);
      if (existing) {
        const pin = this.#pins.get(existing.workspaceId)!;
        if (pin.device !== directory.device || pin.inode !== directory.inode) {
          throw new Error('Workspace directory identity has changed. Remove its registration explicitly before registering a replacement.');
        }
        result = existing;
        return;
      }
      const source = { workspaceId: crypto.randomUUID(), name: input.name?.trim() || basename(directory.canonicalPath) || 'Workspace', path: resolve(input.path) };
      const pin = { workspaceId: source.workspaceId, ...directory };
      const next = { ...this.#state, workspaces: [...this.#state.workspaces, source], contextPins: [...this.#pins.values(), pin] };
      await this.#persist(next);
      this.#state = next;
      this.#sources.set(source.workspaceId, source);
      this.#pins.set(source.workspaceId, pin);
      result = { ...source, path: directory.canonicalPath, canonicalPath: directory.canonicalPath, availability: 'available', repositoryIdentity: await resolveRepositoryIdentity(directory.canonicalPath) };
      this.#workspaces.set(source.workspaceId, result);
      this.#repositoryInspected.add(source.workspaceId);
    });
    return await this.requireAvailable(result!.workspaceId);
  }

  async remove(workspaceId: string) {
    let removed: RegisteredWorkspace | undefined;
    await this.#mutate(async () => {
      removed = this.#workspaces.get(workspaceId);
      if (!removed) return;
      const next: WorkspaceCatalogState = {
        ...this.#state,
        workspaces: this.#state.workspaces.filter((workspace) => workspace.workspaceId !== workspaceId),
        contextPins: [...this.#pins.values()].filter((pin) => pin.workspaceId !== workspaceId),
        removedConfiguredWorkspaceIds: [...new Set([
          ...this.#state.removedConfiguredWorkspaceIds ?? [],
          ...(this.#configuredIds.has(workspaceId) ? [workspaceId] : []),
        ])],
      };
      await this.#persist(next);
      this.#state = next;
      this.#workspaces.delete(workspaceId);
      this.#sources.delete(workspaceId);
      this.#pins.delete(workspaceId);
    });
    return removed;
  }

  async #mutate(operation: () => Promise<void>) {
    const mutation = this.#mutation.then(operation);
    this.#mutation = mutation.catch(() => undefined);
    await mutation;
  }

  async #persist(state: WorkspaceCatalogState) {
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await writeText(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
  }
}
