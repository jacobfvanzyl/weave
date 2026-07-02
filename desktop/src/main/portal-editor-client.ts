import { randomBytes } from 'node:crypto';
import type {
  EditorDeleteInput,
  EditorDiffPreviewInput,
  EditorDiffPreviewResult,
  EditorFile,
  EditorHashInput,
  EditorHashResult,
  EditorListInput,
  EditorListResult,
  EditorMkdirInput,
  EditorMoveInput,
  EditorOperationResult,
  EditorReadInput,
  EditorTarget,
  EditorWatchEventEnvelope,
  EditorWatchStartInput,
  EditorWatchStartResult,
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

type EditorWebContents = {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, event: EditorWatchEventEnvelope) => void;
};

type PortalEditorWatchHostEvent =
  | { type: 'editor.watch.ready'; requestId?: string; paths: string[] }
  | { type: 'editor.watch.change'; event: EditorWatchEventEnvelope['event'] }
  | { type: 'editor.watch.error'; requestId?: string; error: string };

type LocalEditorWatchConnection = {
  subscriptionId: string;
  socket: WebSocket;
  webContents: EditorWebContents;
  pendingRequests: Map<string, {
    resolve: (value: EditorWatchStartResult) => void;
    reject: (error: Error) => void;
  }>;
};

const editorWatchEventChannel = 'editor:watch-event';

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
  private readonly watchConnections = new Map<string, LocalEditorWatchConnection>();

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

  async hash(input: EditorHashInput): Promise<EditorHashResult> {
    return await this.callPortal<EditorHashResult>('hash', {
      target: await this.resolveTarget(input.target),
      path: input.path,
    });
  }

  async diffPreview(input: EditorDiffPreviewInput): Promise<EditorDiffPreviewResult> {
    return await this.callPortal<EditorDiffPreviewResult>('diffPreview', {
      target: await this.resolveTarget(input.target),
      path: input.path,
      diff: input.diff,
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

  async watchStart(input: EditorWatchStartInput, webContents: EditorWebContents): Promise<EditorWatchStartResult> {
    const subscriptionId = `editor-watch:${randomBytes(12).toString('hex')}`;
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

  async watchUpdate(subscriptionId: string, paths: string[]): Promise<EditorWatchStartResult> {
    const connection = this.watchConnections.get(subscriptionId);
    if (!connection) throw new Error('Editor watch subscription was not found.');
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

  private async callPortal<T>(action: 'list' | 'read' | 'hash' | 'diffPreview' | 'write' | 'mkdir' | 'move' | 'delete', body: unknown): Promise<T> {
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

  private async createWatchConnection(subscriptionId: string, webContents: EditorWebContents) {
    const control = await this.supervisor.ensureStarted();
    const url = new URL('/editor/watch', control.httpUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', control.token);
    const socket = new WebSocket(url);
    const connection: LocalEditorWatchConnection = {
      subscriptionId,
      socket,
      webContents,
      pendingRequests: new Map(),
    };

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('Portal local editor watch WebSocket failed.'));
      socket.onclose = () => {
        for (const pending of connection.pendingRequests.values()) {
          pending.reject(new Error('Portal local editor watch WebSocket closed.'));
        }
        connection.pendingRequests.clear();
        this.watchConnections.delete(subscriptionId);
      };
      socket.onmessage = event => {
        const watchEvent = JSON.parse(String(event.data)) as PortalEditorWatchHostEvent;
        this.handleWatchEvent(connection, watchEvent);
      };
    });

    return connection;
  }

  private watchRequest(
    connection: LocalEditorWatchConnection,
    message: { type: 'watch.start' | 'watch.update' | 'watch.stop'; target?: EditorTarget; paths?: string[] },
  ) {
    const requestId = `editor-watch-${randomBytes(8).toString('hex')}`;
    return new Promise<EditorWatchStartResult>((resolve, reject) => {
      connection.pendingRequests.set(requestId, { resolve, reject });
      this.sendWatchMessage(connection, { ...message, requestId });
    });
  }

  private sendWatchMessage(connection: LocalEditorWatchConnection, message: Record<string, unknown>) {
    if (connection.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Portal local editor watch WebSocket is not open.');
    }
    connection.socket.send(JSON.stringify(message));
  }

  private handleWatchEvent(connection: LocalEditorWatchConnection, watchEvent: PortalEditorWatchHostEvent) {
    if (watchEvent.type === 'editor.watch.ready' && watchEvent.requestId) {
      connection.pendingRequests.get(watchEvent.requestId)?.resolve({
        subscriptionId: connection.subscriptionId,
        paths: watchEvent.paths,
      });
      connection.pendingRequests.delete(watchEvent.requestId);
      return;
    }

    if (watchEvent.type === 'editor.watch.error') {
      if (watchEvent.requestId) {
        connection.pendingRequests.get(watchEvent.requestId)?.reject(new Error(watchEvent.error));
        connection.pendingRequests.delete(watchEvent.requestId);
        return;
      }
      this.sendWatchEvent(connection, { subscriptionId: connection.subscriptionId, error: watchEvent.error });
      return;
    }

    if (watchEvent.type === 'editor.watch.change' && watchEvent.event) {
      this.sendWatchEvent(connection, { subscriptionId: connection.subscriptionId, event: watchEvent.event });
    }
  }

  private sendWatchEvent(connection: LocalEditorWatchConnection, event: EditorWatchEventEnvelope) {
    if (connection.webContents.isDestroyed()) {
      this.closeWatchConnection(connection.subscriptionId);
      return;
    }
    connection.webContents.send(editorWatchEventChannel, event);
  }

  private closeWatchConnection(subscriptionId: string) {
    const connection = this.watchConnections.get(subscriptionId);
    if (!connection) return;
    this.watchConnections.delete(subscriptionId);
    if (connection.socket.readyState === WebSocket.OPEN || connection.socket.readyState === WebSocket.CONNECTING) {
      connection.socket.close();
    }
    for (const pending of connection.pendingRequests.values()) {
      pending.reject(new Error('Editor watch subscription closed.'));
    }
    connection.pendingRequests.clear();
  }
}
