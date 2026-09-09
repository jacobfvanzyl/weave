import { chmod, mkdir, readText, realpath, rename, stat, writeText } from './host-files.ts';
import { isFsError } from './host-files.ts';
import type { RepositoryIdentity, WorkspaceSummary } from '@weave/product-protocol';
import { basename, isAbsolute, join } from 'node:path';
import type { WorkspaceDefinition } from './config.ts';
import { resolveRepositoryIdentity } from './repository-identity.ts';

type StoredWorkspace = {
  workspaceId: string;
  name: string;
  path: string;
};
type WorkspaceCatalogState = {
  version: 1;
  workspaces: StoredWorkspace[];
  removedConfiguredWorkspaceIds?: string[];
};

export type RegisteredWorkspace = WorkspaceDefinition & {
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
  if (
    state.removedConfiguredWorkspaceIds !== undefined &&
    (!Array.isArray(state.removedConfiguredWorkspaceIds) ||
      state.removedConfiguredWorkspaceIds.some((workspaceId) => typeof workspaceId !== 'string'))
  ) {
    throw new Error('Workspace catalog removed-project state is invalid.');
  }
  for (const workspace of state.workspaces) {
    if (
      !workspace || typeof workspace.workspaceId !== 'string' ||
      typeof workspace.name !== 'string' || typeof workspace.path !== 'string'
    ) {
      throw new Error('Workspace catalog entry is invalid.');
    }
  }
  return state;
};

const resolveWorkspace = async (
  workspace: WorkspaceDefinition,
): Promise<RegisteredWorkspace> => {
  const realPath = await realpath(workspace.path);
  if (!(await stat(realPath)).isDirectory()) {
    throw new Error('Project path must be a directory.');
  }
  const repositoryIdentity = await resolveRepositoryIdentity(realPath);
  return {
    ...workspace,
    path: realPath,
    ...(repositoryIdentity ? { repositoryIdentity } : {}),
  };
};

export const workspaceSummary = (
  workspace: RegisteredWorkspace,
): WorkspaceSummary => ({
  workspaceId: workspace.workspaceId,
  name: workspace.name,
  rootName: basename(workspace.path) || workspace.name,
  canonicalPath: workspace.path,
  ...(workspace.repositoryIdentity ? { repositoryIdentity: workspace.repositoryIdentity } : {}),
});

export class WorkspaceCatalog {
  readonly #path: string;
  readonly #configuredIds: Set<string>;
  readonly #removedConfiguredIds: Set<string>;
  readonly #workspaces = new Map<string, RegisteredWorkspace>();
  #state: WorkspaceCatalogState;
  #mutation = Promise.resolve();

  private constructor(
    path: string,
    configuredIds: Set<string>,
    removedConfiguredIds: Set<string>,
    state: WorkspaceCatalogState,
  ) {
    this.#path = path;
    this.#configuredIds = configuredIds;
    this.#removedConfiguredIds = removedConfiguredIds;
    this.#state = state;
  }

  static async open(stateDirectory: string, configured: WorkspaceDefinition[]) {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(stateDirectory, 'workspaces.json');
    let state: WorkspaceCatalogState = { version: 1, workspaces: [] };
    try {
      state = parseState(JSON.parse(await readText(path)));
    } catch (cause) {
      if (!(isFsError(cause, 'ENOENT'))) throw cause;
    }
    const catalog = new WorkspaceCatalog(
      path,
      new Set(configured.map(({ workspaceId }) => workspaceId)),
      new Set(state.removedConfiguredWorkspaceIds ?? []),
      state,
    );
    for (
      const [index, workspace] of [...configured, ...state.workspaces].entries()
    ) {
      if (
        index < configured.length &&
        catalog.#removedConfiguredIds.has(workspace.workspaceId)
      ) continue;
      if (catalog.#workspaces.has(workspace.workspaceId)) continue;
      // Existing IDs may already own Threads, grants or terminals. Aliases can
      // share a context without silently deleting one of those identities.
      const resolved = await resolveWorkspace(workspace);
      catalog.#workspaces.set(resolved.workspaceId, resolved);
    }
    return catalog;
  }

  list() {
    return [...this.#workspaces.values()];
  }

  async add(input: { path: string; name?: string }) {
    if (!isAbsolute(input.path)) {
      throw new Error('Project path must be absolute.');
    }
    const path = await realpath(input.path);
    const existing = [...this.#workspaces.values()].find((workspace) => workspace.path === path);
    if (existing) return existing;
    const name = input.name?.trim() || basename(path) || 'Project';
    const workspace = await resolveWorkspace(
      {
        workspaceId: crypto.randomUUID(),
        name,
        path,
      },
    );
    await this.#mutate(async () => {
      const duplicate = [...this.#workspaces.values()].find((candidate) => candidate.path === workspace.path);
      if (duplicate) return;
      this.#workspaces.set(workspace.workspaceId, workspace);
      this.#state.workspaces = [...this.#workspaces.values()]
        .filter(({ workspaceId }) => !this.#configuredIds.has(workspaceId))
        .map(({ workspaceId, name, path }) => ({ workspaceId, name, path }));
      await this.#persist();
    });
    return [...this.#workspaces.values()].find((candidate) => candidate.path === workspace.path) ?? workspace;
  }

  async remove(workspaceId: string) {
    let removed: RegisteredWorkspace | undefined;
    await this.#mutate(async () => {
      removed = this.#workspaces.get(workspaceId);
      if (!removed) return;
      this.#workspaces.delete(workspaceId);
      if (this.#configuredIds.has(workspaceId)) {
        this.#removedConfiguredIds.add(workspaceId);
      }
      this.#state.removedConfiguredWorkspaceIds = [
        ...this.#removedConfiguredIds,
      ];
      this.#state.workspaces = [...this.#workspaces.values()]
        .filter(({ workspaceId }) => !this.#configuredIds.has(workspaceId))
        .map(({ workspaceId, name, path }) => ({ workspaceId, name, path }));
      await this.#persist();
    });
    return removed;
  }

  async #mutate(operation: () => Promise<void>) {
    const mutation = this.#mutation.then(operation);
    this.#mutation = mutation.catch(() => undefined);
    await mutation;
  }

  async #persist() {
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await writeText(temporary, JSON.stringify(this.#state, null, 2), {
      mode: 0o600,
    });
    await rename(temporary, this.#path);
    await chmod(this.#path, 0o600).catch(() => undefined);
  }
}
