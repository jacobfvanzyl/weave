import { getAuthHeaders } from './mastra-client';
import { weaveRoutes } from './weave-routes';

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
  const response = await fetch(weaveRoutes.agent.chatgptAuthStatus(), { headers: getAuthHeaders() });
  if (!response.ok) {
    const body = await response.json().catch(() => undefined) as { error?: unknown } | undefined;
    throw new Error(typeof body?.error === 'string' ? body.error : `ChatGPT auth status failed: ${response.status}`);
  }
  return response.json() as Promise<ChatGPTAuthStatus>;
};

export const canConnectChatGPT = () => typeof desktopBridge()?.connectChatGPT === 'function';

export const connectChatGPT = async () => {
  const connect = desktopBridge()?.connectChatGPT;
  if (!connect) throw new Error('Connect ChatGPT from Weave Desktop, then return to this client.');
  return await connect();
};
