import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import type { ToolInvocation, ToolService } from '../../services/tool-service.ts';
import { __workspaceFileRoutesTest } from './routes.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const project = {
  id: 'project-1',
  userId: 'owner-1',
  projectKind: 'git',
  portalId: 'project-portal',
  portalRootId: 'root-1',
  repoPath: '/repo',
  workspaces: [{ id: 'workspace-1', path: '/repo/worktree' }],
};

const createContext = (body: Record<string, unknown>) => ({
  get: (key: string) => {
    if (key === 'requestContext') return new Map([[MASTRA_RESOURCE_ID_KEY, 'owner-1']]);
    if (key === 'mastra') {
      return {
        getAgent: async () => ({
          getMemory: async () => ({
            getThreadById: async ({ threadId }: { threadId: string }) =>
              threadId === '__project__project-1'
                ? { id: threadId, resourceId: 'owner-1', metadata: { kind: 'project', ...project } }
                : undefined,
          }),
        }),
      };
    }
    return undefined;
  },
  req: { json: async () => body, url: 'http://weave.test/workspace-files/read' },
  json: (payload: unknown, status?: number) => ({ payload, status }),
});

Deno.test('workspace file route delegates service-injected Portal calls without an online Portal registry entry', async () => {
  let received: { tool?: string; target?: unknown; args?: unknown } = {};
  const tools = {
    invoke: <T = unknown>(_input: ToolInvocation) => Promise.resolve(undefined as T),
    invokeResult: <T = unknown>(_input: ToolInvocation) => Promise.resolve({ ok: true, value: undefined as T }),
    resolvePortalTarget: () => {
      throw new Error('resolvePortalTarget should not be needed for read operations.');
    },
    requestPortal: (input) => {
      received = { tool: input.tool, target: input.target, args: input.args };
      return Promise.resolve({ ok: true, path: 'README.md', content: 'Hello', version: 'v1' });
    },
    portalToolRequester: () => () => Promise.resolve({ ok: true }),
  } as ToolService;

  const response = await __workspaceFileRoutesTest.handleWorkspaceFileRoute(
    createContext({
      target: { projectId: 'project-1', workspaceId: 'workspace-1' },
      path: 'README.md',
    }),
    'read',
    10_000,
    { tools },
  );

  assertEquals(response, {
    payload: { ok: true, path: 'README.md', content: 'Hello', version: 'v1' },
    status: undefined,
  });
  assertEquals(received, {
    tool: 'portal.fs.read',
    target: {
      portalId: 'project-portal',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      rootId: 'root-1',
      repoPath: '/repo',
      workspacePath: '/repo/worktree',
    },
    args: { path: 'README.md' },
  });
});
