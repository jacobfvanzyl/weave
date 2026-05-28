import { apiFetch } from './api.ts';

export type ModelOption = {
  id: string;
  label: string;
  contextWindow?: number;
};

export type ModelConfig = {
  defaultModel: string;
  options: ModelOption[];
};

export const fetchModelConfig = async (server: string, token: string) => {
  const response = await apiFetch(server, token, '/models');
  return await response.json() as ModelConfig;
};

export const getResolvedModelDisplayName = (modelId: string, options: ModelOption[]) =>
  options.find(option => option.id === modelId)?.label ?? modelId;

export const getResolvedModelContextWindow = (modelId: string, options: ModelOption[]) =>
  options.find(option => option.id === modelId)?.contextWindow;
