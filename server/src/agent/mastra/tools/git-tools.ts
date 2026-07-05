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
  description:
    'Inspect structured Git status for the current Workspace. Prefer this over running `git status` through bash.',
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
  description:
    'Read a Git diff for the current Workspace. Use staged=true for the index, ref for a comparison ref, and path to limit output.',
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
  description: 'Read structured Git commit history for the current Workspace.',
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
  description: 'Show a Git commit or ref for the current Workspace, including stat and patch.',
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
  description: 'List local and remote branches for the current Git Project.',
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
  description: 'Switch the current Workspace to an existing branch, or create and switch to a new branch.',
  inputSchema: z.object({
    branch: z.string().describe('Branch name to switch to or create'),
    create: z.boolean().optional().describe('Create the branch before switching'),
    base: z.string().optional().describe('Optional base ref when create is true'),
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
  description: 'List, create, or remove Git worktrees for the current Git Project.',
  inputSchema: z.object({
    operation: z.enum(['list', 'create', 'remove']),
    mode: z.enum(['newBranch', 'existingBranch', 'detached']).optional(),
    name: z.string().optional(),
    branch: z.string().optional(),
    base: z.string().optional(),
    path: z.string().optional(),
    force: z.boolean().optional(),
    deleteLocalBranch: z.boolean().optional().describe(
      'After removing a worktree, delete its local branch only if Git proves it is fully pushed to its upstream/same-name remote branch or fully merged into the default branch. Never force deletes.',
    ),
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
