import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveNotesVault, resolveNotesVaultForProject } from '../../server/src/modules/notes/storage/resolver';
import { createObjectNotesVaultBackend } from '../../server/src/modules/notes/storage/object-backend';
import type {
  NotesProject,
  NotesVaultBackend,
  ResolvedNotesVaultBinding,
} from '../../server/src/modules/notes/storage/types';
import type {
  ObjectStore,
  ObjectStoreCopyInput,
  ObjectStoreDeleteInput,
  ObjectStoreDeleteManyInput,
  ObjectStoreGetInput,
  ObjectStoreListInput,
  ObjectStoreListResult,
  ObjectStoreObject,
  ObjectStorePutInput,
} from '../../server/src/storage/object-store';
import { __workspaceFileRoutesTest } from '../../server/src/modules/workspace-files/routes';
import { __portalToolsTest } from '../../server/src/agent/mastra/tools/portal-tools';
import { connectPortal, disconnectPortal } from '../../server/src/portal/registry';
import { connectWorkspaceFileWatchRelayClient } from '../../server/src/portal/workspace-file-watch-relay';
import { productProjectRepository } from '../../server/src/products/project-repository';
import {
  createNotesWorkspaceTarget,
  isNotesTargetAvailable,
} from '../../packages/client/src/components/workspace/useWorkspaceTargets';
import type { Project, Workspace } from '../../packages/client/src/lib/chat-state-api';

const now = '2026-06-22T10:00:00.000Z';
const connectedPortalIds: string[] = [];

beforeEach(() => {
  vi.spyOn(productProjectRepository, 'get').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  connectedPortalIds.splice(0).forEach((portalId) => disconnectPortal(portalId));
});

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

class MemoryObjectStore implements ObjectStore {
  readonly defaultBucket = 'weave';
  readonly objects = new Map<string, ObjectStoreObject>();
  private version = 0;

  async putObject(input: ObjectStorePutInput) {
    const bucket = input.bucket ?? this.defaultBucket;
    const body = typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body;
    this.version += 1;
    this.objects.set(`${bucket}/${input.key}`, {
      key: input.key,
      body,
      contentType: input.contentType,
      contentLength: body.byteLength,
      etag: `"v${this.version}"`,
      lastModified: new Date(
        `2026-07-08T00:00:${String(this.version).padStart(2, '0')}.000Z`,
      ),
      metadata: input.metadata,
    });
  }

  async getObject(input: ObjectStoreGetInput) {
    return this.objects.get(
      `${input.bucket ?? this.defaultBucket}/${input.key}`,
    ) ?? null;
  }

  async deleteObject(input: ObjectStoreDeleteInput) {
    this.objects.delete(`${input.bucket ?? this.defaultBucket}/${input.key}`);
  }

  async deleteObjects(input: ObjectStoreDeleteManyInput) {
    for (const key of input.keys) {
      this.objects.delete(`${input.bucket ?? this.defaultBucket}/${key}`);
    }
  }

  async copyObject(input: ObjectStoreCopyInput) {
    const bucket = input.bucket ?? this.defaultBucket;
    const source = this.objects.get(`${bucket}/${input.key}`);
    if (!source) return;
    this.version += 1;
    this.objects.set(`${input.toBucket ?? bucket}/${input.toKey}`, {
      ...source,
      key: input.toKey,
      etag: `"v${this.version}"`,
      lastModified: new Date(
        `2026-07-08T00:00:${String(this.version).padStart(2, '0')}.000Z`,
      ),
    });
  }

  async listObjects(
    input: ObjectStoreListInput,
  ): Promise<ObjectStoreListResult> {
    const bucket = input.bucket ?? this.defaultBucket;
    const prefix = input.prefix ?? '';
    const delimiter = input.delimiter;
    const objects = [];
    const prefixes = new Set<string>();

    for (const [bucketKey, object] of this.objects) {
      if (!bucketKey.startsWith(`${bucket}/`)) continue;
      const key = bucketKey.slice(bucket.length + 1);
      if (!key.startsWith(prefix)) continue;
      const remainder = key.slice(prefix.length);
      if (delimiter && remainder.includes(delimiter)) {
        prefixes.add(
          `${prefix}${remainder.slice(0, remainder.indexOf(delimiter) + 1)}`,
        );
        continue;
      }
      objects.push({
        key,
        size: object.contentLength,
        etag: object.etag,
        lastModified: object.lastModified,
      });
    }

    return {
      objects: objects.sort((left, right) => left.key.localeCompare(right.key)),
      prefixes: [...prefixes].sort(),
    };
  }
}

