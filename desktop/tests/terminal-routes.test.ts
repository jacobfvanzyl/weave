import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terminalRoutes } from '../../server/src/modules/code/routes/terminals';
import { connectPortal, disconnectPortal } from '../../server/src/portal/registry';

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

const terminalTokenHandler = terminalRoutes.find(route => route.path === '/code/terminals/token')?.handler as
  | ((c: any) => Promise<unknown>)
  | undefined;

describe('terminal routes', () => {
  afterEach(() => {
    connectedPortalIds.splice(0).forEach(portalId => disconnectPortal(portalId));
  });

  it('honors the requested Portal for general terminal tokens', async () => {
    connectTestPortal('portal-requested', {
      roots: [{ id: 'requested-root', path: '/requested' }],
    });
    connectTestPortal('portal-newer', {
      roots: [{ id: 'newer-root', path: '/newer' }],
    });

    const json = vi.fn((body: unknown, status?: number) => ({ body, status }));
    const context = {
      get: (key: string) => key === 'requestContext'
        ? new Map([[MASTRA_RESOURCE_ID_KEY, 'user-1']])
        : undefined,
      json,
      req: {
        json: async () => ({
          kind: 'general',
          portalId: 'portal-requested',
          rootId: 'requested-root',
        }),
        url: 'http://weave.test/code/terminals/token',
      },
    };

    const response = await terminalTokenHandler?.(context);

    expect(response).toEqual({
      body: expect.objectContaining({
        portalId: 'portal-requested',
        wsUrl: 'ws://weave.test:4112/terminals/connect',
      }),
      status: undefined,
    });
    expect(json).toHaveBeenCalledTimes(1);
  });
});
