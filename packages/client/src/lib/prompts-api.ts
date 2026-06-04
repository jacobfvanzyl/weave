import { getAuthHeaders, getMastraUrl } from './mastra-client';
import { profileParams, type ProfileResolutionContext } from './profiles-api';

export type PromptSummary = {
  name: string;
  command: string;
  description: string;
  argumentHint?: string;
  tags: string[];
  source: 'app' | 'global' | 'project';
  path?: string;
};

export const listPrompts = async (context?: string | ProfileResolutionContext) => {
  const response = await fetch(`${getMastraUrl()}/prompts${profileParams(context)}`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to list prompts: ${response.status}`);
  const data = await response.json() as { prompts?: PromptSummary[] };
  return data.prompts ?? [];
};

export const expandPrompt = async (name: string, args: string, context?: string | ProfileResolutionContext) => {
  const bodyContext = typeof context === 'string' ? { threadId: context } : context;
  const response = await fetch(`${getMastraUrl()}/prompts/${encodeURIComponent(name)}/expand${profileParams(context)}`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ arguments: args, ...bodyContext }),
  });

  if (!response.ok) throw new Error(`Failed to expand prompt: ${response.status}`);
  const data = await response.json() as { text?: string };
  if (typeof data.text !== 'string') throw new Error('Prompt expansion response missing text');
  return data.text;
};
