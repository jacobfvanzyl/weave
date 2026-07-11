import { getAuthHeaders } from './mastra-client';
import { weaveRoutes } from './weave-routes';

export type PromptResolutionContext = {
  threadId?: string | null;
  projectId?: string | null;
  workspaceId?: string | null;
};

export type PromptSummary = {
  name: string;
  command: string;
  description: string;
  argumentHint?: string;
  tags: string[];
  source: 'app' | 'user' | 'project';
  path?: string;
};

export const contextParams = (context?: string | PromptResolutionContext) => {
  const normalized = typeof context === 'string' ? { threadId: context } : context;
  const params = new URLSearchParams();
  if (normalized?.threadId) params.set('threadId', normalized.threadId);
  if (normalized?.projectId) params.set('projectId', normalized.projectId);
  if (normalized?.workspaceId) params.set('workspaceId', normalized.workspaceId);
  return params;
};

export const listPrompts = async (context?: string | PromptResolutionContext) => {
  const response = await fetch(weaveRoutes.agent.prompts(contextParams(context)), { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`Failed to list prompts: ${response.status}`);
  const data = await response.json() as { prompts?: PromptSummary[] };
  return data.prompts ?? [];
};

export const expandPrompt = async (name: string, args: string, context?: string | PromptResolutionContext) => {
  const bodyContext = typeof context === 'string' ? { threadId: context } : context;
  const response = await fetch(weaveRoutes.agent.promptExpand(name, contextParams(context)), {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ arguments: args, ...bodyContext }),
  });

  if (!response.ok) throw new Error(`Failed to expand prompt: ${response.status}`);
  const data = await response.json() as { text?: string };
  if (typeof data.text !== 'string') throw new Error('Prompt expansion response missing text');
  return data.text;
};
