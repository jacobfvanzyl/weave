import { useQuery } from '@tanstack/react-query';
import { listPortals } from '../../lib/chat-state-api';
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
  const { projects } = useProjectsWithLiveGitState(resourceId);
  const { data: portals = [] } = useQuery({
    queryKey: ['portals', resourceId],
    queryFn: listPortals,
  });
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
  const activeWorkspacePortalId = activeWorkspace?.portalId ?? activeProject?.portalId;
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
  const activeNotesWorkspaceTarget = activeProject?.projectKind === 'notes' && activeWorkspace
    ? {
        projectId: activeProject.id,
        workspaceId: activeWorkspace.id,
        portalId: activeWorkspacePortalId,
        rootId: activeProject.portalRootId,
        repoPath: activeProject.vaultPath,
        workspacePath: activeWorkspace.path,
        projectName: activeProject.name,
        workspaceName: activeWorkspace.name,
      }
    : undefined;
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
  const notesTarget = hasOnlinePortalForActiveWorkspace ? activeNotesWorkspaceTarget : undefined;
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
    portals,
    projects,
    terminalTarget,
  };
};
