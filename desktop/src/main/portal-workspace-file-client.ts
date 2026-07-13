import { randomBytes } from 'node:crypto';
import type {
  WorkspaceFileDeleteInput,
  WorkspaceFileDiffPreviewInput,
  WorkspaceFileDiffPreviewResult,
  WorkspaceFileFile,
  WorkspaceFileHashInput,
  WorkspaceFileHashResult,
  WorkspaceFileIndexResult,
  WorkspaceFileListInput,
  WorkspaceFileListResult,
  WorkspaceFileMkdirInput,
  WorkspaceFileMoveInput,
  WorkspaceFileOperationResult,
  WorkspaceFileReadInput,
  WorkspaceFileTarget,
  WorkspaceFileUploadInput,
  WorkspaceFileWatchEventEnvelope,
  WorkspaceFileWatchStartInput,
  WorkspaceFileWatchStartResult,
  WorkspaceFileWriteInput,
  WorkspaceFileWriteResult,
} from '../shared/workspace-file';
import type { PortalSupervisor } from './portal-supervisor';

type WorkspaceFileResolvedTarget = {
  cwd: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
};

type PortalWorkspaceFileClientOptions = {
  supervisor: PortalSupervisor;
  resolveWorkspace: (target: WorkspaceFileTarget) => Promise<WorkspaceFileResolvedTarget>;
};

type WorkspaceFileWebContents = {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, event: WorkspaceFileWatchEventEnvelope) => void;
};

type PortalWorkspaceFileWatchHostEvent =
  | { type: 'workspace-file.watch.ready'; requestId?: string; paths: string[] }
  | { type: 'workspace-file.watch.change'; event: WorkspaceFileWatchEventEnvelope['event'] }
  | { type: 'workspace-file.watch.error'; requestId?: string; error: string };

type LocalWorkspaceFileWatchConnection = {
  subscriptionId: string;
  socket: WebSocket;
  webContents: WorkspaceFileWebContents;
  pendingRequests: Map<string, {
    resolve: (value: WorkspaceFileWatchStartResult) => void;
    reject: (error: Error) => void;
  }>;
};

const workspaceFileWatchEventChannel = 'workspace-file:watch-event';

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
    throw new Error(body?.error || text || `Portal workspace file request failed: HTTP ${response.status}`);
  }
  if (!body) throw new Error('Portal workspace file response was empty.');
  return body;
};

export class PortalWorkspaceFileClient {
  private readonly supervisor: PortalSupervisor;
  private readonly resolveWorkspace: (target: WorkspaceFileTarget) => Promise<WorkspaceFileResolvedTarget>;
  private readonly watchConnections = new Map<string, LocalWorkspaceFileWatchConnection>();

  constructor(options: PortalWorkspaceFileClientOptions) {
    this.supervisor = options.supervisor;
    this.resolveWorkspace = options.resolveWorkspace;
  }

  async list(input: WorkspaceFileListInput): Promise<WorkspaceFileListResult> {
    return await this.callPortal<WorkspaceFileListResult>('list', {
      target: await this.resolveTarget(input.target),
      path: input.path,
    });
  }

  async read(input: WorkspaceFileReadInput): Promise<WorkspaceFileFile> {
    return await this.callPortal<WorkspaceFileFile>('read', {
      target: await this.resolveTarget(input.target),
      path: input.path,
    });
  }

  async hash(input: WorkspaceFileHashInput): Promise<WorkspaceFileHashResult> {
    return await this.callPortal<WorkspaceFileHashResult>('hash', {
      target: await this.resolveTarget(input.target),
      path: input.path,
    });
  }

  async diffPreview(input: WorkspaceFileDiffPreviewInput): Promise<WorkspaceFileDiffPreviewResult> {
    return await this.callPortal<WorkspaceFileDiffPreviewResult>('diffPreview', {
      target: await this.resolveTarget(input.target),
      path: input.path,
      diff: input.diff,
    });
  }

