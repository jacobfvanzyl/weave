import { rpcRequest } from './mastra-client';

export type ChatGPTAuthStatus = {
  connected: boolean;
  accountId?: string;
  expires?: number;
};

type DesktopChatGPTBridge = {
  connectChatGPT?: () => Promise<ChatGPTAuthStatus>;
};

const desktopBridge = () => (window as Window & { weaveDesktop?: DesktopChatGPTBridge }).weaveDesktop;

export const getChatGPTAuthStatus = async () => {
  return await rpcRequest('agent.chatgpt.authStatus');
};

export const canConnectChatGPT = () => typeof desktopBridge()?.connectChatGPT === 'function';

export const connectChatGPT = async () => {
  const connect = desktopBridge()?.connectChatGPT;
  if (!connect) throw new Error('Connect ChatGPT from Weave Desktop, then return to this client.');
  return await connect();
};
