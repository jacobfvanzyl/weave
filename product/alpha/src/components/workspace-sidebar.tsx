import { useState } from 'react';
import type { AlphaController, AlphaThread, AlphaWorkspace } from '@/app/alpha-controller';
import { tabReferenceKey, workspaceReferenceKey, type WorkspaceTabReference } from '@/app/workspace-presentation';
import { AddProjectDialog } from './add-project-dialog';
import { CodexIcon } from './codex-icon';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from './ui/dropdown-menu';
import { Sidebar, SidebarHeader, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarMenu, SidebarMenuItem, SidebarMenuButton, SidebarMenuAction } from './ui/sidebar';

export function WorkspaceSidebar({ controller }: { controller: AlphaController }) {
  const { model, actions, workspaceActions } = controller;
  const state = model.workspaceCompositions!;
  const [adding, setAdding] = useState(false);
  const openFor = (workspace: AlphaWorkspace) => state.presentation.openTabs.filter((tab) =>
    (workspace.placements ?? [workspace]).some((placement) => placement.hostId === tab.hostId && placement.workspaceId === tab.workspaceId));
  const nameFor = (ref: WorkspaceTabReference) => state.compositions[workspaceReferenceKey(ref.hostId, ref.workspaceId)]?.tabs.find((tab) => tab.tabId === ref.tabId)?.name ?? 'Unavailable workspace';
  const matches = (workspace: AlphaWorkspace, thread?: AlphaThread) => !model.searchQuery || [workspace.name, workspace.canonicalPath, workspace.hostName, thread?.title].join(' ').toLocaleLowerCase().includes(model.searchQuery.toLocaleLowerCase());
  const threadRow = (workspace: AlphaWorkspace, thread: AlphaThread) => {
    const available = model.connections.some((connection) => connection.hostId === thread.hostId && connection.status === 'connected');
    return <SidebarMenuItem key={thread.id} data-thread-id={thread.id}>
      <SidebarMenuButton size='lg' isActive={thread.id === model.selectedThreadId} aria-label={`Agent ${thread.title}`} aria-pressed={thread.id === model.selectedThreadId} onClick={() => void actions.selectThread(thread.id)} disabled={!available || model.busy}>
        <CodexIcon />
        <span className='flex min-w-0 flex-1 flex-col gap-1'>
          <span className='truncate'>{thread.title}</span>
          <span className='truncate text-xs text-muted-foreground'>{thread.hostName} · {workspace.canonicalPath ?? workspace.name}{!available ? ' · unavailable' : thread.attention ? ` · ${Date.now() - Date.parse(thread.attention.observedAt) > 15000 ? 'stale' : thread.attention.state}` : ' · activity unavailable'}</span>
        </span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger render={<SidebarMenuAction aria-label={`Actions for ${thread.title}`} />}>⋯</DropdownMenuTrigger>
        <DropdownMenuContent><DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void workspaceActions?.open(workspace.id)}>Open workspace</DropdownMenuItem>
          {thread.supportsThreadLifecycle && <DropdownMenuItem disabled={!available || model.busy} onClick={() => void actions.archiveThread(thread.id)}>Archive</DropdownMenuItem>}
        </DropdownMenuGroup></DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>;
  };
  return <>
    <Sidebar position='inline' collapsible='offcanvas' className='w-(--sidebar-width) shrink-0'>
      <SidebarHeader className='border-b bg-title-bar'>
        <div className='flex items-center gap-2'>
          <span className='flex-1 text-sm font-medium'>Workspaces</span>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size='sm' variant='ghost' disabled={state.loading} />}>Open…</DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuGroup>
              {model.workspaces.map((workspace) => <DropdownMenuItem key={workspace.id} aria-label={`Open workspace in ${workspace.name}`} onClick={() => void workspaceActions?.open(workspace.id)}>{workspace.hostName} · {workspace.canonicalPath ?? workspace.name}</DropdownMenuItem>)}
              <DropdownMenuItem onClick={() => setAdding(true)}>Add directory…</DropdownMenuItem>
            </DropdownMenuGroup></DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size='sm' variant='ghost' aria-label='New agent thread' />}>Agent…</DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuGroup>
              {model.workspaces.map((workspace) => <DropdownMenuItem key={workspace.id} aria-label={`New thread in ${workspace.name}`} disabled={model.busy || !model.connections.some((connection) => connection.hostId === workspace.hostId && connection.status === 'connected')} onClick={() => void actions.createThread(workspace.id)}>{workspace.hostName} · {workspace.canonicalPath ?? workspace.name}</DropdownMenuItem>)}
            </DropdownMenuGroup></DropdownMenuContent>
          </DropdownMenu>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {model.workspaces.filter((workspace) => openFor(workspace).length > 0).map((workspace) => {
          const tabs = openFor(workspace);
          const active = tabs.some((tab) => tabReferenceKey(tab) === state.presentation.activeTab);
          const collapsed = state.presentation.collapsedContexts.includes(workspace.id);
          return <SidebarGroup key={workspace.id} data-context-id={workspace.id}>
            <SidebarMenu><SidebarMenuItem>
              <div className='flex items-center gap-1'>
                <Button variant='ghost' size='icon-sm' aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${workspace.name}`} aria-expanded={!collapsed} onClick={() => workspaceActions?.collapse(workspace.id)}>{collapsed ? '›' : '⌄'}</Button>
                <SidebarMenuButton size='lg' isActive={active} aria-pressed={active} aria-label={`Workspace ${workspace.hostName} ${workspace.canonicalPath ?? workspace.name}`} onClick={() => void workspaceActions?.open(workspace.id)}>
                  <span className='flex min-w-0 flex-col gap-1'><span className='truncate'>{workspace.name}</span><span className='truncate text-xs text-muted-foreground'>{workspace.hostName} · {workspace.canonicalPath ?? 'Path unavailable'}</span></span>
                </SidebarMenuButton>
                <DropdownMenu><DropdownMenuTrigger render={<Button size='icon-sm' variant='ghost' aria-label={`Workspace actions for ${workspace.name}`} />}>⋯</DropdownMenuTrigger>
                  <DropdownMenuContent><DropdownMenuGroup>
                    <DropdownMenuItem onClick={() => void workspaceActions?.open(workspace.id, true)}>New terminal workspace</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void actions.createThread(workspace.id)}>New agent thread</DropdownMenuItem>
                    {tabs.length === 1 && <DropdownMenuItem onClick={() => workspaceActions?.close(tabs[0]!)}>Close workspace view</DropdownMenuItem>}
                  </DropdownMenuGroup></DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SidebarMenuItem></SidebarMenu>
            {!collapsed && <SidebarMenu className='pl-4'>
              {workspace.threads.filter((thread) => matches(workspace, thread)).map((thread) => threadRow(workspace, thread))}
              {tabs.length > 1 && tabs.map((tab) => <SidebarMenuItem key={tabReferenceKey(tab)} data-workspace-tab={tab.tabId}>
                <SidebarMenuButton isActive={tabReferenceKey(tab) === state.presentation.activeTab} aria-pressed={tabReferenceKey(tab) === state.presentation.activeTab} onClick={() => workspaceActions?.activate(tab)}>{nameFor(tab)}</SidebarMenuButton>
                <SidebarMenuAction aria-label={`Close workspace view ${nameFor(tab)}`} onClick={() => workspaceActions?.close(tab)}>×</SidebarMenuAction>
              </SidebarMenuItem>)}
            </SidebarMenu>}
          </SidebarGroup>;
        })}
        <Separator />
        <SidebarGroup data-slot='unattached-agents'>
          <SidebarGroupLabel>Agents without an open workspace</SidebarGroupLabel>
          <SidebarMenu>{model.workspaces.filter((workspace) => openFor(workspace).length === 0).flatMap((workspace) => workspace.threads.filter((thread) => matches(workspace, thread)).map((thread) => threadRow(workspace, thread)))}</SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
    <AddProjectDialog controller={controller} open={adding} onOpenChange={setAdding} />
  </>;
}
