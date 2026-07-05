import type { ToolInvocation, ToolService } from '../../../services/tool-service.ts';
import type { ServiceCaller, ServiceScope } from '../../../services/types.ts';
import { resolveNotesVaultForProjectAsync } from './resolver.ts';
import type { NotesProject, NotesVaultBackend } from './types.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const noopBackend = { kind: 'portal' } as NotesVaultBackend;

const project: NotesProject = {
  id: 'project-1',
  userId: 'owner-1',
  projectKind: 'notes',
  portalId: 'configured-portal',
  portalRootId: 'configured-root',
  vaultPath: '/vault',
  workspaces: [{ id: 'workspace-1', path: '/vault' }],
};

Deno.test('notes resolver can resolve Portal storage through ToolService', async () => {
  let received: { caller?: ServiceCaller; scope?: ServiceScope } = {};
  const tools = {
    invoke: <T = unknown>(_input: ToolInvocation) => Promise.resolve(undefined as T),
    invokeResult: <T = unknown>(_input: ToolInvocation) => Promise.resolve({ ok: true, value: undefined as T }),
    resolvePortalTarget: (caller, scope) => {
      received = { caller, scope };
      return Promise.resolve({
        portalId: 'resolved-portal',
        rootId: 'resolved-root',
        portal: {
          portalId: 'resolved-portal',
          userId: 'owner-1',
          capabilities: [],
          mounts: [],
          roots: [],
          status: 'online',
          connectedAt: '2026-07-05T00:00:00.000Z',
          lastSeenAt: '2026-07-05T00:00:00.000Z',
        },
      });
    },
    requestPortal: () => Promise.resolve({ ok: true }),
    portalToolRequester: () => () => Promise.resolve({ ok: true }),
  } as ToolService;

  const resolved = await resolveNotesVaultForProjectAsync(project, 'owner-1', { projectId: 'project-1' }, {
    tools,
    callerKind: 'workflow',
    correlation: { workflowRunId: 'workflow-run-1' },
    getBackend: (kind) => kind === 'portal' ? noopBackend : undefined,
  });

  assertEquals(received, {
    caller: {
      kind: 'workflow',
      ownerId: 'owner-1',
      correlation: { workflowRunId: 'workflow-run-1' },
    },
    scope: {
      ref: {
        kind: 'locator',
        locatorType: 'portal-target',
        value: {
          portalId: 'configured-portal',
          projectId: 'project-1',
          rootId: 'configured-root',
          repoPath: '/vault',
          workspacePath: '/vault',
        },
      },
    },
  });
  assertEquals(resolved.backend, noopBackend);
  assertEquals(resolved.binding.storage, {
    kind: 'portal',
    portalId: 'resolved-portal',
    rootId: 'configured-root',
    vaultPath: '/vault',
    workspacePath: '/vault',
  });
});
