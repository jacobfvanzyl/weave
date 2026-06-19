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

const gitOnlyToolKeys = new Set(['writePlanTool', 'updatePlanTool']);

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
  instructions: ({ requestContext }) => ({
    role: 'system' as const,
    content: resolveProfile(requestContext).instructions,
    providerOptions: {
      openai: {
        reasoningEffort: resolveProfile(requestContext).reasoningEffort ?? 'medium',
      },
    },
  }),
  model: ({ requestContext }) => resolveProfile(requestContext).model ?? builtinDefaultProfile.model!,
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
