import { getWeaveServerUrl } from './mastra-client';

type QueryInput = string | URLSearchParams | undefined;

const encodePath = (value: string) => encodeURIComponent(value);

const appendQuery = (path: string, query?: QueryInput) => {
  const value = query instanceof URLSearchParams ? query.toString() : query;
  return value ? `${path}?${value.replace(/^\?/, '')}` : path;
};

const url = (path: string) => `${getWeaveServerUrl()}${path}`;

export const weaveRoutePaths = {
  owner: {
    me: () => '/owner/me',
  },
  chat: {
    projects: () => '/chat/projects',
    project: (projectId: string) => `/chat/projects/${encodePath(projectId)}`,
    projectProfile: (projectId: string) => `/chat/projects/${encodePath(projectId)}/profile`,
    reorderProjects: () => '/chat/projects/reorder',
    projectThreads: (projectId: string) => `/chat/projects/${encodePath(projectId)}/threads`,
    threads: () => '/chat/threads',
    thread: (threadId: string) => `/chat/threads/${encodePath(threadId)}`,
    reorderThreads: () => '/chat/threads/reorder',
    threadMessages: (threadId: string) => `/chat/threads/${encodePath(threadId)}/messages`,
    threadContextUsage: (threadId: string, query?: QueryInput) =>
      appendQuery(`/chat/threads/${encodePath(threadId)}/context-usage`, query),
    runs: () => '/chat/runs',
    run: (threadId: string) => `/chat/runs/${encodePath(threadId)}`,
    cancelRun: (threadId: string) => `/chat/runs/${encodePath(threadId)}/cancel`,
    steerRun: (threadId: string) => `/chat/runs/${encodePath(threadId)}/steer`,
  },
  code: {
    projects: () => '/code/projects',
    project: (projectId: string) => `/code/projects/${encodePath(projectId)}`,
    projectProfile: (projectId: string) => `/code/projects/${encodePath(projectId)}/profile`,
    reorderProjects: () => '/code/projects/reorder',
    projectBranches: (projectId: string) => `/code/projects/${encodePath(projectId)}/branches`,
    projectThreads: (projectId: string) => `/code/projects/${encodePath(projectId)}/threads`,
    workspaceGitStates: () => '/code/projects/workspaces/git-state',
    workspaces: (projectId: string) => `/code/projects/${encodePath(projectId)}/workspaces`,
    workspace: (projectId: string, workspaceId: string, query?: QueryInput) =>
      appendQuery(`/code/projects/${encodePath(projectId)}/workspaces/${encodePath(workspaceId)}`, query),
    adoptWorkspace: (projectId: string) => `/code/projects/${encodePath(projectId)}/workspaces/adopt`,
    discoverWorkspaces: (projectId: string) => `/code/projects/${encodePath(projectId)}/workspaces/discover`,
    reorderWorkspaces: (projectId: string) => `/code/projects/${encodePath(projectId)}/workspaces/reorder`,
    workspaceGitFetch: (projectId: string, workspaceId: string) =>
      `/code/projects/${encodePath(projectId)}/workspaces/${encodePath(workspaceId)}/git/fetch`,
    workspaceGitPull: (projectId: string, workspaceId: string) =>
      `/code/projects/${encodePath(projectId)}/workspaces/${encodePath(workspaceId)}/git/pull`,
    workspaceRemovalPreview: (projectId: string, workspaceId: string) =>
      `/code/projects/${encodePath(projectId)}/workspaces/${encodePath(workspaceId)}/removal-preview`,
    resolveWorkspace: () => '/code/workspaces/resolve',
    editor: (action: string) => `/code/editor/${encodePath(action)}`,
    editorWatchToken: () => '/code/editor/watch-token',
    lspSession: () => '/code/lsp/session',
    terminalToken: () => '/code/terminals/token',
  },
  notes: {
    projects: () => '/notes/projects',
    project: (projectId: string) => `/notes/projects/${encodePath(projectId)}`,
    projectProfile: (projectId: string) => `/notes/projects/${encodePath(projectId)}/profile`,
    reorderProjects: () => '/notes/projects/reorder',
    projectThreads: (projectId: string) => `/notes/projects/${encodePath(projectId)}/threads`,
    vault: (action: string) => `/notes/vault/${encodePath(action)}`,
  },
  compat: {
    projects: () => '/projects',
    project: (projectId: string) => `/projects/${encodePath(projectId)}`,
    projectProfile: (projectId: string) => `/projects/${encodePath(projectId)}/profile`,
    reorderProjects: () => '/projects/reorder',
  },
  agent: {
    models: () => '/agent/models',
    profiles: (query?: QueryInput) => appendQuery('/agent/profiles', query),
    resolvedProfile: (query?: QueryInput) => appendQuery('/agent/profiles/resolved', query),
    prompts: (query?: QueryInput) => appendQuery('/agent/prompts', query),
    promptExpand: (name: string, query?: QueryInput) => appendQuery(`/agent/prompts/${encodePath(name)}/expand`, query),
    chatgptAuthStatus: () => '/agent/chatgpt/auth-status',
    chatgptLoginStart: () => '/agent/chatgpt/login/start',
  },
  portal: {
    portals: () => '/portal',
    portalBrowse: (portalId: string, query?: QueryInput) => appendQuery(`/portal/${encodePath(portalId)}/browse`, query),
    portalPrimary: (portalId: string) => `/portal/${encodePath(portalId)}/primary`,
    portalToken: () => '/portal/token',
    windowStreamWindows: (query?: QueryInput) => appendQuery('/portal/window-sessions/windows', query),
    windowStreamApplications: (query?: QueryInput) => appendQuery('/portal/window-sessions/applications', query),
    windowStreamApplicationOpen: () => '/portal/window-sessions/applications/open',
    windowStreamToken: () => '/portal/window-sessions/token',
  },
};

