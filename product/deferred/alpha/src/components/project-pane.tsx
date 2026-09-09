import { type ReactNode, useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiFile01Icon,
  ArrowRight01Icon,
  Folder01Icon,
  FolderTreeIcon,
} from '@hugeicons/core-free-icons';
import type { AlphaWorkspaceFiles } from '@/app/alpha-controller';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { ProjectPaneToggle } from '@/components/project-pane-toggle';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

type ProjectTreeEntryProps = {
  entry: AlphaWorkspaceFiles['directories'][string]['entries'][number];
  files: AlphaWorkspaceFiles;
  nested?: boolean;
  expandedDirectories: Set<string>;
  busy: boolean;
  onDirectoryOpenChange(path: string, open: boolean): void;
  onOpenFile(path: string): void;
};

function ProjectTreeEntry({
  entry,
  files,
  nested = false,
  expandedDirectories,
  busy,
  onDirectoryOpenChange,
  onOpenFile,
}: ProjectTreeEntryProps) {
  const directory = entry.type === 'directory';
  const expanded = directory && expandedDirectories.has(entry.path);
  const listing = directory ? files.directories[entry.path] : undefined;
  const content = directory
    ? (
      <Collapsible
        open={expanded}
        onOpenChange={(open) => onDirectoryOpenChange(entry.path, open)}
      >
        <CollapsibleTrigger
          render={<SidebarMenuButton type='button' size='sm' disabled={busy} />}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} directory ${entry.name}`}
        >
          <HugeiconsIcon
            data-icon='inline-start'
            icon={ArrowRight01Icon}
            strokeWidth={2}
            className={cn('transition-transform', expanded && 'rotate-90')}
          />
          <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.75} className='text-icon-muted' />
          <span>{entry.name}</span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub data-indent-indicator='true'>
            {listing
              ? listing.entries.map((child) => (
                <ProjectTreeEntry
                  key={child.path}
                  entry={child}
                  files={files}
                  nested
                  expandedDirectories={expandedDirectories}
                  busy={busy}
                  onDirectoryOpenChange={onDirectoryOpenChange}
                  onOpenFile={onOpenFile}
                />
              ))
              : (
                <SidebarMenuSubItem>
                  {busy
                    ? <SidebarMenuSkeleton showIcon />
                    : <span className='block px-2 py-1 text-xs text-muted-foreground'>Directory unavailable</span>}
                </SidebarMenuSubItem>
              )}
            {listing && !listing.entries.length && (
              <SidebarMenuSubItem>
                <span className='block px-2 py-1 text-xs text-muted-foreground'>Empty directory</span>
              </SidebarMenuSubItem>
            )}
            {listing?.truncated && (
              <SidebarMenuSubItem>
                <span className='block px-2 py-1 text-xs text-muted-foreground'>More entries available</span>
              </SidebarMenuSubItem>
            )}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    )
    : (
      <SidebarMenuButton
        type='button'
        size='sm'
        isActive={files.activeFilePath === entry.path}
        disabled={busy || entry.type === 'other'}
        aria-label={`Open file ${entry.name}`}
        onClick={() => onOpenFile(entry.path)}
      >
        <HugeiconsIcon icon={AiFile01Icon} strokeWidth={1.75} className='text-icon-muted' />
        <span>{entry.name}</span>
      </SidebarMenuButton>
    );

  return nested
    ? <SidebarMenuSubItem>{content}</SidebarMenuSubItem>
    : <SidebarMenuItem>{content}</SidebarMenuItem>;
}

export function ProjectPane({
  files,
  hasActiveThread = true,
  reconnecting = false,
  capacitorPlatform = false,
  busy,
  footerActions,
  showFooter = true,
  forceVisible = false,
  onOpenDirectory,
  onOpenFile,
}: {
  files?: AlphaWorkspaceFiles;
  hasActiveThread?: boolean;
  reconnecting?: boolean;
  capacitorPlatform?: boolean;
  busy: boolean;
  footerActions?: ReactNode;
  showFooter?: boolean;
  forceVisible?: boolean;
  onOpenDirectory(path: string): Promise<void> | void;
  onOpenFile(path: string): void;
}) {
  const { isMobile, openMobile, state, toggleSidebar } = useSidebar();
  const visible = forceVisible || (isMobile ? openMobile : state === 'expanded');
  const projectRootName = files?.workspaceRootName || files?.workspaceName;
  const loading = reconnecting || (hasActiveThread && busy && !files);
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());

  useEffect(() => setExpandedDirectories(new Set()), [files?.workspaceId]);

  const setDirectoryOpen = (path: string, open: boolean) => {
    setExpandedDirectories((current) => {
      const next = new Set(current);
      if (open) next.add(path);
      else next.delete(path);
      return next;
    });
    if (open && !files?.directories[path]) void onOpenDirectory(path);
  };

  const openFile = (path: string) => {
    onOpenFile(path);
    if (isMobile) toggleSidebar();
  };

  if (!visible) return null;

  return (
    <Sidebar
      side='right'
      collapsible={forceVisible ? 'none' : 'offcanvas'}
      position='inline'
      aria-label={files ? `${projectRootName} Project Pane` : 'Project Pane'}
      data-slot='project-pane'
      className='border-l-0'
      aria-busy={loading}
    >
      <SidebarHeader
        data-slot='project-top-rail'
        className='h-11 shrink-0 justify-center gap-0 border-b border-l border-sidebar-border bg-title-bar px-2 py-0'
      >
        <div className='flex min-w-0 items-center'>
          {loading
            ? <SidebarMenuSkeleton className='h-6 flex-1 px-1' />
            : (
              <span className='min-w-0 flex-1 truncate text-xs font-medium'>
                {projectRootName || 'Project'}
              </span>
            )}
        </div>
      </SidebarHeader>

      <SidebarContent className='border-l border-sidebar-border'>
        {loading
          ? (
            <SidebarGroup data-slot='loading-project-pane' aria-label='Loading project'>
              <SidebarGroupContent className='space-y-1'>
                <SidebarMenuSkeleton showIcon />
                <SidebarMenuSkeleton showIcon />
                <SidebarMenuSkeleton showIcon />
                <SidebarMenuSkeleton showIcon />
                <SidebarMenuSkeleton showIcon />
              </SidebarGroupContent>
            </SidebarGroup>
          )
          : files
          ? (
            <>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {files.directories['']?.entries.map((entry) => (
                      <ProjectTreeEntry
                        key={entry.path}
                        entry={entry}
                        files={files}
                        expandedDirectories={expandedDirectories}
                        busy={busy}
                        onDirectoryOpenChange={setDirectoryOpen}
                        onOpenFile={openFile}
                      />
                    ))}
                  </SidebarMenu>
                  {!files.directories['']?.entries.length && (
                    <Empty className='gap-1 p-3'>
                      <EmptyHeader>
                        <EmptyTitle>Empty directory</EmptyTitle>
                        <EmptyDescription>This directory has no entries.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                  {files.directories['']?.truncated && (
                    <Alert className='mt-2'>
                      <AlertTitle>More entries available</AlertTitle>
                      <AlertDescription>The Host limited this directory listing.</AlertDescription>
                    </Alert>
                  )}
                </SidebarGroupContent>
              </SidebarGroup>

            </>
          )
          : (
            <Empty className='gap-2 p-4'>
              <EmptyHeader>
                <EmptyMedia variant='icon'>
                  <HugeiconsIcon icon={FolderTreeIcon} strokeWidth={1.75} />
                </EmptyMedia>
                <EmptyTitle>
                  {hasActiveThread ? busy ? 'Loading directory' : 'Directory unavailable' : 'No active thread'}
                </EmptyTitle>
                <EmptyDescription>
                  {hasActiveThread
                    ? 'The active Thread directory will appear here when the Host makes it available.'
                    : 'Select a Thread to browse its Workspace directory.'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
      </SidebarContent>

      {showFooter && (
        <SidebarFooter className='h-[var(--bottom-rail-height)] shrink-0 justify-center gap-0 border-t border-sidebar-border bg-status-bar p-0'>
          <div className='flex justify-end px-1'>
            {footerActions ?? (
              <ProjectPaneToggle
                action='Hide'
                capacitorInset={capacitorPlatform}
                onClick={toggleSidebar}
              />
            )}
          </div>
        </SidebarFooter>
      )}
    </Sidebar>
  );
}
