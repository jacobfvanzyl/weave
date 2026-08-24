import { useMemo } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ArrowRight01Icon,
  Folder01Icon,
  Search01Icon,
  Settings01Icon,
} from '@hugeicons/core-free-icons';
import type { AlphaController, AlphaThread } from '@/app/alpha-controller';
import { CodexIcon } from '@/components/codex-icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';

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
  onSelect,
}: {
  thread: AlphaThread;
  selected: boolean;
  busy: boolean;
  onSelect(): void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={selected}
        disabled={busy}
        tooltip={thread.title}
        className="h-auto min-h-12 items-start py-2"
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
          <span className="text-[0.6875rem] text-muted-foreground">
            <span className="truncate">{thread.hostName}</span>
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ThreadSidebar({ controller }: { controller: AlphaController }) {
  const { model, actions } = controller;
  const query = model.searchQuery.trim().toLocaleLowerCase();
  const projects = useMemo(() => model.projects.map((project) => ({
    ...project,
    threads: project.threads.filter((thread) =>
      !query
      || thread.title.toLocaleLowerCase().includes(query)
      || thread.hostName.toLocaleLowerCase().includes(query)
      || project.name.toLocaleLowerCase().includes(query),
    ),
  })).filter((project) => !query || project.threads.length > 0), [model.projects, query]);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="h-11 shrink-0 justify-center gap-0 border-b border-sidebar-border bg-title-bar px-2 py-0">
        <div className="relative [&_svg]:size-3.5">
          <HugeiconsIcon
            icon={Search01Icon}
            strokeWidth={2}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-icon-muted"
          />
          <SidebarInput
            type="search"
            aria-label="Search threads"
            placeholder="Search threads…"
            value={model.searchQuery}
            className="pl-7"
            onChange={(event) => actions.setSearchQuery(event.target.value)}
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {projects.map((project) => (
          <Collapsible key={project.id} defaultOpen className="group/project">
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
                <span className="truncate">{project.name}</span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="shrink-0 transition-transform group-data-open/project:rotate-90"
                />
              </SidebarGroupLabel>
              <SidebarGroupAction
                title={`New thread in ${project.name}`}
                disabled={model.busy}
                onClick={() => void actions.createThread(project.id)}
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                <span className="sr-only">New thread in {project.name}</span>
              </SidebarGroupAction>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {project.threads.map((thread) => (
                      <ThreadMenuItem
                        key={thread.id}
                        thread={thread}
                        selected={thread.id === model.selectedThreadId}
                        busy={model.busy}
                        onSelect={() => void actions.selectThread(thread.id)}
                      />
                    ))}
                    {!project.threads.length && (
                      <li>
                        <Empty className="gap-1 p-3">
                          <EmptyHeader>
                            <EmptyTitle>No threads yet</EmptyTitle>
                            <EmptyDescription>
                              Create the first thread in this project.
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
        ))}
        {!projects.length && (
          <Empty className="gap-1 p-4">
            <EmptyHeader>
              <EmptyTitle>No matching threads</EmptyTitle>
              <EmptyDescription>Try a different search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SidebarContent>

      <SidebarFooter className="h-[var(--bottom-rail-height)] shrink-0 justify-center gap-0 border-t border-sidebar-border bg-status-bar px-1 py-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              type="button"
              aria-label="Settings"
              tooltip="Settings"
              className="w-fit"
              onClick={() => undefined}
            >
              <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
