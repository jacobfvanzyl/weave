import { useQuery } from '@tanstack/react-query';
import { listPortals, type Project, type Workspace } from '../../lib/chat-state-api';
import { isDesktopEditorBackendAvailable, isEditorBackendAvailable } from '../../lib/editor-backend';
import { isDesktopTerminalTransportAvailable, isTerminalTransportAvailable } from '../../lib/terminal-transport';
import { useProjectsWithLiveGitState } from '../../lib/workspace-git-state';
import type { ChatThread } from '../../stores/chat-store';
import { generalTerminalId } from '../../stores/terminal-store';
import type { ActiveSurface } from '../../stores/workspace-surface-store';

type UseWorkspaceTargetsInput = {
  activeSurface: ActiveSurface;
  isElectronWindow: boolean;
  resourceId: string;
  threadId: string;
  threads: ChatThread[];
};

export const createNotesWorkspaceTarget = (
  activeProject: Project | undefined,
  activeWorkspace: Workspace | undefined,
  activeWorkspacePortalId: string | undefined,
) => {
  if (activeProject?.projectKind !== 'notes' || !activeWorkspace) return undefined;

  const notesStorage = activeProject.notesStorage;
  const notesStorageKind = notesStorage?.kind;
  return {
    projectId: activeProject.id,
    workspaceId: activeWorkspace.id,
    portalId: activeWorkspacePortalId,
    rootId: notesStorageKind === 'portal' ? notesStorage?.rootId ?? activeProject.portalRootId : activeProject.portalRootId,
    repoPath: notesStorageKind === 'portal' ? notesStorage?.vaultPath ?? activeProject.vaultPath : activeProject.vaultPath,
    workspacePath: notesStorageKind === 'portal'
      ? notesStorage?.workspacePath ?? activeWorkspace.path
      : activeWorkspace.path,
    projectName: activeProject.name,
    workspaceName: activeWorkspace.name,
  };
};

export const isNotesTargetAvailable = (
  activeProject: Project | undefined,
  hasOnlinePortalForActiveWorkspace: boolean,
) => {
  if (activeProject?.projectKind !== 'notes') return false;
  const notesStorageKind = activeProject.notesStorage?.kind;
  const requiresPortal = !notesStorageKind || notesStorageKind === 'portal';
  return !requiresPortal || hasOnlinePortalForActiveWorkspace;
};

export const useWorkspaceTargets = ({
  activeSurface,
  isElectronWindow,
  resourceId,
  threadId,
  threads,
}: UseWorkspaceTargetsInput) => {
  const activeThreadId = activeSurface.kind === 'thread' ? activeSurface.threadId : threadId;
  const activeThread = activeSurface.kind === 'thread' ? threads.find(thread => thread.id === activeThreadId) : undefined;
  const hasChatPaneTarget = activeSurface.kind === 'thread';
  const hasThreadTitle = Boolean(activeThread && !['New chat', '...'].includes(activeThread.title));
  const { projects, projectsQuery } = useProjectsWithLiveGitState(resourceId);
  const portalsQuery = useQuery({
    queryKey: ['portals', resourceId],
    queryFn: listPortals,
  });
  const portals = portalsQuery.data ?? [];
  const onlinePortals = portals.filter(portal => portal.status === 'online');
  const onlinePortalIds = new Set(onlinePortals.map(portal => portal.portalId));
  const defaultGlobalPortal = onlinePortals[0];
  const defaultGlobalRootId = defaultGlobalPortal?.roots[0]?.id ?? 'default';
  const activeProjectId = activeSurface.kind === 'workspace' ? activeSurface.projectId : activeThread?.projectId;
  const activeWorkspaceId = activeSurface.kind === 'workspace' ? activeSurface.workspaceId : activeThread?.workspaceId;
  const activeProject = activeProjectId ? projects.find(project => project.id === activeProjectId) : undefined;
  const activeWorkspace = activeWorkspaceId
    ? activeProject?.workspaces.find(workspace => workspace.id === activeWorkspaceId)
    : undefined;
  const activeNotesStorage = activeProject?.projectKind === 'notes' ? activeProject.notesStorage : undefined;
  const activeNotesStorageKind = activeNotesStorage?.kind;
  const activeWorkspacePortalId = activeWorkspace?.portalId
    ?? activeProject?.portalId
    ?? (activeNotesStorageKind === 'portal' ? activeNotesStorage?.portalId : undefined);
  const activeGitWorkspaceTarget = activeProject?.projectKind === 'git' && activeWorkspace
    ? {
        kind: 'workspace' as const,
        terminalId: activeWorkspace.id,
        projectId: activeProject.id,
        workspaceId: activeWorkspace.id,
        portalId: activeWorkspacePortalId,
        rootId: activeProject.portalRootId,
        repoPath: activeProject.repoPath,
        workspacePath: activeWorkspace.path,
        projectName: activeProject.name,
        workspaceName: activeWorkspace.name,
        title: `${activeProject.name} / ${activeWorkspace.name}`,
      }
    : undefined;
  const activeNotesWorkspaceTarget = createNotesWorkspaceTarget(activeProject, activeWorkspace, activeWorkspacePortalId);
  const hasDesktopTerminalTransport = isDesktopTerminalTransportAvailable();
  const hasAnyTerminalTransport = isTerminalTransportAvailable();
  const hasOnlinePortalForActiveWorkspace = Boolean(activeWorkspacePortalId && onlinePortalIds.has(activeWorkspacePortalId));
  const generalTerminalTarget = hasAnyTerminalTransport && (defaultGlobalPortal || (isElectronWindow && hasDesktopTerminalTransport))
    ? {
        kind: 'general' as const,
        terminalId: generalTerminalId,
        portalId: defaultGlobalPortal?.portalId,
        rootId: defaultGlobalRootId,
        title: 'Weave Terminal',
      }
    : undefined;
  const terminalTarget = activeGitWorkspaceTarget && hasAnyTerminalTransport && (hasOnlinePortalForActiveWorkspace || (isElectronWindow && hasDesktopTerminalTransport))
    ? activeGitWorkspaceTarget
    : undefined;
  const hasDesktopEditorBackend = isDesktopEditorBackendAvailable();
  const editorTarget = isEditorBackendAvailable() && (hasOnlinePortalForActiveWorkspace || (isElectronWindow && hasDesktopEditorBackend))
    ? activeGitWorkspaceTarget
    : undefined;
  const notesTarget = activeNotesWorkspaceTarget && isNotesTargetAvailable(activeProject, hasOnlinePortalForActiveWorkspace)
    ? activeNotesWorkspaceTarget
    : undefined;
  const hasWindowStreamPortal = onlinePortals.some(portal => portal.capabilities.includes('portal.window.session'));

  return {
    activeGitWorkspaceTarget,
    activeNotesWorkspaceTarget,
    activeProject,
    activeProjectId,
    activeThread,
    activeThreadId,
    activeWorkspace,
    activeWorkspaceId,
    activeWorkspacePortalId,
    editorTarget,
    generalTerminalTarget,
    hasChatPaneTarget,
    hasOnlinePortalForActiveWorkspace,
    hasThreadTitle,
    hasWindowStreamPortal,
    notesTarget,
    onlinePortalIds,
    onlinePortals,
    portalsQuery,
    portals,
    projects,
    projectsQuery,
    terminalTarget,
  };
};
