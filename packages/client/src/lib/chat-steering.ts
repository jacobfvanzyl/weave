import type { UIMessage } from 'ai';
import { sendThreadSteeringMessage, type ThreadSteeringResult } from './chat-state-api';

type SendThreadSteeringMessage = (threadId: string, message: UIMessage) => Promise<ThreadSteeringResult>;

export const sendSteeringMessageOrFallback = async (
  threadId: string,
  message: UIMessage,
  options: {
    sendSteeringMessage?: SendThreadSteeringMessage;
    sendFallbackMessage: () => void;
  },
) => {
  const result = await (options.sendSteeringMessage ?? sendThreadSteeringMessage)(threadId, message);
  if (!result.ok) options.sendFallbackMessage();
  return result;
};
