import { describe, expect, it, vi } from 'vitest';
import {
  resolveNotesVault,
  resolveNotesVaultForProject,
} from '../../server/src/mastra/notes-storage/resolver';
import type {
  NotesProject,
  NotesVaultBackend,
  ResolvedNotesVaultBinding,
} from '../../server/src/mastra/notes-storage/types';
import { __vaultRoutesTest } from '../../server/src/mastra/routes/vault';
import { __portalToolsTest } from '../../server/src/mastra/tools/portal-tools';
import {
  createNotesWorkspaceTarget,
  isNotesTargetAvailable,
} from '../../packages/client/src/components/workspace/useWorkspaceTargets';
import type { Project, Workspace } from '../../packages/client/src/lib/chat-state-api';

const now = '2026-06-22T10:00:00.000Z';

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

const createBackend = (kind = 'portal') => ({
  kind,
  index: vi.fn(async () => ({
    path: '',
    entries: [],
    notes: [],
    attachments: [],
    backlinks: {},
    checkedAt: now,
    ok: true,
  })),
  read: vi.fn(async (_binding: ResolvedNotesVaultBinding, input: { path: string }) => ({
    path: input.path,
    content: 'Hello',
    version: 'v1',
    ok: true,
  })),
  write: vi.fn(async (_binding: ResolvedNotesVaultBinding, input: { path: string }) => ({
    path: input.path,
    version: 'v2',
    ok: true,
  })),
  mkdir: vi.fn(async (_binding: ResolvedNotesVaultBinding, input: { path: string }) => ({ ok: true, path: input.path })),
  move: vi.fn(async (_binding: ResolvedNotesVaultBinding, input: { toPath: string }) => ({ ok: true, path: input.toPath })),
  delete: vi.fn(async (_binding: ResolvedNotesVaultBinding, input: { path: string }) => ({ ok: true, path: input.path })),
  upload: vi.fn(async (_binding: ResolvedNotesVaultBinding, input: { path: string }) => ({ ok: true, path: input.path })),
}) as unknown as NotesVaultBackend & {
  read: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
};

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
    threadId === `__project__${project.id}` ? projectThread(project) : undefined,
  ),
});

const routeContext = (body: Record<string, unknown>, project: NotesProject, resourceId = 'user-1') => {
  const memory = memoryForProject(project);
  const c = {
    get: vi.fn((key: string) => {
      if (key === 'requestContext') return { get: () => resourceId };
      if (key === 'mastra') return { getAgent: async () => ({ getMemory: async () => memory }) };
      return undefined;
    }),
    req: { json: async () => body },
    json: vi.fn((payload: unknown, status?: number) => ({ payload, status: status ?? 200 })),
  };
  return { c, memory };
};

const toolContext = (project: NotesProject) => {
  const thread = {
    id: 'thread-1',
    resourceId: 'user-1',
    metadata: { mode: 'project', projectId: project.id, workspaceId: project.workspaces[0]?.id },
  };
  const projectEntry = projectThread(project);
  const memory = {
    getThreadById: vi.fn(async ({ threadId }: { threadId: string }) =>
      threadId === thread.id ? thread : threadId === projectEntry.id ? projectEntry : undefined,
    ),
  };
  return {
    agent: { threadId: thread.id, resourceId: 'user-1' },
    mastra: { getAgent: async () => ({ getMemory: async () => memory }) },
  };
};

describe('notes vault storage resolver', () => {
  it('normalizes legacy Portal notes projects', () => {
    const backend = createBackend();
    const resolved = resolveNotesVaultForProject(notesProject(), 'user-1', { projectId: 'project-1' }, resolverDeps(backend));

    expect(resolved.backend).toBe(backend);
    expect(resolved.binding).toMatchObject({
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      storage: {
        kind: 'portal',
        portalId: 'portal-1',
        rootId: 'default',
        vaultPath: '/vault',
        workspacePath: '/vault',
      },
    });
  });

  it('uses explicit Portal notesStorage metadata', () => {
    const resolved = resolveNotesVaultForProject(notesProject({
      portalId: undefined,
      portalRootId: undefined,
      vaultPath: undefined,
      notesStorage: {
        kind: 'portal',
        portalId: 'portal-1',
        rootId: 'notes-root',
        vaultPath: 'notes',
        workspacePath: '/resolved/notes',
      },
    }), 'user-1', { projectId: 'project-1' }, resolverDeps());

    expect(resolved.binding.storage).toMatchObject({
      kind: 'portal',
      portalId: 'portal-1',
      rootId: 'notes-root',
      vaultPath: 'notes',
      workspacePath: '/resolved/notes',
    });
  });

  it('rejects non-notes projects, wrong resources, missing workspaces, offline Portals, and unsupported backends', () => {
    expect(() => resolveNotesVaultForProject(notesProject({ projectKind: 'git' }), 'user-1', {}, resolverDeps()))
      .toThrow('Vault tools are only available for Notes Projects');

    expect(() => resolveNotesVaultForProject(notesProject({ userId: 'user-2' }), 'user-1', {}, resolverDeps()))
      .toThrow('Project was not found');

    expect(() => resolveNotesVaultForProject(notesProject({ workspaces: [] }), 'user-1', {}, resolverDeps()))
      .toThrow('Vault workspace was not found');

    expect(() => resolveNotesVaultForProject(notesProject(), 'user-1', {}, {
      ...resolverDeps(),
      getPortalConnection: () => undefined,
    })).toThrow('Portal is offline or unavailable');

    expect(() => resolveNotesVaultForProject(notesProject({
      notesStorage: { kind: 'object' },
    }), 'user-1', {}, resolverDeps())).toThrow('Notes vault backend is not registered: object');
  });
});

