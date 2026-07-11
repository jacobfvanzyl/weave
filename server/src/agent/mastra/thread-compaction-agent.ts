import { Agent } from '@mastra/core/agent';

export const defaultThreadCompactionModel = 'openai/gpt-5.6-luna';
export const threadCompactionReasoningEffort = 'medium';

export const threadCompactionAgent = new Agent({
  id: 'thread-compaction',
  name: 'Thread Compaction',
  model: 'chatgpt/codex/gpt-5.6-luna',
  tools: {},
  workspace: () => undefined,
  instructions: `You create cumulative handoff checkpoints for a coding agent.

Return Markdown with exactly these headings:
# Objective and user intent
# Decisions and constraints
# Completed outcomes
# Current repository and runtime state
# Remaining work and blockers
# Important identifiers and references
# Failures and work not to repeat

Merge the previous checkpoint with the new transcript segment. Preserve concrete file paths, commands, test results,
user corrections, decisions and their rationale, unfinished work, and explicit statements about commits, migrations,
deployments, or external writes. Never invent completion. Never include hidden reasoning or credentials. Be concise but
complete enough for another agent to resume without repeating finished or failed work.`,
});
