import { renameThreadTool } from '../tools/rename-thread-tool';
import { updatePlanTool } from '../tools/update-plan-tool';
import { webExtractTool, webSearchTool } from '../tools/web-search-tools';
import {
  gitBranchTool,
  gitDiffTool,
  gitLogTool,
  gitShowTool,
  gitStatusTool,
  gitSwitchTool,
  gitWorktreeTool,
} from '../tools/git-tools';
import {
  portalBashTool,
  portalEditTool,
  portalReadTool,
  portalWriteTool,
  vaultDeleteTool,
  vaultIndexTool,
  vaultMkdirTool,
  vaultMoveTool,
  vaultReadTool,
  vaultUploadTool,
  vaultWriteTool,
} from '../tools/portal-tools';

export const mageHandTools = {
  renameThreadTool,
  updatePlanTool,
  webSearch: webSearchTool,
  webExtract: webExtractTool,
  read: portalReadTool,
  write: portalWriteTool,
  edit: portalEditTool,
  bash: portalBashTool,
  git_status: gitStatusTool,
  git_diff: gitDiffTool,
  git_log: gitLogTool,
  git_show: gitShowTool,
  git_branch: gitBranchTool,
  git_switch: gitSwitchTool,
  git_worktree: gitWorktreeTool,
  vault_index: vaultIndexTool,
  vault_read: vaultReadTool,
  vault_write: vaultWriteTool,
  vault_mkdir: vaultMkdirTool,
  vault_move: vaultMoveTool,
  vault_delete: vaultDeleteTool,
  vault_upload: vaultUploadTool,
};
