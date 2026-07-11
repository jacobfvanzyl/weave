import { toolDescription } from './tool-instructions.ts';

const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message);
};

const activeToolIds = [
  'rename-thread',
  'ask_user',
  'update_plan',
  'webSearch',
  'webExtract',
  'editor_context',
  'read',
  'write',
  'edit',
  'bash',
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
  'file_index',
  'file_read',
  'file_write',
  'file_mkdir',
  'file_move',
  'file_delete',
  'file_upload',
  'proposal_start',
  'proposal_read',
  'proposal_write',
  'proposal_edit',
  'proposal_delete',
  'proposal_discard',
  'proposal_status',
  'proposal_finalize',
  'proposal_mark',
];

Deno.test('tool IDs load model-facing descriptions from INSTRUCTION.md', () => {
  for (const toolId of activeToolIds) {
    const description = toolDescription(toolId);
    assert(description.trim().length > 0, `${toolId} has no Markdown description`);
  }
});
