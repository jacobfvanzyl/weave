import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectPortal,
  disconnectPortal,
  resolvePortalForTarget,
} from '../../server/src/mastra/portal/registry';

const connectedPortalIds: string[] = [];

const connectTestPortal = (
  portalId: string,
  input: Partial<Parameters<typeof connectPortal>[0]> = {},
) => {
  connectedPortalIds.push(portalId);
  return connectPortal({
    portalId,
    userId: 'user-1',
    ws: { send: vi.fn(), close: vi.fn() },
    ...input,
  });
};

afterEach(() => {
  connectedPortalIds.splice(0).forEach(portalId => disconnectPortal(portalId));
});

describe('Portal target resolution', () => {
  it('uses a live Portal that can resolve the workspace path instead of a stale stored id', () => {
    connectTestPortal('hinted-but-wrong', {
      roots: [{ id: 'default', path: '/tmp/other' }],
    });
    connectTestPortal('path-match', {
      roots: [{ id: 'default', path: '/Users/jaco/Documents/VeeZee' }],
    });

    const portal = resolvePortalForTarget({
      userId: 'user-1',
      portalId: 'hinted-but-wrong',
      workspacePath: '/Users/jaco/Documents/VeeZee/weave',
    });

    expect(portal?.portalId).toBe('path-match');
  });

  it('uses project mounts as path resolvers', () => {
    connectTestPortal('mounted', {
      mounts: [{ projectId: 'project-1', localPath: '/repo/weave' }],
    });

    const portal = resolvePortalForTarget({
      userId: 'user-1',
      projectId: 'project-1',
      workspacePath: '/repo/weave/packages/client',
    });

    expect(portal?.portalId).toBe('mounted');
  });
});
