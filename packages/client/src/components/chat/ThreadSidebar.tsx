import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragStartEvent, type DraggableAttributes } from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ChevronUp, CircleDot, Code2, Folder, GripVertical, Link, Lock, MoreVertical, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { adoptDemiplane, createDemiplane, createPlane, deleteDemiplane, deletePlane, listPlanes, listPortals, reorderDemiplanes, reorderPlanes, reorderThreads, type CreatePlaneInput } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { GitPlaneDirectoryPicker } from './GitPlaneDirectoryPicker';
import { useChatStore } from '../../stores/chat-store';
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
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '../ui/dialog';
import { Empty, EmptyDescription } from '../ui/empty';
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '../ui/menu';
import { ScrollArea } from '../ui/scroll-area';

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

const demiplaneStatusClass = (status: string, isPortalConnected: boolean) => {
  if (!isPortalConnected) return 'bg-destructive';
  if (status === 'ready') return 'bg-success';
  if (status === 'creating') return 'bg-primary animate-pulse';
  if (status === 'dirty') return 'bg-yellow';
  return 'bg-destructive';
};

const getDemiplanePortalId = (plane: { portalId?: string }, demiplane: { portalId?: string }) => demiplane.portalId ?? plane.portalId;

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

type ThreadSidebarProps = {
  closeOnSelect?: boolean;
  onClose?: () => void;
};

