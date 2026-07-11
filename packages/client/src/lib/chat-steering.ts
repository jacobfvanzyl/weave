import type { UIMessage } from 'ai';
import { sendThreadSteeringMessage, type SendThreadSteeringMessageOptions, type ThreadSteeringResult } from './chat-state-api';

type SendThreadSteeringMessage = (
  threadId: string,
  message: UIMessage,
  options?: SendThreadSteeringMessageOptions,
) => Promise<ThreadSteeringResult>;

export const sendSteeringMessageToActiveRun = async (
  threadId: string,
  message: UIMessage,
  options: {
    sendSteeringMessage?: SendThreadSteeringMessage;
    runId?: string;
  },
) => {
  return (options.sendSteeringMessage ?? sendThreadSteeringMessage)(threadId, message, { runId: options.runId });
};
