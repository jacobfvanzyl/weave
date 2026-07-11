import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  createProjectWorktree,
  type GitProject,
  type GitWorkspace,
  listProjectBranches,
  listProjectWorktrees,
  removeWorkspaceWorktree,
  requestWorkspaceGitOperation,
  switchWorkspaceBranch,
} from '../../../modules/code/git/service';
import { getPortalConnection } from '../../../portal/registry';
import { callerForOwner } from '../../../services/types';
import { toolService } from '../../../services/tool-runtime';
import { toolDescription, toolInputDescription } from './instructions';
import { formatToolModelOutput, getCodeToolModelOutputMaxChars } from './model-output';
import { getThreadBinding, offlineMessage, resolvePortalForBinding } from './portal-tools';

const adaptersForCaller = (resourceId: string, threadId?: string) => ({
  getPortal: getPortalConnection,
  requestPortal: toolService.portalToolRequester(callerForOwner(resourceId, 'agent', { threadId })),
});

const gitOutputSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
}).passthrough();

const getGitTarget = async (context: any) => {
  const binding = await getThreadBinding(context);
  if (binding.projectKind !== 'git') throw new Error('Git tools are only available in Git Project Workspace threads.');
  const portalId = await resolvePortalForBinding(binding);
  if (!portalId) throw new Error(offlineMessage);
  if (!binding.workspacePath) {
    throw new Error('This Workspace has no local path yet. Create it again or attach an existing location.');
  }

  const workspace: GitWorkspace = {
    id: binding.workspaceId,
    portalId,
    path: binding.workspacePath,
  };
  const project: GitProject = {
    id: binding.projectId,
    projectKind: 'git',
    portalId,
    portalRootId: binding.rootId,
    repoPath: binding.repoPath,
    workspaces: [workspace],
  };
  return {
    resourceId: binding.resourceId,
    project,
    workspace,
    adapters: adaptersForCaller(
      binding.resourceId,
      typeof context.agent?.threadId === 'string' ? context.agent.threadId : undefined,
    ),
  };
};

const gitModelOutput = (name: string, output: unknown, maxChars = getCodeToolModelOutputMaxChars()) => {
  const result = output && typeof output === 'object' ? output as Record<string, unknown> : {};
  const body = result.diff ?? result.output ?? result.entries ?? result.commits ?? result.worktrees ??
    result.branches ?? result.worktree;
  return formatToolModelOutput(
    name,
    [
      ['ok', result.ok],
      ['error', result.error],
      ['branch', result.branch],
      ['head', result.head],
      ['clean', result.clean],
      ['ahead', result.ahead],
      ['behind', result.behind],
    ],
    body,
    maxChars,
  );
};

const withOk = async (value: Promise<Record<string, unknown> & { ok?: boolean; error?: string }>) => {
  const result = await value;
  return { ...result, ok: result.ok !== false };
};

export const gitStatusTool = createTool({
  id: 'git_status',
  description: toolDescription('git_status'),
  inputSchema: z.object({}),
  outputSchema: gitOutputSchema,
  execute: async (_input, context) => {
    const target = await getGitTarget(context);
    return withOk(requestWorkspaceGitOperation(target.project, target.workspace, target.resourceId, {
      operation: 'status',
      adapters: target.adapters,
    }));
  },
  toModelOutput: (output) => gitModelOutput('git_status', output),
});

export const gitDiffTool = createTool({
  id: 'git_diff',
  description: toolDescription('git_diff'),
  inputSchema: z.object({
    staged: z.boolean().optional(),
    ref: z.string().optional(),
    path: z.string().optional(),
  }),
  outputSchema: gitOutputSchema,
  execute: async (input, context) => {
    const target = await getGitTarget(context);
    return withOk(requestWorkspaceGitOperation(target.project, target.workspace, target.resourceId, {
      operation: 'diff',
      args: input,
      adapters: target.adapters,
    }));
  },
  toModelOutput: (output) => gitModelOutput('git_diff', output),
});

export const gitLogTool = createTool({
  id: 'git_log',
  description: toolDescription('git_log'),
  inputSchema: z.object({
    limit: z.number().optional(),
    ref: z.string().optional(),
  }),
  outputSchema: gitOutputSchema,
  execute: async (input, context) => {
    const target = await getGitTarget(context);
    return withOk(requestWorkspaceGitOperation(target.project, target.workspace, target.resourceId, {
      operation: 'log',
      args: input,
      adapters: target.adapters,
    }));
  },
  toModelOutput: (output) => gitModelOutput('git_log', output),
});

export const gitShowTool = createTool({
  id: 'git_show',
  description: toolDescription('git_show'),
  inputSchema: z.object({
    ref: z.string().optional(),
  }),
  outputSchema: gitOutputSchema,
  execute: async (input, context) => {
    const target = await getGitTarget(context);
    return withOk(requestWorkspaceGitOperation(target.project, target.workspace, target.resourceId, {
      operation: 'show',
      args: input,
      adapters: target.adapters,
    }));
  },
  toModelOutput: (output) => gitModelOutput('git_show', output),
});

export const gitBranchTool = createTool({
  id: 'git_branch',
  description: toolDescription('git_branch'),
  inputSchema: z.object({}),
  outputSchema: gitOutputSchema,
  execute: async (_input, context) => {
    const target = await getGitTarget(context);
    return {
      ok: true,
      branches: await listProjectBranches(target.project, target.resourceId, target.adapters),
    };
  },
  toModelOutput: (output) => gitModelOutput('git_branch', output),
});

export const gitSwitchTool = createTool({
  id: 'git_switch',
  description: toolDescription('git_switch'),
  inputSchema: z.object({
    branch: z.string().describe(toolInputDescription('git_switch', 'branch')),
    create: z.boolean().optional().describe(toolInputDescription('git_switch', 'create')),
    base: z.string().optional().describe(toolInputDescription('git_switch', 'base')),
  }),
  outputSchema: gitOutputSchema,
  execute: async (input, context) => {
    const target = await getGitTarget(context);
    return {
      ok: true,
      worktree: await switchWorkspaceBranch(
        target.project,
        target.workspace,
        target.resourceId,
        input,
        target.adapters,
      ),
    };
  },
  toModelOutput: (output) => gitModelOutput('git_switch', output),
});

export const gitWorktreeTool = createTool({
  id: 'git_worktree',
  description: toolDescription('git_worktree'),
  inputSchema: z.object({
    operation: z.enum(['list', 'create', 'remove']),
    mode: z.enum(['newBranch', 'existingBranch', 'detached']).optional(),
    name: z.string().optional(),
    branch: z.string().optional(),
    base: z.string().optional(),
    path: z.string().optional(),
    force: z.boolean().optional(),
    deleteLocalBranch: z.boolean().optional().describe(toolInputDescription('git_worktree', 'deleteLocalBranch')),
  }),
  outputSchema: gitOutputSchema,
  execute: async (input, context) => {
    const target = await getGitTarget(context);
    if (input.operation === 'list') {
      return {
        ok: true,
        worktrees: await listProjectWorktrees(target.project, target.resourceId, target.adapters),
      };
    }
    if (input.operation === 'create') {
      return {
        ok: true,
        worktree: await createProjectWorktree(target.project, target.resourceId, input, target.adapters),
      };
    }

    const workspace = input.path ? { ...target.workspace, path: input.path } : target.workspace;
    const result = await removeWorkspaceWorktree(target.project, workspace, target.resourceId, input, target.adapters);
    return { ok: true, branchCleanup: result.branchCleanup };
  },
  toModelOutput: (output) => gitModelOutput('git_worktree', output),
});
