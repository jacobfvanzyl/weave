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
  projectKind: 'general' | 'git';
  portalId?: string;
  portalRootId?: string;
  repoPath?: string;
  workspaces: Workspace[];
};

type EditorTarget = {
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
    projectKind: metadata.projectKind === 'git' ? 'git' : 'general',
    portalId: metadata.portalId,
    portalRootId: metadata.portalRootId,
    repoPath: metadata.repoPath,
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

const parseTarget = (body: Record<string, unknown>): EditorTarget => {
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
  if (!portalId) throw new Error('No online Portal is available for this editor.');
  const portal = getPortalConnection(portalId);
  if (!portal || portal.userId !== resourceId) throw new Error('Portal is offline or unavailable.');
  return portal;
};

const resolveEditorTarget = async (c: any, resourceId: string, body: Record<string, unknown>) => {
  const target = parseTarget(body);
  if (!target.projectId || !target.workspaceId) throw new Error('Project and Workspace are required for this editor.');

  const memory = await getMemory(c);
  const project = await getProject(memory, resourceId, target.projectId);
  if (!project) throw new Error('Project was not found.');
  if (project.projectKind !== 'git') throw new Error('Editor is only available for Git Projects.');

  const workspace = project.workspaces.find(item => item.id === target.workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  const mountedPortal = findPortalForProject(resourceId, target.projectId);
  const portalId = workspace.portalId ?? project.portalId ?? mountedPortal?.portalId ?? target.portalId;
  assertPortal(portalId, resourceId);

  return {
    portalId: portalId!,
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    rootId: project.portalRootId ?? target.rootId,
    repoPath: project.repoPath ?? target.repoPath,
    workspacePath: workspace.path ?? target.workspacePath,
  };
};

const cleanPortalResult = (result: unknown) => {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (record.ok === false) throw new Error(typeof record.error === 'string' ? record.error : 'Portal editor request failed.');
  const { id: _id, type: _type, ok: _ok, ...body } = record;
  return body;
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /Portal|editor|Project|Workspace/.test(message) ? 400 : 500;
  return c.json({ error: message }, status);
};

const handleEditorRoute = async (c: any, tool: string, args: (body: Record<string, unknown>) => unknown) => {
  try {
    const resourceId = getResourceId(c);
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const target = await resolveEditorTarget(c, resourceId, body);
    const result = await requestPortalTool({
      ...target,
      tool,
      args: args(body),
      timeoutMs: 10_000,
    });
    return c.json(cleanPortalResult(result));
  } catch (error) {
    return errorResponse(c, error);
  }
};

export const editorRoutes = [
  registerApiRoute('/editor/list', {
    method: 'POST',
    handler: async c => handleEditorRoute(c, 'portal.editor.list', body => ({
      path: optionalString(body.path) ?? '',
    })),
  }),
  registerApiRoute('/editor/read', {
    method: 'POST',
    handler: async c => handleEditorRoute(c, 'portal.editor.read', body => ({
      path: optionalString(body.path) ?? '',
    })),
  }),
  registerApiRoute('/editor/write', {
    method: 'POST',
    handler: async c => handleEditorRoute(c, 'portal.editor.write', body => ({
      path: optionalString(body.path) ?? '',
      content: typeof body.content === 'string' ? body.content : undefined,
      version: optionalString(body.version),
    })),
  }),
];
