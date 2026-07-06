import type { MastraDBMessage } from '@mastra/core/agent';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const messageTextForTokenEstimate = (message: MastraDBMessage) =>
  message.content.parts
    .map((part) => {
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
      if (typeof record.result === 'string') return record.result;
      if (record.result !== undefined) return JSON.stringify(record.result);
      if (record.output !== undefined) {
        return typeof record.output === 'string' ? record.output : JSON.stringify(record.output);
      }
      return JSON.stringify(record);
    })
    .filter(Boolean)
    .join('\n');

const estimateTextTokens = (memory: any, text: string) =>
  typeof memory.estimateTokens === 'function' ? memory.estimateTokens(text) : Math.ceil(text.length / 4);

export const estimateContextTokens = (memory: any, messages: MastraDBMessage[], systemMessage?: string) =>
  messages.reduce((total, message) => {
    const text = messageTextForTokenEstimate(message);
    return total + estimateTextTokens(memory, text);
  }, systemMessage ? estimateTextTokens(memory, systemMessage) : 0);

export const contextUsageRecallOptions = (
  threadId: string,
  resourceId: string,
  threadConfig: unknown,
) => ({
  threadId,
  resourceId,
  ...(isRecord(threadConfig) ? { threadConfig } : {}),
});

export const estimateMemoryContextTokens = async (
  memory: any,
  args: {
    threadId: string;
    resourceId: string;
    memoryConfig: unknown;
  },
) => {
  if (typeof memory.getContext === 'function') {
    const context = await memory.getContext({
      threadId: args.threadId,
      resourceId: args.resourceId,
      ...(isRecord(args.memoryConfig) ? { memoryConfig: args.memoryConfig } : {}),
    });
    return estimateContextTokens(
      memory,
      Array.isArray(context?.messages) ? context.messages : [],
      context?.systemMessage,
    );
  }

  const recalled = await memory.recall({
    ...contextUsageRecallOptions(args.threadId, args.resourceId, args.memoryConfig),
  });
  return estimateContextTokens(memory, recalled.messages);
};
