import { registerApiRoute } from '@mastra/core/server';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { findPortalForProject, getPortalConnection, listPortalConnections } from '../portal/registry';
import { issueTerminalToken, type TerminalSessionKind } from '../portal/terminal-relay';

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

const getPortalWsUrl = (c: any) => {
  const configured = process.env.WEAVE_PORTAL_WS_PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/terminals/connect`;

  const url = new URL(c.req.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = process.env.WEAVE_PORTAL_WS_PUBLIC_PORT ?? process.env.WEAVE_PORTAL_WS_PORT ?? '4112';
  url.pathname = '/terminals/connect';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const portalRootId = (portal: { roots?: unknown[] }) => {
  const firstRoot = Array.isArray(portal.roots)
    ? portal.roots.find((root: any) => typeof root?.id === 'string')
    : undefined;
  return typeof (firstRoot as any)?.id === 'string' ? (firstRoot as any).id : 'default';
};

const assertPortal = (portalId: string | undefined, resourceId: string) => {
  if (!portalId) throw new Error('No online Portal is available for this terminal.');
  const portal = getPortalConnection(portalId);
  if (!portal || portal.userId !== resourceId) throw new Error('Portal is offline or unavailable.');
  return portal;
};

const resolveTerminalTarget = async (c: any, resourceId: string, body: Record<string, unknown>) => {
  const kind: TerminalSessionKind = body.kind === 'workspace' ? 'workspace' : 'general';

  if (kind === 'general') {
    const portal = listPortalConnections(resourceId).find(connection => connection.status === 'online');
    if (!portal) throw new Error('No online Portal is available for this terminal.');
    return {
      kind,
      portalId: portal.portalId,
      rootId: optionalString(body.rootId) ?? portalRootId(portal),
    };
  }

  const projectId = optionalString(body.projectId);
  const workspaceId = optionalString(body.workspaceId);
  if (!projectId || !workspaceId) throw new Error('Project and Workspace are required for this terminal.');

  const memory = await getMemory(c);
  const project = await getProject(memory, resourceId, projectId);
  if (!project) throw new Error('Project was not found.');
  if (project.projectKind !== 'git') throw new Error('Terminal is only available for Git Projects.');

  const workspace = project.workspaces.find(item => item.id === workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  const mountedPortal = findPortalForProject(resourceId, projectId);
  const portalId = workspace.portalId ?? project.portalId ?? mountedPortal?.portalId;
  assertPortal(portalId, resourceId);

  return {
    kind,
    portalId: portalId!,
    projectId,
    workspaceId,
    rootId: project.portalRootId,
    repoPath: project.repoPath,
    workspacePath: workspace.path,
  };
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /Portal|terminal|Project|Workspace/.test(message) ? 400 : 500;
  return c.json({ error: message }, status);
};

export const terminalRoutes = [
  registerApiRoute('/terminals/token', {
    method: 'POST',
    handler: async c => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
        const target = await resolveTerminalTarget(c, resourceId, body);
        const token = issueTerminalToken({ resourceId, ...target });
        return c.json({
          token,
          portalId: target.portalId,
          wsUrl: getPortalWsUrl(c),
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];