describe('vault routes and tools use notes storage backends', () => {
  it('routes /vault/read through the resolved backend and preserves HTTP response shape', async () => {
    const backend = createBackend();
    const { c } = routeContext({ target: { projectId: 'project-1' }, path: 'note.md' }, notesProject());

    const response = await __vaultRoutesTest.handleVaultRoute(
      c,
      'read',
      body => ({ path: String(body.path) }),
      undefined,
      resolverDeps(backend),
    );

    expect(backend.read).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'project-1' }), { path: 'note.md' }, undefined);
    expect(response).toEqual({ payload: { path: 'note.md', content: 'Hello', version: 'v1' }, status: 200 });
  });

  it('routes /vault/write through the resolved backend and strips ok from route responses', async () => {
    const backend = createBackend();
    const { c } = routeContext({ target: { projectId: 'project-1' }, path: 'note.md', content: 'Next' }, notesProject());

    const response = await __vaultRoutesTest.handleVaultRoute(
      c,
      'write',
      body => ({ path: String(body.path), content: String(body.content) }),
      undefined,
      resolverDeps(backend),
    );

    expect(backend.write).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1' }),
      { path: 'note.md', content: 'Next' },
      undefined,
    );
    expect(response).toEqual({ payload: { path: 'note.md', version: 'v2' }, status: 200 });
  });

  it('routes agent vault tools through the same notes storage resolver', async () => {
    const backend = createBackend();
    const result = await __portalToolsTest.routeNotesVaultTool(
      'read',
      { path: 'note.md' },
      toolContext(notesProject()),
      undefined,
      resolverDeps(backend),
    );

    expect(backend.read).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'workspace-1' }), { path: 'note.md' }, undefined);
    expect(result).toMatchObject({ ok: true, path: 'note.md', content: 'Hello', version: 'v1' });
  });

  it('resolves projects from memory for route callers', async () => {
    const backend = createBackend();
    const resolved = await resolveNotesVault(memoryForProject(notesProject()), 'user-1', { projectId: 'project-1' }, resolverDeps(backend));

    expect(resolved.backend).toBe(backend);
    expect(resolved.binding.projectId).toBe('project-1');
  });
});

describe('notes workspace target gating', () => {
  const workspace: Workspace = notesWorkspace;
  const portalProject: Project = {
    ...notesProject(),
    name: 'Portal notes',
    createdAt: now,
    updatedAt: now,
    notesStorage: {
      kind: 'portal',
      portalId: 'portal-1',
      rootId: 'default',
      vaultPath: '/vault',
      workspacePath: '/vault',
    },
    workspaces: [workspace],
  };

  it('requires an online Portal for Portal-backed notes projects', () => {
    expect(isNotesTargetAvailable(portalProject, false)).toBe(false);
    expect(isNotesTargetAvailable(portalProject, true)).toBe(true);
    expect(createNotesWorkspaceTarget(portalProject, workspace, 'portal-1')).toMatchObject({
      projectId: 'project-1',
      portalId: 'portal-1',
      rootId: 'default',
      repoPath: '/vault',
      workspacePath: '/vault',
    });
  });

  it('allows future non-Portal notes projects without an online Portal', () => {
    const objectProject: Project = {
      ...portalProject,
      portalId: undefined,
      notesStorage: { kind: 'object', bucket: 'notes' },
    };

    expect(isNotesTargetAvailable(objectProject, false)).toBe(true);
    expect(createNotesWorkspaceTarget(objectProject, workspace, undefined)).toMatchObject({
      projectId: 'project-1',
      portalId: undefined,
      workspacePath: '/vault',
    });
  });
});
