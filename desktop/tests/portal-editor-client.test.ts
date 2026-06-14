import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { PortalEditorClient } from '../src/main/portal-editor-client';
import type { PortalSupervisor } from '../src/main/portal-terminal-client';

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
  new PortalEditorClient({
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

describe('PortalEditorClient', () => {
  it('routes editor operations through Portal local control', async () => {
    const requests: Array<{ url?: string; authorization?: string; body: Record<string, unknown> }> = [];
    const { server, url } = await listen(async (request, response) => {
      const body = await readBody(request);
      requests.push({
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });

      response.setHeader('content-type', 'application/json');
      if (request.headers.authorization !== 'Bearer local-token') {
        response.statusCode = 401;
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      if (request.url === '/editor/list') {
        response.end(JSON.stringify({ path: '', entries: [{ name: 'README.md', path: 'README.md', type: 'file' }] }));
      } else if (request.url === '/editor/read') {
        response.end(JSON.stringify({ path: 'README.md', content: 'hello', version: '1:5' }));
      } else if (request.url === '/editor/write') {
        response.end(JSON.stringify({ path: 'README.md', version: '2:7' }));
      } else if (request.url === '/editor/mkdir') {
        response.end(JSON.stringify({ ok: true, path: 'src' }));
      } else if (request.url === '/editor/move') {
        response.end(JSON.stringify({ ok: true, path: 'src/README.md' }));
      } else if (request.url === '/editor/delete') {
        response.end(JSON.stringify({ ok: true, path: 'src/README.md' }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not found' }));
      }
    });

    try {
      const client = createClient(url);
      await expect(client.list({ target: { projectId: 'project-1', workspaceId: 'workspace-1' }, path: '' }))
        .resolves.toEqual({ path: '', entries: [{ name: 'README.md', path: 'README.md', type: 'file' }] });
      await expect(client.read({ target: { projectId: 'project-1', workspaceId: 'workspace-1' }, path: 'README.md' }))
        .resolves.toEqual({ path: 'README.md', content: 'hello', version: '1:5' });
      await expect(client.write({
        target: { projectId: 'project-1', workspaceId: 'workspace-1' },
        path: 'README.md',
        content: 'updated',
        version: '1:5',
      })).resolves.toEqual({ path: 'README.md', version: '2:7' });
      await expect(client.mkdir({ target: { projectId: 'project-1', workspaceId: 'workspace-1' }, path: 'src' }))
        .resolves.toEqual({ ok: true, path: 'src' });
      await expect(client.move({
        target: { projectId: 'project-1', workspaceId: 'workspace-1' },
        fromPath: 'README.md',
        toPath: 'src/README.md',
        overwrite: true,
      })).resolves.toEqual({ ok: true, path: 'src/README.md' });
      await expect(client.delete({ target: { projectId: 'project-1', workspaceId: 'workspace-1' }, path: 'src/README.md' }))
        .resolves.toEqual({ ok: true, path: 'src/README.md' });

      expect(requests).toHaveLength(6);
      for (const request of requests) {
        expect(request.authorization).toBe('Bearer local-token');
        expect(request.body).toMatchObject({
          target: {
            projectId: 'project-1',
            workspaceId: 'workspace-1',
            portalId: 'portal_123',
            rootId: 'default',
            repoPath: 'repo',
            workspacePath: '/resolved/workspace',
          },
        });
      }
      expect(requests.map(request => request.url)).toEqual([
        '/editor/list',
        '/editor/read',
        '/editor/write',
        '/editor/mkdir',
        '/editor/move',
        '/editor/delete',
      ]);
      expect(requests[4].body).toMatchObject({ fromPath: 'README.md', toPath: 'src/README.md', overwrite: true });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('forwards Portal editor errors', async () => {
    const { server, url } = await listen((_request, response) => {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: 'File changed on disk. Reload before saving.' }));
    });

    try {
      const client = createClient(url);
      await expect(client.write({
        target: { projectId: 'project-1', workspaceId: 'workspace-1' },
        path: 'README.md',
        content: 'updated',
        version: 'old',
      })).rejects.toThrow('Reload before saving');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
