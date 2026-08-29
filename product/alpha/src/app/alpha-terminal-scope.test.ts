import { describe, expect, it } from 'vitest';
import type { AlphaViewModel } from './alpha-controller';
import {
  alphaTerminalScopeKey,
  selectedTerminalScope,
} from './alpha-terminal-scope';

describe('Alpha Terminal scope', () => {
  it('uses Host, Project, and optional Worktree identity, not Portal routing identity', () => {
    const base = {
      hostId: 'host-1',
      projectId: 'project-1',
      workspaceId: 'workspace-route-1',
    };

    expect(alphaTerminalScopeKey(base)).toBe(
      alphaTerminalScopeKey({ ...base, workspaceId: 'workspace-route-2' }),
    );
    expect(alphaTerminalScopeKey(base)).not.toBe(
      alphaTerminalScopeKey({ ...base, hostId: 'host-2' }),
    );
    expect(alphaTerminalScopeKey(base)).not.toBe(
      alphaTerminalScopeKey({ ...base, projectId: 'project-2' }),
    );
    expect(alphaTerminalScopeKey(base)).not.toBe(
      alphaTerminalScopeKey({ ...base, worktreeId: 'worktree-1' }),
    );
  });

  it('derives the logical Project from the selected Thread container', () => {
    const model = {
      selectedThreadId: 'thread-1',
      workspaces: [{
        id: 'repository:github.com/veezee/weave',
        workspaceId: 'workspace-1',
        hostId: 'host-1',
        hostName: 'Bazzite',
        name: 'Weave',
        threads: [{
          id: 'thread-1',
          threadId: 'thread-1',
          hostId: 'host-1',
          title: 'Thread',
          agentName: 'Codex',
          hostName: 'Bazzite',
          status: 'active',
          updatedAt: '2026-08-29T00:00:00.000Z',
          workspaceId: 'workspace-1',
          worktreeId: 'worktree-1',
        }],
      }],
    } as AlphaViewModel;

    expect(selectedTerminalScope(model)).toEqual({
      hostId: 'host-1',
      projectId: 'repository:github.com/veezee/weave',
      workspaceId: 'workspace-1',
      worktreeId: 'worktree-1',
    });
  });
});
