import { defineRoute } from '../../../server/routes';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import {
  optionalString,
  parseNotesVaultTarget,
  resolveNotesVault,
  type NotesVaultResolverDependencies,
} from '../storage/resolver';
import type {
  NotesVaultBackend,
  NotesVaultDeleteInput,
  NotesVaultIndexInput,
  NotesVaultMkdirInput,
  NotesVaultMoveInput,
  NotesVaultReadInput,
  NotesVaultUploadInput,
  NotesVaultWriteInput,
  ResolvedNotesVaultBinding,
} from '../storage/types';

const agentId = 'mageHandAgent';

type VaultAction = 'index' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'upload';

type VaultActionInput = {
  index: NotesVaultIndexInput;
  read: NotesVaultReadInput;
  write: NotesVaultWriteInput;
  mkdir: NotesVaultMkdirInput;
  move: NotesVaultMoveInput;
  delete: NotesVaultDeleteInput;
  upload: NotesVaultUploadInput;
};

type VaultRouteDeps = NotesVaultResolverDependencies;

const getMemory = async (c: any) => {
  const mastra = c.get('mastra');
  const agent = await mastra?.getAgent(agentId);
  const memory = await agent?.getMemory();
  if (!memory) throw new Error(`${agentId} has no memory configured`);
  return memory;
};

const getResourceId = (c: any) => {
  const resourceId = c.get('requestContext')?.get(MASTRA_RESOURCE_ID_KEY);
  if (typeof resourceId !== 'string' || !resourceId) throw new Error('Authenticated resource missing');
  return resourceId;
};

const cleanVaultResult = (result: unknown) => {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (record.ok === false) throw new Error(typeof record.error === 'string' ? record.error : 'Vault request failed.');
  const { id: _id, type: _type, ok: _ok, ...body } = record;
  return body;
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /Portal|vault|Project|Workspace|backend/.test(message) ? 400 : 500;
  return c.json({ error: message }, status);
};

const invokeVaultBackend = <TAction extends VaultAction>(
  backend: NotesVaultBackend,
  binding: ResolvedNotesVaultBinding,
  action: TAction,
  input: VaultActionInput[TAction],
  timeoutMs?: number,
) => backend[action](binding, input as never, timeoutMs ? { timeoutMs } : undefined);

const handleVaultRoute = async <TAction extends VaultAction>(
  c: any,
  action: TAction,
  args: (body: Record<string, unknown>) => VaultActionInput[TAction],
  timeoutMs?: number,
  deps: VaultRouteDeps = {},
) => {
  try {
    const resourceId = getResourceId(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const memory = await getMemory(c);
    const target = parseNotesVaultTarget(body);
    const { backend, binding } = await resolveNotesVault(memory, resourceId, target, deps);
    const result = await invokeVaultBackend(backend, binding, action, args(body), timeoutMs);
    return c.json(cleanVaultResult(result));
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const vaultRoutes = [
  defineRoute('/notes/vault/index', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'index', body => ({
      path: optionalString(body.path) ?? '',
    }), 30_000),
  }),
  defineRoute('/notes/vault/read', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'read', body => ({
      path: optionalString(body.path) ?? '',
    })),
  }),
  defineRoute('/notes/vault/write', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'write', body => ({
      path: optionalString(body.path) ?? '',
      content: typeof body.content === 'string' ? body.content : undefined,
      version: optionalString(body.version),
    })),
  }),
  defineRoute('/notes/vault/mkdir', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'mkdir', body => ({
      path: optionalString(body.path) ?? '',
    })),
  }),
  defineRoute('/notes/vault/move', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'move', body => ({
      fromPath: optionalString(body.fromPath) ?? '',
      toPath: optionalString(body.toPath) ?? '',
      overwrite: body.overwrite === true,
    })),
  }),
  defineRoute('/notes/vault/delete', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'delete', body => ({
      path: optionalString(body.path) ?? '',
      recursive: body.recursive === true,
    })),
  }),
  defineRoute('/notes/vault/upload', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'upload', body => ({
      path: optionalString(body.path) ?? '',
      base64Content: typeof body.base64Content === 'string' ? body.base64Content : undefined,
      contentType: optionalString(body.contentType),
    })),
  }),
];

export const __vaultRoutesTest = {
  cleanVaultResult,
  handleVaultRoute,
};
