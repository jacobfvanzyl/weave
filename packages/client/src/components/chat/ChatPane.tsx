import { useEffect, useRef, type ReactNode } from 'react';
import { Maximize2, MessageSquare, Minimize2, Settings, X } from 'lucide-react';
import { useChatStore, type ChatThread } from '../../stores/chat-store';
import { PaneContentHost, type PaneHostIdentity, type PaneHostLifecycle } from '../panes/PaneContentHost';
import { Button } from '../ui/button';
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from '../ui/menu';
import { AssistantChat } from './AssistantChat';

type ChatPaneProps = {
  activeThreadId: string;
  breadcrumb?: ReactNode;
  isMaximized: boolean;
  lifecycle: PaneHostLifecycle;
  runningThreadIds: string[];
  terminalSlot?: ReactNode;
  threads: ChatThread[];
  onMaximizeToggle: () => void;
};

const ChatPaneContent = ({
  activeThreadId,
  breadcrumb,
  isMaximized,
  lifecycle,
  runningThreadIds,
  terminalSlot,
  threads,
  onMaximizeToggle,
}: ChatPaneProps) => {
  const showToolCalls = useChatStore(state => state.showToolCalls);
  const setShowToolCalls = useChatStore(state => state.setShowToolCalls);
  const showReasoning = useChatStore(state => state.showReasoning);
  const setShowReasoning = useChatStore(state => state.setShowReasoning);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (lifecycle.focusRequest === 0) return undefined;
    const animationFrame = window.requestAnimationFrame(() => {
      surfaceRef.current
        ?.querySelector<HTMLTextAreaElement>('[data-weave-active-thread="true"] textarea:not([disabled])')
        ?.focus();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [lifecycle.focusRequest]);

  return (
    <>
      <div className="relative flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <MessageSquare size={15} className="relative z-10 shrink-0 text-muted-foreground" />
        {breadcrumb ? (
          <div
            className="pointer-events-none absolute inset-y-0 left-1/2 flex min-w-0 -translate-x-1/2 items-center justify-center"
            style={{ maxWidth: 'min(60%, calc(100% - 9rem))' }}
          >
            {breadcrumb}
          </div>
        ) : null}
        <div className="min-w-0 flex-1" />
        <Menu>
          <MenuTrigger
            render={<Button className="relative z-10" size="icon-xs" variant="ghost" aria-label="Chat settings" title="Chat settings" />}
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
          className="relative z-10"
          size="icon-xs"
          variant="ghost"
          aria-label={isMaximized ? 'Restore chat pane' : 'Maximize chat pane'}
          title={isMaximized ? 'Restore chat pane' : 'Maximize chat pane'}
          data-weave-chat-pane-window-action
          onClick={onMaximizeToggle}
        >
          {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
        <Button
          className="relative z-10"
          size="icon-xs"
          variant="ghost"
          aria-label="Close chat pane"
          title="Close chat pane"
          data-weave-chat-pane-window-action
          onClick={lifecycle.onClose}
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
              <AssistantChat threadId={thread.id} />
            </div>
          ))}
      </div>
      {terminalSlot}
    </>
  );
};

type ChatPaneHostProps = ChatPaneProps & {
  identity: PaneHostIdentity;
};

export const ChatPaneHost = ({ identity, ...props }: ChatPaneHostProps) => (
  <PaneContentHost
    className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    identity={identity}
    paneType="thread"
    data-maximized={props.isMaximized ? 'true' : 'false'}
  >
    <ChatPaneContent {...props} />
  </PaneContentHost>
);

export const LegacyUnscopedChatPane = (props: ChatPaneProps) => (
  <div
    className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    data-maximized={props.isMaximized ? 'true' : 'false'}
    data-weave-legacy-unscoped-pane="thread"
  >
    <ChatPaneContent {...props} />
  </div>
);
