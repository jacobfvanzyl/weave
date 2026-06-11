import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';
import { formatRuntimeContext, type ChatRuntimeContext } from './agents/instructions';

const chatRuntimeContextKey = 'weave:chat-runtime-context';

type PromptMessage = Record<string, unknown> & {
  role?: unknown;
  content?: unknown;
};

export const putChatRuntimeContext = (requestContext: any, context: ChatRuntimeContext) => {
  requestContext?.set?.(chatRuntimeContextKey, context);
};

const isChatRuntimeContext = (value: unknown): value is ChatRuntimeContext =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getChatRuntimeContext = (requestContext: any): ChatRuntimeContext | undefined => {
  const value = requestContext?.get?.(chatRuntimeContextKey);
  return isChatRuntimeContext(value) ? value : undefined;
};

const runtimeSystemMessage = (context: ChatRuntimeContext): PromptMessage => ({
  role: 'system',
  content: formatRuntimeContext(context),
});

const insertAfterSystemPrefix = (prompt: PromptMessage[], message: PromptMessage) => {
  let insertIndex = 0;
  while (insertIndex < prompt.length && prompt[insertIndex]?.role === 'system') insertIndex += 1;
  return [
    ...prompt.slice(0, insertIndex),
    message,
    ...prompt.slice(insertIndex),
  ];
};

export class RuntimeContextProcessor implements Processor<'weave-runtime-context'> {
  readonly id = 'weave-runtime-context';
  readonly name = 'Weave Runtime Context';

  constructor(private readonly fallbackContext: ChatRuntimeContext = {}) {}

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    const context = getChatRuntimeContext(args.requestContext) ?? this.fallbackContext;
    return {
      prompt: insertAfterSystemPrefix(
        args.prompt as PromptMessage[],
        runtimeSystemMessage(context),
      ) as typeof args.prompt,
    };
  }
}
