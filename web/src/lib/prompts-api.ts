import { getAuthHeaders, getMastraUrl } from './mastra-client';

export type PromptSummary = {
  name: string;
  command: string;
  description: string;
  argumentHint?: string;
  tags: string[];
  source: 'app';
};

export const listPrompts = async () => {
  const response = await fetch(`${getMastraUrl()}/prompts`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to list prompts: ${response.status}`);
  const data = await response.json() as { prompts?: PromptSummary[] };
  return data.prompts ?? [];
};

export const expandPrompt = async (name: string, args: string) => {
  const response = await fetch(`${getMastraUrl()}/prompts/${encodeURIComponent(name)}/expand`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ arguments: args }),
  });

  if (!response.ok) throw new Error(`Failed to expand prompt: ${response.status}`);
  const data = await response.json() as { text?: string };
  if (typeof data.text !== 'string') throw new Error('Prompt expansion response missing text');
  return data.text;
};