const createBackend = (kind = 'portal') =>
  ({
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
    read: vi.fn(async (
      _binding: ResolvedNotesVaultBinding,
      input: { path: string },
    ) => ({
      path: input.path,
      content: 'Hello',
      version: 'v1',
      ok: true,
    })),
    write: vi.fn(async (
      _binding: ResolvedNotesVaultBinding,
      input: { path: string },
    ) => ({
      path: input.path,
      version: 'v2',
      ok: true,
    })),
    mkdir: vi.fn(async (
      _binding: ResolvedNotesVaultBinding,
      input: { path: string },
    ) => ({
      ok: true,
      path: input.path,
    })),
    move: vi.fn(async (
      _binding: ResolvedNotesVaultBinding,
      input: { toPath: string },
    ) => ({
      ok: true,
      path: input.toPath,
    })),
    delete: vi.fn(async (
      _binding: ResolvedNotesVaultBinding,
      input: { path: string },
    ) => ({
      ok: true,
      path: input.path,
    })),
    upload: vi.fn(async (
      _binding: ResolvedNotesVaultBinding,
      input: { path: string },
    ) => ({
      ok: true,
      path: input.path,
    })),
  }) as unknown as NotesVaultBackend & {
    read: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
  };

const resolverDeps = (backend: NotesVaultBackend = createBackend()) => ({
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
      url: 'http://127.0.0.1/workspace-files/watch-token',
    },
    json: vi.fn((payload: unknown, status?: number) => ({
      payload,
      status: status ?? 200,
    })),
  };
  return { c, memory };
};

const toolContext = (project: NotesProject) => {
  const thread = {
    id: 'thread-1',
    resourceId: 'user-1',
    metadata: {
      mode: 'project',
      projectId: project.id,
      workspaceId: project.workspaces[0]?.id,
    },
  };
  const projectEntry = projectThread(project);
  const memory = {
    getThreadById: vi.fn(async ({ threadId }: { threadId: string }) =>
      threadId === thread.id ? thread : threadId === projectEntry.id ? projectEntry : undefined
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
    const resolved = resolveNotesVaultForProject(
      notesProject(),
      'user-1',
      { projectId: 'project-1' },
      resolverDeps(backend),
    );

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
    const resolved = resolveNotesVaultForProject(
      notesProject({
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
      }),
      'user-1',
      { projectId: 'project-1' },
      resolverDeps(),
    );

    expect(resolved.binding.storage).toMatchObject({
      kind: 'portal',
      portalId: 'portal-1',
      rootId: 'notes-root',
      vaultPath: 'notes',
      workspacePath: '/resolved/notes',
    });
  });

  it('rejects non-notes projects, wrong resources, missing workspaces, offline Portals, and unsupported backends', () => {
    expect(() =>
      resolveNotesVaultForProject(
        notesProject({ projectKind: 'git' }),
        'user-1',
        {},
        resolverDeps(),
      )
    )
      .toThrow('Notes file operations are only available for Notes Projects');

    expect(() =>
      resolveNotesVaultForProject(
        notesProject({ userId: 'user-2' }),
        'user-1',
        {},
        resolverDeps(),
      )
    )
      .toThrow('Project was not found');

    expect(() =>
      resolveNotesVaultForProject(
        notesProject({ workspaces: [] }),
        'user-1',
        {},
        resolverDeps(),
      )
    )
      .toThrow('Notes workspace was not found');

    expect(() =>
      resolveNotesVaultForProject(notesProject(), 'user-1', {}, {
        ...resolverDeps(),
        getPortalConnection: () => undefined,
      })
    ).toThrow('Portal is offline or unavailable');

    expect(() =>
      resolveNotesVaultForProject(
        notesProject({
          notesStorage: { kind: 'object' },
        }),
        'user-1',
        {},
        resolverDeps(),
      )
    ).toThrow('Notes vault backend is not registered: object');
  });
});