  async write(input: WorkspaceFileWriteInput): Promise<WorkspaceFileWriteResult> {
    return await this.callPortal<WorkspaceFileWriteResult>('write', {
      target: await this.resolveTarget(input.target),
      path: input.path,
      content: input.content,
      version: input.version,
    });
  }

  async mkdir(input: WorkspaceFileMkdirInput): Promise<WorkspaceFileOperationResult> {
    return await this.callPortal<WorkspaceFileOperationResult>('mkdir', {
      target: await this.resolveTarget(input.target),
      path: input.path,
    });
  }

  async move(input: WorkspaceFileMoveInput): Promise<WorkspaceFileOperationResult> {
    return await this.callPortal<WorkspaceFileOperationResult>('move', {
      target: await this.resolveTarget(input.target),
      fromPath: input.fromPath,
      toPath: input.toPath,
      overwrite: input.overwrite,
    });
  }

  async delete(input: WorkspaceFileDeleteInput): Promise<WorkspaceFileOperationResult> {
    return await this.callPortal<WorkspaceFileOperationResult>('delete', {
      target: await this.resolveTarget(input.target),
      path: input.path,
      recursive: input.recursive,
    });
  }

  async index(input: { target: WorkspaceFileTarget; path?: string }): Promise<WorkspaceFileIndexResult> {
    return await this.callPortal<WorkspaceFileIndexResult>('index', {
      target: await this.resolveTarget(input.target),
      path: input.path,
    });
  }

  async upload(input: WorkspaceFileUploadInput): Promise<WorkspaceFileOperationResult> {
    return await this.callPortal<WorkspaceFileOperationResult>('upload', {
      target: await this.resolveTarget(input.target),
      path: input.path,
      base64Content: input.base64Content,
      contentType: input.contentType,
    });
  }

  async watchStart(input: WorkspaceFileWatchStartInput, webContents: WorkspaceFileWebContents): Promise<WorkspaceFileWatchStartResult> {
    const subscriptionId = `workspace-file-watch:${randomBytes(12).toString('hex')}`;
    const connection = await this.createWatchConnection(subscriptionId, webContents);
    this.watchConnections.set(subscriptionId, connection);
    try {
      return await this.watchRequest(connection, {
        type: 'watch.start',
        target: await this.resolveTarget(input.target),
        paths: input.paths,
      });
    } catch (error) {
      this.closeWatchConnection(subscriptionId);
      throw error;
    }
  }

  async watchUpdate(subscriptionId: string, paths: string[]): Promise<WorkspaceFileWatchStartResult> {
    const connection = this.watchConnections.get(subscriptionId);
    if (!connection) throw new Error('WorkspaceFile watch subscription was not found.');
    return await this.watchRequest(connection, { type: 'watch.update', paths });
  }

  async watchStop(subscriptionId: string): Promise<void> {
    const connection = this.watchConnections.get(subscriptionId);
    if (!connection) return;
    try {
      await this.watchRequest(connection, { type: 'watch.stop' }).catch(() => undefined);
    } finally {
      this.closeWatchConnection(subscriptionId);
    }
  }

  detachWebContents(webContentsId: number) {
    for (const [subscriptionId, connection] of this.watchConnections) {
      if (connection.webContents.id === webContentsId) this.closeWatchConnection(subscriptionId);
    }
  }

  dispose() {
    for (const subscriptionId of this.watchConnections.keys()) this.closeWatchConnection(subscriptionId);
  }

