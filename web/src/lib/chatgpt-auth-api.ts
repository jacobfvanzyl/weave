import { getAuthHeaders, mastraUrl } from './mastra-client';

export type ChatGPTAuthStatus = {
  connected: boolean;
  accountId?: string;
  expires?: number;
  authPath?: string;
};

export const getChatGPTAuthStatus = async () => {
  const response = await fetch(`${mastraUrl}/chatgpt/auth-status`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`ChatGPT auth status failed: ${response.status}`);
  return response.json() as Promise<ChatGPTAuthStatus>;
};

export const startChatGPTLogin = async () => {
  const response = await fetch(`${mastraUrl}/chatgpt/login/start`, {
    method: 'POST',
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error(`ChatGPT login start failed: ${response.status}`);
  return response.json() as Promise<{ url: string; state: string }>;
};