export const ThreadSidebar = ({ closeOnSelect = true, onClose }: ThreadSidebarProps) => {
  const {
    resourceId,
    threadId,
    threads,
    newThread,
    setThreadId,
    archiveThread,
    restoreThread,
    deleteThread,
  } = useChatStore();
  const queryClient = useQueryClient();
  const openPlaneIdsBeforeDragRef = useRef<string[] | null>(null);
  const suppressSelectionUntilRef = useRef(0);
  const [archivedDialogScopeId, setArchivedDialogScopeId] = useState<string | null>(null);
  const [deletePlaneId, setDeletePlaneId] = useState<string | null>(null);
  const [isCreatePlaneDialogOpen, setIsCreatePlaneDialogOpen] = useState(false);
  const [isCreatingPlane, setIsCreatingPlane] = useState(false);
  const [createPlaneError, setCreatePlaneError] = useState<string | null>(null);
  const [collapsedPlaneIds, setCollapsedPlaneIds] = useState<string[]>(loadCollapsedPlaneIds);
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
  const onlinePortalCount = portals.filter(portal => portal.status === 'online').length;
  const onlinePortalIds = new Set(portals.filter(portal => portal.status === 'online').map(portal => portal.portalId));
  const plainThreads = sortManual(threads.filter(thread => (!thread.planeId || thread.adHoc) && thread.archived !== true));
  const threadsByPlane = new Map(planes.map(plane => [plane.id, sortManual(threads.filter(thread => thread.planeId === plane.id && !thread.adHoc))]));
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
  const suppressSelectionAfterDrag = () => {
    suppressSelectionUntilRef.current = Date.now() + 500;
  };
  const shouldSuppressSelection = () => Date.now() < suppressSelectionUntilRef.current;
  const selectThread = (nextThreadId: string) => {
    if (shouldSuppressSelection()) return;
    setThreadId(nextThreadId);
    if (closeOnSelect) onClose?.();
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
    ? threads.filter(thread => (!thread.planeId || thread.adHoc) && thread.archived)
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
  const deletePlaneTarget = deletePlaneId ? planes.find(plane => plane.id === deletePlaneId) : undefined;
  const renderThreadMenu = (thread: typeof threads[number]) => (
    <Menu>
      <MenuTrigger render={<Button className="shrink-0" size="icon-xs" variant="ghost" aria-label={`Open menu for ${thread.title}`} />}>
        <MoreVertical size={14} />
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
      data-weave-thread-sidebar
      className="fixed inset-y-0 left-0 z-40 flex w-full shrink-0 flex-col border-r border-border bg-muted p-4 md:static md:z-auto md:w-96 dark:bg-card"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto pr-1">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-wide text-muted-foreground">
            <div className="-ml-4 h-px flex-1 bg-border" />
            <span className="text-primary">Threads</span>
            <div className="h-px flex-1 bg-border" />
            <Button
              className="h-6 w-8"
              size="icon-xs"
              aria-label="Create Thread"
              onClick={async () => {
                await newThread();
                await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
                if (closeOnSelect) onClose?.();
              }}
            >
              <Plus size={14} strokeWidth={3} />
            </Button>
            <Button
              className="h-6 w-8 md:hidden"
              size="icon-xs"
              variant="ghost"
              aria-label="Close sidebar"
              onClick={onClose}
            >
              <X size={14} />
            </Button>

          </div>
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
              thread.id === threadId ? 'border-transparent bg-selected-thread' : 'hover:bg-background',
            )}
          >
            <SidebarItemButton
              className="min-w-0 flex-1 items-center text-left"
              onClick={() => selectThread(thread.id)}
            >
              <div className="flex min-w-0 items-center text-sm font-medium text-foreground">
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              </div>
            </SidebarItemButton>
            {renderThreadMenu(thread)}
          </SortableItem>
        ))}
        </SortableSection>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold tracking-wide text-muted-foreground">
            <div className="-ml-4 h-px flex-1 bg-border" />
            <span className="text-success">Planes</span>
            <div className="h-px flex-1 bg-border" />
            <Button
              className="h-6 w-8 border-success-button bg-success-button text-background hover:bg-success-button/90"
              size="icon-xs"
              aria-label="Create Plane"
              onClick={() => {
                setCreatePlaneError(null);
                setIsCreatePlaneDialogOpen(true);
              }}
            >
              <Plus size={14} strokeWidth={3} />
            </Button>

          </div>
          <SortableSection
            items={sortedPlanes.map(plane => plane.id)}
            onDragStart={() => {
              suppressSelectionAfterDrag();
              collapsePlanesForDrag();
            }}
            onDragEnd={() => {
              restorePlanesAfterDrag();
              suppressSelectionAfterDrag();
            }}
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
                className={cn('p-2', index > 0 && 'border-t border-border')}
              >
                {dragActivator => (
                <>
                <div
                  ref={dragActivator.ref}
                  className={cn('flex w-[calc(100%+0.5rem)] cursor-grab touch-none select-none items-center gap-2 text-sm font-bold text-mauve active:cursor-grabbing', !isCollapsed && 'mb-2')}
                  style={{ touchAction: 'none' }}
                  {...dragActivator.attributes}
                  {...dragActivator.listeners}
                >
                  <SidebarItemButton
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => {
                      if (shouldSuppressSelection()) return;
                      togglePlaneCollapsed(plane.id);
                    }}
                    aria-expanded={!isCollapsed}
                  >
                    <ChevronUp size={14} className={cn('shrink-0 text-success transition', isCollapsed ? 'rotate-180' : '')} />
                    {plane.projectKind === 'git' ? (
                      <Code2 size={14} className="shrink-0 text-success" aria-label="Code - Portal Plane" />
                    ) : (
                      <Folder size={14} className="shrink-0 text-success" aria-label="Standard Plane" />
                    )}
                    <span className="min-w-0 truncate">{plane.name}</span>
                  </SidebarItemButton>
                  {!isCollapsed ? (
                    <>
                      {plane.projectKind === 'standard' ? (
                        <Button
                          className="h-6 w-8 shrink-0"
                          size="icon-xs"
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
                        </Button>
                      ) : (
                        <Button
                          className="h-6 w-8 shrink-0 border-blue bg-blue text-background hover:bg-blue/90"
                          size="icon-xs"
                          aria-label={`Create workspace in ${plane.name}`}
                          onClick={async () => {
                            const name = window.prompt('Branch / workspace name');
                            if (!name?.trim()) return;
                            try {
                              await createDemiplane(plane.id, name.trim());
                              await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
                            } catch (error) {
                              window.alert(error instanceof Error ? error.message : String(error));
                            }
                          }}
                        >
                          <Plus size={14} strokeWidth={3} />
                        </Button>
                      )}
                      <Menu>
                        <MenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-success" aria-label={`${plane.name} menu`} />}>
                          <MoreVertical size={14} />
                        </MenuTrigger>
                        <MenuPopup align="end" sideOffset={4} className="w-44">
                          {plane.projectKind === 'git' ? (
                            <MenuItem
                              onClick={async () => {
                                const path = window.prompt('Existing worktree path');
                                if (!path?.trim()) return;
                                const name = window.prompt('Workspace display name (optional)') ?? undefined;
                                try {
                                  await adoptDemiplane(plane.id, path.trim(), name?.trim() || undefined);
                                  await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
                                } catch (error) {
                                  window.alert(error instanceof Error ? error.message : String(error));
                                }
                              }}
                            >
                              <Link size={13} />
                              Attach Workspace
                            </MenuItem>
                          ) : null}
                          <MenuItem onClick={() => setArchivedDialogScopeId(plane.id)}>
                            <Archive size={13} />
                            Archived Threads
                          </MenuItem>
                          <MenuItem variant="destructive" onClick={() => setDeletePlaneId(plane.id)}>
                            <Trash2 size={13} />
                            Delete Plane
                          </MenuItem>
                        </MenuPopup>
                      </Menu>
                    </>
                  ) : null}
                </div>
                {!isCollapsed ? (
                  <>
                    <div className="space-y-2">
                      {plane.projectKind === 'standard' ? (
                        <SortableSection
                          items={standardPlaneThreads.map(thread => thread.id)}
                          onDragStart={suppressSelectionAfterDrag}
                          onDragEnd={suppressSelectionAfterDrag}
                          onReorder={(activeId, overId) => reorderPlaneThreads(plane.id, activeId, overId)}
                        >
                        {standardPlaneThreads.map(thread => (
                        <SortableItem
                          key={thread.id}
                          id={thread.id}
                          canDrag={standardPlaneThreads.length > 1}
                          showHandle={false}
                          className={cn(
                            'group relative -ml-2 flex min-h-9 min-w-0 w-[calc(100%+1.25rem)] items-center gap-2 rounded-md border py-1 pl-2 pr-1 text-left transition-colors',
                            thread.id === threadId ? 'border-transparent bg-selected-thread text-foreground' : 'border-transparent text-foreground hover:bg-background',
                          )}
                        >
                          <SidebarItemButton
                            className="min-w-0 flex-1 items-center text-left"
                            onClick={() => selectThread(thread.id)}
                          >
                            <div className="flex min-w-0 items-center">
                              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{thread.title}</span>
                            </div>
                          </SidebarItemButton>
                          {renderThreadMenu(thread)}
                        </SortableItem>
                      ))}
                        </SortableSection>
                      ) : null}
                      {plane.projectKind === 'git' ? (
                        <SortableSection
                          items={sortedDemiplanes.map(demiplane => demiplane.id)}
                          onDragStart={suppressSelectionAfterDrag}
                          onDragEnd={suppressSelectionAfterDrag}
                          onReorder={async (activeId, overId) => {
                            const ordered = moveItem(sortedDemiplanes, activeId, overId);
                            await reorderDemiplanes(plane.id, ordered.map(item => item.id));
                            await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
                          }}
                        >
                        {sortedDemiplanes.map((demiplane, demiplaneIndex) => {
                        const demiplaneThreads = planeThreads.filter(thread => thread.demiplaneId === demiplane.id && thread.archived !== true);
                        const demiplanePortalId = getDemiplanePortalId(plane, demiplane);
                        const isDemiplanePortalConnected = Boolean(demiplanePortalId && onlinePortalIds.has(demiplanePortalId));
                        const demiplaneStatusLabel = isDemiplanePortalConnected ? demiplane.status : 'portal offline';

                        return (
                          <SortableItem
                            key={demiplane.id}
                            id={demiplane.id}
                            canDrag={sortedDemiplanes.length > 1}
                            showHandle={false}
                            className={cn('space-y-1 pt-2 pb-0', demiplaneIndex > 0 && 'border-t border-border')}
                          >
                            <div className="flex w-[calc(100%+0.5rem)] items-start justify-between gap-2 text-sm font-bold text-blue">
                              <div className="min-w-0 flex-1">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span className="truncate">{demiplane.name}</span>
                                  <span className={cn('h-2 w-2 shrink-0 rounded-full', demiplaneStatusClass(demiplane.status, isDemiplanePortalConnected))} title={demiplaneStatusLabel} aria-label={demiplaneStatusLabel} />
                                  {demiplane.locked || demiplane.workspaceKind === 'primary' ? <Lock size={11} className="shrink-0 text-muted-foreground" aria-label="Primary workspace" /> : null}
                                </div>
                                {demiplane.lastError ? <div className="truncate text-[10px] font-normal text-destructive">{demiplane.lastError}</div> : null}
                              </div>
                              <Button
                                className="h-6 w-8 shrink-0"
                                size="icon-xs"
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
                              </Button>
                              <Menu>
                                <MenuTrigger render={<Button size="icon-xs" variant="ghost" className="text-blue" aria-label={`${demiplane.name} menu`} />}>
                                  <MoreVertical size={14} />
                                </MenuTrigger>
                                <MenuPopup align="end" sideOffset={4} className="w-44">
                                  <MenuItem onClick={() => setArchivedDialogScopeId(demiplane.id)}>
                                    <Archive size={13} />
                                    Archived Threads
                                  </MenuItem>
                                  {!demiplane.locked && demiplane.workspaceKind !== 'primary' ? (
                                    <>
                                      <MenuItem
                                        onClick={async () => {
                                          if (!window.confirm(`Detach ${demiplane.name} from this Plane? Worktree files stay on disk.`)) return;
                                          try {
                                            await deleteDemiplane(plane.id, demiplane.id, 'detach');
                                            await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
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
                                          if (!window.confirm(`Remove worktree for ${demiplane.name}? This runs wt remove.`)) return;
                                          try {
                                            await deleteDemiplane(plane.id, demiplane.id, 'remove');
                                            await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
                                          } catch (error) {
                                            window.alert(error instanceof Error ? error.message : String(error));
                                          }
                                        }}
                                      >
                                        <Trash2 size={13} />
                                        Remove Worktree
                                      </MenuItem>
                                    </>
                                  ) : null}
                                </MenuPopup>
                              </Menu>
                            </div>
                            <SortableSection
                              items={demiplaneThreads.map(thread => thread.id)}
                              onDragStart={suppressSelectionAfterDrag}
                              onDragEnd={suppressSelectionAfterDrag}
                              onReorder={(activeId, overId) => reorderDemiplaneThreads(plane.id, demiplane.id, activeId, overId)}
                            >
                            {demiplaneThreads.map(thread => (
                              <SortableItem
                                key={thread.id}
                                id={thread.id}
                                canDrag={demiplaneThreads.length > 1}
                                showHandle={false}
                                className={cn(
                                  'group relative -ml-2 flex min-h-9 min-w-0 w-[calc(100%+1.25rem)] items-center gap-2 rounded-md border py-1 pl-2 pr-1 text-left transition-colors',
                                  thread.id === threadId ? 'border-transparent bg-selected-thread text-foreground' : 'border-transparent text-foreground hover:bg-background',
                                )}
                              >
                                <SidebarItemButton
                                  className="min-w-0 flex-1 items-center text-left"
                                  onClick={() => selectThread(thread.id)}
                                >
                                  <div className="flex min-w-0 items-center">
                                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{thread.title}</span>
                                  </div>
                                </SidebarItemButton>
                                {renderThreadMenu(thread)}
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

      {isCreatePlaneDialogOpen ? (
        <GitPlaneDirectoryPicker
          portals={portals.filter(portal => portal.status === 'online')}
          isCreating={isCreatingPlane}
          createError={createPlaneError}
          onCancel={() => {
            setIsCreatePlaneDialogOpen(false);
            setCreatePlaneError(null);
          }}
          onCreate={async (input: CreatePlaneInput) => {
            setIsCreatingPlane(true);
            setCreatePlaneError(null);
            try {
              await createPlane(input);
              setIsCreatePlaneDialogOpen(false);
              await queryClient.invalidateQueries({ queryKey: ['planes', resourceId] });
            } catch (error) {
              setCreatePlaneError(error instanceof Error ? error.message : String(error));
            } finally {
              setIsCreatingPlane(false);
            }
          }}
        />
      ) : null}

      <AlertDialog open={Boolean(deletePlaneTarget)} onOpenChange={open => {
        if (!open) setDeletePlaneId(null);
      }}>
        {deletePlaneTarget ? (
          <AlertDialogPopup className="max-w-sm">
            <AlertDialogHeader>
              <div className="flex items-start gap-3 text-left">
                <Trash2 className="mt-0.5 shrink-0 text-destructive" size={18} />
                <div className="min-w-0">
                  <AlertDialogTitle>Delete Plane?</AlertDialogTitle>
                  <AlertDialogDescription className="mt-1">
                    This will permanently delete <span className="font-medium text-foreground">{deletePlaneTarget.name}</span>, its workspaces, and all threads in it.
                  </AlertDialogDescription>
                </div>
              </div>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button
                variant="destructive"
                onClick={async () => {
                  await deletePlane(deletePlaneTarget.id);
                  setDeletePlaneId(null);
                  await Promise.all([
                    queryClient.invalidateQueries({ queryKey: ['planes', resourceId] }),
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

      <div className="mt-4 flex justify-end">
        <div
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground"
          title={`${onlinePortalCount} online Portal${onlinePortalCount === 1 ? '' : 's'}`}
          aria-label={`${onlinePortalCount} online Portal${onlinePortalCount === 1 ? '' : 's'}`}
        >
          <CircleDot size={15} className={cn('shrink-0', onlinePortalCount > 0 ? 'text-success' : 'text-muted-foreground')} />
          <span className="tabular-nums">{onlinePortalCount}</span>
        </div>
      </div>
    </aside>
  );
};
