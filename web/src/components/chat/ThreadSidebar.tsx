import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, Check, ChevronUp, Code2, Folder, GripVertical, Loader2, MessageSquare, Moon, MoreHorizontal, MoreVertical, Plus, RotateCcw, Sun, Trash2, X } from 'lucide-react';
import { createDemiplane, createPlane, getAuthUser, listPlanes, listPortals, reorderDemiplanes, reorderPlanes, reorderThreads } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { useChatStore } from '../../stores/chat-store';
import { getResolvedTheme, useThemeStore } from '../../stores/theme-store';
import { MageHandIcon } from '../icons/MageHandIcon';

const collapsedPlanesStorageKey = 'weave.collapsedPlaneIds';

const loadCollapsedPlaneIds = () => {
  try {
    const value = window.localStorage.getItem(collapsedPlanesStorageKey);
    const parsed = value ? JSON.parse(value) : [];
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  } catch {
    return [];
  }
};

const formatThreadTimestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));

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
    attributes: Record<string, unknown>;
    listeners: Record<string, unknown> | undefined;
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
        <button
          ref={setActivatorNodeRef}
          className={cn('absolute left-0 top-1/2 z-10 -translate-x-3 -translate-y-1/2 cursor-grab touch-none select-none rounded p-0.5 text-muted-foreground/70 transition hover:bg-muted hover:text-foreground active:cursor-grabbing', handleClassName)}
          aria-label="Drag to reorder"
          type="button"
          style={{ touchAction: 'none' }}
          onClick={event => event.preventDefault()}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={13} />
        </button>
      ) : null}
      {hasCustomActivator ? children({ ref: setActivatorNodeRef, attributes, listeners }) : children}
    </div>
  );
};

type ThreadSidebarProps = {
  closeOnSelect?: boolean;
  onClose?: () => void;
};