describe('workspace file routes and tools use notes storage backends', () => {
  it('routes /workspace-files/read through the resolved backend and preserves HTTP response shape', async () => {
    const backend = createBackend();
    const { c } = routeContext({
      target: { projectId: 'project-1' },
      path: 'note.md',
    }, notesProject());

    const response = await __workspaceFileRoutesTest.handleWorkspaceFileRoute(
      c,
      'read',
      0,
      resolverDeps(backend),
    );

    expect(backend.read).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1' }),
      { path: 'note.md' },
      undefined,
    );
    expect(response).toEqual({
      payload: { path: 'note.md', content: 'Hello', version: 'v1' },
      status: 200,
    });
  });

  it('routes /workspace-files/write through the resolved backend and strips ok from route responses', async () => {
    const backend = createBackend();
    const { c } = routeContext(
      { target: { projectId: 'project-1' }, path: 'note.md', content: 'Next' },
      notesProject(),
    );

    const response = await __workspaceFileRoutesTest.handleWorkspaceFileRoute(
      c,
      'write',
      0,
      resolverDeps(backend),
    );

    expect(backend.write).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-1' }),
      { path: 'note.md', content: 'Next' },
      undefined,
    );
    expect(response).toEqual({
      payload: { path: 'note.md', version: 'v2' },
      status: 200,
    });
  });

  it('issues workspace file watch tokens for Portal-backed notes projects', async () => {
    const project = notesProject({
      notesStorage: {
        kind: 'portal',
        portalId: 'portal-1',
        rootId: 'root-1',
        vaultPath: '/vault',
        workspacePath: '/vault',
      },
    });
    const { c } = routeContext({
      target: { projectId: 'project-1', workspaceId: 'workspace-1' },
    }, project);

    const response = await __workspaceFileRoutesTest
      .handleWorkspaceFileWatchTokenRoute(
        c,
        resolverDeps(),
      );
    const payload = response.payload as {
      token: string;
      portalId: string;
      wsUrl: string;
    };

    expect(response.status).toBe(200);
    expect(payload.portalId).toBe('portal-1');
    expect(payload.token).toMatch(/^workspace_file_watch_/);
    expect(payload.wsUrl).toBe(
      'ws://127.0.0.1:4112/workspace-files/watch/connect',
    );

    connectedPortalIds.push('portal-1');
    connectPortal({
      portalId: 'portal-1',
      userId: 'user-1',
      capabilities: ['portal.fs.watch'],
      mounts: [],
      roots: [],
      ws: { send: () => undefined, close: () => undefined },
    });
    const connected = connectWorkspaceFileWatchRelayClient({
      token: payload.token,
      ws: { send: () => undefined, close: () => undefined },
    });

    expect(connected?.token).toMatchObject({
      portalId: 'portal-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      rootId: 'root-1',
      repoPath: '/vault',
      workspacePath: '/vault',
    });
  });

  it('routes agent file tools through the same notes storage resolver', async () => {
    const backend = createBackend();
    const result = await __portalToolsTest.routeNotesFileTool(
      'read',
      { path: 'note.md' },
      toolContext(notesProject()),
      undefined,
      resolverDeps(backend),
    );

    expect(backend.read).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1' }),
      {
        path: 'note.md',
      },
      undefined,
    );
    expect(result).toMatchObject({
      ok: true,
      path: 'note.md',
      content: 'Hello',
      version: 'v1',
    });
  });

  it('resolves projects from memory for route callers', async () => {
    const backend = createBackend();
    const resolved = await resolveNotesVault(
      memoryForProject(notesProject()),
      'user-1',
      { projectId: 'project-1' },
      resolverDeps(backend),
    );

    expect(resolved.backend).toBe(backend);
    expect(resolved.binding.projectId).toBe('project-1');
  });

  it('routes object-backed Notes through the concrete object backend', async () => {
    const objects = new MemoryObjectStore();
    const backend = createObjectNotesVaultBackend(objects);
    const project = notesProject({
      portalId: undefined,
      portalRootId: undefined,
      vaultPath: undefined,
      notesStorage: {
        kind: 'object',
        bucket: 'notes-bucket',
        prefix: 'vaults/project-1',
      },
      workspaces: [{ ...notesWorkspace, portalId: undefined, path: undefined }],
    });

    const writeContext = routeContext({
      target: { projectId: 'project-1' },
      path: 'Folder/Hello.md',
      content: '# Hello\n\n[[Other]]\n\n#tag',
    }, project);
    const writeResponse = await __workspaceFileRoutesTest
      .handleWorkspaceFileRoute(
        writeContext.c,
        'write',
        0,
        resolverDeps(backend),
      );

    expect(writeResponse.status).toBe(200);
    expect(writeResponse.payload).toMatchObject({ path: 'Folder/Hello.md' });

    const readContext = routeContext({
      target: { projectId: 'project-1' },
      path: 'Folder/Hello.md',
    }, project);
    const readResponse = await __workspaceFileRoutesTest
      .handleWorkspaceFileRoute(
        readContext.c,
        'read',
        0,
        resolverDeps(backend),
      );
    expect(readResponse.payload).toMatchObject({
      path: 'Folder/Hello.md',
      content: '# Hello\n\n[[Other]]\n\n#tag',
    });

    const uploadContext = routeContext({
      target: { projectId: 'project-1' },
      path: 'assets/pic.png',
      base64Content: Buffer.from([1, 2, 3]).toString('base64'),
      contentType: 'image/png',
    }, project);
    await __workspaceFileRoutesTest.handleWorkspaceFileRoute(
      uploadContext.c,
      'upload',
      0,
      resolverDeps(backend),
    );

    const indexContext = routeContext({
      target: { projectId: 'project-1' },
      path: '',
    }, project);
    const indexResponse = await __workspaceFileRoutesTest
      .handleWorkspaceFileRoute(
        indexContext.c,
        'index',
        0,
        resolverDeps(backend),
      );
    expect(indexResponse.payload).toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ path: 'Folder', type: 'directory' }),
        expect.objectContaining({ path: 'assets', type: 'directory' }),
      ]),
      notes: [
        expect.objectContaining({
          path: 'Folder/Hello.md',
          title: 'Hello',
          tags: ['tag'],
        }),
      ],
      attachments: [
        expect.objectContaining({ path: 'assets/pic.png', mediaType: 'image' }),
      ],
    });

    const moveContext = routeContext({
      target: { projectId: 'project-1' },
      fromPath: 'Folder/Hello.md',
      toPath: 'Folder/Renamed.md',
    }, project);
    await __workspaceFileRoutesTest.handleWorkspaceFileRoute(
      moveContext.c,
      'move',
      0,
      resolverDeps(backend),
    );

    const toolResult = await __portalToolsTest.routeNotesFileTool(
      'read',
      { path: 'Folder/Renamed.md' },
      toolContext(project),
      undefined,
      resolverDeps(backend),
    );
    expect(toolResult).toMatchObject({
      path: 'Folder/Renamed.md',
      content: '# Hello\n\n[[Other]]\n\n#tag',
    });
  });

  it('rejects watch tokens for object-backed Notes projects', async () => {
    const backend = createObjectNotesVaultBackend(new MemoryObjectStore());
    const project = notesProject({
      portalId: undefined,
      notesStorage: {
        kind: 'object',
        bucket: 'notes-bucket',
        prefix: 'vaults/project-1',
      },
    });
    const { c } = routeContext({ target: { projectId: 'project-1' } }, project);

    const response = await __workspaceFileRoutesTest
      .handleWorkspaceFileWatchTokenRoute(c, resolverDeps(backend));

    expect(response.status).toBe(400);
    expect(response.payload).toEqual({
      error: 'Workspace file watching is only available for Portal-backed Notes Projects.',
    });
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
    expect(createNotesWorkspaceTarget(portalProject, workspace, 'portal-1'))
      .toMatchObject({
        projectId: 'project-1',
        portalId: 'portal-1',
        rootId: 'default',
        repoPath: '/vault',
        workspacePath: '/vault',
      });
  });

  it('allows object-backed notes projects without an online Portal', () => {
    const objectProject: Project = {
      ...portalProject,
      portalId: undefined,
      notesStorage: { kind: 'object', bucket: 'notes' },
    };

    expect(isNotesTargetAvailable(objectProject, false)).toBe(true);
    expect(createNotesWorkspaceTarget(objectProject, workspace, undefined))
      .toMatchObject({
        projectId: 'project-1',
        portalId: undefined,
        workspacePath: '/vault',
      });
  });
});
