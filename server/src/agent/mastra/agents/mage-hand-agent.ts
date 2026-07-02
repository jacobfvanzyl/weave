import { Agent } from '@mastra/core/agent';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { SkillSearchProcessor } from '@mastra/core/processors';
import { LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { CompactToolHistoryProcessor, getToolHistoryFullCalls } from '../compact-tool-history-processor';
import { CurrentTurnImageProcessor } from '../current-turn-image-processor';
import { getContextTokenLimit, getMemoryCapabilities } from '../memory-policy';
import { RuntimeContextProcessor } from '../runtime-context-processor';
import { storageAuthToken, storageUrl } from '../storage-config';
import { baseWorkspace } from '../workspace';
import { builtinDefaultProfile, getProfileContext } from '../profiles/resolver';
import { mageHandTools } from './mage-hand-tools';
import { normalizeOpenAIReasoningEffort, normalizeOpenAIServiceTier } from '../../model-capabilities';

const createSharedMemory = () => {
  const embeddingModel = process.env.WEAVE_MEMORY_EMBEDDING_MODEL?.trim();
  const capabilities = getMemoryCapabilities();

  return new Memory({
    ...(embeddingModel
      ? {
          vector: new LibSQLVector({
            id: 'weave-memory-vector',
            url: storageUrl,
            authToken: storageAuthToken,
          }),
          embedder: new ModelRouterEmbeddingModel(embeddingModel),
        }
      : {}),
    ...(capabilities.observationalMemory && capabilities.observationalMemoryModel
      ? {
          options: {
            observationalMemory: {
              model: capabilities.observationalMemoryModel,
              scope: 'thread' as const,
              activateAfterIdle: '5m',
              activateOnProviderChange: true,
              temporalMarkers: true,
            },
          },
        }
      : {}),
  });
};

const sharedMemory = createSharedMemory();

const resolveProfile = (requestContext: any) => getProfileContext(requestContext)?.profile ?? builtinDefaultProfile;

const resolveProfileModel = (requestContext: any) => resolveProfile(requestContext).model ?? builtinDefaultProfile.model!;

const resolveOpenAIProviderOptions = (requestContext: any) => {
  const profile = resolveProfile(requestContext);
  const model = resolveProfileModel(requestContext);
  const reasoningEffort = normalizeOpenAIReasoningEffort(profile.reasoningEffort, model, { fallbackToDefault: true });
  const serviceTier = normalizeOpenAIServiceTier(profile.serviceTier, model);

  return reasoningEffort || serviceTier
    ? {
        openai: {
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(serviceTier ? { serviceTier } : {}),
        },
      }
    : undefined;
};

const gitOnlyToolKeys = new Set(['writePlanTool', 'updatePlanTool', 'writeProposalTool', 'writeProposalPatchTool', 'updateProposalTool']);

const isToolAvailableForContext = (key: string, requestContext: any) =>
  !gitOnlyToolKeys.has(key) || getProfileContext(requestContext)?.projectKind === 'git';

const resolveTools = ({ requestContext }: { requestContext: any }) => {
  const profile = resolveProfile(requestContext);
  const allowed = new Set(profile.tools);
  const entries = Object.entries(mageHandTools).filter(([key]) => isToolAvailableForContext(key, requestContext));
  if (allowed.has('*') || allowed.has('all')) return Object.fromEntries(entries);
  return Object.fromEntries(entries.filter(([key]) => allowed.has(key)));
};

export const mageHandAgent = new Agent({
  id: 'mage-hand',
  name: 'Mage Hand',
  instructions: ({ requestContext }) => {
    const providerOptions = resolveOpenAIProviderOptions(requestContext);
    return {
      role: 'system' as const,
      content: resolveProfile(requestContext).instructions,
      ...(providerOptions ? { providerOptions } : {}),
    };
  },
  model: ({ requestContext }) => resolveProfileModel(requestContext),
  workspace: baseWorkspace,
  tools: resolveTools,
  inputProcessors: [
    new CurrentTurnImageProcessor(),
    new CompactToolHistoryProcessor({ preserveToolCalls: getToolHistoryFullCalls(), tokenLimit: getContextTokenLimit() }),
    new SkillSearchProcessor({
      workspace: baseWorkspace,
      search: { topK: 8, minScore: 0.1 },
    }),
    new RuntimeContextProcessor(),
  ],
  memory: sharedMemory,
});
