import type {
  EditorFile,
  EditorDeleteInput,
  EditorListInput,
  EditorListResult,
  EditorMkdirInput,
  EditorMoveInput,
  EditorOperationResult,
  EditorReadInput,
  EditorTarget,
  EditorWriteInput,
  EditorWriteResult,
} from '../shared/editor';
import type { PortalSupervisor } from './portal-terminal-client';

type EditorResolvedTarget = {
  cwd: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
};

type PortalEditorClientOptions = {
  supervisor: PortalSupervisor;
  resolveWorkspace: (target: EditorTarget) => Promise<EditorResolvedTarget>;
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
    throw new Error(body?.error || text || `Portal editor request failed: HTTP ${response.status}`);
  }
  if (!body) throw new Error('Portal editor response was empty.');
  return body;
};

export class PortalEditorClient {
  private readonly supervisor: PortalSupervisor;
  private readonly resolveWorkspace: (target: EditorTarget) => Promise<EditorResolvedTarget>;

  constructor(options: PortalEditorClientOptions) {
    this.supervisor = options.supervisor;
    this.resolveWorkspace = options.resolveWorkspace;
  }

  async list(input: EditorListInput): Promise<EditorListResult> {
    return await this.callPortal<EditorListResult>('list', {
      target: await this.resolveTarget(input.target),
      path: input.path,
    });
  }

  async read(input: EditorReadInput): Promise<EditorFile> {
    return await this.callPortal<EditorFile>('read', {
      target: await this.resolveTarget(input.target),
      path: input.path,
    });
  }

  async write(input: EditorWriteInput): Promise<EditorWriteResult> {
    return await this.callPortal<EditorWriteResult>('write', {
      target: await this.resolveTarget(input.target),
      path: input.path,
      content: input.content,
      version: input.version,
    });
  }

  async mkdir(input: EditorMkdirInput): Promise<EditorOperationResult> {
    return await this.callPortal<EditorOperationResult>('mkdir', {
      target: await this.resolveTarget(input.target),
      path: input.path,
    });
  }

  async move(input: EditorMoveInput): Promise<EditorOperationResult> {
    return await this.callPortal<EditorOperationResult>('move', {
      target: await this.resolveTarget(input.target),
      fromPath: input.fromPath,
      toPath: input.toPath,
      overwrite: input.overwrite,
    });
  }

  async delete(input: EditorDeleteInput): Promise<EditorOperationResult> {
    return await this.callPortal<EditorOperationResult>('delete', {
      target: await this.resolveTarget(input.target),
      path: input.path,
      recursive: input.recursive,
    });
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

  private async callPortal<T>(action: 'list' | 'read' | 'write' | 'mkdir' | 'move' | 'delete', body: unknown): Promise<T> {
    const control = await this.supervisor.ensureStarted();
    return await parseResponse<T>(
      await fetch(`${control.httpUrl}/editor/${action}`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${control.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );
  }
}
