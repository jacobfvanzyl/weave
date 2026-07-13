import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { PortalLspClient } from '../src/main/portal-lsp-client';
import type { PortalSupervisor } from '../src/main/portal-supervisor';

const listen = (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
  const server = createServer(handler);
  return new Promise<{ server: ReturnType<typeof createServer>; url: string }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('test server did not bind');
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
};

const readBody = async (request: IncomingMessage) =>
  await new Promise<Record<string, unknown>>((resolve, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}') as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });

const createClient = (httpUrl: string, token = 'local-token') =>
  new PortalLspClient({
    supervisor: {
      ensureStarted: async () => ({
        httpUrl,
        token,
        url: `${httpUrl.replace(/^http:/, 'ws:')}/terminal?token=${token}`,
      }),
    } as unknown as PortalSupervisor,
    resolveWorkspace: async () => ({
      cwd: '/resolved/workspace',
      portalId: 'portal_123',
      rootId: 'default',
      repoPath: 'repo',
    }),
  });

describe('PortalLspClient', () => {
  it('creates local Portal LSP sessions and returns a local websocket URL', async () => {
    const requests: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
    const { server, url } = await listen(async (request, response) => {
      const body = await readBody(request);
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });

      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        ok: true,
        sessionId: 'lsp_123',
        status: 'ready',
        serverId: 'typescript',
        languageId: 'typescript',
        documentUri: 'file:///resolved/workspace/src/main.ts',
        rootUri: 'file:///resolved/workspace',
      }));
    });

    try {
      const client = createClient(url);
      await expect(client.createSession({
        target: { projectId: 'project-1', workspaceId: 'workspace-1' },
        path: 'src/main.ts',
        languageId: 'typescript',
      })).resolves.toMatchObject({
        sessionId: 'lsp_123',
        status: 'ready',
        wsUrl: expect.stringMatching(/^ws:\/\/127\.0\.0\.1:\d+\/lsp\?token=local-token$/),
      });

      expect(requests).toEqual([{
        url: '/lsp/session',
        authorization: 'Bearer local-token',
        body: {
          target: {
            projectId: 'project-1',
            workspaceId: 'workspace-1',
            portalId: 'portal_123',
            rootId: 'default',
            repoPath: 'repo',
            workspacePath: '/resolved/workspace',
          },
          path: 'src/main.ts',
          languageId: 'typescript',
        },
      }]);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
