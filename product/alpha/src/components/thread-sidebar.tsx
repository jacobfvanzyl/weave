import { useMemo } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, ArrowRight01Icon, Folder01Icon, Search01Icon, Settings01Icon } from '@hugeicons/core-free-icons';
import type { AlphaController, AlphaThread } from '@/app/alpha-controller';
import { CodexIcon } from '@/components/codex-icon';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
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
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

const isCapacitorPlatform = (platform: string) =>
  platform === 'ios' || platform === 'android';

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
        size='lg'
        isActive={selected}
        disabled={busy}
        tooltip={thread.title}
        className='h-auto min-h-12 items-start py-2'
        onClick={onSelect}
      >
        <CodexIcon />
        <span className='flex min-w-0 flex-1 flex-col gap-1'>
          <span className='flex min-w-0 items-center gap-2'>
            <span className='truncate font-medium text-sidebar-foreground'>
              {thread.title}
            </span>
            <span className='ml-auto shrink-0 text-[0.6875rem] text-muted-foreground'>
              {updatedLabel(thread.updatedAt)}
            </span>
          </span>
          <span className='text-[0.6875rem] text-muted-foreground'>
            <span className='truncate'>{thread.hostName}</span>
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function ThreadSidebar({ controller }: { controller: AlphaController }) {
  const { model, actions } = controller;
  const { setOpenMobile } = useSidebar();
  const capacitorPlatform = isCapacitorPlatform(model.platform);
  const query = model.searchQuery.trim().toLocaleLowerCase();
  const workspaces = useMemo(() =>
    model.workspaces.map((workspace) => ({
      ...workspace,
      threads: workspace.threads.filter((thread) =>
        !query ||
        thread.title.toLocaleLowerCase().includes(query) ||
        thread.hostName.toLocaleLowerCase().includes(query) ||
        workspace.name.toLocaleLowerCase().includes(query)
      ),
    })).filter((workspace) => !query || workspace.threads.length > 0), [model.workspaces, query]);

  return (
    <Sidebar collapsible='offcanvas' position='inline'>
      <SidebarHeader className='h-11 shrink-0 justify-center gap-0 border-b border-sidebar-border bg-title-bar px-2 py-0'>
        <div className='relative [&_svg]:size-3.5'>
          <HugeiconsIcon
            icon={Search01Icon}
            strokeWidth={2}
            className='pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-icon-muted'
          />
          <SidebarInput
            type='search'
            aria-label='Search threads'
            placeholder='Search threads…'
            value={model.searchQuery}
            className='pl-7'
            onChange={(event) => actions.setSearchQuery(event.target.value)}
          />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {workspaces.map((workspace) => (
          <Collapsible key={workspace.id} defaultOpen className='group/workspace'>
            <SidebarGroup className='py-1'>
              <SidebarGroupLabel
                render={<CollapsibleTrigger />}
                className='gap-1.5 pr-7'
              >
                <HugeiconsIcon
                  icon={Folder01Icon}
                  strokeWidth={2}
                  className='mr-0.5 shrink-0'
                />
                <span className='truncate'>{workspace.name}</span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className='shrink-0 transition-transform group-data-open/workspace:rotate-90'
                />
              </SidebarGroupLabel>
              <SidebarGroupAction
                className='top-3 right-2.5 w-6'
                title={`New thread in ${workspace.name}`}
                disabled={model.busy}
                onClick={() => void actions.createThread(workspace.id)}
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                <span className='sr-only'>New thread in {workspace.name}</span>
              </SidebarGroupAction>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {workspace.threads.map((thread) => (
                      <ThreadMenuItem
                        key={thread.id}
                        thread={thread}
                        selected={thread.id === model.selectedThreadId}
                        busy={model.busy}
                        onSelect={() => {
                          setOpenMobile(false);
                          void actions.selectThread(thread.id);
                        }}
                      />
                    ))}
                    {!workspace.threads.length && (
                      <li>
                        <Empty className='gap-1 p-3'>
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
        ))}
        {!workspaces.length && (
          <Empty className='gap-1 p-4'>
            <EmptyHeader>
              <EmptyTitle>No matching threads</EmptyTitle>
              <EmptyDescription>Try a different search.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SidebarContent>

      <SidebarFooter
        className={cn(
          'h-[var(--bottom-rail-height)] shrink-0 justify-start gap-0 border-t border-sidebar-border bg-status-bar py-0 pr-1',
          capacitorPlatform ? 'pl-7' : 'pl-1',
        )}
      >
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size='sm'
              type='button'
              aria-label='Settings'
              tooltip='Settings'
              className='w-fit'
              onClick={() => undefined}
            >
              <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
