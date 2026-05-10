import { useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, MessageSquare, MessageSquarePlus, Moon, Sun, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { cn } from '../../lib/cn';
import { useChatStore } from '../../stores/chat-store';
import { getResolvedTheme, useThemeStore } from '../../stores/theme-store';

export const ThreadSidebar = () => {
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
  const mode = useThemeStore(state => state.mode);
  const toggleMode = useThemeStore(state => state.toggleMode);
  const resolvedTheme = getResolvedTheme(mode);

  return (
    <aside className="hidden w-80 shrink-0 border-r border-border bg-muted/50 p-4 md:flex md:flex-col">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Weave</h1>
        <button
          className="rounded-lg border border-border p-2 text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
          aria-label={resolvedTheme === 'dark' ? 'Switch to Catppuccin Latte' : 'Switch to Catppuccin Mocha'}
          title={resolvedTheme === 'dark' ? 'Catppuccin Mocha' : 'Catppuccin Latte'}
          onClick={toggleMode}
        >
          {resolvedTheme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
        </button>
      </div>

      <Button
        className="mb-4 w-full gap-2"
        onClick={async () => {
          await newThread();
          await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
        }}
      >
        <MessageSquarePlus size={16} />
        New chat
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
            <button className="min-w-0 flex-1 text-left" onClick={() => setThreadId(thread.id)}>
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
              <div className="mt-1 truncate pl-6 text-xs text-muted-foreground">{thread.id}</div>
            </button>
            <button
              className="rounded-md p-1 text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
              aria-label={`Delete ${thread.title}`}
              onClick={async event => {
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

      <div className="mt-4 rounded-lg border border-border bg-background/60 p-3 text-xs text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">Resource</div>
        <code className="break-all">{resourceId}</code>
      </div>
    </aside>
  );
};
