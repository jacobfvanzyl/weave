import { forwardRef, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type DraggableAttributes } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ChevronDown, Download, Folder, FolderCode, FolderOpen, GitBranch, GripVertical, Link, Loader2, Lock, MoreHorizontal, Plus, RotateCcw, Shell, SquarePen, StickyNote, TerminalSquare, Trash2, X } from 'lucide-react';
import { adoptWorkspace, createWorkspace, createProject, deleteWorkspace, deleteProject, discoverWorkspaces, fetchWorkspaceGitUpstream, listPortals, listProjectBranches, pullWorkspaceGitUpstream, reorderWorkspaces, reorderProjects, reorderThreads, updateWorkspace, type CreateProjectInput, type CreateWorkspaceInput, type DiscoveredWorktree, type WorkspaceBranchMode, type WorkspaceBranchOption } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { createWorkspaceDraftDefaults, getDefaultWorkspaceBase } from '../../lib/workspace-create-defaults';
import { projectsQueryKey, useProjectsWithLiveGitState, workspaceGitStateQueryKey } from '../../lib/workspace-git-state';
import { GitProjectDirectoryPicker } from './GitProjectDirectoryPicker';
import { useChatStore } from '../../stores/chat-store';
import { useTerminalStore } from '../../stores/terminal-store';
import { useWorkspaceSurfaceStore } from '../../stores/workspace-surface-store';
import { Alert, AlertDescription } from '../ui/alert';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '../ui/dialog';
import { Empty, EmptyDescription } from '../ui/empty';
import { Field, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Combobox, ComboboxCollection, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxPopup } from '../ui/combobox';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../ui/menu';
import { ScrollArea } from '../ui/scroll-area';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';

const collapsedProjectsStorageKey = 'weave.collapsedProjectIds';
const branchMenuRefreshThrottleMs = 15_000;

const loadCollapsedProjectIds = () => {
  try {
    const value = window.localStorage.getItem(collapsedProjectsStorageKey);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const sortManual = <T extends { sortOrder?: number; updatedAt: string }>(items: T[]) => [...items].sort((a, b) =>
  (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
  || String(b.updatedAt).localeCompare(String(a.updatedAt)),
);

const moveItem = <T extends { id: string }>(items: T[], activeId: string, overId: string) => {
  const from = items.findIndex(item => item.id === activeId);
  const to = items.findIndex(item => item.id === overId);
  if (from < 0 || to < 0 || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

const normalizeWorkspacePath = (path: string | null | undefined) => path?.trim().replace(/\/+$/, '').toLowerCase() || '';

const pathBasename = (path: string | undefined) => path?.split('/').filter(Boolean).pop() || '';

const getDiscoveredWorktreeName = (worktree: DiscoveredWorktree) =>
  worktree.branch?.trim() || pathBasename(worktree.path) || 'Workspace';

const getDiscoveredWorktreeState = (worktree: DiscoveredWorktree) => {
  if (worktree.detached) return `Detached ${(worktree.head ?? worktree.commit)?.slice(0, 7) ?? 'HEAD'}`;
  return worktree.branch || 'No branch';
};

const resolveWorkspaceBaseRef = (
  base: string | undefined,
  options: WorkspaceBranchOption[],
  fallback: string,
) => {
  const fallbackTarget = fallback.trim() || 'main';
  const target = base?.trim() || fallbackTarget;
  if (!options.length) return target;
  const resolve = (candidate: string) =>
    options.find(option => option.ref === candidate)
      ?? options.find(option => option.kind === 'local' && option.name === candidate)
      ?? options.find(option => option.name === candidate);
  return resolve(target)?.ref ?? resolve(fallbackTarget)?.ref ?? options[0]?.ref ?? fallbackTarget;
};

const SortableSection = ({
  items,
  onReorder,
  onDragStart,
  onDragEnd,
  children,
}: {
  items: string[];
  onReorder: (activeId: string, overId: string) => void;
  onDragStart?: (event: DragStartEvent) => void;
  onDragEnd?: (event: DragEndEvent) => void;
  children: ReactNode;
}) => {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 5 } }),
  );
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) onReorder(String(active.id), String(over.id));
    onDragEnd?.(event);
  };

  return (
    <DndContext
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => onDragEnd?.({} as DragEndEvent)}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
};

const SidebarItemButton = ({ className, ...props }: ComponentProps<typeof Button>) => (
  <Button
    variant="ghost"
    className={cn(
      'h-auto min-w-0 flex-1 justify-start whitespace-normal rounded-none border-0 bg-transparent p-0 text-left font-normal shadow-none before:hidden hover:!bg-transparent data-pressed:!bg-transparent [:hover,[data-pressed]]:!bg-transparent',
      className,
    )}
    {...props}
  />
);

const SidebarSectionHeader = ({
  children,
  label,
  labelClassName,
}: {
  children: ReactNode;
  label: string;
  labelClassName?: string;
}) => (
  <div className="weave-sidebar-section-heading flex h-6 items-center justify-between bg-muted text-sm font-semibold tracking-wide text-muted-foreground dark:bg-card">
    <span className={labelClassName}>{label}</span>
    <div className="flex items-center gap-2">
      {children}
    </div>
  </div>
);

const SortableItem = ({
  id,
  className,
  handleClassName,
  canDrag = true,
  showHandle = true,
  children,
}: {
  id: string;
  className?: string;
  handleClassName?: string;
  canDrag?: boolean;
  showHandle?: boolean;
  children: ReactNode | ((activatorProps: {
    ref: (node: HTMLElement | null) => void;
    attributes: DraggableAttributes;
    listeners: Record<string, Function> | undefined;
  }) => ReactNode);
}) => {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !canDrag });
  const hasCustomActivator = typeof children === 'function';
  const useRootActivator = canDrag && !showHandle && !hasCustomActivator;

  return (
    <div
      ref={node => {
        setNodeRef(node);
        if (useRootActivator) setActivatorNodeRef(node);
      }}
      className={cn('group relative', useRootActivator && 'cursor-grab touch-none select-none active:cursor-grabbing', className, isDragging && 'z-20 opacity-90 shadow-lg')}
      style={{ transform: CSS.Transform.toString(transform), transition, touchAction: useRootActivator ? 'none' : undefined }}
      {...(useRootActivator ? attributes : {})}
      {...(useRootActivator ? listeners : {})}
    >
      {canDrag && showHandle ? (
        <Button
          ref={setActivatorNodeRef}
          className={cn('absolute left-0 top-1/2 z-10 -translate-x-3 -translate-y-1/2 cursor-grab touch-none select-none p-0 text-muted-foreground/70 hover:text-foreground active:cursor-grabbing', handleClassName)}
          aria-label="Drag to reorder"
          size="icon-xs"
          variant="ghost"
          style={{ touchAction: 'none' }}
          onClick={event => event.preventDefault()}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={13} />
        </Button>
      ) : null}
      {hasCustomActivator ? children({ ref: setActivatorNodeRef, attributes, listeners }) : children}
    </div>
  );
};

type WorkspaceSidebarProps = {
  closeOnSelect?: boolean;
  connectionSettingsButton?: ReactNode;
  onClose?: () => void;
  presentation?: 'inline' | 'overlay';
};

