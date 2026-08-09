import { describe, expect, it } from 'vitest';
import { resolveStartupSurface } from '../../packages/client/src/lib/startup-surface-resolver';

describe('startup surface resolver', () => {
  it('restores only the saved valid surface', () => {
    expect(
      resolveStartupSurface({
        activeSurface: { kind: 'thread', threadId: 'draft-1' },
        openableThreads: [{ id: 'draft-1', draft: true }, { id: 'thread-1' }],
        workspaceRefs: new Set(['project-1:workspace-1']),
        fallbackWorkspace: { projectId: 'project-1', workspaceId: 'workspace-1' },
      }),
    ).toEqual({ kind: 'restore-draft', draftId: 'draft-1' });

    expect(
      resolveStartupSurface({
        activeSurface: {
          kind: 'workspace',
          projectId: 'project-1',
          workspaceId: 'workspace-1',
        },
        openableThreads: [{ id: 'thread-1' }],
        workspaceRefs: new Set(['project-1:workspace-1']),
        fallbackWorkspace: { projectId: 'project-1', workspaceId: 'workspace-1' },
      }),
    ).toEqual({
      kind: 'restore-workspace',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
    });
  });

  it('restores an ordinary Workspace instead of creating an unscoped draft', () => {
    expect(
      resolveStartupSurface({
        activeSurface: { kind: 'thread', threadId: 'archived-thread' },
        openableThreads: [{ id: 'recent-valid-thread' }],
        workspaceRefs: new Set(['project-1:workspace-1']),
        fallbackWorkspace: { projectId: 'project-1', workspaceId: 'workspace-1' },
      }),
    ).toEqual({
      kind: 'restore-workspace',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      discardStaleComposer: true,
    });
  });

  it('reports no available surface when no Workspace exists', () => {
    expect(
      resolveStartupSurface({
        activeSurface: { kind: 'thread', threadId: 'legacy-thread' },
        openableThreads: [],
        workspaceRefs: new Set(),
      }),
    ).toEqual({ kind: 'unavailable', discardStaleComposer: true });
  });
});
