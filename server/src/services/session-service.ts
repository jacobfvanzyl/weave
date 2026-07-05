import { issueJupyterSessionToken } from '../portal/jupyter-relay';
import { issueLspSessionToken } from '../portal/lsp-relay';
import { issueTerminalToken, type TerminalSessionKind } from '../portal/terminal-relay';
import { issueWorkspaceFileWatchToken } from '../portal/workspace-file-watch-relay';
import type { ResolvedPortalToolTarget } from './providers/portal-provider';
import type { ToolService } from './tool-service';
import type { ServiceCaller, ServiceGrant, ServiceScope } from './types';
import { optionalString, requireServiceGrant, ServiceError } from './types';

export type TerminalSessionInput = {
  caller: ServiceCaller;
  scope: ServiceScope;
  grants?: ServiceGrant[];
  kind: TerminalSessionKind;
};

export type LspSessionInput = {
  caller: ServiceCaller;
  scope: ServiceScope;
  grants?: ServiceGrant[];
  path: string;
  languageId?: string;
  serverId?: string;
  timeoutMs?: number;
};

export type JupyterSessionInput = {
  caller: ServiceCaller;
  scope: ServiceScope;
  grants?: ServiceGrant[];
  action: 'status' | 'kernelspecs' | 'session';
  path?: string;
  kernelName?: string;
  language?: string;
  timeoutMs?: number;
};

export type WorkspaceFileWatchSessionInput = {
  caller: ServiceCaller;
  scope: ServiceScope;
  grants?: ServiceGrant[];
};

export interface SessionService {
  issueTerminalToken(input: TerminalSessionInput): Promise<{ token: string; target: ResolvedPortalToolTarget }>;
  startLspSession(
    input: LspSessionInput,
  ): Promise<Record<string, unknown> & { token: string; target: ResolvedPortalToolTarget }>;
  handleJupyter(
    input: JupyterSessionInput,
  ): Promise<Record<string, unknown> & { token?: string; target: ResolvedPortalToolTarget }>;
  issueWorkspaceFileWatchToken(
    input: WorkspaceFileWatchSessionInput,
  ): Promise<{ token: string; target: ResolvedPortalToolTarget }>;
}

const cleanPortalEnvelope = (result: unknown, fallbackMessage: string) => {
  const record = result && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  if (record.ok === false) {
    throw new ServiceError('operation_failed', optionalString(record.error) ?? fallbackMessage, 400);
  }
  const { id: _id, type: _type, ...body } = record;
  return body;
};

const requireCapability = (target: ResolvedPortalToolTarget, capability: string, message: string) => {
  if (!target.portal.capabilities.includes(capability)) throw new ServiceError('operation_failed', message, 400);
};

export class DefaultSessionService implements SessionService {
  constructor(private readonly tools: ToolService) {}

  async issueTerminalToken(input: TerminalSessionInput) {
    requireServiceGrant(input.grants, {
      service: 'session',
      operation: 'portal.terminal.issue',
      scope: input.scope,
    });
    const target = await this.tools.resolvePortalTarget(input.caller, input.scope);
    const token = issueTerminalToken({
      resourceId: input.caller.ownerId,
      portalId: target.portalId,
      kind: input.kind,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      rootId: target.rootId,
      repoPath: target.repoPath,
      workspacePath: target.workspacePath,
    });
    return { token, target };
  }

  async startLspSession(input: LspSessionInput) {
    if (!input.path) throw new ServiceError('operation_failed', 'path is required.', 400);
    requireServiceGrant(input.grants, {
      service: 'session',
      operation: 'portal.lsp.session',
      scope: input.scope,
    });
    const target = await this.tools.resolvePortalTarget(input.caller, input.scope);
    requireCapability(target, 'portal.lsp', 'The connected Portal does not support language intelligence yet.');
    requireCapability(target, 'portal.lsp.session', 'The connected Portal does not support language intelligence yet.');

    const result = cleanPortalEnvelope(
      await this.tools.requestPortal({
        caller: input.caller,
        scope: input.scope,
        tool: 'portal.lsp.session',
        args: {
          path: input.path,
          languageId: input.languageId,
          serverId: input.serverId,
        },
        timeoutMs: input.timeoutMs,
      }),
      'Portal LSP request failed.',
    ) as Record<string, unknown>;
    const sessionId = optionalString(result.sessionId);
    if (!sessionId) {
      throw new ServiceError('operation_failed', 'Portal LSP session response did not include a sessionId.', 400);
    }

    const token = issueLspSessionToken({
      resourceId: input.caller.ownerId,
      portalId: target.portalId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      rootId: target.rootId,
      repoPath: target.repoPath,
      workspacePath: target.workspacePath,
      sessionId,
      path: input.path,
      languageId: optionalString(result.languageId) ?? input.languageId,
      serverId: optionalString(result.serverId) ?? input.serverId,
    });
    return { ...result, token, target };
  }

  async handleJupyter(input: JupyterSessionInput) {
    const tool = input.action === 'kernelspecs' ? 'portal.jupyter.kernelspecs' : `portal.jupyter.${input.action}`;
    requireServiceGrant(input.grants, {
      service: 'session',
      operation: tool,
      scope: input.scope,
    });
    const target = await this.tools.resolvePortalTarget(input.caller, input.scope);
    requireCapability(target, tool, 'The connected Portal does not support Jupyter execution yet.');

    const result = cleanPortalEnvelope(
      await this.tools.requestPortal({
        caller: input.caller,
        scope: input.scope,
        tool,
        args: {
          path: input.path,
          kernelName: input.kernelName,
          language: input.language,
        },
        timeoutMs: input.timeoutMs,
      }),
      'Portal Jupyter request failed.',
    ) as Record<string, unknown>;

    if (input.action !== 'session') return { ...result, target };
    if (!input.path) throw new ServiceError('operation_failed', 'path is required.', 400);
    const sessionId = optionalString(result.sessionId);
    if (!sessionId) {
      throw new ServiceError('operation_failed', 'Portal Jupyter session response did not include a sessionId.', 400);
    }

    const token = issueJupyterSessionToken({
      resourceId: input.caller.ownerId,
      portalId: target.portalId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      rootId: target.rootId,
      repoPath: target.repoPath,
      workspacePath: target.workspacePath,
      sessionId,
      path: input.path,
      kernelName: optionalString(result.kernelName) ?? input.kernelName,
    });
    return { ...result, token, target };
  }

  async issueWorkspaceFileWatchToken(input: WorkspaceFileWatchSessionInput) {
    requireServiceGrant(input.grants, {
      service: 'session',
      operation: 'portal.fs.watch',
      scope: input.scope,
    });
    const target = await this.tools.resolvePortalTarget(input.caller, input.scope);
    requireCapability(target, 'portal.fs.watch', 'The connected Portal does not support workspace file watching yet.');
    const token = issueWorkspaceFileWatchToken({
      resourceId: input.caller.ownerId,
      portalId: target.portalId,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      rootId: target.rootId,
      repoPath: target.repoPath,
      workspacePath: target.workspacePath,
    });
    return { token, target };
  }
}
