import { renameThreadTool } from '../tools/rename-thread-tool';
import { updatePlanTool } from '../tools/update-plan-tool';
import { webExtractTool, webSearchTool } from '../tools/web-search-tools';
import { portalBashTool, portalEditTool, portalReadTool, portalWriteTool } from '../tools/portal-tools';

export const mageHandTools = {
  renameThreadTool,
  updatePlanTool,
  webSearch: webSearchTool,
  webExtract: webExtractTool,
  read: portalReadTool,
  write: portalWriteTool,
  edit: portalEditTool,
  bash: portalBashTool,
};
