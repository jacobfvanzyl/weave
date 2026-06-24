import { requestPortalTool } from '../portal/registry';
import type {
  NotesStorageMetadata,
  NotesVaultBackend,
  NotesVaultBackendOptions,
  ResolvedNotesVaultBinding,
} from './types';

export type PortalToolRequester = (input: {
  portalId: string;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  tool: string;
  args: unknown;
  timeoutMs?: number;
}) => Promise<unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const assertPortalStorage = (storage: NotesStorageMetadata) => {
  if (storage.kind !== 'portal') throw new Error(`Portal backend cannot handle notes storage kind: ${storage.kind}`);
  if (typeof storage.portalId !== 'string' || !storage.portalId) {
    throw new Error('No online Portal is available for this vault.');
  }
  return storage as NotesStorageMetadata & { kind: 'portal'; portalId: string };
};

const cleanPortalResult = (result: unknown) => {
  const record = isRecord(result) ? result : {};
  if (record.ok === false) {
    throw new Error(typeof record.error === 'string' ? record.error : 'Portal vault request failed.');
  }
  const { id: _id, type: _type, ...body } = record;
  return body;
};

const requestPortalVaultTool = async (
  requestPortal: PortalToolRequester,
  binding: ResolvedNotesVaultBinding,
  action: 'index' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'upload',
  args: unknown,
  options?: NotesVaultBackendOptions,
) => {
  const storage = assertPortalStorage(binding.storage);
  return cleanPortalResult(await requestPortal({
    portalId: storage.portalId,
    projectId: binding.projectId,
    workspaceId: binding.workspaceId,
    rootId: storage.rootId,
    repoPath: storage.vaultPath,
    workspacePath: storage.workspacePath,
    tool: `portal.vault.${action}`,
    args,
    timeoutMs: options?.timeoutMs,
  }));
};

export const createPortalNotesVaultBackend = (
  requestPortal: PortalToolRequester = requestPortalTool,
): NotesVaultBackend => ({
  kind: 'portal',
  index: async (binding, input, options) =>
    requestPortalVaultTool(requestPortal, binding, 'index', input, options) as Promise<any>,
  read: async (binding, input, options) =>
    requestPortalVaultTool(requestPortal, binding, 'read', input, options) as Promise<any>,
  write: async (binding, input, options) =>
    requestPortalVaultTool(requestPortal, binding, 'write', input, options) as Promise<any>,
  mkdir: async (binding, input, options) =>
    requestPortalVaultTool(requestPortal, binding, 'mkdir', input, options) as Promise<any>,
  move: async (binding, input, options) =>
    requestPortalVaultTool(requestPortal, binding, 'move', input, options) as Promise<any>,
  delete: async (binding, input, options) =>
    requestPortalVaultTool(requestPortal, binding, 'delete', input, options) as Promise<any>,
  upload: async (binding, input, options) =>
    requestPortalVaultTool(requestPortal, binding, 'upload', input, options) as Promise<any>,
});

export const portalNotesVaultBackend = createPortalNotesVaultBackend();
