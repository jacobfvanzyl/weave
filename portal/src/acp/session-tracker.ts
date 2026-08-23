import type { JsonRpcId, JsonRpcMessage } from '@weave/protocol';
import type { ThreadCatalog } from './thread-catalog.ts';

type PendingLifecycleRequest =
  | { kind: 'new' }
  | { kind: 'load' | 'resume' | 'prompt' | 'close' | 'delete'; sessionId: string };

const idKey = (id: JsonRpcId) => `${typeof id}:${String(id)}`;

const objectValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const sessionIdFrom = (value: unknown) => {
  const sessionId = objectValue(value)?.sessionId;
  return typeof sessionId === 'string' && sessionId.trim() ? sessionId : undefined;
};

export class AcpSessionTracker {
  private readonly pending = new Map<string, PendingLifecycleRequest>();

  constructor(
    private readonly catalog: ThreadCatalog,
    private readonly context: {
      agentId: string;
      workspaceId: string;
      principalId: string;
    },
  ) {}

  observeClientMessage(message: JsonRpcMessage) {
    if (!('method' in message) || !('id' in message)) return;
    const key = idKey(message.id);
    if (message.method === 'session/new') {
      this.pending.set(key, { kind: 'new' });
      return;
    }
    if (
      !['session/load', 'session/resume', 'session/prompt', 'session/close', 'session/delete'].includes(message.method)
    ) {
      return;
    }
    const sessionId = sessionIdFrom(message.params);
    if (!sessionId) return;
    this.pending.set(key, {
      kind: message.method.slice('session/'.length) as Exclude<PendingLifecycleRequest['kind'], 'new'>,
      sessionId,
    });
  }

  async observeAgentMessage(message: JsonRpcMessage): Promise<void> {
    if ('method' in message) return;
    if (message.id === null) return;
    const pending = this.pending.get(idKey(message.id));
    if (!pending) return;
    this.pending.delete(idKey(message.id));
    if ('error' in message) return;

    if (pending.kind === 'new') {
      const sessionId = sessionIdFrom(message.result);
      if (sessionId) await this.upsert(sessionId);
      return;
    }
    if (pending.kind === 'load' || pending.kind === 'resume') {
      await this.upsert(pending.sessionId);
      return;
    }
    if (pending.kind === 'prompt') {
      await this.catalog.touchAcpSession(this.context.agentId, this.context.workspaceId, pending.sessionId);
      return;
    }
    await this.catalog.setAcpSessionStatus(
      this.context.agentId,
      this.context.workspaceId,
      pending.sessionId,
      pending.kind === 'delete' ? 'deleted' : 'closed',
    );
  }

  private async upsert(acpSessionId: string) {
    await this.catalog.upsertAcpSession({
      agentId: this.context.agentId,
      workspaceId: this.context.workspaceId,
      creatorPrincipalId: this.context.principalId,
      acpSessionId,
    });
  }
}
