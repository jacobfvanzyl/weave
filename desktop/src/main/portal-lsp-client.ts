import type { EditorTarget } from '../shared/editor';
import type { LspSessionInput, LspSessionResult } from '../shared/language-intelligence';
import type { PortalSupervisor } from './portal-terminal-client';

type LspResolvedTarget = {
  cwd: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
};

type PortalLspClientOptions = {
  supervisor: PortalSupervisor;
  resolveWorkspace: (target: EditorTarget) => Promise<LspResolvedTarget>;
};

const parseResponse = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  const body = text
    ? (() => {
      try {
        return JSON.parse(text) as { error?: string } & T;
      } catch {
        return undefined;
      }
    })()
    : undefined;
  if (!response.ok) {
    throw new Error(body?.error || text || `Portal LSP request failed: HTTP ${response.status}`);
  }
  if (!body) throw new Error('Portal LSP response was empty.');
  return body;
};

const toWsUrl = (httpUrl: string, token: string) => {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/lsp';
  url.searchParams.set('token', token);
  return url.toString();
};

export class PortalLspClient {
  private readonly supervisor: PortalSupervisor;
  private readonly resolveWorkspace: (target: EditorTarget) => Promise<LspResolvedTarget>;

  constructor(options: PortalLspClientOptions) {
    this.supervisor = options.supervisor;
    this.resolveWorkspace = options.resolveWorkspace;
  }

  async createSession(input: LspSessionInput): Promise<LspSessionResult> {
    const control = await this.supervisor.ensureStarted();
    const target = await this.resolveTarget(input.target);
    const result = await parseResponse<Omit<LspSessionResult, 'wsUrl'>>(
      await fetch(`${control.httpUrl}/lsp/session`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          target,
          path: input.path,
          languageId: input.languageId,
          serverId: input.serverId,
        }),
      }),
    );
    return {
      ...result,
      wsUrl: toWsUrl(control.httpUrl, control.token),
    };
  }

  private async resolveTarget(target: EditorTarget): Promise<EditorTarget> {
    const resolved = await this.resolveWorkspace(target);
    return {
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      portalId: resolved.portalId ?? target.portalId,
      rootId: resolved.rootId ?? target.rootId,
      repoPath: resolved.repoPath ?? target.repoPath,
      workspacePath: resolved.cwd,
    };
  }
}
