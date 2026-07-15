import { registerCodeRpcMethods } from './rpc.ts';
import type { RpcModuleServices } from '../types.ts';
import type { RpcRouter } from '../../rpc/router.ts';

Deno.test('code.project.list aggregates every product without a legacy aggregate route', async () => {
  const handlers = new Map<string, (params: unknown, context: unknown) => unknown>();
  const requestedPaths: string[] = [];
  const register = (method: string, _role: string, handler: (params: unknown, context: unknown) => unknown) => {
    handlers.set(method, handler);
  };
  const router = {
    register,
    registerValidated: register,
  } as unknown as RpcRouter;
  const services = {
    requestModule: ({ path }: { path: string }) => {
      requestedPaths.push(path);
      return Promise.resolve({ projects: [{ id: path }] });
    },
  } as unknown as RpcModuleServices;

  registerCodeRpcMethods(router, services);
  const result = await handlers.get('code.project.list')?.({ product: 'all' }, {});

  if (JSON.stringify(requestedPaths) !== JSON.stringify(['/code/projects', '/notes/projects', '/chat/projects'])) {
    throw new Error(`Unexpected aggregate paths: ${JSON.stringify(requestedPaths)}`);
  }
  const projects = (result as { projects?: unknown[] })?.projects;
  if (!Array.isArray(projects) || projects.length !== 3) {
    throw new Error(`Unexpected aggregate result: ${JSON.stringify(result)}`);
  }
});
