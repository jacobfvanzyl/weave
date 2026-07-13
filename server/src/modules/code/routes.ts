import { mountRoute } from '../../server/routes';
import { registerAgentContribution } from '../../agent/contributions';
import { contributionDescription } from '../../instructions/contribution-instructions';
import { toolDescription } from '../../instructions/tool-instructions';
import type { ServerModule } from '../types';
import { projectRoutes } from './routes/projects';
import { registerCodeRpcMethods } from './rpc.ts';

registerAgentContribution({
  moduleId: 'code',
  tools: [
    { id: 'read', description: toolDescription('read') },
    { id: 'write', description: toolDescription('write') },
    { id: 'edit', description: toolDescription('edit') },
    { id: 'bash', description: toolDescription('bash') },
    { id: 'git_status', description: toolDescription('git_status') },
    { id: 'git_diff', description: toolDescription('git_diff') },
    { id: 'git_log', description: toolDescription('git_log') },
    { id: 'git_show', description: toolDescription('git_show') },
    { id: 'git_branch', description: toolDescription('git_branch') },
    { id: 'git_switch', description: toolDescription('git_switch') },
    { id: 'git_worktree', description: toolDescription('git_worktree') },
    { id: 'code_intel_capabilities', description: toolDescription('code_intel_capabilities') },
    { id: 'code_diagnostics', description: toolDescription('code_diagnostics') },
    { id: 'code_hover', description: toolDescription('code_hover') },
    { id: 'code_definition', description: toolDescription('code_definition') },
    { id: 'code_references', description: toolDescription('code_references') },
    { id: 'code_symbols', description: toolDescription('code_symbols') },
    { id: 'workspace_symbols', description: toolDescription('workspace_symbols') },
    { id: 'code_actions', description: toolDescription('code_actions') },
    { id: 'code_action_preview', description: toolDescription('code_action_preview') },
    { id: 'rename_preview', description: toolDescription('rename_preview') },
    { id: 'format_preview', description: toolDescription('format_preview') },
    { id: 'update_plan', description: toolDescription('update_plan') },
  ],
  sources: [
    { id: 'code.workspace.context', description: contributionDescription('code.workspace.context') },
  ],
});

export const codeModule: ServerModule = {
  id: 'code',
  registerInternalRoutes: (app) => {
    for (const route of projectRoutes) mountRoute(app, route);
  },
  registerRpc: registerCodeRpcMethods,
};
