import { Agent } from '@mastra/core/agent';
import { SkillSearchProcessor } from '@mastra/core/processors';
import { Memory } from '@mastra/memory';
import { baseWorkspace, gitDemiplaneWorkspace } from '../workspace';
import { baseMageHandInstructions } from './instructions';
import { mageHandTools } from './mage-hand-tools';

const model = 'chatgpt/codex/gpt-5.5';

export const mageHandAgent = new Agent({
  id: 'mage-hand',
  name: 'Mage Hand',
  instructions: baseMageHandInstructions,
  model,
  workspace: baseWorkspace,
  tools: mageHandTools,
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
  tools: mageHandTools,
  memory: new Memory(),
});
