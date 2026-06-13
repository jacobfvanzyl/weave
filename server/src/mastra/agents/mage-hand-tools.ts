import { renameThreadTool } from '../tools/rename-thread-tool';
import { updatePlanTool } from '../tools/update-plan-tool';
import { webExtractTool, webSearchTool } from '../tools/web-search-tools';
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
  vault_index: vaultIndexTool,
  vault_read: vaultReadTool,
  vault_write: vaultWriteTool,
  vault_mkdir: vaultMkdirTool,
  vault_move: vaultMoveTool,
  vault_delete: vaultDeleteTool,
  vault_upload: vaultUploadTool,
};
