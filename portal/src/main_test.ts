import { assertEquals } from 'jsr:@std/assert@1';
import { parseRpcRequestParams } from '@weave/protocol';
import { workspaceFileTargetFromRequest } from './main.ts';

Deno.test('workspace RPC targets omit portalId before internal Portal tool dispatch', () => {
  const target = workspaceFileTargetFromRequest({
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    portalId: 'portal-1',
    rootId: 'default',
    repoPath: 'Documents/project',
    workspacePath: '/Users/example/Documents/project',
  });

  assertEquals(target, {
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    rootId: 'default',
    repoPath: 'Documents/project',
    workspacePath: '/Users/example/Documents/project',
  });
  parseRpcRequestParams('server', 'portal', 'portal.tool.call', {
    ...target,
    tool: 'portal.fs.list',
    args: { path: '' },
  });
});
