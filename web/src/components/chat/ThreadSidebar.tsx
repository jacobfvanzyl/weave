import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronUp, Loader2, MessageSquare, MessageSquarePlus, Moon, Sun, Trash2, X } from 'lucide-react';
import { Button } from '../ui/button';
import { getAuthUser } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { useChatStore } from '../../stores/chat-store';
import { getResolvedTheme, useThemeStore } from '../../stores/theme-store';
import { MageHandIcon } from '../icons/MageHandIcon';

const formatThreadTimestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));

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
    deleteThread,
  } = useChatStore();
  const queryClient = useQueryClient();
  const resourceMenuRef = useRef<HTMLDivElement>(null);
  const [isResourceMenuOpen, setIsResourceMenuOpen] = useState(false);
  const mode = useThemeStore(state => state.mode);
  const toggleMode = useThemeStore(state => state.toggleMode);
  const resolvedTheme = getResolvedTheme(mode);
  const { data: authUser } = useQuery({
    queryKey: ['auth-user'],
    queryFn: getAuthUser,
    staleTime: 1000 * 60 * 5,
  });
  const displayName = authUser?.name ?? '...';

  useEffect(() => {
    if (!isResourceMenuOpen) return undefined;

    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!resourceMenuRef.current?.contains(event.target as Node)) {
        setIsResourceMenuOpen(false);
      }
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, [isResourceMenuOpen]);

  return (
    <aside className="fixed inset-y-0 left-0 z-40 flex w-full shrink-0 flex-col border-r border-border bg-muted/95 p-4 shadow-xl backdrop-blur md:static md:z-auto md:w-80 md:bg-muted/50 md:shadow-none md:backdrop-blur-none">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <MageHandIcon className="h-6 w-6 text-mauve" />
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

      <Button
        className="mb-4 w-full gap-2"
        onClick={async () => {
          await newThread();
          await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
          if (closeOnSelect) onClose?.();
        }}
      >
        <MessageSquarePlus size={16} />
        New Thread
      </Button>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {threads.map(thread => (
          <div
            key={thread.id}
            className={cn(
              'group flex items-start gap-2 rounded-lg border border-transparent p-2 text-left transition',
              thread.id === threadId ? 'border-border bg-background' : 'hover:bg-background/60',
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
            <button
              className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
              aria-label={`Delete ${thread.title}`}
              onPointerDown={event => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={async event => {
                event.preventDefault();
                event.stopPropagation();
                await deleteThread(thread.id);
                await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

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
              <span className="truncate">{displayName}</span>
            </div>
            <ChevronUp size={14} className={cn('shrink-0 transition', isResourceMenuOpen ? 'rotate-180' : '')} />
          </div>
        </button>
      </div>
    </aside>
  );
};
