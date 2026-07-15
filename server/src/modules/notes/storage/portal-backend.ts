import { requestPortalTool } from '../../../portal/registry';
import {
  parsePortalToolArgs,
  type PortalToolArgs,
  type PortalToolName,
  type PortalToolResult,
} from '@weave/protocol';
import type { ToolService } from '../../../services/tool-service';
import { callerForOwner, type ServiceCaller } from '../../../services/types';
import type {
  NotesStorageMetadata,
  NotesVaultBackend,
  NotesVaultBackendOptions,
  ResolvedNotesVaultBinding,
} from './types';

export type PortalToolRequester = <Name extends PortalToolName>(input: {
  portalId: string;
  projectId?: string;
  workspaceId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
  tool: Name;
  args: PortalToolArgs<Name>;
  timeoutMs?: number;
}) => Promise<PortalToolResult<Name>>;

export type ServicePortalNotesVaultBackendOptions = {
  callerKind?: ServiceCaller['kind'];
  correlation?: ServiceCaller['correlation'];
  createCaller?: (binding: ResolvedNotesVaultBinding) => ServiceCaller;
};

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

const requestPortalWorkspaceFileTool = async (
  requestPortal: PortalToolRequester,
  binding: ResolvedNotesVaultBinding,
  action: 'index' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'upload',
  args: unknown,
  options?: NotesVaultBackendOptions,
) => {
  const storage = assertPortalStorage(binding.storage);
  const tool = `portal.fs.${action}` as const;
  const toolArgs = parsePortalToolArgs(
    tool,
    action === 'write' || action === 'move' ? { ...(isRecord(args) ? args : {}), createParents: true } : args,
  );
  return cleanPortalResult(
    await requestPortal({
      portalId: storage.portalId,
      projectId: binding.projectId,
      workspaceId: binding.workspaceId,
      rootId: storage.rootId,
      repoPath: storage.vaultPath,
      workspacePath: storage.workspacePath,
      tool,
      args: toolArgs,
      timeoutMs: options?.timeoutMs,
    }),
  );
};

export const createPortalNotesVaultBackend = (
  requestPortal: PortalToolRequester = requestPortalTool,
): NotesVaultBackend => ({
  kind: 'portal',
  index: async (binding, input, options) =>
    requestPortalWorkspaceFileTool(requestPortal, binding, 'index', input, options) as Promise<any>,
  read: async (binding, input, options) =>
    requestPortalWorkspaceFileTool(requestPortal, binding, 'read', input, options) as Promise<any>,
  write: async (binding, input, options) =>
    requestPortalWorkspaceFileTool(requestPortal, binding, 'write', input, options) as Promise<any>,
  mkdir: async (binding, input, options) =>
    requestPortalWorkspaceFileTool(requestPortal, binding, 'mkdir', input, options) as Promise<any>,
  move: async (binding, input, options) =>
    requestPortalWorkspaceFileTool(requestPortal, binding, 'move', input, options) as Promise<any>,
  delete: async (binding, input, options) =>
    requestPortalWorkspaceFileTool(requestPortal, binding, 'delete', input, options) as Promise<any>,
  upload: async (binding, input, options) =>
    requestPortalWorkspaceFileTool(requestPortal, binding, 'upload', input, options) as Promise<any>,
});

const requestServicePortalWorkspaceFileTool = async (
  tools: ToolService,
  serviceOptions: ServicePortalNotesVaultBackendOptions,
  binding: ResolvedNotesVaultBinding,
  action: 'index' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'upload',
  args: unknown,
  options?: NotesVaultBackendOptions,
) => {
  const storage = assertPortalStorage(binding.storage);
  const caller = serviceOptions.createCaller?.(binding) ??
    callerForOwner(binding.resourceId, serviceOptions.callerKind ?? 'ui', serviceOptions.correlation);
  return cleanPortalResult(
    await tools.requestPortal({
      caller,
      target: {
        portalId: storage.portalId,
        projectId: binding.projectId,
        workspaceId: binding.workspaceId,
        rootId: storage.rootId,
        repoPath: storage.vaultPath,
        workspacePath: storage.workspacePath,
      },
      tool: `portal.fs.${action}`,
      args: action === 'write' || action === 'move' ? { ...(isRecord(args) ? args : {}), createParents: true } : args,
      timeoutMs: options?.timeoutMs,
    }),
  );
};

export const createServicePortalNotesVaultBackend = (
  tools: ToolService,
  serviceOptions: ServicePortalNotesVaultBackendOptions = {},
): NotesVaultBackend => ({
  kind: 'portal',
  index: async (binding, input, options) =>
    requestServicePortalWorkspaceFileTool(tools, serviceOptions, binding, 'index', input, options) as Promise<any>,
  read: async (binding, input, options) =>
    requestServicePortalWorkspaceFileTool(tools, serviceOptions, binding, 'read', input, options) as Promise<any>,
  write: async (binding, input, options) =>
    requestServicePortalWorkspaceFileTool(tools, serviceOptions, binding, 'write', input, options) as Promise<any>,
  mkdir: async (binding, input, options) =>
    requestServicePortalWorkspaceFileTool(tools, serviceOptions, binding, 'mkdir', input, options) as Promise<any>,
  move: async (binding, input, options) =>
    requestServicePortalWorkspaceFileTool(tools, serviceOptions, binding, 'move', input, options) as Promise<any>,
  delete: async (binding, input, options) =>
    requestServicePortalWorkspaceFileTool(tools, serviceOptions, binding, 'delete', input, options) as Promise<any>,
  upload: async (binding, input, options) =>
    requestServicePortalWorkspaceFileTool(tools, serviceOptions, binding, 'upload', input, options) as Promise<any>,
});

export const portalNotesVaultBackend = createPortalNotesVaultBackend();
