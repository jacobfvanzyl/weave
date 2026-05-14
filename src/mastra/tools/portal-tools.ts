import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { findPortalForPlane, requestPortalTool } from '../portal/registry';

const offlineMessage = 'This thread is not bound to an active Demiplane. Connect a Portal or choose a Plane with an online Portal to use local tools.';

const planeThreadId = (planeId: string) => `__plane__${planeId}`;

const getThreadBinding = async (context: any) => {
  const threadId = context.agent?.threadId;
  const contextResourceId = context.agent?.resourceId;
  if (!threadId) throw new Error(offlineMessage);

  const agent = await context.mastra?.getAgent('mageHandAgent');
  const memory = await agent?.getMemory();
  const thread = await memory?.getThreadById({ threadId });
  const resourceId = typeof contextResourceId === 'string' && contextResourceId ? contextResourceId : thread?.resourceId;
  const metadata = thread?.metadata as Record<string, unknown> | undefined;

  if (!thread || !resourceId || thread.resourceId !== resourceId) throw new Error(offlineMessage);
  if (metadata?.mode !== 'plane' || typeof metadata.planeId !== 'string' || typeof metadata.demiplaneId !== 'string') {
    throw new Error(offlineMessage);
  }

  const planeThread = await memory?.getThreadById({ threadId: planeThreadId(metadata.planeId) }).catch(() => undefined);
  const planeMetadata = planeThread?.metadata as Record<string, any> | undefined;
  const demiplane = Array.isArray(planeMetadata?.demiplanes)
    ? planeMetadata.demiplanes.find((item: any) => item?.id === metadata.demiplaneId)
    : undefined;
  const portalId = typeof demiplane?.portalId === 'string'
    ? demiplane.portalId
    : typeof planeMetadata?.portalId === 'string'
      ? planeMetadata.portalId
      : undefined;

  const rootId = typeof planeMetadata?.portalRootId === 'string' ? planeMetadata.portalRootId : undefined;
  const repoPath = typeof planeMetadata?.repoPath === 'string' ? planeMetadata.repoPath : undefined;

  const workspacePath = typeof demiplane?.path === 'string' ? demiplane.path : undefined;
  if (planeMetadata?.projectKind === 'git' && !workspacePath) {
    throw new Error('This Demiplane has no workspace path yet. Recreate it with Worktrunk or attach an existing worktree.');
  }

  return { resourceId, planeId: metadata.planeId, demiplaneId: metadata.demiplaneId, portalId, rootId, repoPath, workspacePath };
};

const routePortalTool = async (tool: string, args: unknown, context: any, timeoutMs?: number) => {
  const binding = await getThreadBinding(context);
  const mountedPortal = findPortalForPlane(binding.resourceId, binding.planeId);
  const portalId = binding.portalId ?? mountedPortal?.portalId;
  if (!portalId) return { ok: false, error: offlineMessage };

  return requestPortalTool({
    portalId,
    planeId: binding.planeId,
    demiplaneId: binding.demiplaneId,
    rootId: binding.rootId,
    repoPath: binding.repoPath,
    workspacePath: binding.workspacePath,
    tool,
    args,
    timeoutMs,
  });
};

export const portalReadTool = createTool({
  id: 'read',
  description: 'Read the contents of a file from the current Demiplane through a connected Portal. Text output is truncated to 2000 lines or 50KB. Use offset/limit for large files. When you need the full file, continue with offset until complete.',
  inputSchema: z.object({
    path: z.string().describe('Path to the file to read, relative to the Demiplane root'),
    offset: z.number().optional().describe('Line number to start reading from, 1-indexed'),
    limit: z.number().optional().describe('Maximum number of lines to read'),
  }),
  outputSchema: z.object({ ok: z.boolean(), content: z.string().optional(), error: z.string().optional() }),
  execute: async (input, context) => routePortalTool('read', input, context),
});

export const portalWriteTool = createTool({
  id: 'write',
  description: 'Write content to a file in the current Demiplane through a connected Portal. Creates the file if it does not exist, overwrites if it does. Automatically creates parent directories.',
  inputSchema: z.object({
    path: z.string().describe('Path to write, relative to the Demiplane root'),
    content: z.string().describe('Full file content'),
  }),
  outputSchema: z.object({ ok: z.boolean(), bytes: z.number().optional(), error: z.string().optional() }),
  execute: async (input, context) => routePortalTool('write', input, context),
});

export const portalEditTool = createTool({
  id: 'edit',
  description: 'Edit a single file in the current Demiplane using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. Each edit is matched against the original file, not incrementally. If two changes affect nearby or overlapping lines, merge them into one edit.',
  inputSchema: z.object({
    path: z.string().describe('Path to edit, relative to the Demiplane root'),
    edits: z.array(z.object({
      oldText: z.string().describe('Exact text for one targeted replacement. Must be unique in the original file and non-overlapping with other edits.'),
      newText: z.string().describe('Replacement text for this targeted edit.'),
    }).strict()).min(1),
  }),
  outputSchema: z.object({ ok: z.boolean(), replacements: z.number().optional(), diff: z.string().optional(), error: z.string().optional() }),
  execute: async (input, context) => routePortalTool('edit', input, context),
});

export const portalBashTool = createTool({
  id: 'bash',
  description: 'Run a bash command in the current Demiplane through a connected Portal. Prefer `fd`, `rg`, and `ls` for file discovery/search.',
  inputSchema: z.object({
    command: z.string().describe('Bash command to execute'),
    timeout: z.number().optional().describe('Timeout in seconds'),
  }),
  outputSchema: z.object({ ok: z.boolean(), stdout: z.string().optional(), stderr: z.string().optional(), exitCode: z.number().optional(), error: z.string().optional() }),
  execute: async (input, context) => routePortalTool('bash', input, context, input.timeout ? input.timeout * 1000 + 1000 : undefined),
});
