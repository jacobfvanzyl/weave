import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useThread,
} from '@assistant-ui/react';
import type { ToolCallMessagePartProps } from '@assistant-ui/react';
import type { UIMessage } from 'ai';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Send } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { listServerMessages } from '../../lib/chat-state-api';
import { chatUrl } from '../../lib/mastra-client';
import { getModelDisplayName, modelOptions, resolveModelInput } from '../../lib/models';
import { useChatStore } from '../../stores/chat-store';

const toolCallCache = new Map<string, Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result' | 'isError'>>();

const isEmptyObject = (value: unknown) =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

const isDegradedToolCall = ({ toolName, args, result }: Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result'>) =>
  (toolName === 'call' || toolName === 'tool') && isEmptyObject(args) && result === undefined;

const ToolCall = (props: ToolCallMessagePartProps) => {
  const cached = toolCallCache.get(props.toolCallId);
  const display = isDegradedToolCall(props) && cached ? { ...props, ...cached } : props;
  const displayStatus = display.result !== undefined ? (display.isError ? 'error' : 'complete') : display.status.type;

  useEffect(() => {
    if (!['renameThreadTool', 'rename-thread'].includes(display.toolName)) return;

    const args = display.args as { title?: unknown } | undefined;
    const result = display.result as { renamed?: unknown; title?: unknown } | undefined;
    const title = typeof args?.title === 'string' ? args.title : typeof result?.title === 'string' ? result.title : undefined;

    if (title) {
      const threadId = useChatStore.getState().threadId;
      useChatStore.setState(state => ({
        threads: state.threads.map(thread => (thread.id === threadId ? { ...thread, title } : thread)),
      }));
    }
  }, [display.args, display.result, display.toolName]);

  if (!isDegradedToolCall(display)) {
    toolCallCache.set(props.toolCallId, {
      toolName: display.toolName,
      args: display.args,
      result: display.result,
      isError: display.isError,
    });
  }

  return (
    <details className="my-2 rounded-lg border border-border bg-background/70 px-3 py-2 text-xs" open={displayStatus === 'running'}>
      <summary className="cursor-pointer select-none font-medium text-muted-foreground">
        Tool: <span className="text-foreground">{display.toolName}</span>
        <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">{displayStatus}</span>
      </summary>
      <div className="mt-2 space-y-2">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Input</div>
          <pre className="overflow-x-auto rounded-md bg-muted p-2 text-[11px] leading-4 text-foreground">
            {JSON.stringify(display.args, null, 2)}
          </pre>
        </div>
        {display.result !== undefined ? (
          <div>
            <div className={display.isError ? 'mb-1 text-[10px] uppercase tracking-wide text-destructive' : 'mb-1 text-[10px] uppercase tracking-wide text-muted-foreground'}>
              {display.isError ? 'Error' : 'Result'}
            </div>
            <pre className="overflow-x-auto rounded-md bg-muted p-2 text-[11px] leading-4 text-foreground">
              {typeof display.result === 'string' ? display.result : JSON.stringify(display.result, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
};

const ThreadMessage = () => (
  <MessagePrimitive.Root className="w-full px-4 py-3">
    <MessagePrimitive.If assistant>
      <div className="flex justify-start gap-3">
        <div className="mt-1 h-8 w-8 shrink-0 rounded-full bg-muted text-center text-xs font-semibold leading-8 text-muted-foreground">
          A
        </div>
        <div className="min-w-0 max-w-[78%] rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm leading-6 shadow-sm">
          <MessagePrimitive.Content components={{ tools: { Override: ToolCall } }} />
          <div className="text-red-300">
            <MessagePrimitive.Error />
          </div>
        </div>
      </div>
    </MessagePrimitive.If>
    <MessagePrimitive.If user>
      <div className="flex justify-end gap-3">
        <div className="min-w-0 max-w-[78%] rounded-xl border border-primary/40 bg-user px-4 py-3 text-sm leading-6 text-user-foreground shadow-sm">
          <MessagePrimitive.Content components={{ tools: { Override: ToolCall } }} />
          <div className="text-red-950">
            <MessagePrimitive.Error />
          </div>
        </div>
        <div className="mt-1 h-8 w-8 shrink-0 rounded-full bg-user text-center text-xs font-semibold leading-8 text-user-foreground">
          U
        </div>
      </div>
    </MessagePrimitive.If>
  </MessagePrimitive.Root>
);

const ModelPicker = () => {
  const isRunning = useThread(state => state.isRunning);
  const selectedModel = useChatStore(state => state.selectedModel);
  const setSelectedModel = useChatStore(state => state.setSelectedModel);
  const [modelInput, setModelInput] = useState(getModelDisplayName(selectedModel));

  useEffect(() => {
    setModelInput(getModelDisplayName(selectedModel));
  }, [selectedModel]);

  const commitModelInput = (input: string) => {
    const resolvedModel = resolveModelInput(input);
    if (resolvedModel) {
      setSelectedModel(resolvedModel);
      setModelInput(getModelDisplayName(resolvedModel));
      return;
    }

    setModelInput(getModelDisplayName(selectedModel));
  };

  return (
    <div className="min-w-0 shrink-0">
      <input
        aria-label="Model"
        list="weave-models"
        value={modelInput}
        disabled={isRunning}
        onBlur={event => commitModelInput(event.target.value)}
        onChange={event => {
          setModelInput(event.target.value);
          const resolvedModel = resolveModelInput(event.target.value);
          if (resolvedModel) setSelectedModel(resolvedModel);
        }}
        className="h-10 w-64 rounded-lg bg-transparent px-2 text-right text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <datalist id="weave-models">
        {modelOptions.map(model => (
          <option key={model.id} value={model.label} label={model.id} />
        ))}
      </datalist>
    </div>
  );
};

const Composer = () => {
  const isEmpty = useThread(state => state.messages.length === 0 && !state.isLoading);

  return (
    <ComposerPrimitive.Root className="mx-0 rounded-[2rem] border border-border bg-muted/70 px-6 py-5 shadow-lg sm:mx-11">
      <ComposerPrimitive.Input
        autoFocus
        placeholder={isEmpty ? 'How can I help you today?' : ''}
        className="min-h-10 w-full resize-none bg-transparent text-xl outline-none placeholder:text-muted-foreground"
      />
    <div className="mt-2 flex items-center gap-3">
      <button
        type="button"
        className="rounded-lg p-2 text-muted-foreground transition hover:bg-background/70 hover:text-foreground"
        aria-label="Add attachment"
      >
        <Plus size={24} />
      </button>
      <div className="flex-1" />
      <ModelPicker />
      <AuiIf condition={state => !state.thread.isRunning}>
        <ComposerPrimitive.Send className="rounded-lg p-2 text-foreground transition hover:bg-background/70 disabled:opacity-40">
          <Send size={22} />
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={state => state.thread.isRunning}>
        <ComposerPrimitive.Cancel className="rounded-lg p-2 text-primary transition hover:bg-background/70">
          <Loader2 size={22} className="animate-spin" />
        </ComposerPrimitive.Cancel>
      </AuiIf>
      </div>
    </ComposerPrimitive.Root>
  );
};

const ThreadRunningTracker = ({ threadId }: { threadId: string }) => {
  const wasRunning = useRef(false);
  const isRunning = useThread(state => state.isRunning);
  const activeThreadId = useChatStore(state => state.threadId);
  const setThreadRunning = useChatStore(state => state.setThreadRunning);
  const markThreadCompleted = useChatStore(state => state.markThreadCompleted);
  const clearThreadCompleted = useChatStore(state => state.clearThreadCompleted);

  useEffect(() => {
    setThreadRunning(threadId, isRunning);

    if (wasRunning.current && !isRunning && activeThreadId !== threadId) {
      markThreadCompleted(threadId);
    }

    wasRunning.current = isRunning;

    return undefined;
  }, [activeThreadId, isRunning, markThreadCompleted, setThreadRunning, threadId]);

  useEffect(() => {
    if (activeThreadId === threadId) {
      clearThreadCompleted(threadId);
    }
  }, [activeThreadId, clearThreadCompleted, threadId]);

  return null;
};

const Thread = () => (
  <ThreadPrimitive.Root className="flex h-full flex-col bg-background">
    <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto">
      <ThreadPrimitive.Empty>
        <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 text-center">
          <div className="mb-4 rounded-2xl border border-border bg-muted px-5 py-4 text-2xl">☁️</div>
          <h2 className="text-2xl font-semibold">Ask weather-agent</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Try “What is the weather in Cape Town?”
          </p>
        </div>
      </ThreadPrimitive.Empty>
      <ThreadPrimitive.Messages components={{ UserMessage: ThreadMessage, AssistantMessage: ThreadMessage }} />
      <ThreadPrimitive.ViewportFooter className="sticky bottom-0 w-full bg-gradient-to-t from-background via-background p-4">
        <Composer />
      </ThreadPrimitive.ViewportFooter>
    </ThreadPrimitive.Viewport>
  </ThreadPrimitive.Root>
);

type AssistantChatProps = {
  threadId: string;
};

const AssistantChatRuntime = ({ threadId, initialMessages }: AssistantChatProps & { initialMessages: UIMessage[] }) => {
  const queryClient = useQueryClient();
  const resourceId = useChatStore(state => state.resourceId);
  const selectedModel = useChatStore(state => state.selectedModel);

  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: chatUrl,
        prepareSendMessagesRequest({ messages }) {
          const firstUserText = messages
            .find(message => message.role === 'user')
            ?.parts?.filter((part): part is { type: 'text'; text: string } =>
              Boolean(part.type === 'text' && 'text' in part && typeof part.text === 'string'),
            )
            .map(part => part.text)
            .join(' ')
            .trim();
          useChatStore.getState().touchThread(threadId, firstUserText?.slice(0, 64), true);

          return {
            body: {
              messages,
              model: selectedModel,
              memory: {
                resource: resourceId,
                thread: threadId,
              },
            },
          };
        },
      }),
    [resourceId, selectedModel, threadId],
  );

  const runtime = useChatRuntime({
    id: threadId,
    transport,
    messages: initialMessages,
    onFinish: async () => {
      await queryClient.invalidateQueries({ queryKey: ['thread-messages', resourceId, threadId] });
      await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadRunningTracker threadId={threadId} />
      <Thread />
    </AssistantRuntimeProvider>
  );
};

export const AssistantChat = ({ threadId }: AssistantChatProps) => {
  const resourceId = useChatStore(state => state.resourceId);
  const { data: initialMessages = [], isLoading } = useQuery({
    queryKey: ['thread-messages', resourceId, threadId],
    queryFn: () => listServerMessages(resourceId, threadId),
    staleTime: 0,
  });

  if (isLoading) return <div className="h-full bg-background" />;

  return <AssistantChatRuntime key={`${threadId}:${initialMessages.length}`} threadId={threadId} initialMessages={initialMessages} />;
};
