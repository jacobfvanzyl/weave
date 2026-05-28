import { Agent } from '@mastra/core/agent';
import { SkillSearchProcessor } from '@mastra/core/processors';
import { Memory } from '@mastra/memory';
import { renameThreadTool } from '../tools/rename-thread-tool';
import { updatePlanTool } from '../tools/update-plan-tool';
import { webExtractTool, webSearchTool } from '../tools/web-search-tools';
import { portalBashTool, portalEditTool, portalReadTool, portalWriteTool } from '../tools/portal-tools';
import { baseWorkspace, gitDemiplaneWorkspace } from '../workspace';
import { baseMageHandInstructions } from './instructions';

const tools = {
  renameThreadTool,
  updatePlanTool,
  webSearch: webSearchTool,
  webExtract: webExtractTool,
  read: portalReadTool,
  write: portalWriteTool,
  edit: portalEditTool,
  bash: portalBashTool,
};

const model = 'chatgpt/codex/gpt-5.5';

export const mageHandAgent = new Agent({
  id: 'mage-hand',
  name: 'Mage Hand',
  instructions: baseMageHandInstructions,
  model,
  workspace: baseWorkspace,
  tools,
  memory: new Memory(),
});

export const mageHandCodingAgent = new Agent({
  id: 'mage-hand-coding',
  name: 'Mage Hand Coding',
  instructions: baseMageHandInstructions,
  model,
  workspace: gitDemiplaneWorkspace,
  inputProcessors: [
    new SkillSearchProcessor({
      workspace: gitDemiplaneWorkspace,
      search: { topK: 5, minScore: 0.1 },
    }),
  ],
  tools,
  memory: new Memory(),
});
