import { useEffect, useMemo, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Archive02Icon,
  ArrowRight01Icon,
  Folder01Icon,
  MoreHorizontalIcon,
  Search01Icon,
  Settings01Icon,
} from "@hugeicons/core-free-icons";
import type { AlphaController, AlphaThread } from "@/app/alpha-controller";
import { AddProjectDialog } from "@/components/add-project-dialog";
import { CodexIcon } from "@/components/codex-icon";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { isCapacitorPlatform } from "@/lib/platform";

const updatedLabel = (value: string) => {
  const elapsedMinutes = Math.max(
    1,
    Math.floor((Date.now() - new Date(value).getTime()) / 60_000),
  );
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const hours = Math.floor(elapsedMinutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

function ThreadMenuItem({
  thread,
  selected,
  busy,
  showHostIdentity,
  onSelect,
  onArchive,
}: {
  thread: AlphaThread;
  selected: boolean;
  busy: boolean;
  showHostIdentity: boolean;
  onSelect(): void;
  onArchive(): void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={selected}
        disabled={busy}
        tooltip={thread.title}
        className="h-auto min-h-12 items-start py-2 pr-8"
        onClick={onSelect}
      >
        <CodexIcon />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium text-sidebar-foreground">
              {thread.title}
            </span>
            <span className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground">
              {updatedLabel(thread.updatedAt)}
            </span>
          </span>
          {showHostIdentity && (
            <span className="text-[0.6875rem] text-muted-foreground">
              <span className="truncate">{thread.hostName}</span>
            </span>
          )}
        </span>
      </SidebarMenuButton>
      {thread.supportsThreadLifecycle && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuAction
                showOnHover
                aria-label={`Actions for ${thread.title}`}
                disabled={busy}
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onArchive}>
                <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} />
                Archive
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </SidebarMenuItem>
  );
}

export function ThreadSidebar({ controller }: { controller: AlphaController }) {
  const { model, actions } = controller;
  const { setOpenMobile } = useSidebar();
  const capacitorPlatform = isCapacitorPlatform(model.platform);
  const query = model.searchQuery.trim().toLocaleLowerCase();
  const reconnectingHostIds = new Set(
    model.connections
      .filter(({ status }) => status === "reconnecting")
      .map(({ hostId }) => hostId),
  );
  const connectedHostIds = new Set(
    model.connections
      .filter(({ status }) => status === "connected")
      .map(({ hostId }) => hostId),
  );
  const selectedThreadIsDraft = model.workspaces.some(({ threads }) =>
    threads.some(
      ({ draft, id }) => draft && id === model.selectedThreadId,
    )
  );
  const threadSelectionBusy = model.busy && (
    !selectedThreadIsDraft || Boolean(model.creatingThreadWorkspaceId)
  );
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState(
    Boolean(model.searchQuery),
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (model.searchQuery) setSearchExpanded(true);
  }, [model.searchQuery]);
  useEffect(() => {
    if (searchExpanded) searchInputRef.current?.focus();
  }, [searchExpanded]);
  const workspaces = useMemo(
    () =>
      model.workspaces
        .map((workspace) => ({
          ...workspace,
          threads: workspace.threads.filter(
            (thread) =>
              !query ||
              thread.title.toLocaleLowerCase().includes(query) ||
              thread.hostName.toLocaleLowerCase().includes(query) ||
              workspace.name.toLocaleLowerCase().includes(query),
          ),
        }))
        .filter((workspace) => !query || workspace.threads.length > 0),
    [model.workspaces, query],
  );

  return (
    <Sidebar collapsible="offcanvas" position="inline">
      <SidebarHeader
        className="h-11 shrink-0 flex-row items-center gap-1 border-b border-sidebar-border bg-title-bar px-2.5 py-0"
        data-slot="sidebar-top-rail"
      >
        <div
          className={cn(
            "relative min-w-0 transition-[width,flex-grow] duration-200 ease-out [&_svg]:size-3.5",
            searchExpanded ? "flex-1" : "w-7 shrink-0",
          )}
          data-slot="thread-search"
        >
          {searchExpanded
            ? (
              <>
                <HugeiconsIcon
                  icon={Search01Icon}
                  strokeWidth={2}
                  className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-icon-muted"
                />
                <SidebarInput
                  ref={searchInputRef}
                  type="search"
                  aria-label="Search threads"
                  placeholder="Search threads…"
                  value={model.searchQuery}
                  className="pl-7"
                  onBlur={() => {
                    if (!model.searchQuery) setSearchExpanded(false);
                  }}
                  onChange={(event) =>
                    actions.setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    actions.setSearchQuery("");
                    setSearchExpanded(false);
                  }}
                />
              </>
            )
            : (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Search threads"
                title="Search threads"
                className="size-7"
                onClick={() => setSearchExpanded(true)}
              >
                <HugeiconsIcon
                  data-icon="inline-start"
                  icon={Search01Icon}
                  strokeWidth={2}
                />
              </Button>
            )}
        </div>
        <SidebarGroupAction
          type="button"
          aria-label="Add Project"
          title="Add Project"
          className="static ml-auto w-6 shrink-0"
          onClick={() => setAddProjectOpen(true)}
        >
          <HugeiconsIcon
            data-icon="inline-start"
            icon={Add01Icon}
            strokeWidth={2}
          />
        </SidebarGroupAction>
      </SidebarHeader>

      <SidebarContent>
        {workspaces.map((workspace) => {
          const creatingThread =
            model.creatingThreadWorkspaceId === workspace.id;
          const selectedDraft = workspace.threads.some(
            ({ draft, id }) => draft && id === model.selectedThreadId,
          );
          return (
          <Collapsible
            key={workspace.id}
            defaultOpen
            className="group/workspace"
          >
            <SidebarGroup className="py-1">
              <SidebarGroupLabel
                render={<CollapsibleTrigger />}
                className="gap-1.5 pr-7"
              >
                <HugeiconsIcon
                  icon={Folder01Icon}
                  strokeWidth={2}
                  className="mr-0.5 shrink-0"
                />
                <span className="truncate">{workspace.name}</span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="shrink-0 transition-transform group-data-open/workspace:rotate-90"
                />
              </SidebarGroupLabel>
              <SidebarGroupAction
                className="top-3 right-2.5 w-6"
                title={creatingThread
                  ? `Creating thread in ${workspace.name}`
                  : `New thread in ${workspace.name}`}
                aria-label={creatingThread
                  ? `Creating thread in ${workspace.name}`
                  : `New thread in ${workspace.name}`}
                aria-busy={creatingThread}
                disabled={
                  (!selectedDraft && model.busy) ||
                  Boolean(model.creatingThreadWorkspaceId) ||
                  !(workspace.placements ?? [workspace]).some(
                    ({ hostId }) => connectedHostIds.has(hostId),
                  )
                }
                onClick={() => void actions.createThread(workspace.id)}
              >
                {creatingThread
                  ? <Spinner aria-hidden="true" />
                  : <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />}
              </SidebarGroupAction>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {workspace.threads.map((thread) =>
                      reconnectingHostIds.has(thread.hostId)
                        ? (
                          <SidebarMenuItem key={thread.id}>
                            <SidebarMenuSkeleton
                              showIcon
                              className="h-12"
                              aria-label={`Reconnecting ${thread.hostName} thread`}
                              data-slot="reconnecting-thread"
                            />
                          </SidebarMenuItem>
                        )
                        : (
                          <ThreadMenuItem
                            key={thread.id}
                            thread={thread}
                            selected={thread.id === model.selectedThreadId}
                            busy={threadSelectionBusy}
                            showHostIdentity={model.showHostIdentity}
                            onSelect={() => {
                              setOpenMobile(false);
                              void actions.selectThread(thread.id);
                            }}
                            onArchive={() =>
                              void actions.archiveThread(thread.id)}
                          />
                        )
                    )}
                    {!workspace.threads.length && (
                      <li>
                        <Empty className="gap-1 p-3">
                          <EmptyHeader>
                            <EmptyTitle>No threads yet</EmptyTitle>
                            <EmptyDescription>
                              Create the first thread in this workspace.
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      </li>
                    )}
                  </SidebarMenu>
                </SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
          );
        })}
        {!workspaces.length && (
          <Empty className="gap-1 p-4">
            <EmptyHeader>
              <EmptyTitle>No matching threads</EmptyTitle>
              <EmptyDescription>Try a different search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SidebarContent>

      <SidebarFooter
        className={cn(
          "h-[var(--bottom-rail-height)] shrink-0 justify-start gap-0 border-t border-sidebar-border bg-status-bar py-0 pr-1",
          capacitorPlatform ? "pl-7" : "pl-1",
        )}
      >
        <SidebarMenu className="flex-row">
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              type="button"
              aria-label="Archived Threads"
              tooltip="Archived Threads"
              className="w-fit"
              onClick={actions.openArchivedThreads}
            >
              <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} />
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              type="button"
              aria-label="Settings"
              tooltip="Settings"
              className="w-fit"
              onClick={actions.openConnections}
            >
              <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <AddProjectDialog
        controller={controller}
        open={addProjectOpen}
        onOpenChange={setAddProjectOpen}
      />
    </Sidebar>
  );
}
