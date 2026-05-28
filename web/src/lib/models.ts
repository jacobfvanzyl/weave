import { getAuthHeaders, mastraUrl } from './mastra-client';

export type ModelOption = {
  id: string;
  label: string;
  contextWindow?: number;
};

export type ModelConfig = {
  defaultModel: string;
  options: ModelOption[];
};

export const fetchModelConfig = async (): Promise<ModelConfig> => {
  const response = await fetch(`${mastraUrl}/models`, { headers: getAuthHeaders() });
  if (!response.ok) throw new Error(`models failed: ${response.status}`);
  return await response.json() as ModelConfig;
};

export const resolveModelInput = (input: string, options: ModelOption[]) => {
  const normalized = input.trim().toLowerCase();

  return options.find(
    option => option.id.toLowerCase() === normalized || option.label.toLowerCase() === normalized,
  )?.id;
};

export const getResolvedModelDisplayName = (modelId: string, options: ModelOption[]) =>
  options.find(option => option.id === modelId)?.label ?? modelId;
