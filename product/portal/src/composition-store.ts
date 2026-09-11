import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { terminalPaneTargets, parseWorkspaceComposition, parseWorkspaces, type CompositionErrorData, type WorkspaceComposition, type Workspace, type TerminalLayoutNode } from '@weave/product-protocol';

export class CompositionError extends Error {
  constructor(readonly data: CompositionErrorData) {
    super(data.code === 'STALE_REVISION' ? 'The workspace arrangement changed. Reload it before editing.' : 'The target is unavailable on this Host.');
  }
}

// A single Host revision orders layouts, including terminal placement across
// Workspaces. Legacy per-directory compositions remain read-only migration input.
export class CompositionStore {
  readonly #directory: string;
  #pending: Promise<unknown> = Promise.resolve();
  constructor(stateDirectory: string) { this.#directory = join(stateDirectory, 'compositions'); }
  #path(hostId: string) { return join(this.#directory, `host-${createHash('sha256').update(hostId).digest('hex')}.json`); }
  async #serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#pending.catch(() => undefined).then(action);
    this.#pending = operation;
    return operation;
  }
  async #save(composition: WorkspaceComposition) {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.#path(composition.hostId)}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(composition) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.#path(composition.hostId));
    } finally { await rm(temporary, { force: true }); }
  }
  async migrate(hostId: string, executionContextIds: string[]) {
    return this.#serialize(async () => {
      const workspaces: Workspace[] = [];
      const assignments = new Map<string, string | null>();
      const terminals = new Set<string>();
      for (const executionContextId of executionContextIds) {
        let legacy;
        try { legacy = JSON.parse(await readFile(join(this.#directory, `${createHash('sha256').update(executionContextId).digest('hex')}.json`), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { assignments.set(executionContextId, null); continue; } throw error; }
        if (legacy.schemaVersion !== 1 || legacy.workspaceId !== executionContextId || !Array.isArray(legacy.tabs)) throw new Error('Invalid legacy composition.');
        const migrateNode = (node: any): TerminalLayoutNode => {
          if (node.kind === 'split') return { ...node, children: node.children.map(migrateNode) };
          const terminalId = node.terminalId && !terminals.has(node.terminalId) ? node.terminalId : null;
          if (terminalId) terminals.add(terminalId);
          return { ...node, terminalId, executionContextId };
        };
        const converted = parseWorkspaces(legacy.tabs.map((tab: any) => ({ workspaceId: tab.tabId, name: tab.name, layout: migrateNode(tab.layout) })));
        assignments.set(executionContextId, converted.length === 1 ? converted[0]!.workspaceId : null);
        workspaces.push(...converted);
      }
      try { await this.#load(hostId); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await this.#save(parseWorkspaceComposition({ schemaVersion: 2, hostId, revision: 0, workspaces }));
      }
      return assignments;
    });
  }
  // Save the destination before the Thread catalog. A deterministic recovery ID
  // makes retries after a partial migration reuse the same empty Workspace.
  ensureThreadWorkspace(hostId: string, executionContextId: string, name: string, preferredId?: string, assignedIds: string[] = []) {
    return this.#serialize(async () => {
      const current = await this.#load(hostId);
      if (preferredId && current.workspaces.some((workspace) => workspace.workspaceId === preferredId)) return preferredId;
      const recoveryId = `recovered-${createHash('sha256').update(JSON.stringify([hostId, executionContextId])).digest('hex').slice(0, 32)}`;
      if (current.workspaces.some((workspace) => workspace.workspaceId === recoveryId)) return recoveryId;
      const candidates = current.workspaces.filter((workspace) => assignedIds.includes(workspace.workspaceId) || terminalPaneTargets([workspace]).some((pane) => pane.executionContextId === executionContextId));
      if (candidates.length === 1) return candidates[0]!.workspaceId;
      await this.#save(parseWorkspaceComposition({ ...current, revision: current.revision + 1, workspaces: [...current.workspaces, { workspaceId: recoveryId, name: name.slice(0, 120) || 'Workspace', layout: null }] }));
      return recoveryId;
    });
  }
  // Reconcile inside the same queue as layout writes: a terminal can exit while
  // a new split is being provisioned, including without any client attached.
  reconcileTerminals(hostId: string, available: () => Promise<Set<string>>) {
    return this.#prune(hostId, async () => {
      const ids = await available();
      return (id: string | null) => id === null || !ids.has(id);
    });
  }
  removeTerminal(hostId: string, terminalId: string) {
    return this.#prune(hostId, async () => (id) => id === terminalId);
  }
  #prune(hostId: string, predicate: () => Promise<(id: string | null) => boolean>) {
    return this.#serialize(async () => {
      const remove = await predicate();
      const current = await this.#load(hostId);
      let changed = false;
      const prune = (node: TerminalLayoutNode | null): TerminalLayoutNode | null => {
        if (!node) return null;
        if (node.kind === 'terminal') {
          if (!remove(node.terminalId)) return node;
          changed = true;
          return null;
        }
        const left = prune(node.children[0]), right = prune(node.children[1]);
        return left && right ? { ...node, children: [left, right] } : left ?? right;
      };
      const workspaces = current.workspaces.map((workspace) => ({ ...workspace, layout: prune(workspace.layout) }));
      if (!changed) return current;
      const next = parseWorkspaceComposition({ ...current, revision: current.revision + 1, workspaces });
      await this.#save(next);
      return next;
    });
  }
  pruneEmpty(hostId: string, occupied: Set<string>) {
    return this.#serialize(async () => {
      const current = await this.#load(hostId);
      const workspaces = current.workspaces.filter((workspace) => workspace.layout !== null || occupied.has(workspace.workspaceId));
      if (workspaces.length === current.workspaces.length) return current;
      const next = { ...current, revision: current.revision + 1, workspaces };
      await this.#save(next);
      return next;
    });
  }
  get(hostId: string) { return this.#serialize(() => this.#load(hostId)); }
  async #load(hostId: string): Promise<WorkspaceComposition> {
    const composition = parseWorkspaceComposition(JSON.parse(await readFile(this.#path(hostId), 'utf8')));
    if (composition.hostId !== hostId) throw new Error('Composition ownership mismatch.');
    return composition;
  }
  async replace(hostId: string, expectedRevision: number, workspaces: Workspace[], prepare: (current: WorkspaceComposition, workspaces: Workspace[]) => Promise<Workspace[] | void>) {
    const valid = parseWorkspaces(workspaces);
    return this.#serialize(async () => {
      const current = await this.#load(hostId);
      if (current.revision !== expectedRevision) throw new CompositionError({ domain: 'composition', code: 'STALE_REVISION', currentRevision: current.revision });
      const prepared = await prepare(current, valid) ?? valid;
      const next = parseWorkspaceComposition({ ...current, revision: current.revision + 1, workspaces: prepared });
      await this.#save(next);
      return next;
    });
  }
}
