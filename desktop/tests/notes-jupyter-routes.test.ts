import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __notesJupyterRoutesTest } from '../../server/src/modules/notes/jupyter-routes';
import type { NotesProject, NotesVaultBackend } from '../../server/src/modules/notes/storage/types';
import { connectPortal, disconnectPortal, handlePortalMessage } from '../../server/src/portal/registry';
import { productProjectRepository } from '../../server/src/products/project-repository';

const now = '2026-06-22T10:00:00.000Z';
const connectedPortalIds: string[] = [];

const notesWorkspace = {
  id: 'workspace-1',
  projectId: 'project-1',
  workspaceKind: 'primary' as const,
  source: 'notes' as const,
  name: 'Vault',
  path: '/vault',
  status: 'ready' as const,
  locked: true,
  createdAt: now,
  updatedAt: now,
};

const notesProject = (patch: Partial<NotesProject> = {}): NotesProject => ({
  id: 'project-1',
  userId: 'user-1',
  projectKind: 'notes',
  portalId: 'portal-1',
  portalRootId: 'default',
  vaultPath: '/vault',
  workspaces: [notesWorkspace],
  ...patch,
});

const createBackend = (kind = 'portal') =>
  ({
    kind,
  }) as NotesVaultBackend;

const resolverDeps = (backend = createBackend()) => ({
  getBackend: (kind: string) => kind === backend.kind ? backend : undefined,
  getPortalConnection: (portalId: string) => portalId === 'portal-1' ? { userId: 'user-1' } : undefined,
  findPortalForProject: () => undefined,
});

const projectThread = (project: NotesProject) => ({
  id: `__project__${project.id}`,
  resourceId: project.userId,
  metadata: { kind: 'project', ...project },
});

const memoryForProject = (project: NotesProject) => ({
  getThreadById: vi.fn(async ({ threadId }: { threadId: string }) =>
    threadId === `__project__${project.id}` ? projectThread(project) : undefined
  ),
});

const routeContext = (
  body: Record<string, unknown>,
  project: NotesProject,
  resourceId = 'user-1',
) => {
  const memory = memoryForProject(project);
  const c = {
    get: vi.fn((key: string) => {
      if (key === 'requestContext') return { get: () => resourceId };
      if (key === 'mastra') {
        return { getAgent: async () => ({ getMemory: async () => memory }) };
      }
      return undefined;
    }),
    req: {
      json: async () => body,
      url: 'http://127.0.0.1:4111/notes/jupyter/session',
    },
    json: vi.fn((payload: unknown, status?: number) => ({
      payload,
      status: status ?? 200,
    })),
  };
  return { c, memory };
};

const connectTestPortal = (capabilities: string[]) => {
  const ws = { send: vi.fn(), close: vi.fn() };
  connectedPortalIds.push('portal-1');
  connectPortal({
    portalId: 'portal-1',
    userId: 'user-1',
    capabilities,
    ws,
  });
  return ws;
};

const readToolCall = async (ws: { send: ReturnType<typeof vi.fn> }) => {
  await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
  return JSON.parse(String(ws.send.mock.calls[0]?.[0] ?? '{}')) as {
    id: string;
    tool: string;
    args?: Record<string, unknown>;
  };
};

beforeEach(() => {
  vi.spyOn(productProjectRepository, 'get').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  connectedPortalIds.splice(0).forEach((portalId) => disconnectPortal(portalId));
});

describe('notes Jupyter routes', () => {
  it('routes status requests through Portal capabilities', async () => {
    const ws = connectTestPortal(['portal.jupyter.status']);
    const { c } = routeContext(
      { target: { projectId: 'project-1' } },
      notesProject(),
    );

    const responsePromise = __notesJupyterRoutesTest.handleNotesJupyterRoute(
      c,
      'status',
      1_000,
      resolverDeps(),
    );
    const request = await readToolCall(ws);
    expect(request.tool).toBe('portal.jupyter.status');
    expect(request.args).toMatchObject({});

    handlePortalMessage({
      type: 'tool.result',
      id: request.id,
      ok: true,
      available: true,
      status: 'ready',
    });

    await expect(responsePromise).resolves.toEqual({
      payload: { ok: true, available: true, status: 'ready' },
      status: 200,
    });
  });

  it('issues a short-lived WebSocket token for document sessions', async () => {
    const ws = connectTestPortal(['portal.jupyter.session']);
    const { c } = routeContext(
      {
        target: { projectId: 'project-1' },
        path: 'Notebook.cpr',
        language: 'python',
      },
      notesProject(),
    );

    const responsePromise = __notesJupyterRoutesTest.handleNotesJupyterRoute(
      c,
      'session',
      1_000,
      resolverDeps(),
    );
    const request = await readToolCall(ws);
    expect(request.tool).toBe('portal.jupyter.session');
    expect(request.args).toMatchObject({
      path: 'Notebook.cpr',
      language: 'python',
    });

    handlePortalMessage({
      type: 'tool.result',
      id: request.id,
      ok: true,
      available: true,
      sessionId: 'session-1',
      kernelId: 'kernel-1',
      kernelName: 'python3',
      pythonPath: '/vault/.venv/bin/python',
      rootPath: '/vault',
      path: 'Notebook.cpr',
      venvPath: '/vault/.venv',
    });

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      available: true,
      sessionId: 'session-1',
      kernelId: 'kernel-1',
      kernelName: 'python3',
      pythonPath: '/vault/.venv/bin/python',
      portalId: 'portal-1',
      venvPath: '/vault/.venv',
      wsUrl: 'ws://127.0.0.1:4112/jupyter/connect',
    });
    expect((response.payload as { token?: string }).token).toMatch(/^jupyter_/);
  });

  it('rejects non-Portal notes storage and missing Portal capabilities', async () => {
    const objectProject = notesProject({
      notesStorage: { kind: 'object' },
    });
    const objectContext = routeContext(
      { target: { projectId: 'project-1' } },
      objectProject,
    );
    const objectResponse = await __notesJupyterRoutesTest
      .handleNotesJupyterRoute(
        objectContext.c,
        'status',
        1_000,
        resolverDeps(createBackend('object')),
      );
    expect(objectResponse.status).toBe(400);
    expect(objectResponse.payload).toMatchObject({
      error: 'Jupyter execution is only available for Portal-backed Notes storage.',
    });

    connectTestPortal([]);
    const missingCapabilityContext = routeContext(
      { target: { projectId: 'project-1' }, path: 'Notebook.cpr' },
      notesProject(),
    );
    const missingCapabilityResponse = await __notesJupyterRoutesTest
      .handleNotesJupyterRoute(
        missingCapabilityContext.c,
        'session',
        1_000,
        resolverDeps(),
      );
    expect(missingCapabilityResponse.status).toBe(400);
    expect(missingCapabilityResponse.payload).toMatchObject({
      error: 'The connected Portal does not support Jupyter execution yet.',
    });
  });
});
