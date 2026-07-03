import { describe, expect, it } from 'vitest';
import { listAgentContributions } from '../../server/src/agent';
import { chatgptAuthRoutes } from '../../server/src/agent/routes/chatgpt-auth';
import { modelRoutes } from '../../server/src/agent/routes/models';
import { profileRoutes } from '../../server/src/agent/routes/profiles';
import { promptRoutes } from '../../server/src/agent/routes/prompts';
import { serverModules } from '../../server/src/modules';
import { chatRoutes } from '../../server/src/modules/chat/routes/chat';
import { chatStateRoutes } from '../../server/src/modules/chat/routes/chat-state';
import { lspRoutes } from '../../server/src/modules/code/routes/lsp';
import { projectRoutes } from '../../server/src/modules/code/routes/projects';
import { terminalRoutes } from '../../server/src/modules/code/routes/terminals';
import { workspaceFileRoutes } from '../../server/src/modules/workspace-files/routes';
import { portalRoutes } from '../../server/src/portal/routes/portals';
import { windowSessionRoutes } from '../../server/src/portal/routes/window-sessions';
import { __compatibilityRoutesTest } from '../../server/src/server/compatibility-routes';

const paths = (routes: Array<{ path: string }>) => routes.map(route => route.path);

describe('backend route ownership', () => {
  it('keeps Agent and Portal out of product module registration', () => {
    expect(serverModules.map(module => module.id)).toEqual(['chat', 'code', 'notes', 'workspace-files', 'attachments']);
  });

  it('registers canonical route prefixes at their owning boundaries', () => {
    expect(paths(projectRoutes).every(path => path.startsWith('/code/projects') || path === '/code/workspaces/resolve')).toBe(true);
    expect(paths(lspRoutes).every(path => path.startsWith('/code/lsp'))).toBe(true);
    expect(paths(terminalRoutes).every(path => path.startsWith('/code/terminals'))).toBe(true);
    expect(paths(workspaceFileRoutes).every(path => path.startsWith('/workspace-files'))).toBe(true);
    expect(paths(workspaceFileRoutes)).toEqual([
      '/workspace-files/list',
      '/workspace-files/read',
      '/workspace-files/write',
      '/workspace-files/mkdir',
      '/workspace-files/move',
      '/workspace-files/delete',
      '/workspace-files/upload',
      '/workspace-files/index',
      '/workspace-files/hash',
      '/workspace-files/diff-preview',
      '/workspace-files/watch-token',
    ]);
    expect(paths(chatStateRoutes).every(path => path === '/owner/me' || path.startsWith('/chat/threads'))).toBe(true);
    expect(paths(chatRoutes).every(path => path.startsWith('/chat/runs'))).toBe(true);
    expect(paths(profileRoutes).every(path => path.startsWith('/agent/profiles'))).toBe(true);
    expect(paths(promptRoutes).every(path => path.startsWith('/agent/prompts'))).toBe(true);
    expect(paths(modelRoutes).every(path => path.startsWith('/agent/models'))).toBe(true);
    expect(paths(chatgptAuthRoutes).every(path => path.startsWith('/agent/chatgpt'))).toBe(true);
    expect(paths(portalRoutes).every(path => path.startsWith('/portal'))).toBe(true);
    expect(paths(windowSessionRoutes).every(path => path.startsWith('/portal/window-sessions'))).toBe(true);
  });

  it('keeps compatibility aliases centralized', () => {
    expect(__compatibilityRoutesTest.codeProjectAlias('/code/projects/:projectId/workspaces')).toBe('/projects/:projectId/workspaces');
    expect(__compatibilityRoutesTest.codeProjectAlias('/code/workspaces/resolve')).toBe('/projects/resolve-workspace');
    expect(__compatibilityRoutesTest.chatStateAlias('/chat/threads/:threadId/messages')).toBe('/chat-state/threads/:threadId/messages');
    expect(__compatibilityRoutesTest.chatStateAlias('/owner/me')).toBe('/chat-state/me');
    expect(__compatibilityRoutesTest.chatRunAlias('/chat/runs/:threadId')).toBe('/chat/:threadId/run');
    expect(__compatibilityRoutesTest.chatRunAlias('/chat/runs/:threadId/steer')).toBe('/chat/:threadId/steer');
    expect(__compatibilityRoutesTest.replacePrefix('/portal/window-sessions/token', '/portal/window-sessions', '/window-sessions'))
      .toBe('/window-sessions/token');
    expect(__compatibilityRoutesTest.replacePrefix('/workspace-files/read', '/code/editor', '/editor')).toBeUndefined();
    expect(__compatibilityRoutesTest.replacePrefix('/workspace-files/index', '/notes/vault', '/vault')).toBeUndefined();
  });

  it('exposes product Agent contributions without Agent or Portal pseudo-modules', () => {
    const contributions = listAgentContributions();
    expect(contributions.map(contribution => contribution.moduleId).sort()).toEqual(['chat', 'code', 'notes']);
    expect(contributions.find(contribution => contribution.moduleId === 'code')?.tools?.map(tool => tool.id))
      .toEqual(expect.arrayContaining(['read', 'bash', 'git_status', 'code_diagnostics', 'rename_preview', 'format_preview']));
    expect(contributions.find(contribution => contribution.moduleId === 'notes')?.tools?.map(tool => tool.id))
      .toEqual(expect.arrayContaining(['file_index', 'file_read', 'file_write']));
  });
});
