import type { RpcModuleServices } from '../types.ts';
import type { RpcRouter } from '../../rpc/router.ts';
import { guarded, isRecord, optionalString, recordParams, requiredString } from '../../rpc/handlers.ts';

const encoded = (value: unknown, name: string) => encodeURIComponent(requiredString(value, name));
const productPrefix = (value: unknown) =>
  value === 'all' ? '' : value === 'notes' ? '/notes' : value === 'chat' ? '/chat' : '/code';

export const registerCodeRpcMethods = (router: RpcRouter, services: RpcModuleServices) => {
  const moduleCall = (path: string, method = 'GET', body?: unknown) =>
    guarded(() => services.requestModule({ path, method, body }));

  router.register('code.project.list', 'client', (params) => {
    const body = recordParams(params);
    if (body.product === 'all') {
      return guarded(async () => {
        const results = await Promise.all([
          services.requestModule({ path: '/code/projects', method: 'GET' }),
          services.requestModule({ path: '/notes/projects', method: 'GET' }),
          services.requestModule({ path: '/chat/projects', method: 'GET' }),
        ]);
        return {
          projects: results.flatMap((result) =>
            isRecord(result) && Array.isArray(result.projects) ? result.projects : []
          ),
        };
      });
    }
    return moduleCall(`${productPrefix(body.product)}/projects`);
  });
  router.register('code.project.create', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(`${productPrefix(body.product)}/projects`, 'POST', body);
  });
  router.register('code.project.get', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(`${productPrefix(body.product)}/projects/${encoded(body.projectId, 'projectId')}`);
  });
  router.register('code.project.delete', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(`${productPrefix(body.product)}/projects/${encoded(body.projectId, 'projectId')}`, 'DELETE');
  });
  router.register('code.project.reorder', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(`${productPrefix(body.product)}/projects/reorder`, 'PATCH', body);
  });
  router.register(
    'code.project.branches.list',
    'client',
    (params) => moduleCall(`/code/projects/${encoded(recordParams(params).projectId, 'projectId')}/branches`),
  );
  router.register('code.workspace.gitState.list', 'client', () => moduleCall('/code/projects/workspaces/git-state'));
  router.register('code.workspace.create', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(`/code/projects/${encoded(body.projectId, 'projectId')}/workspaces`, 'POST', body);
  });
  router.register('code.workspace.update', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(
      `/code/projects/${encoded(body.projectId, 'projectId')}/workspaces/${encoded(body.workspaceId, 'workspaceId')}`,
      'PATCH',
      body,
    );
  });
  router.register('code.workspace.git.fetch', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(
      `/code/projects/${encoded(body.projectId, 'projectId')}/workspaces/${
        encoded(body.workspaceId, 'workspaceId')
      }/git/fetch`,
      'POST',
    );
  });
  router.register('code.workspace.git.pull', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(
      `/code/projects/${encoded(body.projectId, 'projectId')}/workspaces/${
        encoded(body.workspaceId, 'workspaceId')
      }/git/pull`,
      'POST',
    );
  });
  router.register('code.workspace.adopt', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(`/code/projects/${encoded(body.projectId, 'projectId')}/workspaces/adopt`, 'POST', body);
  });
  router.register('code.workspace.removalPreview', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(
      `/code/projects/${encoded(body.projectId, 'projectId')}/workspaces/${
        encoded(body.workspaceId, 'workspaceId')
      }/removal-preview`,
    );
  });
  router.register('code.workspace.delete', 'client', (params) => {
    const body = recordParams(params);
    const query = new URLSearchParams({ mode: body.mode === 'remove' ? 'remove' : 'detach' });
    if (body.force === true) query.set('force', 'true');
    if (body.deleteLocalBranch === true) query.set('deleteLocalBranch', 'true');
    return moduleCall(
      `/code/projects/${encoded(body.projectId, 'projectId')}/workspaces/${
        encoded(body.workspaceId, 'workspaceId')
      }?${query}`,
      'DELETE',
    );
  });
  router.register(
    'code.workspace.discover',
    'client',
    (params) =>
      moduleCall(`/code/projects/${encoded(recordParams(params).projectId, 'projectId')}/workspaces/discover`),
  );
  router.register('code.workspace.reorder', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(`/code/projects/${encoded(body.projectId, 'projectId')}/workspaces/reorder`, 'PATCH', body);
  });
  router.register('code.project.threads.create', 'client', (params) => {
    const body = recordParams(params);
    return moduleCall(
      `${productPrefix(body.product)}/projects/${encoded(body.projectId, 'projectId')}/threads`,
      'POST',
      body,
    );
  });
  router.register('code.project.threads.list', 'client', (params, { session }) =>
    guarded(async () => {
      const body = recordParams(params);
      const projectId = requiredString(body.projectId, 'projectId');
      const workspaceId = optionalString(body.workspaceId);
      const threads = (await services.agent.service.listChatThreads({ resourceId: session.ownerContext.owner.id }))
        .filter((thread) => {
          const metadata = isRecord(thread.metadata) ? thread.metadata : {};
          return metadata.projectId === projectId && (!workspaceId || metadata.workspaceId === workspaceId);
        });
      return { threads };
    }));
  router.register(
    'code.workspace.resolve',
    'client',
    (params) => moduleCall('/code/workspaces/resolve', 'POST', recordParams(params)),
  );
};
