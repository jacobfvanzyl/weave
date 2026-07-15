import { AssistantChatTransport } from '@assistant-ui/react-ai-sdk';
import type { ChatTransport, HttpChatTransportInitOptions, UIMessage, UIMessageChunk } from 'ai';
import { parseRpcRequestParams } from '@weave/protocol';
import { onRpcConnectionState, onRpcNotification, rpcRequest } from './mastra-client';

type RpcChatTransportOptions<UI_MESSAGE extends UIMessage> = HttpChatTransportInitOptions<UI_MESSAGE> & {
  onRunStarted?: () => void;
};

export class RpcAssistantChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
  extends AssistantChatTransport<UI_MESSAGE> {
  private readonly lastSequenceByRun = new Map<string, number>();
  private readonly onRunStarted?: () => void;

  constructor(options: RpcChatTransportOptions<UI_MESSAGE> = {}) {
    const { onRunStarted, ...transportOptions } = options;
    super(transportOptions);
    this.onRunStarted = onRunStarted;
  }

  override async sendMessages(
    options: Parameters<ChatTransport<UI_MESSAGE>['sendMessages']>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    const requestId = crypto.randomUUID();
    const body = parseRpcRequestParams('client', 'server', 'chat.run.start', {
      ...await this.prepareBody(options),
      requestId,
    });
    let started: { run?: { runId?: string } };
    try {
      started = await rpcRequest('chat.run.start', body, { signal: options.abortSignal });
    } catch (error) {
      if (options.abortSignal?.aborted) throw error;
      const recovered = await rpcRequest('chat.run.get', { threadId: options.chatId, runId: requestId });
      if (recovered.run?.runId !== requestId && recovered.persisted?.runId !== requestId) throw error;
      started = { run: { runId: requestId } };
    }
    const runId = started.run?.runId ?? requestId;
    this.lastSequenceByRun.set(runId, 0);
    this.onRunStarted?.();
    return await this.subscribe(options.chatId, runId, options.abortSignal);
  }

  override async reconnectToStream(
    options: Parameters<ChatTransport<UI_MESSAGE>['reconnectToStream']>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    const state = await rpcRequest('chat.run.get', {
      threadId: options.chatId,
    });
    if (!state.run?.active || !state.run.runId) return null;
    return await this.subscribe(options.chatId, state.run.runId);
  }

  private async prepareBody(options: Parameters<ChatTransport<UI_MESSAGE>['sendMessages']>[0]) {
    const prepared = await this.prepareSendMessagesRequest?.({
      api: '/rpc',
      id: options.chatId,
      messages: options.messages,
      body: options.body as Record<string, unknown> | undefined,
      headers: options.headers,
      credentials: undefined,
      requestMetadata: options.metadata,
      trigger: options.trigger,
      messageId: options.messageId,
    });
    return prepared?.body ?? {
      ...(options.body ?? {}),
      id: options.chatId,
      messages: options.messages,
      trigger: options.trigger,
      messageId: options.messageId,
    };
  }

  private async subscribe(threadId: string, runId: string, signal?: AbortSignal) {
    let subscriptionId: string | undefined;
    let closed = false;
    let detach: () => void = () => {};
    let detachState: () => void = () => {};
    let unsubscribe: () => void = () => {};
    let disconnected = false;
    let subscribing = false;

    const stream = new ReadableStream<UIMessageChunk>({
      start: async controller => {
        const finish = (error?: unknown) => {
          if (closed) return;
          closed = true;
          detach();
          detachState();
          signal?.removeEventListener('abort', unsubscribe);
          if (error) controller.error(error instanceof Error ? error : new Error(String(error)));
          else controller.close();
        };
        unsubscribe = () => {
          if (subscriptionId) void rpcRequest('chat.run.unsubscribe', { subscriptionId }).catch(() => undefined);
          finish();
        };
        signal?.addEventListener('abort', unsubscribe, { once: true });
        detach = onRpcNotification('chat.run.event', event => {
          if (
            event.threadId !== threadId || event.runId !== runId ||
            (subscriptionId && event.subscriptionId !== subscriptionId)
          ) return;
          // Completion/error notifications carry the last durable event sequence as a
          // watermark; they are control messages, not duplicate durable events.
          if (event.error) {
            finish(event.error);
            return;
          }
          if (event.done === true) {
            finish();
            return;
          }
          const sequence = event.sequence;
          const lastSequence = this.lastSequenceByRun.get(runId) ?? 0;
          if (sequence <= lastSequence) return;
          this.lastSequenceByRun.set(runId, sequence);
          if (event.event !== undefined) controller.enqueue(event.event as UIMessageChunk);
        });

        const startSubscription = async () => {
          if (closed || subscribing) return;
          subscribing = true;
          try {
            const result = await rpcRequest('chat.run.subscribe', {
              threadId,
              runId,
              afterSequence: this.lastSequenceByRun.get(runId) ?? 0,
            }, { signal });
            if (closed) return;
            if (!result.active || !result.subscriptionId) {
              finish();
              return;
            }
            subscriptionId = result.subscriptionId;
          } finally {
            subscribing = false;
          }
        };
        detachState = onRpcConnectionState(state => {
          if (state !== 'connected') {
            disconnected = true;
            subscriptionId = undefined;
            return;
          }
          if (!disconnected || closed) return;
          disconnected = false;
          void startSubscription().catch(finish);
        });
        try {
          await startSubscription();
        } catch (error) {
          finish(error);
        }
      },
      cancel: () => {
        if (subscriptionId) void rpcRequest('chat.run.unsubscribe', { subscriptionId }).catch(() => undefined);
        if (closed) return;
        closed = true;
        detach();
        detachState();
        signal?.removeEventListener('abort', unsubscribe);
      },
    });

    return stream;
  }
}
