import { rpcRequest } from './mastra-client';

export type ModelOption = {
  id: string;
  label: string;
  providerId?: string;
  providerName?: string;
  providerLogoUrl?: string;
  contextWindow?: number;
  supportedReasoningEfforts?: Array<{
    effort: string;
    label: string;
    description?: string;
  }>;
  defaultReasoningEffort?: string;
  serviceTiers?: Array<{
    id: string;
    name: string;
    description?: string;
  }>;
  defaultServiceTier?: string | null;
};

export type ModelConfig = {
  defaultModel: string;
  options: ModelOption[];
};

export const fetchModelConfig = async (): Promise<ModelConfig> => {
  return await rpcRequest<ModelConfig>('agent.models.list');
};

export const resolveModelInput = (input: string, options: ModelOption[]) => {
  const normalized = input.trim().toLowerCase();

  return options.find(
    option => option.id.toLowerCase() === normalized || option.label.toLowerCase() === normalized,
  )?.id;
};

export const getResolvedModelDisplayName = (modelId: string, options: ModelOption[]) =>
  options.find(option => option.id === modelId)?.label ?? modelId;