export const WorkspaceSidebar = forwardRef<HTMLElement, WorkspaceSidebarProps>(({
  closeOnSelect = true,
  connectionSettingsButton,
  onClose,
  presentation = 'inline',
}, ref) => {
  const {
    resourceId,
    threads,
    runningThreadIds,
    newThread,
    archiveThread,
    restoreThread,
    deleteThread,
  } = useChatStore();
  const activeSurface = useWorkspaceSurfaceStore(state => state.activeSurface);
  const selectWorkspace = useWorkspaceSurfaceStore(state => state.selectWorkspace);
  const selectThreadSurface = useChatStore(state => state.selectThread);
  const workspaceTerminalWindowCounts = useTerminalStore(state => state.workspaceTerminalWindowCounts);
  const queryClient = useQueryClient();
  const openProjectIdsBeforeDragRef = useRef<string[] | null>(null);
  const suppressSelectionUntilRef = useRef(0);
  const branchRefreshTimesRef = useRef(new Map<string, number>());
  const [archivedDialogScopeId, setArchivedDialogScopeId] = useState<string | null>(null);
  const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null);
  const [isCreateProjectDialogOpen, setIsCreateProjectDialogOpen] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const [createWorkspaceProjectId, setCreateWorkspaceProjectId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState(() => createWorkspaceDraftDefaults().name);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceBranchMode>('detached');
  const [workspaceBranch, setWorkspaceBranch] = useState('');
  const [workspaceBase, setWorkspaceBase] = useState(() => getDefaultWorkspaceBase());
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [attachWorkspaceProjectId, setAttachWorkspaceProjectId] = useState<string | null>(null);
  const [attachWorkspacePath, setAttachWorkspacePath] = useState<string | null>(null);
  const [attachWorkspaceName, setAttachWorkspaceName] = useState('');
  const [isAttachingWorkspace, setIsAttachingWorkspace] = useState(false);
  const [attachWorkspaceError, setAttachWorkspaceError] = useState<string | null>(null);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<string[]>(loadCollapsedProjectIds);
  const [pendingBranchActionKey, setPendingBranchActionKey] = useState<string | null>(null);
  const { projects } = useProjectsWithLiveGitState(resourceId);
  const createWorkspaceProject = createWorkspaceProjectId ? projects.find(project => project.id === createWorkspaceProjectId) : undefined;
  const attachWorkspaceProject = attachWorkspaceProjectId ? projects.find(project => project.id === attachWorkspaceProjectId) : undefined;
  const {
    data: workspaceBranchOptions = [],
    error: workspaceBranchOptionsError,
  } = useQuery({
    queryKey: ['project-branches', resourceId, createWorkspaceProject?.id],
    queryFn: () => listProjectBranches(createWorkspaceProject!.id),
    enabled: Boolean(createWorkspaceProject && createWorkspaceProject.projectKind === 'git'),
    staleTime: 1000 * 30,
  });
  const {
    data: discoveredWorktrees = [],
    error: discoverWorkspaceError,
    isLoading: isDiscoveringWorkspaces,
  } = useQuery({
    queryKey: ['project-worktrees', resourceId, attachWorkspaceProject?.id],
    queryFn: () => discoverWorkspaces(attachWorkspaceProject!.id),
    enabled: Boolean(attachWorkspaceProject && attachWorkspaceProject.projectKind === 'git'),
    staleTime: 1000 * 10,
  });
  const { data: portals = [] } = useQuery({
    queryKey: ['portals', resourceId],
    queryFn: listPortals,
    staleTime: 1000 * 6,
    refetchInterval: 1000 * 6,
  });
  const invalidateProjects = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: projectsQueryKey(resourceId) }),
    queryClient.invalidateQueries({ queryKey: workspaceGitStateQueryKey(resourceId) }),
  ]);
  const workspaceActionKey = (projectId: string, workspaceId: string) => `${projectId}:${workspaceId}`;
  const invalidateWorkspaceGitState = () => queryClient.invalidateQueries({ queryKey: workspaceGitStateQueryKey(resourceId) });
  const refreshWorkspaceBranchState = async (projectId: string, workspaceId: string, hasUpstream: boolean) => {
    if (!hasUpstream) return;
    const key = workspaceActionKey(projectId, workspaceId);
    const lastRefresh = branchRefreshTimesRef.current.get(key) ?? 0;
    if (Date.now() - lastRefresh < branchMenuRefreshThrottleMs || pendingBranchActionKey === key) return;
    branchRefreshTimesRef.current.set(key, Date.now());
    setPendingBranchActionKey(key);
    try {
      await fetchWorkspaceGitUpstream(projectId, workspaceId);
      await invalidateWorkspaceGitState();
    } catch {
      branchRefreshTimesRef.current.delete(key);
    } finally {
      setPendingBranchActionKey(current => current === key ? null : current);
    }
  };
  const pullWorkspaceBranch = async (projectId: string, workspaceId: string) => {
    const key = workspaceActionKey(projectId, workspaceId);
    setPendingBranchActionKey(key);
    try {
      await pullWorkspaceGitUpstream(projectId, workspaceId);
      branchRefreshTimesRef.current.set(key, Date.now());
      await invalidateWorkspaceGitState();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingBranchActionKey(current => current === key ? null : current);
    }
  };
  const onlinePortalCount = portals.filter(portal => portal.status === 'online').length;
  const plainThreads = sortManual(threads.filter(thread => (!thread.projectId || thread.adHoc) && thread.archived !== true));
  const threadsByProject = new Map(projects.map(project => [project.id, sortManual(threads.filter(thread => thread.projectId === project.id && !thread.adHoc))]));
  const sortedProjects = sortManual(projects);
  const toggleProjectCollapsed = (projectId: string) =>
    setCollapsedProjectIds(ids => (ids.includes(projectId) ? ids.filter(id => id !== projectId) : [...ids, projectId]));
  const collapseProjectsForDrag = () => {
    openProjectIdsBeforeDragRef.current = sortedProjects
      .map(project => project.id)
      .filter(projectId => !collapsedProjectIds.includes(projectId));
    setCollapsedProjectIds(sortedProjects.map(project => project.id));
  };
  const restoreProjectsAfterDrag = () => {
    const openProjectIds = openProjectIdsBeforeDragRef.current;
    openProjectIdsBeforeDragRef.current = null;
    if (!openProjectIds) return;
    setCollapsedProjectIds(sortedProjects.map(project => project.id).filter(projectId => !openProjectIds.includes(projectId)));
  };
  const suppressSelectionAfterDrag = () => {
    suppressSelectionUntilRef.current = Date.now() + 500;
  };
  const shouldSuppressSelection = () => Date.now() < suppressSelectionUntilRef.current;
  const isThreadActive = (nextThreadId: string) => activeSurface.kind === 'thread' && activeSurface.threadId === nextThreadId;
  const isWorkspaceActive = (projectId: string, workspaceId: string) =>
    activeSurface.kind === 'workspace' && activeSurface.projectId === projectId && activeSurface.workspaceId === workspaceId;
  const selectThread = (nextThreadId: string) => {
    if (shouldSuppressSelection()) return;
    selectThreadSurface(nextThreadId);
    if (closeOnSelect) onClose?.();
  };
  const selectWorkspaceSurface = (projectId: string, workspaceId: string | undefined) => {
    if (!workspaceId || shouldSuppressSelection()) return;
    selectWorkspace(projectId, workspaceId);
    if (closeOnSelect) onClose?.();
  };
  const reorderPlainThreads = async (activeId: string, overId: string) => {
    const ordered = moveItem(plainThreads, activeId, overId);
    await reorderThreads({ plain: true }, ordered.map(thread => thread.id));
    await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
  };
  const reorderProjectThreads = async (projectId: string, activeId: string, overId: string) => {
    const ordered = moveItem((threadsByProject.get(projectId) ?? []).filter(thread => !thread.workspaceId && thread.archived !== true), activeId, overId);
    await reorderThreads({ projectId }, ordered.map(thread => thread.id));
    await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
  };
  const reorderWorkspaceThreads = async (projectId: string, workspaceId: string, activeId: string, overId: string) => {
    const ordered = moveItem((threadsByProject.get(projectId) ?? []).filter(thread => thread.workspaceId === workspaceId && thread.archived !== true), activeId, overId);
    await reorderThreads({ projectId, workspaceId }, ordered.map(thread => thread.id));
    await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
  };
  const createPlainThread = async () => {
    await newThread();
    await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
    if (closeOnSelect) onClose?.();
  };
  const openCreateProjectDialog = () => {
    setCreateProjectError(null);
    setIsCreateProjectDialogOpen(true);
  };
  const openCreateWorkspaceDialog = (projectId: string) => {
    const project = projects.find(item => item.id === projectId);
    const defaults = createWorkspaceDraftDefaults(project?.defaultBranch);
    setWorkspaceName(defaults.name);
    setWorkspaceMode(defaults.mode);
    setWorkspaceBranch(defaults.branch);
    setWorkspaceBase(defaults.base);
    setCreateWorkspaceError(null);
    setCreateWorkspaceProjectId(projectId);
  };
  const closeCreateWorkspaceDialog = () => {
    if (isCreatingWorkspace) return;
    setCreateWorkspaceProjectId(null);
    setCreateWorkspaceError(null);
  };
  const openAttachWorkspaceDialog = (projectId: string) => {
    setAttachWorkspacePath(null);
    setAttachWorkspaceName('');
    setAttachWorkspaceError(null);
    setAttachWorkspaceProjectId(projectId);
  };
  const closeAttachWorkspaceDialog = () => {
    if (isAttachingWorkspace) return;
    setAttachWorkspaceProjectId(null);
    setAttachWorkspacePath(null);
    setAttachWorkspaceName('');
    setAttachWorkspaceError(null);
  };

  useEffect(() => {
    if (!createWorkspaceProject || workspaceMode !== 'newBranch') return;
    const fallback = getDefaultWorkspaceBase(createWorkspaceProject.defaultBranch);
    const nextBase = resolveWorkspaceBaseRef(workspaceBase, workspaceBranchOptions, fallback);
    if (nextBase !== workspaceBase) setWorkspaceBase(nextBase);
  }, [createWorkspaceProject, workspaceBase, workspaceBranchOptions, workspaceMode]);

  useEffect(() => {
    window.localStorage.setItem(collapsedProjectsStorageKey, JSON.stringify(collapsedProjectIds));
  }, [collapsedProjectIds]);
  const archivedDialogThreads = archivedDialogScopeId === 'plain'
    ? threads.filter(thread => (!thread.projectId || thread.adHoc) && thread.archived)
    : threads.filter(thread => {
      if (!archivedDialogScopeId || !thread.archived) return false;
      if (thread.workspaceId) return thread.workspaceId === archivedDialogScopeId;
      return thread.projectId === archivedDialogScopeId;
    });
  const archivedDialogTitle = archivedDialogScopeId === 'plain'
    ? 'Archived Threads'
    : projects.find(project => project.id === archivedDialogScopeId)?.name
      ?? projects.flatMap(project => project.workspaces).find(workspace => workspace.id === archivedDialogScopeId)?.name
      ?? 'Archived Threads';
  const deleteProjectTarget = deleteProjectId ? projects.find(project => project.id === deleteProjectId) : undefined;
  const attachedWorkspacePaths = new Set(
    projects.flatMap(project => project.workspaces)
      .map(workspace => normalizeWorkspacePath(workspace.path))
      .filter(Boolean),
  );
  const unattachedWorktrees = discoveredWorktrees.filter(worktree => {
    const path = normalizeWorkspacePath(worktree.path);
    return path && !worktree.adopted && !attachedWorkspacePaths.has(path);
  });
  const selectedAttachWorktree = unattachedWorktrees.find(worktree => normalizeWorkspacePath(worktree.path) === normalizeWorkspacePath(attachWorkspacePath));
  const trimmedWorkspaceName = workspaceName.trim();
  const trimmedWorkspaceBranch = workspaceBranch.trim();
  const trimmedWorkspaceBase = workspaceBase.trim();
  const trimmedAttachWorkspaceName = attachWorkspaceName.trim();
  const workspaceBranchOptionRefs = workspaceBranchOptions.map(option => option.ref);
  const workspaceBranchOptionByRef = new Map(workspaceBranchOptions.map(option => [option.ref, option]));
  const canCreateWorkspace = Boolean(
    createWorkspaceProject
      && trimmedWorkspaceName
      && !isCreatingWorkspace
      && (workspaceMode === 'detached' ? trimmedWorkspaceBase : trimmedWorkspaceBranch),
  );
  const canAttachWorkspace = Boolean(attachWorkspaceProject && selectedAttachWorktree?.path && !isAttachingWorkspace);
  const renderThreadRunningSpinner = (thread: typeof threads[number]) => {
    if (!runningThreadIds.includes(thread.id)) return null;

    return (
      <span
        className="flex size-6 shrink-0 items-center justify-center text-primary"
        role="status"
        aria-label={`${thread.title} is running`}
      >
        <Loader2 size={20} className="animate-spin" aria-hidden="true" />
      </span>
    );
  };
  const renderThreadMenu = (thread: typeof threads[number]) => (
    <Menu>
      <MenuTrigger render={<Button className="shrink-0 text-foreground" size="icon-xs" variant="ghost" aria-label={`Open menu for ${thread.title}`} />}>
        <MoreHorizontal size={14} />
      </MenuTrigger>
      <MenuPopup align="end" sideOffset={4} className="w-32">
        <MenuItem
          onClick={async event => {
            event.preventDefault();
            await archiveThread(thread.id);
            await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
          }}
        >
          <Archive size={13} />
          Archive
        </MenuItem>
        <MenuItem
          variant="destructive"
          onClick={async event => {
            event.preventDefault();
            await deleteThread(thread.id);
            await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
          }}
        >
          <Trash2 size={13} />
          Delete
        </MenuItem>
      </MenuPopup>
    </Menu>
  );

  return (
    <aside
      ref={ref}
      data-weave-thread-sidebar
      data-weave-thread-sidebar-overlay={presentation === 'overlay' ? 'true' : undefined}
      data-weave-surface="sidebar"
      tabIndex={-1}
      className={cn(
        'fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col border-r border-border bg-muted p-4 dark:bg-card',
        presentation === 'overlay'
          ? 'w-96 max-w-[min(24rem,calc(100vw-1rem))]'
          : 'w-full md:static md:z-auto md:w-96',
      )}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto pr-1">
        <div className="space-y-2">
          <SidebarSectionHeader label="Threads" labelClassName="text-primary">
            <div className="flex items-center">
              <Button
                className="h-5 w-6 text-foreground sm:h-5 sm:w-6"
                size="icon-xs"
                variant="ghost"
                aria-label="Create Thread"
                onClick={createPlainThread}
              >
                <SquarePen size={14} />
              </Button>
              <Menu>
                <MenuTrigger render={<Button className="h-5 w-6 text-foreground sm:h-5 sm:w-6" size="icon-xs" variant="ghost" aria-label="Threads menu" />}>
                  <MoreHorizontal size={14} />
                </MenuTrigger>
                <MenuPopup align="end" sideOffset={4} className="w-40">
                  <MenuItem onClick={() => setArchivedDialogScopeId('plain')}>
                    <Archive size={13} />
                    Archived Threads
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
            <Button
              className="h-6 w-8 md:hidden"
              size="icon-xs"
              variant="ghost"
              aria-label="Close sidebar"
              onClick={onClose}
            >
              <X size={14} />
            </Button>
          </SidebarSectionHeader>
        <SortableSection
          items={plainThreads.map(thread => thread.id)}
          onDragStart={suppressSelectionAfterDrag}
          onDragEnd={suppressSelectionAfterDrag}
          onReorder={reorderPlainThreads}
        >
        {plainThreads.map(thread => (
          <SortableItem
            key={thread.id}
            id={thread.id}
            canDrag={plainThreads.length > 1}
            showHandle={false}
            className={cn(
              'group flex min-h-9 min-w-0 w-[calc(100%+6px)] items-center gap-2 rounded-md border border-transparent py-1 pl-2 pr-1 text-left transition-colors',
              isThreadActive(thread.id) ? 'border-transparent bg-selected-thread' : 'hover:bg-background',
            )}
          >
            <SidebarItemButton
              className="min-w-0 flex-1 items-center text-left"
              onClick={() => selectThread(thread.id)}
            >
              <div className="flex min-w-0 items-center text-sm font-normal text-foreground">
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              </div>
            </SidebarItemButton>
            {renderThreadRunningSpinner(thread)}
            {renderThreadMenu(thread)}
          </SortableItem>
        ))}
        </SortableSection>
        </div>

        <div className="space-y-2">
          <SidebarSectionHeader label="Projects" labelClassName="text-success">
            <Menu>
              <MenuTrigger render={<Button className="h-6 w-8 text-foreground" size="icon-xs" variant="ghost" aria-label="Projects menu" />}>
                <MoreHorizontal size={14} />
              </MenuTrigger>
              <MenuPopup align="end" sideOffset={4} className="w-36">
                <MenuItem onClick={openCreateProjectDialog}>
                  <Plus size={13} />
                  Create Project
                </MenuItem>
              </MenuPopup>
            </Menu>
          </SidebarSectionHeader>
          <SortableSection
            items={sortedProjects.map(project => project.id)}
            onDragStart={() => {
              suppressSelectionAfterDrag();
              collapseProjectsForDrag();
            }}
            onDragEnd={() => {
              restoreProjectsAfterDrag();
              suppressSelectionAfterDrag();
            }}
            onReorder={async (activeId, overId) => {
              const ordered = moveItem(sortedProjects, activeId, overId);
              await reorderProjects(ordered.map(item => item.id));
              await invalidateProjects();
            }}
          >
            {sortedProjects.map(project => {
              const isCollapsed = collapsedProjectIds.includes(project.id);
              const projectThreads = threadsByProject.get(project.id) ?? [];
              const workspaces = project.workspaces.length > 0 ? project.workspaces : [];
              const generalProjectThreads = projectThreads.filter(thread => !thread.workspaceId && thread.archived !== true);
              const sortedWorkspaces = sortManual(workspaces);
              const notesWorkspace = project.projectKind === 'notes' ? sortedWorkspaces[0] : undefined;
              const notesThreads = notesWorkspace
                ? projectThreads.filter(thread => thread.workspaceId === notesWorkspace.id && thread.archived !== true)
                : [];
              const isNotesProjectActive = Boolean(notesWorkspace && isWorkspaceActive(project.id, notesWorkspace.id));

              return (
                <SortableItem
                  key={project.id}
                  id={project.id}
                  canDrag={sortedProjects.length > 1}
                  showHandle={false}
                  className="-ml-2 py-2"
                >
                  {dragActivator => (
                    <>
                      <div
                        ref={dragActivator.ref}
                        className={cn(
                          'flex w-full cursor-grab touch-none select-none items-center gap-2 text-sm font-normal text-foreground active:cursor-grabbing',
                          !isCollapsed && 'mb-2',
                        )}
                        style={{ touchAction: 'none' }}
                        {...dragActivator.attributes}
                        {...dragActivator.listeners}
                      >
                        <Button
                          className="h-6 w-6 shrink-0 text-muted-foreground/80"
                          size="icon-xs"
                          variant="ghost"
                          aria-expanded={!isCollapsed}
                          aria-label={isCollapsed ? `Expand ${project.name}` : `Collapse ${project.name}`}
                          onClick={event => {
                            event.stopPropagation();
                            if (shouldSuppressSelection()) return;
                            toggleProjectCollapsed(project.id);
                          }}
                        >
                          <ChevronDown
                            size={15}
                            className={cn('transition-transform', isCollapsed && '-rotate-90')}
                            aria-hidden="true"
                          />
                        </Button>
                        <SidebarItemButton
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left',
                            isNotesProjectActive && 'bg-selected-thread',
                          )}
                          onClick={() => {
                            if (project.projectKind === 'notes') {
                              selectWorkspaceSurface(project.id, notesWorkspace?.id);
                              return;
                            }
                            if (shouldSuppressSelection()) return;
                            toggleProjectCollapsed(project.id);
                          }}
                        >
                          {!isCollapsed ? (
                            <FolderOpen size={16} className="shrink-0 text-foreground" aria-label="Expanded Project" />
                          ) : project.projectKind === 'git' ? (
                            <FolderCode size={16} className="shrink-0 text-foreground" aria-label="Git Project" />
                          ) : project.projectKind === 'notes' ? (
                            <StickyNote size={16} className="shrink-0 text-foreground" aria-label="Notes Project" />
                          ) : (
                            <Folder size={16} className="shrink-0 text-foreground" aria-label="General Project" />
                          )}
                          <span className="min-w-0 truncate text-foreground">{project.name}</span>
                        </SidebarItemButton>
                        {!isCollapsed ? (
                          <div className="flex shrink-0 items-center">
                            {project.projectKind === 'general' || project.projectKind === 'notes' ? (
                              <Button
                                className="h-5 w-6 shrink-0 text-foreground sm:h-5 sm:w-6"
                                size="icon-xs"
                                variant="ghost"
                                aria-label={`Create thread in ${project.name}`}
                                onClick={async () => {
                                  await newThread(project.id, project.projectKind === 'notes' ? project.workspaces[0]?.id : undefined);
                                  await Promise.all([
                                    queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }),
                                    invalidateProjects(),
                                  ]);
                                  if (closeOnSelect) onClose?.();
                                }}
                              >
                                <SquarePen size={14} />
                              </Button>
                            ) : null}
                            <Menu>
                              <MenuTrigger render={<Button size="icon-xs" variant="ghost" className="h-5 w-6 text-foreground sm:h-5 sm:w-6" aria-label={`${project.name} menu`} />}>
                                <MoreHorizontal size={14} />
                              </MenuTrigger>
                              <MenuPopup align="end" sideOffset={4} className="w-44">
                                {project.projectKind === 'git' ? (
                                  <>
                                    <MenuItem onClick={() => openCreateWorkspaceDialog(project.id)}>
                                      <Plus size={13} />
                                      Create Workspace
                                    </MenuItem>
                                    <MenuItem onClick={() => openAttachWorkspaceDialog(project.id)}>
                                      <Link size={13} />
                                      Attach Workspace
                                    </MenuItem>
                                  </>
                                ) : null}
                                {project.projectKind !== 'git' ? (
                                  <MenuItem onClick={() => setArchivedDialogScopeId(project.projectKind === 'notes' ? notesWorkspace?.id ?? project.id : project.id)}>
                                    <Archive size={13} />
                                    Archived Threads
                                  </MenuItem>
                                ) : null}
                                <MenuItem variant="destructive" onClick={() => setDeleteProjectId(project.id)}>
                                  <Trash2 size={13} />
                                  Delete Project
                                </MenuItem>
                              </MenuPopup>
                            </Menu>
                          </div>
                        ) : null}
                      </div>
                      {!isCollapsed ? (
                        <>
                    <div className="relative space-y-2 pl-6 before:absolute before:bottom-1 before:left-3 before:top-0 before:w-px before:bg-success/70">
                            {project.projectKind === 'general' ? (
                              <SortableSection
                                items={generalProjectThreads.map(thread => thread.id)}
                                onDragStart={suppressSelectionAfterDrag}
                                onDragEnd={suppressSelectionAfterDrag}
                                onReorder={(activeId, overId) => reorderProjectThreads(project.id, activeId, overId)}
                              >
                                {generalProjectThreads.map(thread => (
                                  <SortableItem
                                    key={thread.id}
                                    id={thread.id}
                                    canDrag={generalProjectThreads.length > 1}
                                    showHandle={false}
                                    className={cn(
                                      'group relative -ml-2 flex min-h-9 min-w-0 w-[calc(100%+0.5rem)] items-center gap-2 rounded-md border py-1 pl-2 pr-1 text-left transition-colors',
                                      isThreadActive(thread.id) ? 'border-transparent bg-selected-thread text-foreground' : 'border-transparent text-foreground hover:bg-background',
                                    )}
                                  >
                                    <SidebarItemButton
                                      className="min-w-0 flex-1 items-center text-left"
                                      onClick={() => selectThread(thread.id)}
                                    >
                                      <div className="flex min-w-0 items-center pl-4">
                                        <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">{thread.title}</span>
                                      </div>
                                    </SidebarItemButton>
                                    {renderThreadRunningSpinner(thread)}
                                    {renderThreadMenu(thread)}
                                  </SortableItem>
                                ))}
                              </SortableSection>
                            ) : null}
                            {project.projectKind === 'notes' && notesWorkspace ? (
                              <SortableSection
                                items={notesThreads.map(thread => thread.id)}
                                onDragStart={suppressSelectionAfterDrag}
                                onDragEnd={suppressSelectionAfterDrag}
                                onReorder={(activeId, overId) => reorderWorkspaceThreads(project.id, notesWorkspace.id, activeId, overId)}
                              >
                                {notesThreads.map(thread => (
                                  <SortableItem
                                    key={thread.id}
                                    id={thread.id}
                                    canDrag={notesThreads.length > 1}
                                    showHandle={false}
                                    className={cn(
                                      'group relative -ml-2 flex min-h-9 min-w-0 w-[calc(100%+0.5rem)] items-center gap-2 rounded-md border py-1 pl-2 pr-1 text-left transition-colors',
                                      isThreadActive(thread.id) ? 'border-transparent bg-selected-thread text-foreground' : 'border-transparent text-foreground hover:bg-background',
                                    )}
                                  >
                                    <SidebarItemButton
                                      className="min-w-0 flex-1 items-center text-left"
                                      onClick={() => selectThread(thread.id)}
                                    >
                                      <div className="flex min-w-0 items-center pl-4">
                                        <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">{thread.title}</span>
                                      </div>
                                    </SidebarItemButton>
                                    {renderThreadRunningSpinner(thread)}
                                    {renderThreadMenu(thread)}
                                  </SortableItem>
                                ))}
                              </SortableSection>
                            ) : null}
                            {project.projectKind === 'git' ? (
                              <div>
                                <SortableSection
                                  items={sortedWorkspaces.map(workspace => workspace.id)}
                                  onDragStart={suppressSelectionAfterDrag}
                                  onDragEnd={suppressSelectionAfterDrag}
                                  onReorder={async (activeId, overId) => {
                                    const ordered = moveItem(sortedWorkspaces, activeId, overId);
                                    await reorderWorkspaces(project.id, ordered.map(item => item.id));
                                    await invalidateProjects();
                                  }}
                                >
                                  {sortedWorkspaces.map(workspace => {
                                    const workspaceThreads = projectThreads.filter(thread => thread.workspaceId === workspace.id && thread.archived !== true);
                                    const workspaceTerminalCount = workspaceTerminalWindowCounts[workspace.id] ?? 0;

                                    return (
                                      <SortableItem
                                        key={workspace.id}
                                        id={workspace.id}
                                        canDrag={sortedWorkspaces.length > 1}
                                        showHandle={false}
                                        className="space-y-1 pt-2 pb-0"
                                      >
                                        <div
                                          className={cn(
                                            'flex min-h-14 min-w-0 w-[calc(100%+0.5rem)] -ml-2 items-center gap-2 rounded-md border py-1 pl-2 pr-1 text-left text-sm font-normal transition-colors',
                                            isWorkspaceActive(project.id, workspace.id)
                                              ? 'border-transparent bg-selected-thread text-foreground'
                                              : 'border-transparent text-foreground hover:bg-background',
                                          )}
                                        >
                                          <div className="min-w-0 flex-1 rounded-md px-2 py-2 text-left">
                                            <button
                                              type="button"
                                              className="flex h-5 w-full min-w-0 items-center gap-1.5 text-left text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                                              onClick={() => selectWorkspaceSurface(project.id, workspace.id)}
                                            >
                                              <span className="truncate text-foreground">{workspace.name}</span>
                                              {workspace.locked || workspace.workspaceKind === 'primary' ? <Lock size={11} className="shrink-0 text-muted-foreground" aria-label="Primary workspace" /> : null}
                                            </button>
                                            {workspace.detached ? (
                                              <div className="flex h-4 items-center truncate text-[10px] font-normal leading-none text-mauve">
                                                {`Detached ${workspace.head?.slice(0, 7) ?? 'HEAD'}`}
                                              </div>
                                            ) : workspace.branch ? (
                                              <Menu
                                                onOpenChange={(open) => {
                                                  if (open) void refreshWorkspaceBranchState(project.id, workspace.id, Boolean(workspace.upstream));
                                                }}
                                              >
                                                <MenuTrigger
                                                  render={
                                                    <button
                                                      type="button"
                                                      className="flex h-4 max-w-full items-center gap-1 truncate text-[10px] font-normal leading-none text-mauve outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                                                      aria-label={`${workspace.branch} branch menu`}
                                                    />
                                                  }
                                                >
                                                  <span className="truncate">{workspace.branch}</span>
                                                  {typeof workspace.behind === 'number' && workspace.behind > 0 ? (
                                                    <span className="shrink-0 text-muted-foreground" aria-label={`${workspace.behind} behind upstream`}>
                                                      {`\u2193${workspace.behind}`}
                                                    </span>
                                                  ) : null}
                                                  {typeof workspace.ahead === 'number' && workspace.ahead > 0 ? (
                                                    <span className="shrink-0 text-muted-foreground" aria-label={`${workspace.ahead} ahead of upstream`}>
                                                      {`\u2191${workspace.ahead}`}
                                                    </span>
                                                  ) : null}
                                                </MenuTrigger>
                                                <MenuPopup align="start" sideOffset={4} className="w-44">
                                                  {workspace.upstream ? (
                                                    <MenuItem
                                                      disabled={pendingBranchActionKey === workspaceActionKey(project.id, workspace.id)}
                                                      onClick={() => void pullWorkspaceBranch(project.id, workspace.id)}
                                                    >
                                                      <Download size={13} />
                                                      Pull from remote
                                                    </MenuItem>
                                                  ) : (
                                                    <MenuItem disabled>
                                                      <GitBranch size={13} />
                                                      No upstream
                                                    </MenuItem>
                                                  )}
                                                </MenuPopup>
                                              </Menu>
                                            ) : null}
                                            {workspace.lastError ? <div className="truncate text-[10px] font-normal text-destructive">{workspace.lastError}</div> : null}
                                          </div>
                                          <div className="-mr-2 flex w-6 shrink-0 flex-col items-center self-stretch py-2">
                                            <Button
                                              className="h-5 w-6 text-foreground sm:h-5 sm:w-6"
                                              size="icon-xs"
                                              variant="ghost"
                                              aria-label={`Create thread in ${workspace.name}`}
                                              onClick={async () => {
                                                await newThread(project.id, workspace.id);
                                                await Promise.all([
                                                  queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }),
                                                  invalidateProjects(),
                                                ]);
                                                if (closeOnSelect) onClose?.();
                                              }}
                                            >
                                              <SquarePen size={14} />
                                            </Button>
                                          </div>
                                          <div className="flex w-6 shrink-0 flex-col items-center self-stretch py-2">
                                            <Menu>
                                              <MenuTrigger render={<Button size="icon-xs" variant="ghost" className="h-5 w-6 text-foreground sm:h-5 sm:w-6" aria-label={`${workspace.name} menu`} />}>
                                                <MoreHorizontal size={14} />
                                              </MenuTrigger>
                                              <MenuPopup align="end" sideOffset={4} className="w-44">
                                                <MenuItem onClick={() => setArchivedDialogScopeId(workspace.id)}>
                                                  <Archive size={13} />
                                                  Archived Threads
                                                </MenuItem>
                                                {project.projectKind === 'git' ? (
                                                  <MenuItem
                                                    onClick={async () => {
                                                      const branch = window.prompt('Branch name', workspace.branch ?? '');
                                                      if (!branch?.trim()) return;
                                                      const createBranch = window.confirm('Create as a new branch? Cancel switches to an existing branch.');
                                                      const base = createBranch ? window.prompt('Base ref (optional)', project.defaultBranch ?? workspace.branch ?? '') : undefined;
                                                      try {
                                                        await updateWorkspace(project.id, workspace.id, {
                                                          branch: branch.trim(),
                                                          createBranch,
                                                          base: base?.trim() || undefined,
                                                        });
                                                        await invalidateProjects();
                                                      } catch (error) {
                                                        window.alert(error instanceof Error ? error.message : String(error));
                                                      }
                                                    }}
                                                  >
                                                    <GitBranch size={13} />
                                                    Switch Branch
                                                  </MenuItem>
                                                ) : null}
                                                {project.projectKind === 'git' && !workspace.locked && workspace.workspaceKind !== 'primary' ? (
                                                  <>
                                                    <MenuItem
                                                      onClick={async () => {
                                                        if (!window.confirm(`Detach ${workspace.name} from this Project? Worktree files stay on disk.`)) return;
                                                        try {
                                                          await deleteWorkspace(project.id, workspace.id, 'detach');
                                                          await invalidateProjects();
                                                        } catch (error) {
                                                          window.alert(error instanceof Error ? error.message : String(error));
                                                        }
                                                      }}
                                                    >
                                                      <Link size={13} />
                                                      Detach
                                                    </MenuItem>
                                                    <MenuItem
                                                      variant="destructive"
                                                      onClick={async () => {
                                                        if (!window.confirm(`Remove workspace ${workspace.name}? This removes the worktree and leaves the branch alone.`)) return;
                                                        try {
                                                          await deleteWorkspace(project.id, workspace.id, 'remove');
                                                          await invalidateProjects();
                                                        } catch (error) {
                                                          window.alert(error instanceof Error ? error.message : String(error));
                                                        }
                                                      }}
                                                    >
                                                      <Trash2 size={13} />
                                                      Remove Workspace
                                                    </MenuItem>
                                                  </>
                                                ) : null}
                                              </MenuPopup>
                                            </Menu>
                                            {workspaceTerminalCount > 0 ? (
                                              <span
                                                className="flex h-4 w-6 items-center justify-center text-peach"
                                                title={`${workspaceTerminalCount} running terminal${workspaceTerminalCount === 1 ? '' : 's'}`}
                                                aria-label={`${workspaceTerminalCount} running terminal${workspaceTerminalCount === 1 ? '' : 's'}`}
                                              >
                                                <TerminalSquare size={14} />
                                              </span>
                                            ) : null}
                                          </div>
                                        </div>
                                        <div
                                          className={cn(
                                            'relative',
                                            workspaceThreads.length > 0
                                  && 'before:absolute before:bottom-1 before:left-2 before:top-1 before:w-px before:bg-peach/70',
                                          )}
                                        >
                                          <SortableSection
                                            items={workspaceThreads.map(thread => thread.id)}
                                            onDragStart={suppressSelectionAfterDrag}
                                            onDragEnd={suppressSelectionAfterDrag}
                                            onReorder={(activeId, overId) => reorderWorkspaceThreads(project.id, workspace.id, activeId, overId)}
                                          >
                                            {workspaceThreads.map(thread => (
                                              <SortableItem
                                                key={thread.id}
                                                id={thread.id}
                                                canDrag={workspaceThreads.length > 1}
                                                showHandle={false}
                                                className={cn(
                                                  'group relative -ml-2 flex min-h-9 min-w-0 w-[calc(100%+0.5rem)] items-center gap-2 rounded-md border py-1 pl-2 pr-1 text-left transition-colors',
                                                  isThreadActive(thread.id) ? 'border-transparent bg-selected-thread text-foreground' : 'border-transparent text-foreground hover:bg-background',
                                                )}
                                              >
                                                <SidebarItemButton
                                                  className="min-w-0 flex-1 items-center text-left"
                                                  onClick={() => selectThread(thread.id)}
                                                >
                                                  <div className="flex min-w-0 items-center pl-4">
                                                    <span className="min-w-0 flex-1 truncate text-sm font-normal text-foreground">{thread.title}</span>
                                                  </div>
                                                </SidebarItemButton>
                                                {renderThreadRunningSpinner(thread)}
                                                {renderThreadMenu(thread)}
                                              </SortableItem>
                                            ))}
                                          </SortableSection>
                                        </div>
                                      </SortableItem>
                                    );
                                  })}
                                </SortableSection>
                              </div>
                            ) : null}
                            {projectThreads.length === 0 && project.projectKind === 'general' ? <div className="px-2 py-1 text-xs text-muted-foreground">No threads</div> : null}
                          </div>
                        </>
                      ) : null}
                    </>
                  )}
                </SortableItem>
              );
            })}
          </SortableSection>
        </div>
      </div>

      {isCreateProjectDialogOpen ? (
        <GitProjectDirectoryPicker
          portals={portals.filter(portal => portal.status === 'online')}
          isCreating={isCreatingProject}
          createError={createProjectError}
          onCancel={() => {
            setIsCreateProjectDialogOpen(false);
            setCreateProjectError(null);
          }}
          onCreate={async (input: CreateProjectInput) => {
            setIsCreatingProject(true);
            setCreateProjectError(null);
            try {
              await createProject(input);
              setIsCreateProjectDialogOpen(false);
              await invalidateProjects();
            } catch (error) {
              setCreateProjectError(error instanceof Error ? error.message : String(error));
            } finally {
              setIsCreatingProject(false);
            }
          }}
        />
      ) : null}

      <Dialog open={Boolean(createWorkspaceProject)} onOpenChange={open => {
        if (!open) closeCreateWorkspaceDialog();
      }}>
        {createWorkspaceProject ? (
          <DialogPopup className="max-w-md" showCloseButton={false}>
            <DialogHeader className="flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle>Create Workspace</DialogTitle>
                <DialogDescription className="truncate">{createWorkspaceProject.name}</DialogDescription>
              </div>
              <DialogClose render={<Button size="icon-sm" variant="ghost" aria-label="Close create workspace" disabled={isCreatingWorkspace} />}>
                <X size={16} />
              </DialogClose>
            </DialogHeader>
            <DialogPanel className="grid gap-3 pt-1">
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  nativeInput
                  value={workspaceName}
                  onChange={event => setWorkspaceName(event.target.value)}
                  disabled={isCreatingWorkspace}
                  autoFocus
                  placeholder="Workspace name"
                />
              </Field>
              <Field>
                <FieldLabel>Branch Action</FieldLabel>
                <Select
                  value={workspaceMode}
                  onValueChange={value => {
                    const nextMode = value === 'existingBranch' || value === 'detached' ? value : 'newBranch';
                    setWorkspaceMode(nextMode);
                    if ((nextMode === 'detached' || nextMode === 'newBranch') && !workspaceBase.trim()) {
                      setWorkspaceBase(getDefaultWorkspaceBase(createWorkspaceProject.defaultBranch));
                    }
                  }}
                  disabled={isCreatingWorkspace}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="detached">Detached checkout</SelectItem>
                    <SelectItem value="newBranch">New branch</SelectItem>
                    <SelectItem value="existingBranch">Existing branch</SelectItem>
                  </SelectPopup>
                </Select>
              </Field>
              {workspaceMode !== 'detached' ? (
                <Field>
                  <FieldLabel>{workspaceMode === 'existingBranch' ? 'Branch' : 'New Branch'}</FieldLabel>
                  <Input
                    nativeInput
                    value={workspaceBranch}
                    onChange={event => setWorkspaceBranch(event.target.value)}
                    disabled={isCreatingWorkspace}
                    placeholder={workspaceMode === 'existingBranch' ? 'Existing branch' : 'New branch'}
                  />
                </Field>
              ) : null}
              {workspaceMode !== 'existingBranch' ? (
                <div className="grid gap-3">
                  <Field>
                    <FieldLabel>{workspaceMode === 'detached' ? 'Commit / Ref' : 'Base'}</FieldLabel>
                    <Combobox
                      items={workspaceBranchOptionRefs}
                      value={workspaceBranchOptionRefs.includes(workspaceBase) ? workspaceBase : null}
                      inputValue={workspaceBase}
                      onInputValueChange={workspaceMode === 'detached' ? value => setWorkspaceBase(value) : undefined}
                      onValueChange={value => {
                        if (typeof value === 'string') setWorkspaceBase(value);
                      }}
                      disabled={isCreatingWorkspace}
                    >
                      <ComboboxInput
                        placeholder={getDefaultWorkspaceBase(createWorkspaceProject.defaultBranch)}
                        readOnly={workspaceMode === 'newBranch'}
                      />
                      <ComboboxPopup>
                        <ComboboxEmpty>
                          {workspaceBranchOptionsError ? 'Unable to load branches' : 'No branches found'}
                        </ComboboxEmpty>
                        <ComboboxList>
                          <ComboboxCollection>
                            {(ref: string) => {
                              const option = workspaceBranchOptionByRef.get(ref);
                              return (
                                <ComboboxItem key={ref} value={ref}>
                                  <span className="flex min-w-0 items-center gap-2">
                                    <span className="truncate text-mauve">{option?.name ?? ref}</span>
                                    {option?.kind === 'remote' ? (
                                      <span className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">origin</span>
                                    ) : null}
                                    {option?.current ? (
                                      <span className="size-1.5 shrink-0 rounded-full bg-success" aria-label="Current branch" />
                                    ) : null}
                                  </span>
                                </ComboboxItem>
                              );
                            }}
                          </ComboboxCollection>
                        </ComboboxList>
                      </ComboboxPopup>
                    </Combobox>
                  </Field>
                </div>
              ) : null}
              {createWorkspaceError ? <Alert variant="error"><AlertDescription>{createWorkspaceError}</AlertDescription></Alert> : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={closeCreateWorkspaceDialog} disabled={isCreatingWorkspace}>Cancel</Button>
              <Button
                className="bg-success text-background hover:bg-success/90"
                disabled={!canCreateWorkspace}
                onClick={async () => {
                  const input: CreateWorkspaceInput = {
                    name: trimmedWorkspaceName,
                    mode: workspaceMode,
                    branch: workspaceMode === 'detached' ? undefined : trimmedWorkspaceBranch,
                    base: trimmedWorkspaceBase || undefined,
                  };
                  setIsCreatingWorkspace(true);
                  setCreateWorkspaceError(null);
                  try {
                    await createWorkspace(createWorkspaceProject.id, input);
                    setCreateWorkspaceProjectId(null);
                    await invalidateProjects();
                  } catch (error) {
                    setCreateWorkspaceError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setIsCreatingWorkspace(false);
                  }
                }}
              >
                {isCreatingWorkspace ? <Loader2 size={13} className="animate-spin" /> : null}
                Create Workspace
              </Button>
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>

      <Dialog open={Boolean(attachWorkspaceProject)} onOpenChange={open => {
        if (!open) closeAttachWorkspaceDialog();
      }}>
        {attachWorkspaceProject ? (
          <DialogPopup className="max-w-lg" showCloseButton={false}>
            <DialogHeader className="flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle>Attach Workspace</DialogTitle>
                <DialogDescription className="truncate">{attachWorkspaceProject.name}</DialogDescription>
              </div>
              <DialogClose render={<Button size="icon-sm" variant="ghost" aria-label="Close attach workspace" disabled={isAttachingWorkspace} />}>
                <X size={16} />
              </DialogClose>
            </DialogHeader>
            <DialogPanel className="grid gap-3 pt-1">
              {discoverWorkspaceError ? (
                <Alert variant="error">
                  <AlertDescription>{discoverWorkspaceError instanceof Error ? discoverWorkspaceError.message : String(discoverWorkspaceError)}</AlertDescription>
                </Alert>
              ) : null}
              <ScrollArea className="max-h-72">
                <div className="space-y-2 pr-2">
                  {isDiscoveringWorkspaces ? (
                    <div className="flex items-center gap-2 rounded-md border border-border/70 p-3 text-sm text-muted-foreground">
                      <Loader2 size={14} className="animate-spin" />
                      Loading worktrees
                    </div>
                  ) : discoverWorkspaceError ? null : unattachedWorktrees.length === 0 ? (
                    <Empty className="rounded-md border border-border/70 p-3">
                      <EmptyDescription>No unattached worktrees</EmptyDescription>
                    </Empty>
                  ) : unattachedWorktrees.map(worktree => {
                    const path = worktree.path ?? '';
                    const isSelected = normalizeWorkspacePath(path) === normalizeWorkspacePath(attachWorkspacePath);

                    return (
                      <Button
                        key={path}
                        className={cn(
                          'h-auto w-full justify-start rounded-md border p-3 text-left shadow-none',
                          isSelected
                            ? 'border-success/70 bg-selected-thread text-foreground'
                            : 'border-border/70 bg-background text-foreground hover:bg-muted',
                        )}
                        variant="ghost"
                        onClick={() => {
                          setAttachWorkspacePath(path);
                          setAttachWorkspaceName(getDiscoveredWorktreeName(worktree));
                          setAttachWorkspaceError(null);
                        }}
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <GitBranch size={13} className="shrink-0 text-mauve" />
                            <span className="min-w-0 truncate text-sm font-medium">{getDiscoveredWorktreeState(worktree)}</span>
                          </div>
                          <div className="truncate text-xs font-normal text-muted-foreground">{path}</div>
                        </div>
                      </Button>
                    );
                  })}
                </div>
              </ScrollArea>
              <Field>
                <FieldLabel>Name</FieldLabel>
                <Input
                  nativeInput
                  value={attachWorkspaceName}
                  onChange={event => setAttachWorkspaceName(event.target.value)}
                  disabled={isAttachingWorkspace || !selectedAttachWorktree}
                  placeholder="Workspace name"
                />
              </Field>
              {attachWorkspaceError ? <Alert variant="error"><AlertDescription>{attachWorkspaceError}</AlertDescription></Alert> : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={closeAttachWorkspaceDialog} disabled={isAttachingWorkspace}>Cancel</Button>
              <Button
                className="bg-success text-background hover:bg-success/90"
                disabled={!canAttachWorkspace}
                onClick={async () => {
                  if (!attachWorkspaceProject || !selectedAttachWorktree?.path) return;
                  setIsAttachingWorkspace(true);
                  setAttachWorkspaceError(null);
                  try {
                    await adoptWorkspace(attachWorkspaceProject.id, selectedAttachWorktree.path, trimmedAttachWorkspaceName || undefined);
                    setAttachWorkspaceProjectId(null);
                    setAttachWorkspacePath(null);
                    setAttachWorkspaceName('');
                    await Promise.all([
                      invalidateProjects(),
                      queryClient.invalidateQueries({ queryKey: ['project-worktrees', resourceId, attachWorkspaceProject.id] }),
                    ]);
                  } catch (error) {
                    setAttachWorkspaceError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setIsAttachingWorkspace(false);
                  }
                }}
              >
                {isAttachingWorkspace ? <Loader2 size={13} className="animate-spin" /> : null}
                Attach Workspace
              </Button>
            </DialogFooter>
          </DialogPopup>
        ) : null}
      </Dialog>

      <AlertDialog open={Boolean(deleteProjectTarget)} onOpenChange={open => {
        if (!open) setDeleteProjectId(null);
      }}>
        {deleteProjectTarget ? (
          <AlertDialogPopup className="max-w-sm">
            <AlertDialogHeader>
              <div className="flex items-start gap-3 text-left">
                <Trash2 className="mt-0.5 shrink-0 text-destructive" size={18} />
                <div className="min-w-0">
                  <AlertDialogTitle>Delete Project?</AlertDialogTitle>
                  <AlertDialogDescription className="mt-1">
                    This will permanently delete <span className="font-medium text-foreground">{deleteProjectTarget.name}</span>, its workspaces, and all threads in it.
                  </AlertDialogDescription>
                </div>
              </div>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                onClick={async () => {
                  await deleteProject(deleteProjectTarget.id);
                  setDeleteProjectId(null);
                  await Promise.all([
                    invalidateProjects(),
                    queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }),
                  ]);
                }}
              >
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        ) : null}
      </AlertDialog>

      <Dialog open={Boolean(archivedDialogScopeId)} onOpenChange={open => {
        if (!open) setArchivedDialogScopeId(null);
      }}>
        {archivedDialogScopeId ? (
          <DialogPopup className="max-w-sm" showCloseButton={false}>
            <DialogHeader className="flex-row items-start justify-between gap-3">
              <div className="min-w-0">
                <DialogTitle>Archived Threads</DialogTitle>
                <DialogDescription className="truncate">{archivedDialogTitle}</DialogDescription>
              </div>
              <DialogClose render={<Button size="icon-sm" variant="ghost" aria-label="Close archived threads" />}>
                <X size={16} />
              </DialogClose>
            </DialogHeader>
            <DialogPanel className="pt-1">
              <ScrollArea className="max-h-72">
                <div className="space-y-2">
                  {archivedDialogThreads.length === 0 ? (
                    <Empty className="rounded-md border border-border/70 p-3">
                      <EmptyDescription>No archived threads</EmptyDescription>
                    </Empty>
                  ) : archivedDialogThreads.map(thread => (
                    <div key={thread.id} className="flex items-center gap-2 rounded-md border border-border/70 p-2">
                      <div className="min-w-0 flex-1 truncate text-sm text-foreground">{thread.title}</div>
                      <Button
                        size="xs"
                        onClick={async () => {
                          await restoreThread(thread.id);
                          await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                        }}
                      >
                        <RotateCcw size={13} />
                        Restore
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </DialogPanel>
          </DialogPopup>
        ) : null}
      </Dialog>

      <div className={cn('mt-4 flex items-center', connectionSettingsButton ? 'justify-start gap-1' : 'justify-end')}>
        {connectionSettingsButton}
        <div
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground"
          title={`${onlinePortalCount} online Portal${onlinePortalCount === 1 ? '' : 's'}`}
          aria-label={`${onlinePortalCount} online Portal${onlinePortalCount === 1 ? '' : 's'}`}
        >
          <Shell size={15} className={cn('shrink-0', onlinePortalCount > 0 ? 'text-success' : 'text-muted-foreground')} />
          <span className="tabular-nums">{onlinePortalCount}</span>
        </div>
      </div>
    </aside>
  );
});

WorkspaceSidebar.displayName = 'WorkspaceSidebar';