export const ThreadSidebar = ({ closeOnSelect = true, onClose }: ThreadSidebarProps) => {
  const {
    resourceId,
    threadId,
    threads,
    runningThreadIds,
    completedThreadIds,
    newThread,
    setThreadId,
    archiveThread,
    restoreThread,
    deleteThread,
  } = useChatStore();
  const queryClient = useQueryClient();
  const resourceMenuRef = useRef<HTMLDivElement>(null);
  const openPlaneIdsBeforeDragRef = useRef<string[] | null>(null);
  const [isResourceMenuOpen, setIsResourceMenuOpen] = useState(false);
  const [threadMenuId, setThreadMenuId] = useState<string | null>(null);
  const [sectionMenuId, setSectionMenuId] = useState<string | null>(null);
  const [archivedDialogScopeId, setArchivedDialogScopeId] = useState<string | null>(null);
  const [collapsedPlaneIds, setCollapsedPlaneIds] = useState<string[]>(loadCollapsedPlaneIds);
  const mode = useThemeStore(state => state.mode);
  const toggleMode = useThemeStore(state => state.toggleMode);
  const resolvedTheme = getResolvedTheme(mode);
  const { data: authUser } = useQuery({
    queryKey: ['auth-user'],
    queryFn: getAuthUser,
    staleTime: 1000 * 60 * 5,
  });
  const { data: planes = [] } = useQuery({
    queryKey: ['planes', resourceId],
    queryFn: listPlanes,
    staleTime: 1000 * 30,
  });
  const { data: portals = [] } = useQuery({
    queryKey: ['portals', resourceId],
    queryFn: listPortals,
    staleTime: 1000 * 6,
    refetchInterval: 1000 * 6,
  });
  const displayName = authUser?.name ?? '...';
  const onlinePortalCount = portals.filter(portal => portal.status === 'online').length;
  const plainThreads = sortManual(threads.filter(thread => !thread.planeId && thread.archived !== true));
  const threadsByPlane = new Map(planes.map(plane => [plane.id, sortManual(threads.filter(thread => thread.planeId === plane.id))]));
  const sortedPlanes = sortManual(planes);
  const togglePlaneCollapsed = (planeId: string) =>
    setCollapsedPlaneIds(ids => (ids.includes(planeId) ? ids.filter(id => id !== planeId) : [...ids, planeId]));
  const collapsePlanesForDrag = () => {
    openPlaneIdsBeforeDragRef.current = sortedPlanes
      .map(plane => plane.id)
      .filter(planeId => !collapsedPlaneIds.includes(planeId));
    setCollapsedPlaneIds(sortedPlanes.map(plane => plane.id));
  };
  const restorePlanesAfterDrag = () => {
    const openPlaneIds = openPlaneIdsBeforeDragRef.current;
    openPlaneIdsBeforeDragRef.current = null;
    if (!openPlaneIds) return;
    setCollapsedPlaneIds(sortedPlanes.map(plane => plane.id).filter(planeId => !openPlaneIds.includes(planeId)));
  };
  const reorderPlainThreads = async (activeId: string, overId: string) => {
    const ordered = moveItem(plainThreads, activeId, overId);
    await reorderThreads({ plain: true }, ordered.map(thread => thread.id));
    await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
  };
  const reorderPlaneThreads = async (planeId: string, activeId: string, overId: string) => {
    const ordered = moveItem((threadsByPlane.get(planeId) ?? []).filter(thread => !thread.demiplaneId && thread.archived !== true), activeId, overId);
    await reorderThreads({ planeId }, ordered.map(thread => thread.id));
    await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
  };
  const reorderDemiplaneThreads = async (planeId: string, demiplaneId: string, activeId: string, overId: string) => {
    const ordered = moveItem((threadsByPlane.get(planeId) ?? []).filter(thread => thread.demiplaneId === demiplaneId && thread.archived !== true), activeId, overId);
    await reorderThreads({ planeId, demiplaneId }, ordered.map(thread => thread.id));
    await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
  };

  useEffect(() => {
    window.localStorage.setItem(collapsedPlanesStorageKey, JSON.stringify(collapsedPlaneIds));
  }, [collapsedPlaneIds]);
  const archivedDialogThreads = archivedDialogScopeId === 'plain'
    ? threads.filter(thread => !thread.planeId && thread.archived)
    : threads.filter(thread => {
      if (!archivedDialogScopeId || !thread.archived) return false;
      if (thread.demiplaneId) return thread.demiplaneId === archivedDialogScopeId;
      return thread.planeId === archivedDialogScopeId;
    });
  const archivedDialogTitle = archivedDialogScopeId === 'plain'
    ? 'Archived Threads'
    : planes.find(plane => plane.id === archivedDialogScopeId)?.name
      ?? planes.flatMap(plane => plane.demiplanes).find(demiplane => demiplane.id === archivedDialogScopeId)?.name
      ?? 'Archived Threads';

  useEffect(() => {
    if (!isResourceMenuOpen && !threadMenuId && !sectionMenuId) return undefined;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!resourceMenuRef.current?.contains(event.target as Node)) {
        setIsResourceMenuOpen(false);
      }
      setThreadMenuId(null);
      setSectionMenuId(null);
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isResourceMenuOpen, threadMenuId, sectionMenuId]);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-full shrink-0 flex-col border-r border-border bg-muted/95 p-4 shadow-xl backdrop-blur md:static md:z-auto md:w-96 md:bg-muted/50 md:shadow-none md:backdrop-blur-none">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <MageHandIcon className="h-6 w-6 text-yellow" />
          <span>Mage Hand</span>
        </h1>
        <button
          className="rounded-lg p-2 text-muted-foreground transition hover:bg-background/80 hover:text-foreground md:hidden"
          aria-label="Close sidebar"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <div className="-ml-4 h-0.5 flex-1 bg-primary/60" />
            <span className="text-primary">Threads</span>
            <div className="h-0.5 flex-1 bg-primary/60" />
            <button
              className="flex h-5 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90"
              aria-label="Create Thread"
              onClick={async () => {
                await newThread();
                await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                if (closeOnSelect) onClose?.();
              }}
            >
              <Plus size={14} strokeWidth={3} />
            </button>

          </div>
        <SortableSection items={plainThreads.map(thread => thread.id)} onReorder={reorderPlainThreads}>
        {plainThreads.map(thread => (
          <SortableItem
            key={thread.id}
            id={thread.id}
            canDrag={plainThreads.length > 1}
            showHandle={false}
            className={cn(
              'group flex items-start gap-2 rounded-lg border border-transparent p-2 text-left transition',
              thread.id === threadId ? 'border-primary bg-background' : 'hover:bg-background/60',
            )}
          >
            <button
              className="min-w-0 flex-1 text-left"
              onClick={() => {
                setThreadId(thread.id);
                if (closeOnSelect) onClose?.();
              }}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                {runningThreadIds.includes(thread.id) ? (
                  <Loader2 size={14} className="animate-spin text-primary" />
                ) : completedThreadIds.includes(thread.id) ? (
                  <Check size={14} className="text-success" />
                ) : (
                  <MessageSquare size={14} />
                )}
                <span className="truncate">{thread.title}</span>
              </div>
              <div className="mt-1 truncate pl-6 text-xs text-muted-foreground">{formatThreadTimestamp(thread.updatedAt)}</div>
            </button>
            <div className="relative">
              <button
                className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                aria-label={`Open menu for ${thread.title}`}
                onPointerDown={event => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={event => {
                  event.preventDefault();
                  event.stopPropagation();
                  setThreadMenuId(openId => (openId === thread.id ? null : thread.id));
                }}
              >
                <MoreHorizontal size={14} />
              </button>
              {threadMenuId === thread.id ? (
                <div className="absolute right-0 top-6 z-20 w-28 rounded-md border border-border bg-background p-1 text-xs shadow-lg" onPointerDown={event => event.stopPropagation()}>
                  <button
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    onClick={async event => {
                      event.preventDefault();
                      event.stopPropagation();
                      setThreadMenuId(null);
                      await archiveThread(thread.id);
                      await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                    }}
                  >
                    <Archive size={13} />
                    Archive
                  </button>
                  <button
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground transition hover:bg-muted hover:text-foreground"
                    onClick={async event => {
                      event.preventDefault();
                      event.stopPropagation();
                      setThreadMenuId(null);
                      await deleteThread(thread.id);
                      await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                    }}
                  >
                    <Trash2 size={13} />
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
          </SortableItem>
        ))}
        </SortableSection>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            <div className="-ml-4 h-0.5 flex-1 bg-mauve/60" />
            <span className="text-mauve">Planes</span>
            <div className="h-0.5 flex-1 bg-mauve/60" />
            <button
              className="flex h-5 w-10 items-center justify-center rounded-full bg-mauve text-background transition hover:opacity-90"
              aria-label="Create Plane"
              onClick={async () => {
                const name = window.prompt('Project name');
                if (!name?.trim()) return;
                const gitBacked = window.confirm('Create as git-backed project?');
                if (!gitBacked) {
                  await createPlane({ name: name.trim(), projectKind: 'standard' });
                } else {
                  const onlinePortals = portals.filter(portal => portal.status === 'online');
                  if (onlinePortals.length === 0) {
                    window.alert('Connect a Portal before creating a git-backed project.');
                    return;
                  }
                  const portal = onlinePortals[0];
                  const repoPath = window.prompt('Repo path relative to Portal root');
                  if (!repoPath?.trim()) return;
                  await createPlane({ name: name.trim(), projectKind: 'git', portalId: portal.portalId, rootId: 'default', repoPath: repoPath.trim() });
                }
                await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
              }}
            >
              <Plus size={14} strokeWidth={3} />
            </button>

          </div>
          <SortableSection
            items={sortedPlanes.map(plane => plane.id)}
            onDragStart={collapsePlanesForDrag}
            onDragEnd={restorePlanesAfterDrag}
            onReorder={async (activeId, overId) => {
              const ordered = moveItem(sortedPlanes, activeId, overId);
              await reorderPlanes(ordered.map(item => item.id));
              await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
            }}
          >
          {sortedPlanes.map((plane, index) => {
            const isCollapsed = collapsedPlaneIds.includes(plane.id);
            const planeThreads = threadsByPlane.get(plane.id) ?? [];
            const demiplanes = plane.demiplanes.length > 0 ? plane.demiplanes : [];
            const standardPlaneThreads = planeThreads.filter(thread => !thread.demiplaneId && thread.archived !== true);
            const sortedDemiplanes = sortManual(demiplanes);
            const isActivePlane = planeThreads.some(thread => thread.id === threadId);

            return (
              <SortableItem
                key={plane.id}
                id={plane.id}
                canDrag={sortedPlanes.length > 1}
                showHandle={false}
                className={cn('p-2', index > 0 && 'border-t border-mauve/60')}
              >
                {dragActivator => (
                <>
                <div
                  ref={dragActivator.ref}
                  className={cn('flex cursor-grab touch-none select-none items-center gap-2 text-sm font-bold text-mauve active:cursor-grabbing', !isCollapsed && 'mb-2')}
                  style={{ touchAction: 'none' }}
                  {...dragActivator.attributes}
                  {...dragActivator.listeners}
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => togglePlaneCollapsed(plane.id)}
                    aria-expanded={!isCollapsed}
                  >
                    <ChevronUp size={14} className={cn('shrink-0 text-mauve transition', isCollapsed ? 'rotate-180' : '')} />
                    <span className="min-w-0 truncate">{plane.name}</span>
                    {plane.projectKind === 'git' ? (
                      <Code2 size={14} className="shrink-0 text-success" aria-label="Git-backed Plane" />
                    ) : (
                      <Folder size={14} className="shrink-0 text-success" aria-label="Standard Plane" />
                    )}
                  </button>
                  {!isCollapsed ? (
                    <>
                      {plane.projectKind === 'standard' ? (
                        <button
                          className="flex h-5 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90"
                          aria-label={`Create thread in ${plane.name}`}
                          onClick={async () => {
                            await newThread(plane.id);
                            await Promise.all([
                              queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }),
                              queryClient.invalidateQueries({ queryKey: ['planes', resourceId] }),
                            ]);
                            if (closeOnSelect) onClose?.();
                          }}
                        >
                          <Plus size={14} strokeWidth={3} />
                        </button>
                      ) : (
                        <button
                          className="flex h-5 w-10 shrink-0 items-center justify-center rounded-full bg-success text-background transition hover:opacity-90"
                          aria-label={`Create workspace in ${plane.name}`}
                          onClick={async () => {
                            const name = window.prompt('Workspace name');
                            if (!name?.trim()) return;
                            await createDemiplane(plane.id, name.trim());
                            await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
                          }}
                        >
                          <Plus size={14} strokeWidth={3} />
                        </button>
                      )}
                      <div className="relative">
                        <button
                          className="rounded-md p-1 text-mauve transition hover:bg-background/60"
                          aria-label={`${plane.name} menu`}
                          onClick={() => setSectionMenuId(id => id === plane.id ? null : plane.id)}
                        >
                          <MoreVertical size={14} />
                        </button>
                        {sectionMenuId === plane.id ? (
                          <div className="absolute right-0 top-6 z-20 w-36 rounded-md border border-border bg-background p-1 text-xs font-normal text-muted-foreground shadow-lg" onPointerDown={event => event.stopPropagation()}>
                            <button
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition hover:bg-muted hover:text-foreground"
                              onClick={() => {
                                setArchivedDialogScopeId(plane.id);
                                setSectionMenuId(null);
                              }}
                            >
                              <Archive size={13} />
                              Archived Threads
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </>
                  ) : null}
                </div>
                {!isCollapsed ? (
                  <>
                    <div className="space-y-2">
                      {plane.projectKind === 'standard' ? (
                        <SortableSection
                          items={standardPlaneThreads.map(thread => thread.id)}
                          onReorder={(activeId, overId) => reorderPlaneThreads(plane.id, activeId, overId)}
                        >
                        {standardPlaneThreads.map(thread => (
                        <SortableItem
                          key={thread.id}
                          id={thread.id}
                          canDrag={standardPlaneThreads.length > 1}
                          showHandle={false}
                          className={cn(
                            'group relative flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[13px] leading-5 transition',
                            thread.id === threadId ? 'border-primary bg-background text-foreground' : 'border-transparent text-foreground hover:bg-background/60',
                          )}
                        >
                          <button
                            className="min-w-0 flex-1 text-left"
                            onClick={() => {
                              setThreadId(thread.id);
                              if (closeOnSelect) onClose?.();
                            }}
                          >
                            <div className="flex items-center gap-2">
                              {runningThreadIds.includes(thread.id) ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />}
                              <span className="truncate text-[13px] font-normal leading-5">{thread.title}</span>
                            </div>
                            <div className="mt-1 truncate pl-5 text-xs text-muted-foreground">{formatThreadTimestamp(thread.updatedAt)}</div>
                          </button>
                          <div className="relative">
                            <button
                              className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                              aria-label={`Open menu for ${thread.title}`}
                              onClick={event => {
                                event.preventDefault();
                                event.stopPropagation();
                                setThreadMenuId(openId => (openId === thread.id ? null : thread.id));
                              }}
                            >
                              <MoreHorizontal size={14} />
                            </button>
                            {threadMenuId === thread.id ? (
                              <div className="absolute right-0 top-6 z-20 w-28 rounded-md border border-border bg-background p-1 text-xs shadow-lg" onPointerDown={event => event.stopPropagation()}>
                                <button
                                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                  onClick={async event => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setThreadMenuId(null);
                                    await archiveThread(thread.id);
                                    await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                                  }}
                                >
                                  <Archive size={13} />
                                  Archive
                                </button>
                                <button
                                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                  onClick={async event => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    setThreadMenuId(null);
                                    await deleteThread(thread.id);
                                    await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                                  }}
                                >
                                  <Trash2 size={13} />
                                  Delete
                                </button>
                              </div>
                            ) : null}
                          </div>
                        </SortableItem>
                      ))}
                        </SortableSection>
                      ) : null}
                      {plane.projectKind === 'git' ? (
                        <SortableSection
                          items={sortedDemiplanes.map(demiplane => demiplane.id)}
                          onReorder={async (activeId, overId) => {
                            const ordered = moveItem(sortedDemiplanes, activeId, overId);
                            await reorderDemiplanes(plane.id, ordered.map(item => item.id));
                            await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
                          }}
                        >
                        {sortedDemiplanes.map((demiplane, demiplaneIndex) => {
                        const demiplaneThreads = planeThreads.filter(thread => thread.demiplaneId === demiplane.id && thread.archived !== true);

                        return (
                          <SortableItem
                            key={demiplane.id}
                            id={demiplane.id}
                            handleClassName="top-3 translate-y-0"
                            canDrag={sortedDemiplanes.length > 1}
                            className={cn('space-y-1 py-2', demiplaneIndex > 0 && 'border-t border-success/60')}
                          >
                            <div className="flex items-center justify-between gap-2 text-sm font-bold text-success">
                              <span className="min-w-0 flex-1 truncate">{demiplane.name}</span>
                              <button
                                className="flex h-5 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90"
                                aria-label={`Create thread in ${demiplane.name}`}
                                onClick={async () => {
                                  await newThread(plane.id, demiplane.id);
                                  await Promise.all([
                                    queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }),
                                    queryClient.invalidateQueries({ queryKey: ['planes', resourceId] }),
                                  ]);
                                  if (closeOnSelect) onClose?.();
                                }}
                              >
                                <Plus size={14} strokeWidth={3} />
                              </button>
                              <div className="relative">
                                <button
                                  className="rounded-md p-1 text-success transition hover:bg-background/60"
                                  aria-label={`${demiplane.name} menu`}
                                  onClick={() => setSectionMenuId(id => id === demiplane.id ? null : demiplane.id)}
                                >
                                  <MoreVertical size={14} />
                                </button>
                                {sectionMenuId === demiplane.id ? (
                                  <div className="absolute right-0 top-6 z-20 w-36 rounded-md border border-border bg-background p-1 text-xs font-normal text-muted-foreground shadow-lg" onPointerDown={event => event.stopPropagation()}>
                                    <button
                                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition hover:bg-muted hover:text-foreground"
                                      onClick={() => {
                                        setArchivedDialogScopeId(demiplane.id);
                                        setSectionMenuId(null);
                                      }}
                                    >
                                      <Archive size={13} />
                                      Archived Threads
                                    </button>
                                  </div>
                                ) : null}
                              </div>
                            </div>
                            <SortableSection
                              items={demiplaneThreads.map(thread => thread.id)}
                              onReorder={(activeId, overId) => reorderDemiplaneThreads(plane.id, demiplane.id, activeId, overId)}
                            >
                            {demiplaneThreads.map(thread => (
                              <SortableItem
                                key={thread.id}
                                id={thread.id}
                                canDrag={demiplaneThreads.length > 1}
                                showHandle={false}
                                className={cn(
                                  'group relative flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[13px] leading-5 transition',
                                  thread.id === threadId ? 'border-primary bg-background text-foreground' : 'border-transparent text-foreground hover:bg-background/60',
                                )}
                              >
                                <button
                                  className="min-w-0 flex-1 text-left"
                                  onClick={() => {
                                    setThreadId(thread.id);
                                    if (closeOnSelect) onClose?.();
                                  }}
                                >
                                  <div className="flex items-center gap-2">
                                    {runningThreadIds.includes(thread.id) ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />}
                                    <span className="truncate text-[13px] font-normal leading-5">{thread.title}</span>
                                  </div>
                                  <div className="mt-1 truncate pl-5 text-xs text-muted-foreground">{formatThreadTimestamp(thread.updatedAt)}</div>
                                </button>
                                <div className="relative">
                                  <button
                                    className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
                                    aria-label={`Open menu for ${thread.title}`}
                                    onClick={event => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      setThreadMenuId(openId => (openId === thread.id ? null : thread.id));
                                    }}
                                  >
                                    <MoreHorizontal size={14} />
                                  </button>
                                  {threadMenuId === thread.id ? (
                                    <div className="absolute right-0 top-6 z-20 w-28 rounded-md border border-border bg-background p-1 text-xs shadow-lg" onPointerDown={event => event.stopPropagation()}>
                                      <button
                                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                        onClick={async event => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          setThreadMenuId(null);
                                          await archiveThread(thread.id);
                                          await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                                        }}
                                      >
                                        <Archive size={13} />
                                        Archive
                                      </button>
                                      <button
                                        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground transition hover:bg-muted hover:text-foreground"
                                        onClick={async event => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          setThreadMenuId(null);
                                          await deleteThread(thread.id);
                                          await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                                        }}
                                      >
                                        <Trash2 size={13} />
                                        Delete
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              </SortableItem>
                            ))}
                            </SortableSection>
                          </SortableItem>
                        );
                      })}
                        </SortableSection>
                      ) : null}
                      {planeThreads.length === 0 && plane.projectKind === 'standard' ? <div className="px-2 py-1 text-xs text-muted-foreground">No threads</div> : null}
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

      {archivedDialogScopeId ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg border border-border bg-background p-3 shadow-xl">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Archived Threads</h2>
                <p className="mt-1 truncate text-xs text-muted-foreground">{archivedDialogTitle}</p>
              </div>
              <button
                className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Close archived threads"
                onClick={() => setArchivedDialogScopeId(null)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="max-h-72 space-y-2 overflow-y-auto">
              {archivedDialogThreads.length === 0 ? (
                <div className="rounded-md border border-border/70 p-3 text-xs text-muted-foreground">No archived threads</div>
              ) : archivedDialogThreads.map(thread => (
                <div key={thread.id} className="flex items-center gap-2 rounded-md border border-border/70 p-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-foreground">{thread.title}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{formatThreadTimestamp(thread.updatedAt)}</div>
                  </div>
                  <button
                    className="flex h-7 items-center gap-1 rounded-full bg-primary px-2 text-xs text-primary-foreground transition hover:opacity-90"
                    onClick={async () => {
                      await restoreThread(thread.id);
                      await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                    }}
                  >
                    <RotateCcw size={13} />
                    Restore
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div ref={resourceMenuRef} className="relative mt-4">
        {isResourceMenuOpen ? (
          <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-border bg-background p-2 text-sm shadow-lg">
            <button
              className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-foreground transition hover:bg-muted"
              onClick={() => {
                toggleMode();
                setIsResourceMenuOpen(false);
              }}
            >
              {resolvedTheme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              <span>{resolvedTheme === 'dark' ? 'Switch to Catppuccin Latte' : 'Switch to Catppuccin Mocha'}</span>
            </button>
          </div>
        ) : null}
        <button
          className="w-full rounded-lg border border-border bg-background/60 p-3 text-left text-xs text-muted-foreground transition hover:bg-background"
          onClick={() => setIsResourceMenuOpen(open => !open)}
        >
          <div className="flex items-center justify-between gap-3 font-medium text-foreground">
            <div className="flex min-w-0 items-center gap-3">
              <div className="h-8 w-8 shrink-0 rounded-full bg-primary/20 text-center text-xs font-semibold leading-8 text-primary">
                U
              </div>
              <div className="min-w-0">
                <span className="block truncate">{displayName}</span>
                <span className="mt-1 flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                  <span className={cn('h-1.5 w-1.5 rounded-full', onlinePortalCount > 0 ? 'bg-success' : 'bg-muted-foreground')} />
                  {onlinePortalCount > 0 ? `${onlinePortalCount} Portal${onlinePortalCount === 1 ? '' : 's'} online` : 'No Portal'}
                </span>
              </div>
            </div>
            <ChevronUp size={14} className={cn('shrink-0 transition', isResourceMenuOpen ? 'rotate-180' : '')} />
          </div>
        </button>
      </div>
    </aside>
  );
};
