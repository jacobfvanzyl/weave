import { registerApiRoute } from '@mastra/core/server';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { findPortalForProject, getPortalConnection, requestPortalTool } from '../portal/registry';

const agentId = 'mageHandAgent';
const projectThreadPrefix = '__project__';

type Workspace = {
  id: string;
  portalId?: string;
  path?: string;
};

type Project = {
  id: string;
  userId: string;
  projectKind: 'general' | 'git' | 'notes';
  portalId?: string;
  portalRootId?: string;
  vaultPath?: string;
  workspaces: Workspace[];
};

type VaultTarget = {
  projectId?: string;
  workspaceId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

const projectThreadId = (projectId: string) => `${projectThreadPrefix}${projectId}`;

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

const toProject = (thread: any): Project => {
  const metadata = (thread.metadata ?? {}) as Partial<Project> & { workspaces?: Workspace[] };
  return {
    id: typeof metadata.id === 'string' ? metadata.id : thread.id.replace(projectThreadPrefix, ''),
    userId: thread.resourceId,
    projectKind: metadata.projectKind === 'git' || metadata.projectKind === 'notes' ? metadata.projectKind : 'general',
    portalId: metadata.portalId,
    portalRootId: metadata.portalRootId,
    vaultPath: metadata.vaultPath,
    workspaces: Array.isArray(metadata.workspaces) ? metadata.workspaces : [],
  };
};

const getProject = async (memory: any, resourceId: string, projectId: string) => {
  const thread = await memory.getThreadById({ threadId: projectThreadId(projectId) }).catch(() => undefined);
  if (!thread || thread.resourceId !== resourceId) return undefined;
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  if (!thread.id.startsWith(projectThreadPrefix) && metadata?.kind !== 'project') return undefined;
  return toProject(thread);
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseTarget = (body: Record<string, unknown>): VaultTarget => {
  const target = body.target && typeof body.target === 'object'
    ? body.target as Record<string, unknown>
    : body;
  return {
    projectId: optionalString(target.projectId),
    workspaceId: optionalString(target.workspaceId),
    portalId: optionalString(target.portalId),
    rootId: optionalString(target.rootId),
    repoPath: optionalString(target.repoPath),
    workspacePath: optionalString(target.workspacePath),
  };
};

const assertPortal = (portalId: string | undefined, resourceId: string) => {
  if (!portalId) throw new Error('No online Portal is available for this vault.');
  const portal = getPortalConnection(portalId);
  if (!portal || portal.userId !== resourceId) throw new Error('Portal is offline or unavailable.');
  return portal;
};

const resolveVaultTarget = async (c: any, resourceId: string, body: Record<string, unknown>) => {
  const target = parseTarget(body);
  if (!target.projectId) throw new Error('Project is required for this vault.');

  const memory = await getMemory(c);
  const project = await getProject(memory, resourceId, target.projectId);
  if (!project) throw new Error('Project was not found.');
  if (project.projectKind !== 'notes') throw new Error('Vault tools are only available for Notes Projects.');

  const workspace = target.workspaceId
    ? project.workspaces.find(item => item.id === target.workspaceId)
    : project.workspaces[0];
  if (!workspace) throw new Error('Vault workspace was not found.');
  const mountedPortal = findPortalForProject(resourceId, target.projectId);
  const portalId = workspace.portalId ?? project.portalId ?? mountedPortal?.portalId ?? target.portalId;
  assertPortal(portalId, resourceId);

  return {
    portalId: portalId!,
    projectId: target.projectId,
    workspaceId: workspace.id,
    rootId: project.portalRootId ?? target.rootId,
    repoPath: project.vaultPath ?? target.repoPath,
    workspacePath: workspace.path ?? target.workspacePath,
  };
};

const cleanPortalResult = (result: unknown) => {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (record.ok === false) throw new Error(typeof record.error === 'string' ? record.error : 'Portal vault request failed.');
  const { id: _id, type: _type, ok: _ok, ...body } = record;
  return body;
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /Portal|vault|Project|Workspace/.test(message) ? 400 : 500;
  return c.json({ error: message }, status);
};

const handleVaultRoute = async (c: any, tool: string, args: (body: Record<string, unknown>) => unknown, timeoutMs = 15_000) => {
  try {
    const resourceId = getResourceId(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const target = await resolveVaultTarget(c, resourceId, body);
    const result = await requestPortalTool({
      ...target,
      tool,
      args: args(body),
      timeoutMs,
    });
    return c.json(cleanPortalResult(result));
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const vaultRoutes = [
  registerApiRoute('/vault/index', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'portal.vault.index', body => ({
      path: optionalString(body.path) ?? '',
    }), 30_000),
  }),
  registerApiRoute('/vault/read', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'portal.vault.read', body => ({
      path: optionalString(body.path) ?? '',
    })),
  }),
  registerApiRoute('/vault/write', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'portal.vault.write', body => ({
      path: optionalString(body.path) ?? '',
      content: typeof body.content === 'string' ? body.content : undefined,
      version: optionalString(body.version),
    })),
  }),
  registerApiRoute('/vault/mkdir', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'portal.vault.mkdir', body => ({
      path: optionalString(body.path) ?? '',
    })),
  }),
  registerApiRoute('/vault/move', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'portal.vault.move', body => ({
      fromPath: optionalString(body.fromPath) ?? '',
      toPath: optionalString(body.toPath) ?? '',
      overwrite: body.overwrite === true,
    })),
  }),
  registerApiRoute('/vault/delete', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'portal.vault.delete', body => ({
      path: optionalString(body.path) ?? '',
      recursive: body.recursive === true,
    })),
  }),
  registerApiRoute('/vault/upload', {
    method: 'POST',
    handler: async c => handleVaultRoute(c, 'portal.vault.upload', body => ({
      path: optionalString(body.path) ?? '',
      base64Content: typeof body.base64Content === 'string' ? body.base64Content : undefined,
      contentType: optionalString(body.contentType),
    })),
  }),
];