  private async resolveTarget(target: WorkspaceFileTarget): Promise<WorkspaceFileTarget> {
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

  private async callPortal<T>(
    action: 'list' | 'read' | 'hash' | 'diffPreview' | 'write' | 'mkdir' | 'move' | 'delete' | 'index' | 'upload',
    body: unknown,
  ): Promise<T> {
    const control = await this.supervisor.ensureStarted();
    const endpoint = action === 'diffPreview' ? 'diff-preview' : action;
    return await parseResponse<T>(
      await fetch(`${control.httpUrl}/fs/${endpoint}`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${control.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );
  }

  private async createWatchConnection(subscriptionId: string, webContents: WorkspaceFileWebContents) {
    const control = await this.supervisor.ensureStarted();
    const url = new URL('/fs/watch', control.httpUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', control.token);
    const socket = new WebSocket(url);
    const connection: LocalWorkspaceFileWatchConnection = {
      subscriptionId,
      socket,
      webContents,
      pendingRequests: new Map(),
    };

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Portal local workspace-file watch WebSocket failed.'));
      socket.onclose = () => {
        for (const pending of connection.pendingRequests.values()) {
          pending.reject(new Error('Portal local workspace-file watch WebSocket closed.'));
        }
        connection.pendingRequests.clear();
        this.watchConnections.delete(subscriptionId);
      };
      socket.onmessage = event => {
        const watchEvent = JSON.parse(String(event.data)) as PortalWorkspaceFileWatchHostEvent;
        this.handleWatchEvent(connection, watchEvent);
      };
    });

    return connection;
  }

  private watchRequest(
    connection: LocalWorkspaceFileWatchConnection,
    message: { type: 'watch.start' | 'watch.update' | 'watch.stop'; target?: WorkspaceFileTarget; paths?: string[] },
  ) {
    const requestId = `workspace-file-watch-${randomBytes(8).toString('hex')}`;
    return new Promise<WorkspaceFileWatchStartResult>((resolve, reject) => {
      connection.pendingRequests.set(requestId, { resolve, reject });
      this.sendWatchMessage(connection, { ...message, requestId });
    });
  }

  private sendWatchMessage(connection: LocalWorkspaceFileWatchConnection, message: Record<string, unknown>) {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Portal local workspace-file watch WebSocket is not open.');
    }
    connection.socket.send(JSON.stringify(message));
  }

  private handleWatchEvent(connection: LocalWorkspaceFileWatchConnection, watchEvent: PortalWorkspaceFileWatchHostEvent) {
    if (watchEvent.type === 'workspace-file.watch.ready' && watchEvent.requestId) {
      connection.pendingRequests.get(watchEvent.requestId)?.resolve({
        subscriptionId: connection.subscriptionId,
        paths: watchEvent.paths,
      });
      connection.pendingRequests.delete(watchEvent.requestId);
      return;
    }

    if (watchEvent.type === 'workspace-file.watch.error') {
      if (watchEvent.requestId) {
        connection.pendingRequests.get(watchEvent.requestId)?.reject(new Error(watchEvent.error));
        connection.pendingRequests.delete(watchEvent.requestId);
        return;
      }
      this.sendWatchEvent(connection, { subscriptionId: connection.subscriptionId, error: watchEvent.error });
      return;
    }

    if (watchEvent.type === 'workspace-file.watch.change' && watchEvent.event) {
      this.sendWatchEvent(connection, { subscriptionId: connection.subscriptionId, event: watchEvent.event });
    }
  }

  private sendWatchEvent(connection: LocalWorkspaceFileWatchConnection, event: WorkspaceFileWatchEventEnvelope) {
    if (connection.webContents.isDestroyed()) {
      this.closeWatchConnection(connection.subscriptionId);
      return;
    }
    connection.webContents.send(workspaceFileWatchEventChannel, event);
  }

  private closeWatchConnection(subscriptionId: string) {
    const connection = this.watchConnections.get(subscriptionId);
    if (!connection) return;
    this.watchConnections.delete(subscriptionId);
    if (connection.socket.readyState === WebSocket.OPEN || connection.socket.readyState === WebSocket.CONNECTING) {
      connection.socket.close();
    }
    for (const pending of connection.pendingRequests.values()) {
      pending.reject(new Error('WorkspaceFile watch subscription closed.'));
    }
    connection.pendingRequests.clear();
  }
}
