import { getAuthHeaders } from './mastra-client';
import { weaveRoutes } from './weave-routes';

export type ChatGPTAuthStatus = {
  connected: boolean;
  accountId?: string;
  expires?: number;
  authPath?: string;
};

export const getChatGPTAuthStatus = async () => {
  const response = await fetch(weaveRoutes.agent.chatgptAuthStatus(), { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`ChatGPT auth status failed: ${response.status}`);
  return response.json() as Promise<ChatGPTAuthStatus>;
};

export const startChatGPTLogin = async () => {
  const response = await fetch(weaveRoutes.agent.chatgptLoginStart(), {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`ChatGPT login start failed: ${response.status}`);
  return response.json() as Promise<{ url: string; state: string }>;
};
