import { describe, expect, it } from 'vitest';
import type { AlphaViewModel } from './alpha-controller';
import {
  alphaTerminalScopeKey,
  selectedTerminalScope,
} from './alpha-terminal-scope';

describe('Alpha Terminal scope', () => {
  it('uses Host and execution-context identity independently of organizational aliases', () => {
    const base = {
      hostId: 'host-1',
      contextId: 'project-1',
      executionContextId: 'workspace-route-1',
    };

    expect(alphaTerminalScopeKey(base)).not.toBe(
      alphaTerminalScopeKey({ ...base, executionContextId: 'workspace-route-2' }),
    );
    expect(alphaTerminalScopeKey(base)).not.toBe(
      alphaTerminalScopeKey({ ...base, hostId: 'host-2' }),
    );
    expect(alphaTerminalScopeKey(base)).toBe(
      alphaTerminalScopeKey({ ...base, contextId: 'project-2' }),
    );
  });

  it('derives the logical ExecutionContext from the selected Thread container', () => {
    const model = {
      selectedThreadId: 'thread-1',
      executionContexts: [{
        id: 'repository:github.com/veezee/weave',
        executionContextId: 'workspace-1',
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
          executionContextId: 'workspace-1',
          worktreeId: 'worktree-1',
        }],
      }],
    } as unknown as AlphaViewModel;

    expect(selectedTerminalScope(model)).toEqual({
      hostId: 'host-1',
      contextId: 'workspace-1',
      executionContextId: 'workspace-1',
    });
  });
});
