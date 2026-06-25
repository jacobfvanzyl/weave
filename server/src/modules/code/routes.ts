import { mountRoute } from '../../server/routes';
import { registerAgentContribution } from '../../agent/contributions';
import type { ServerModule } from '../types';
import { editorRoutes } from './routes/editor';
import { projectRoutes } from './routes/projects';
import { terminalRoutes } from './routes/terminals';

registerAgentContribution({
  moduleId: 'code',
  tools: [
    { id: 'read', description: 'Read files from the current Code workspace through Portal.' },
    { id: 'write', description: 'Write files in the current Code workspace through Portal.' },
    { id: 'edit', description: 'Patch files in the current Code workspace through Portal.' },
    { id: 'bash', description: 'Run shell commands in the current Code workspace through Portal.' },
    { id: 'git_status', description: 'Inspect structured Git status for the current Code workspace.' },
    { id: 'git_diff', description: 'Read Git diffs for the current Code workspace.' },
    { id: 'git_log', description: 'Read Git history for the current Code workspace.' },
    { id: 'git_show', description: 'Read Git object contents for the current Code workspace.' },
    { id: 'git_branch_list', description: 'List Git branches for the current Code project.' },
    { id: 'git_worktree_list', description: 'List worktrees for the current Code project.' },
    { id: 'git_worktree_create', description: 'Create worktrees for the current Code project.' },
    { id: 'git_worktree_switch', description: 'Switch branches for the current Code workspace.' },
    { id: 'git_worktree_remove', description: 'Remove worktrees for the current Code project.' },
    { id: 'update_plan', description: 'Update the plan artifact for the current Code workspace.' },
    { id: 'write_plan', description: 'Write a plan artifact for the current Code workspace.' },
  ],
  sources: [
    { id: 'code.workspace.context', description: 'Workspace AGENTS.md and .weave context discovered through Portal.' },
  ],
});

export const codeModule: ServerModule = {
  id: 'code',
  registerRoutes: app => {
    for (const route of projectRoutes) mountRoute(app, route);
    for (const route of editorRoutes) mountRoute(app, route);
    for (const route of terminalRoutes) mountRoute(app, route);
  },
};
