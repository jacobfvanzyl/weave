import { rpcRequest } from './mastra-client';

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
  const normalized = typeof context === 'string' ? { threadId: context } : context;
  const data = await rpcRequest<{ prompts?: PromptSummary[] }>('agent.prompts.list', normalized);
  return data.prompts ?? [];
};

export const expandPrompt = async (name: string, args: string, context?: string | PromptResolutionContext) => {
  const bodyContext = typeof context === 'string' ? { threadId: context } : context;
  const data = await rpcRequest<{ text?: string }>('agent.prompts.expand', {
    name,
    arguments: args,
    ...bodyContext,
  });
  if (typeof data.text !== 'string') throw new Error('Prompt expansion response missing text');
  return data.text;
};
