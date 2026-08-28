import type { RepositoryIdentity, WorkspaceSummary } from '@weave/product-protocol';
import { basename, isAbsolute, join } from 'jsr:@std/path@1.1.2';
import type { WorkspaceDefinition } from './config.ts';
import { resolveRepositoryIdentity } from './repository-identity.ts';

type StoredWorkspace = {
  workspaceId: string;
  name: string;
  path: string;
};
type WorkspaceCatalogState = { version: 1; workspaces: StoredWorkspace[] };

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
  canonicalizePath = false,
): Promise<RegisteredWorkspace> => {
  const realPath = (await Deno.realPath(workspace.path)).replace(/\/$/, '');
  if (!(await Deno.stat(realPath)).isDirectory) {
    throw new Error('Project path must be a directory.');
  }
  const repositoryIdentity = await resolveRepositoryIdentity(realPath);
  return {
    ...workspace,
    path: canonicalizePath ? realPath : workspace.path.replace(/\/$/, ''),
    ...(repositoryIdentity ? { repositoryIdentity } : {}),
  };
};

export const workspaceSummary = (
  workspace: RegisteredWorkspace,
): WorkspaceSummary => ({
  workspaceId: workspace.workspaceId,
  name: workspace.name,
  ...(workspace.repositoryIdentity ? { repositoryIdentity: workspace.repositoryIdentity } : {}),
});

export class WorkspaceCatalog {
  readonly #path: string;
  readonly #configuredIds: Set<string>;
  readonly #workspaces = new Map<string, RegisteredWorkspace>();
  #state: WorkspaceCatalogState;
  #mutation = Promise.resolve();

  private constructor(
    path: string,
    configuredIds: Set<string>,
    state: WorkspaceCatalogState,
  ) {
    this.#path = path;
    this.#configuredIds = configuredIds;
    this.#state = state;
  }

  static async open(stateDirectory: string, configured: WorkspaceDefinition[]) {
    await Deno.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(stateDirectory, 'workspaces.json');
    let state: WorkspaceCatalogState = { version: 1, workspaces: [] };
    try {
      state = parseState(JSON.parse(await Deno.readTextFile(path)));
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) throw cause;
    }
    const catalog = new WorkspaceCatalog(
      path,
      new Set(configured.map(({ workspaceId }) => workspaceId)),
      state,
    );
    const seenPaths = new Set<string>();
    for (
      const [index, workspace] of [...configured, ...state.workspaces].entries()
    ) {
      if (catalog.#workspaces.has(workspace.workspaceId)) continue;
      const realPath = await Deno.realPath(workspace.path);
      if (seenPaths.has(realPath)) continue;
      const resolved = await resolveWorkspace(
        workspace,
        index >= configured.length,
      );
      seenPaths.add(realPath);
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
    const path = (await Deno.realPath(input.path)).replace(/\/$/, '');
    const existing = await Promise.all(
      [...this.#workspaces.values()].map(async (workspace) => ({
        workspace,
        path: await Deno.realPath(workspace.path),
      })),
    ).then((workspaces) => workspaces.find((workspace) => workspace.path === path)?.workspace);
    if (existing) return existing;
    const name = input.name?.trim() || basename(path) || 'Project';
    const workspace = await resolveWorkspace(
      {
        workspaceId: crypto.randomUUID(),
        name,
        path,
      },
      true,
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

  async #mutate(operation: () => Promise<void>) {
    const mutation = this.#mutation.then(operation);
    this.#mutation = mutation.catch(() => undefined);
    await mutation;
  }

  async #persist() {
    const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(temporary, JSON.stringify(this.#state, null, 2), {
      mode: 0o600,
    });
    await Deno.rename(temporary, this.#path);
    await Deno.chmod(this.#path, 0o600).catch(() => undefined);
  }
}
