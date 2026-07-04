import { Agent } from '@mastra/core/agent';
import { ModelRouterEmbeddingModel } from '@mastra/core/llm';
import { SkillSearchProcessor, ToolCallFilter } from '@mastra/core/processors';
import { LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { CurrentTurnImageProcessor } from '../current-turn-image-processor';
import {
  getMemoryCapabilities,
  resolveObservationalMemoryConfig,
  type SemanticRecallEmbeddingConfig,
} from '../memory-policy';
import { RuntimeContextProcessor } from '../runtime-context-processor';
import { storageAuthToken, storageUrl } from '../storage-config';
import { getToolHistoryFullSteps } from '../tool-call-filter-policy';
import { baseWorkspace } from '../workspace';
import {
  getAgentContext,
  hasPortalWorkspaceBinding,
  hasWorkspaceBinding,
  isPortalBackedNotesContext,
  singletonAgentConfig,
} from '../context/resolver';
import { mageHandTools } from './mage-hand-tools';
import { normalizeOpenAIReasoningEffort, normalizeOpenAIServiceTier } from '../../model-capabilities';

const createSemanticRecallEmbedder = (config: SemanticRecallEmbeddingConfig) => {
  if (config.kind === 'model-router') {
    return new ModelRouterEmbeddingModel(config.model);
  }

  return new ModelRouterEmbeddingModel({
    providerId: config.providerId,
    modelId: config.modelId,
    url: config.url,
    apiKey: config.apiKey ?? '',
  });
};

const createSharedMemory = () => {
  const capabilities = getMemoryCapabilities();
  const embeddingConfig = capabilities.semanticRecall ? capabilities.semanticRecallEmbeddingConfig : undefined;
  const observationalMemory = resolveObservationalMemoryConfig(capabilities);

  return new Memory({
    ...(embeddingConfig
      ? {
        vector: new LibSQLVector({
          id: 'weave-memory-vector',
          url: storageUrl,
          authToken: storageAuthToken,
        }),
        embedder: createSemanticRecallEmbedder(embeddingConfig),
      }
      : {}),
    ...(observationalMemory
      ? {
        options: { observationalMemory },
      }
      : {}),
  });
};

const sharedMemory = createSharedMemory();

const resolveAgentConfig = (requestContext: any) => getAgentContext(requestContext)?.config ?? singletonAgentConfig;

const resolveAgentModel = (requestContext: any) => resolveAgentConfig(requestContext).model;

const resolveOpenAIProviderOptions = (requestContext: any) => {
  const config = resolveAgentConfig(requestContext);
  const model = resolveAgentModel(requestContext);
  const reasoningEffort = normalizeOpenAIReasoningEffort(config.reasoningEffort, model, { fallbackToDefault: true });
  const serviceTier = normalizeOpenAIServiceTier(config.serviceTier, model);

  return reasoningEffort || serviceTier
    ? {
      openai: {
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(serviceTier ? { serviceTier } : {}),
      },
    }
    : undefined;
};

const baseToolKeys = new Set(['renameThreadTool', 'webSearch', 'webExtract']);

const portalWorkspaceToolKeys = new Set(['read', 'write', 'edit', 'bash']);

const editorWorkspaceToolKeys = new Set(['editor_context']);

const gitWorkspaceToolKeys = new Set([
  'writePlanTool',
  'updatePlanTool',
  'writeProposalTool',
  'writeProposalPatchTool',
  'updateProposalTool',
  'git_status',
  'git_diff',
  'git_log',
  'git_show',
  'git_branch',
  'git_switch',
  'git_worktree',
  'code_intel_capabilities',
  'code_diagnostics',
  'code_hover',
  'code_definition',
  'code_references',
  'code_symbols',
  'workspace_symbols',
  'code_actions',
  'code_action_preview',
  'rename_preview',
  'format_preview',
]);

const notesWorkspaceToolKeys = new Set([
  'file_index',
  'file_read',
  'file_write',
  'file_mkdir',
  'file_move',
  'file_delete',
  'file_upload',
]);

const toolKeysForContext = (requestContext: any) => {
  const agentContext = getAgentContext(requestContext);
  const keys = new Set(baseToolKeys);

  if (hasWorkspaceBinding(agentContext)) {
    for (const key of editorWorkspaceToolKeys) keys.add(key);
  }

  if (hasPortalWorkspaceBinding(agentContext) && agentContext?.projectKind !== 'notes') {
    for (const key of portalWorkspaceToolKeys) keys.add(key);
  }

  if (agentContext?.projectKind === 'git' && hasPortalWorkspaceBinding(agentContext)) {
    for (const key of gitWorkspaceToolKeys) keys.add(key);
  }

  if (agentContext?.projectKind === 'notes') {
    for (const key of notesWorkspaceToolKeys) keys.add(key);
    if (isPortalBackedNotesContext(agentContext) && hasPortalWorkspaceBinding(agentContext)) {
      for (const key of portalWorkspaceToolKeys) keys.add(key);
    }
  }

  return keys;
};

const resolveTools = ({ requestContext }: { requestContext: any }) => {
  const allowed = toolKeysForContext(requestContext);
  return Object.fromEntries(Object.entries(mageHandTools).filter(([key]) => allowed.has(key)));
};

export const mageHandAgent = new Agent({
  id: 'mage-hand',
  name: 'Mage Hand',
  instructions: ({ requestContext }) => {
    const providerOptions = resolveOpenAIProviderOptions(requestContext);
    return {
      role: 'system' as const,
      content: resolveAgentConfig(requestContext).instructions,
      ...(providerOptions ? { providerOptions } : {}),
    };
  },
  model: ({ requestContext }) => resolveAgentModel(requestContext),
  workspace: baseWorkspace,
  tools: resolveTools,
  inputProcessors: [
    new CurrentTurnImageProcessor(),
    new ToolCallFilter({ filterAfterToolSteps: getToolHistoryFullSteps(), preserveModelOutput: true }),
    new SkillSearchProcessor({
      workspace: baseWorkspace,
      search: { topK: 8, minScore: 0.1 },
    }),
    new RuntimeContextProcessor(),
  ],
  memory: sharedMemory,
});

export const __mageHandAgentTest = {
  createSemanticRecallEmbedder,
  toolKeysForContext,
};
