import { describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => {
  const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  return {
    notificationHandlers,
    request: vi.fn(async (method: string) => {
      if (method === 'chat.run.subscribe') {
        return { subscriptionId: 'chat_sub_1', active: true, afterSequence: 0 };
      }
      return {};
    }),
  };
});

vi.mock('../../packages/client/src/lib/mastra-client', () => ({
  rpcRequest: rpc.request,
  onRpcConnectionState: (handler: (state: string) => void) => {
    handler('connected');
    return () => undefined;
  },
  onRpcNotification: (method: string, handler: (params: unknown) => void) => {
    const handlers = rpc.notificationHandlers.get(method) ?? new Set();
    handlers.add(handler);
    rpc.notificationHandlers.set(method, handlers);
    return () => handlers.delete(handler);
  },
}));

import { RpcAssistantChatTransport } from '../../packages/client/src/lib/rpc-chat-transport';

const notify = (method: string, params: unknown) => {
  for (const handler of rpc.notificationHandlers.get(method) ?? []) handler(params);
};

describe('RpcAssistantChatTransport', () => {
  it('closes when done repeats the final durable event sequence', async () => {
    const transport = new RpcAssistantChatTransport();
    const stream = await transport.sendMessages({
      chatId: 'thread-1',
      messages: [],
    } as never);
    const reader = stream.getReader();

    notify('chat.run.event', {
      subscriptionId: 'chat_sub_1',
      threadId: 'thread-1',
      sequence: 1,
      event: { type: 'text-start', id: 'text-1' },
    });
    await expect(reader.read()).resolves.toEqual({
      done: false,
      value: { type: 'text-start', id: 'text-1' },
    });

    notify('chat.run.event', {
      subscriptionId: 'chat_sub_1',
      threadId: 'thread-1',
      sequence: 1,
      done: true,
    });

    await expect(Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('stream did not close')), 250)),
    ])).resolves.toEqual({ done: true, value: undefined });
  });
});
