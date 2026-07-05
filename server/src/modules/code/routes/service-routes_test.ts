import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { createLspRoutes } from './lsp.ts';
import { createTerminalRoutes } from './terminals.ts';
import type { SessionService } from '../../../services/session-service.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const portalTarget = {
  portalId: 'service-portal',
  portal: {
    portalId: 'service-portal',
    userId: 'owner-1',
    capabilities: ['portal.lsp', 'portal.lsp.session', 'portal.terminal.session'],
    mounts: [],
    roots: [{ id: 'default' }],
    status: 'online' as const,
    connectedAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
  },
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
  req: { json: async () => body, url: 'http://weave.test/code/test' },
  json: (payload: unknown, status?: number) => ({ payload, status }),
});

Deno.test('terminal route delegates service-injected token creation without an online Portal registry entry', async () => {
  let receivedScope: unknown;
  const sessions = {
    issueTerminalToken: async (input: any) => {
      receivedScope = input.scope;
      return { token: 'terminal-token', target: portalTarget };
    },
  } as unknown as SessionService;
  const handler = createTerminalRoutes({ sessions }).find((route) => route.path === '/code/terminals/token')
    ?.handler as (c: any) => Promise<unknown>;

  const response = await handler(createContext({ kind: 'general', workspacePath: '/repo' }));

  assertEquals(response, {
    payload: {
      token: 'terminal-token',
      portalId: 'service-portal',
      wsUrl: 'ws://weave.test:4112/terminals/connect',
    },
    status: undefined,
  });
  assertEquals(receivedScope, {
    ref: { kind: 'locator', locatorType: 'portal-target', value: { workspacePath: '/repo' } },
  });
});

Deno.test('LSP route delegates service-injected session creation without an online Portal registry entry', async () => {
  let receivedScope: unknown;
  const sessions = {
    startLspSession: async (input: any) => {
      receivedScope = input.scope;
      return {
        sessionId: 'lsp-session-1',
        token: 'lsp-token',
        languageId: 'typescript',
        target: portalTarget,
      };
    },
  } as unknown as SessionService;
  const handler = createLspRoutes({ sessions }).find((route) => route.path === '/code/lsp/session')?.handler as (
    c: any,
  ) => Promise<unknown>;

  const response = await handler(createContext({
    target: { projectId: 'project-1', workspaceId: 'workspace-1' },
    path: 'src/main.ts',
    languageId: 'typescript',
  }));

  assertEquals(response, {
    payload: {
      sessionId: 'lsp-session-1',
      languageId: 'typescript',
      token: 'lsp-token',
      portalId: 'service-portal',
      wsUrl: 'ws://weave.test:4112/lsp/connect',
    },
    status: undefined,
  });
  assertEquals(receivedScope, {
    ref: {
      kind: 'locator',
      locatorType: 'portal-target',
      value: {
        portalId: 'project-portal',
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        rootId: 'root-1',
        repoPath: '/repo',
        workspacePath: '/repo/worktree',
      },
    },
  });
});
