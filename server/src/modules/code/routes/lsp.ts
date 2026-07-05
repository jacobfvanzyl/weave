import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { productProjectRepository } from '../../../products/project-repository';
import { issueLspSessionToken } from '../../../portal/lsp-relay';
import { requestPortalTool, resolvePortalForTarget } from '../../../portal/registry';
import { defineRoute } from '../../../server/routes';
import type { SessionService } from '../../../services/session-service';
import { portalToolScope, type PortalToolTarget } from '../../../services/providers/portal-provider';
import { callerForOwner } from '../../../services/types';

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

type LspTarget = PortalToolTarget & {
  projectId?: string;
  workspaceId?: string;
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
  const persisted = await productProjectRepository.get(resourceId, projectId, 'code');
  if (persisted) return persisted as Project;

  const thread = await memory.getThreadById({ threadId: projectThreadId(projectId) }).catch(() => undefined);
  if (!thread || thread.resourceId !== resourceId) return undefined;
  const metadata = thread.metadata as Record<string, unknown> | undefined;
  if (!thread.id.startsWith(projectThreadPrefix) && metadata?.kind !== 'project') return undefined;
  return toProject(thread);
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseTarget = (body: Record<string, unknown>): LspTarget => {
  const target = body.target && typeof body.target === 'object' ? body.target as Record<string, unknown> : body;
  return {
    projectId: optionalString(target.projectId),
    workspaceId: optionalString(target.workspaceId),
    portalId: optionalString(target.portalId),
    rootId: optionalString(target.rootId),
    repoPath: optionalString(target.repoPath),
    workspacePath: optionalString(target.workspacePath),
  };
};

const resolveLspTarget = async (
  c: any,
  resourceId: string,
  body: Record<string, unknown>,
  useServiceResolution = false,
) => {
  const target = parseTarget(body);
  if (!target.projectId || !target.workspaceId) {
    throw new Error('Project and Workspace are required for language intelligence.');
  }

  const memory = await getMemory(c);
  const project = await getProject(memory, resourceId, target.projectId);
  if (!project) throw new Error('Project was not found.');
  if (project.projectKind !== 'git') throw new Error('Language intelligence is only available for Git Projects.');

  const workspace = project.workspaces.find((item) => item.id === target.workspaceId);
  if (!workspace) throw new Error('Workspace was not found.');
  const serviceTarget = {
    portalId: target.portalId ?? workspace.portalId ?? project.portalId,
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    rootId: project.portalRootId ?? target.rootId,
    repoPath: project.repoPath ?? target.repoPath,
    workspacePath: workspace.path ?? target.workspacePath,
  };
  if (useServiceResolution) return serviceTarget;

  const portal = resolvePortalForTarget({
    userId: resourceId,
    portalId: serviceTarget.portalId,
    projectId: serviceTarget.projectId,
    rootId: serviceTarget.rootId,
    repoPath: serviceTarget.repoPath,
    workspacePath: serviceTarget.workspacePath,
  });
  if (!portal) throw new Error('No online Portal is available for language intelligence.');
  if (!portal.capabilities.includes('portal.lsp') || !portal.capabilities.includes('portal.lsp.session')) {
    throw new Error('The connected Portal does not support language intelligence yet.');
  }

  return {
    ...serviceTarget,
    portalId: portal.portalId,
  };
};

const cleanPortalResult = (result: unknown) => {
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (record.ok === false) {
    throw new Error(typeof record.error === 'string' ? record.error : 'Portal LSP request failed.');
  }
  const { id: _id, type: _type, ...body } = record;
  return body;
};

const requireResolvedPortalTarget = (target: LspTarget) => {
  if (!target.portalId) throw new Error('No online Portal is available for language intelligence.');
  return target as LspTarget & { portalId: string };
};

const getPortalWsUrl = (c: any) => {
  const configured = process.env.WEAVE_PORTAL_WS_PUBLIC_URL?.replace(/\/+$/, '');
  if (configured) return `${configured}/lsp/connect`;

  const url = new URL(c.req.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.port = process.env.WEAVE_PORTAL_WS_PUBLIC_PORT ?? process.env.WEAVE_PORTAL_WS_PORT ?? '4112';
  url.pathname = '/lsp/connect';
  url.search = '';
  url.hash = '';
  return url.toString();
};

const errorResponse = (c: any, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message)
    ? 404
    : /Portal|language intelligence|Project|Workspace/.test(message)
    ? 400
    : 500;
  return c.json({ error: message }, status);
};

type LspRouteDeps = {
  sessions?: SessionService;
};

export const createLspRoutes = (deps: LspRouteDeps = {}) => [
  defineRoute('/code/lsp/session', {
    method: 'POST',
    handler: async (c) => {
      try {
        const resourceId = getResourceId(c);
        const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
        const path = optionalString(body.path);
        if (!path) throw new Error('path is required.');
        const target = await resolveLspTarget(c, resourceId, body, Boolean(deps.sessions));
        const languageId = optionalString(body.languageId);
        const requestedServerId = optionalString(body.serverId);
        const session = deps.sessions
          ? await deps.sessions.startLspSession({
            caller: callerForOwner(resourceId, 'ui'),
            scope: portalToolScope(target),
            path,
            languageId,
            serverId: requestedServerId,
            timeoutMs: 10_000,
          })
          : (() => undefined)();
        const result = session ? session : cleanPortalResult(
          await requestPortalTool({
            ...requireResolvedPortalTarget(target),
            tool: 'portal.lsp.session',
            args: {
              path,
              languageId,
              serverId: requestedServerId,
            },
            timeoutMs: 10_000,
          }),
        ) as Record<string, any>;
        const token = session?.token ?? (() => {
          const sessionId = optionalString(result.sessionId);
          if (!sessionId) throw new Error('Portal LSP session response did not include a sessionId.');
          return issueLspSessionToken({
            resourceId,
            ...requireResolvedPortalTarget(target),
            sessionId,
            path,
            languageId: optionalString(result.languageId) ?? languageId,
            serverId: optionalString(result.serverId) ?? requestedServerId,
          });
        })();
        const { target: _serviceTarget, token: _serviceToken, ...responseResult } = result as Record<string, any>;
        return c.json({
          ...responseResult,
          token,
          portalId: session?.target.portalId ?? target.portalId,
          wsUrl: getPortalWsUrl(c),
        });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];

export const lspRoutes = createLspRoutes();
