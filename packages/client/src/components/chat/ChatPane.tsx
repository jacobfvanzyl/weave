import type { RefObject, ReactNode } from 'react';
import { Maximize2, MessageSquare, Minimize2, Settings, X } from 'lucide-react';
import { useChatStore, type ChatThread, type ThreadPlan } from '../../stores/chat-store';
import { useWorkspaceSurfaceStore } from '../../stores/workspace-surface-store';
import { Button } from '../ui/button';
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from '../ui/menu';
import { AssistantChat } from './AssistantChat';
import { PlanSidebar } from './PlanSidebar';

type ChatPaneProps = {
  activePlan?: ThreadPlan;
  activeThreadId: string;
  canFollowWrites: boolean;
  isMaximized: boolean;
  runningThreadIds: string[];
  showPlanPanel: boolean;
  surfaceRef: RefObject<HTMLDivElement | null>;
  terminalSlot?: ReactNode;
  threads: ChatThread[];
  onClose: () => void;
  onMaximizeToggle: () => void;
};

export const ChatPane = ({
  activePlan,
  activeThreadId,
  canFollowWrites,
  isMaximized,
  runningThreadIds,
  showPlanPanel,
  surfaceRef,
  terminalSlot,
  threads,
  onClose,
  onMaximizeToggle,
}: ChatPaneProps) => {
  const showToolCalls = useChatStore(state => state.showToolCalls);
  const setShowToolCalls = useChatStore(state => state.setShowToolCalls);
  const showReasoning = useChatStore(state => state.showReasoning);
  const setShowReasoning = useChatStore(state => state.setShowReasoning);
  const requestEditorFollow = useWorkspaceSurfaceStore(state => state.requestEditorFollow);
  const activeThreadWorkspaceId = threads.find(thread => thread.id === activeThreadId)?.workspaceId;
  const handleOpenPlan = activeThreadWorkspaceId
    ? (path: string) => requestEditorFollow({
        threadId: activeThreadId,
        workspaceId: activeThreadWorkspaceId,
        path,
        line: 1,
        toolCallId: 'plan-artifact',
      })
    : undefined;

  return (
    <div
      key="chat"
      className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden"
      data-weave-main-pane="chat"
      data-maximized={isMaximized ? 'true' : 'false'}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <MessageSquare size={15} className="shrink-0 text-primary" />
        <div className="min-w-0 flex-1" />
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost" aria-label="Chat settings" title="Chat settings" />}
          >
            <Settings size={14} />
          </MenuTrigger>
          <MenuPopup align="end" sideOffset={8} className="w-56">
            <MenuCheckboxItem
              checked={showToolCalls}
              variant="switch"
              onCheckedChange={checked => setShowToolCalls(checked)}
            >
              Show tool calls
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={showReasoning}
              variant="switch"
              onCheckedChange={checked => setShowReasoning(checked)}
            >
              Show reasoning
            </MenuCheckboxItem>
          </MenuPopup>
        </Menu>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={isMaximized ? 'Restore chat pane' : 'Maximize chat pane'}
          title={isMaximized ? 'Restore chat pane' : 'Maximize chat pane'}
          onClick={onMaximizeToggle}
        >
          {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close chat pane"
          title="Close chat pane"
          onClick={onClose}
        >
          <X size={14} />
        </Button>
      </div>
      <div
        ref={surfaceRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        data-weave-chat-pane
        data-weave-surface="chat"
      >
        {threads
          .filter(thread => thread.id === activeThreadId || runningThreadIds.includes(thread.id))
          .map(thread => (
            <div
              key={thread.id}
              className={thread.id === activeThreadId ? 'absolute inset-0' : 'absolute inset-0 hidden'}
              data-weave-active-thread={thread.id === activeThreadId ? 'true' : 'false'}
            >
              <AssistantChat canFollowWrites={thread.id === activeThreadId && canFollowWrites} threadId={thread.id} />
            </div>
          ))}
        {showPlanPanel ? <PlanSidebar plan={activePlan} onOpenPlan={handleOpenPlan} /> : null}
      </div>
      {terminalSlot}
    </div>
  );
};