export const weaveRoutes = {
  owner: {
    me: () => url(weaveRoutePaths.owner.me()),
  },
  chat: {
    projects: () => url(weaveRoutePaths.chat.projects()),
    project: (projectId: string) => url(weaveRoutePaths.chat.project(projectId)),
    projectProfile: (projectId: string) => url(weaveRoutePaths.chat.projectProfile(projectId)),
    reorderProjects: () => url(weaveRoutePaths.chat.reorderProjects()),
    projectThreads: (projectId: string) => url(weaveRoutePaths.chat.projectThreads(projectId)),
    threads: () => url(weaveRoutePaths.chat.threads()),
    thread: (threadId: string) => url(weaveRoutePaths.chat.thread(threadId)),
    reorderThreads: () => url(weaveRoutePaths.chat.reorderThreads()),
    threadMessages: (threadId: string) => url(weaveRoutePaths.chat.threadMessages(threadId)),
    threadContextUsage: (threadId: string, query?: QueryInput) =>
      url(weaveRoutePaths.chat.threadContextUsage(threadId, query)),
    runs: () => url(weaveRoutePaths.chat.runs()),
    run: (threadId: string) => url(weaveRoutePaths.chat.run(threadId)),
    cancelRun: (threadId: string) => url(weaveRoutePaths.chat.cancelRun(threadId)),
    steerRun: (threadId: string) => url(weaveRoutePaths.chat.steerRun(threadId)),
  },
  code: {
    projects: () => url(weaveRoutePaths.code.projects()),
    project: (projectId: string) => url(weaveRoutePaths.code.project(projectId)),
    projectProfile: (projectId: string) => url(weaveRoutePaths.code.projectProfile(projectId)),
    reorderProjects: () => url(weaveRoutePaths.code.reorderProjects()),
    projectBranches: (projectId: string) => url(weaveRoutePaths.code.projectBranches(projectId)),
    projectThreads: (projectId: string) => url(weaveRoutePaths.code.projectThreads(projectId)),
    workspaceGitStates: () => url(weaveRoutePaths.code.workspaceGitStates()),
    workspaces: (projectId: string) => url(weaveRoutePaths.code.workspaces(projectId)),
    workspace: (projectId: string, workspaceId: string, query?: QueryInput) =>
      url(weaveRoutePaths.code.workspace(projectId, workspaceId, query)),
    adoptWorkspace: (projectId: string) => url(weaveRoutePaths.code.adoptWorkspace(projectId)),
    discoverWorkspaces: (projectId: string) => url(weaveRoutePaths.code.discoverWorkspaces(projectId)),
    reorderWorkspaces: (projectId: string) => url(weaveRoutePaths.code.reorderWorkspaces(projectId)),
    workspaceGitFetch: (projectId: string, workspaceId: string) =>
      url(weaveRoutePaths.code.workspaceGitFetch(projectId, workspaceId)),
    workspaceGitPull: (projectId: string, workspaceId: string) =>
      url(weaveRoutePaths.code.workspaceGitPull(projectId, workspaceId)),
    workspaceRemovalPreview: (projectId: string, workspaceId: string) =>
      url(weaveRoutePaths.code.workspaceRemovalPreview(projectId, workspaceId)),
    resolveWorkspace: () => url(weaveRoutePaths.code.resolveWorkspace()),
    editor: (action: string) => url(weaveRoutePaths.code.editor(action)),
    editorWatchToken: () => url(weaveRoutePaths.code.editorWatchToken()),
    lspSession: () => url(weaveRoutePaths.code.lspSession()),
    terminalToken: () => url(weaveRoutePaths.code.terminalToken()),
  },
  notes: {
    projects: () => url(weaveRoutePaths.notes.projects()),
    project: (projectId: string) => url(weaveRoutePaths.notes.project(projectId)),
    projectProfile: (projectId: string) => url(weaveRoutePaths.notes.projectProfile(projectId)),
    reorderProjects: () => url(weaveRoutePaths.notes.reorderProjects()),
    projectThreads: (projectId: string) => url(weaveRoutePaths.notes.projectThreads(projectId)),
    vault: (action: string) => url(weaveRoutePaths.notes.vault(action)),
  },
  compat: {
    projects: () => url(weaveRoutePaths.compat.projects()),
    project: (projectId: string) => url(weaveRoutePaths.compat.project(projectId)),
    projectProfile: (projectId: string) => url(weaveRoutePaths.compat.projectProfile(projectId)),
    reorderProjects: () => url(weaveRoutePaths.compat.reorderProjects()),
  },
  agent: {
    models: () => url(weaveRoutePaths.agent.models()),
    profiles: (query?: QueryInput) => url(weaveRoutePaths.agent.profiles(query)),
    resolvedProfile: (query?: QueryInput) => url(weaveRoutePaths.agent.resolvedProfile(query)),
    prompts: (query?: QueryInput) => url(weaveRoutePaths.agent.prompts(query)),
    promptExpand: (name: string, query?: QueryInput) => url(weaveRoutePaths.agent.promptExpand(name, query)),
    chatgptAuthStatus: () => url(weaveRoutePaths.agent.chatgptAuthStatus()),
    chatgptLoginStart: () => url(weaveRoutePaths.agent.chatgptLoginStart()),
  },
  portal: {
    portals: () => url(weaveRoutePaths.portal.portals()),
    portalBrowse: (portalId: string, query?: QueryInput) => url(weaveRoutePaths.portal.portalBrowse(portalId, query)),
    portalPrimary: (portalId: string) => url(weaveRoutePaths.portal.portalPrimary(portalId)),
    portalToken: () => url(weaveRoutePaths.portal.portalToken()),
    windowStreamWindows: (query?: QueryInput) => url(weaveRoutePaths.portal.windowStreamWindows(query)),
    windowStreamApplications: (query?: QueryInput) => url(weaveRoutePaths.portal.windowStreamApplications(query)),
    windowStreamApplicationOpen: () => url(weaveRoutePaths.portal.windowStreamApplicationOpen()),
    windowStreamToken: () => url(weaveRoutePaths.portal.windowStreamToken()),
  },
};
