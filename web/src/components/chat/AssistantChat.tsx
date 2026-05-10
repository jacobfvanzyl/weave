import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useThread,
} from '@assistant-ui/react';
import type { ReasoningMessagePartProps, ToolCallMessagePartProps } from '@assistant-ui/react';
import type { UIMessage } from 'ai';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Send } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { listServerMessages } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { chatUrl } from '../../lib/mastra-client';
import { fetchModelsDevModelOptions, fallbackModelOptions, getResolvedModelDisplayName, resolveModelInput } from '../../lib/models';
import { useChatStore } from '../../stores/chat-store';
import { CodeBlock } from './CodeBlock';

const ThreadIdContext = createContext<string | null>(null);
const toolCallCache = new Map<string, Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result' | 'isError'>>();

const isEmptyObject = (value: unknown) =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

const isDegradedToolCall = ({ toolName, args, result }: Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result'>) =>
  (toolName === 'call' || toolName === 'tool') && isEmptyObject(args) && result === undefined;

const Reasoning = ({ text }: ReasoningMessagePartProps) => (
  <details className="my-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
    <summary className="cursor-pointer select-none font-medium text-primary">
      Reasoning
      <span className="ml-2 text-[10px] uppercase tracking-wide text-muted-foreground">summary</span>
    </summary>
    <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-background/70 p-2 text-[11px] leading-4 text-foreground">
      {text}
    </pre>
  </details>
);

const ToolCall = (props: ToolCallMessagePartProps) => {
  const threadId = useContext(ThreadIdContext);
  const showToolCalls = useChatStore(state => state.showToolCalls);
  const cached = toolCallCache.get(props.toolCallId);
  const display = isDegradedToolCall(props) && cached ? { ...props, ...cached } : props;
  const displayStatus = display.result !== undefined ? (display.isError ? 'error' : 'complete') : display.status.type;

  useEffect(() => {
    if (!['renameThreadTool', 'rename-thread'].includes(display.toolName)) return;

    const args = display.args as { title?: unknown } | undefined;
    const result = display.result as { renamed?: unknown; title?: unknown } | undefined;
    const title = typeof args?.title === 'string' ? args.title : typeof result?.title === 'string' ? result.title : undefined;

    if (title) {
      const targetThreadId = threadId ?? useChatStore.getState().threadId;
      useChatStore.setState(state => ({
        threads: state.threads.map(thread => (thread.id === targetThreadId ? { ...thread, title } : thread)),
      }));
    }
  }, [display.args, display.result, display.toolName, threadId]);

  if (!isDegradedToolCall(display)) {
    toolCallCache.set(props.toolCallId, {
      toolName: display.toolName,
      args: display.args,
      result: display.result,
      isError: display.isError,
    });
  }

  if (!showToolCalls) return null;

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

const emptyThreadPlaceholders = [
  'What shall we bend into shape?',
  'Point me at the locked door.',
  'What thread should I pull first?',
  'Name the thing. I’ll help move it.',
  'What are we making real today?',
  'Give me a problem with sharp edges.',
  'Where should the hand reach?',
  'What needs a little leverage?',
  'Tell me what to untangle.',
  'What would you like amplified?',
];

const getRandomEmptyThreadPlaceholder = () =>
  emptyThreadPlaceholders[Math.floor(Math.random() * emptyThreadPlaceholders.length)];

const MarkdownImage = ({ alt, src }: { alt?: string; src?: string }) => {
  const [failed, setFailed] = useState(false);

  if (!src) return null;

  if (failed) {
    return (
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="my-3 block rounded-lg border border-border bg-background/70 p-3 text-sm text-primary underline underline-offset-2"
      >
        Image failed to load: {alt || src}
      </a>
    );
  }

  return (
    <img
      alt={alt ?? ''}
      src={src}
      className="my-3 max-w-full rounded-lg border border-border"
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
};

const MarkdownText = ({ text }: { text: string }) => (
  <div className="space-y-3 text-inherit [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRaw, rehypeSanitize]}
      components={{
        h1: ({ children }) => <h1 className="mb-3 mt-5 text-2xl font-bold leading-tight first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-3 mt-5 text-xl font-bold leading-tight first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-2 mt-4 text-lg font-semibold leading-tight first:mt-0">{children}</h3>,
        h4: ({ children }) => <h4 className="mb-2 mt-4 text-base font-semibold leading-tight first:mt-0">{children}</h4>,
        p: ({ children }) => <p className="my-3 leading-6 first:mt-0 last:mb-0">{children}</p>,
        ul: ({ children, className }) => <ul className={cn('my-3 list-disc space-y-1 pl-6', className?.includes('contains-task-list') && 'list-none pl-0')}>{children}</ul>,
        ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>,
        li: ({ children, className }) => <li className={cn('pl-1 leading-6 marker:text-muted-foreground', className?.includes('task-list-item') && 'flex items-start gap-2 pl-0')}>{children}</li>,
        strong: ({ children }) => <strong className="font-bold text-inherit">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
        a: ({ children, href }) => <a href={href} className="text-primary underline underline-offset-2" target="_blank" rel="noreferrer">{children}</a>,
        code: ({ children, className }) =>
          className?.startsWith('language-') ? (
            <CodeBlock className={className}>{String(children)}</CodeBlock>
          ) : (
            <code className={cn('rounded bg-background/70 px-1 py-0.5 text-[0.9em]', className)}>{children}</code>
          ),
        pre: ({ children }) => <div className="my-3 overflow-x-auto rounded-md bg-background/70 p-3 text-xs leading-5">{children}</div>,
        blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
        table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
        thead: ({ children }) => <thead className="border-b border-border bg-muted/50">{children}</thead>,
        tbody: ({ children }) => <tbody className="divide-y divide-border">{children}</tbody>,
        th: ({ children }) => <th className="border border-border px-3 py-2 font-semibold text-foreground">{children}</th>,
        td: ({ children }) => <td className="border border-border px-3 py-2 align-top">{children}</td>,
        hr: () => <hr className="my-5 border-border" />,
        img: ({ alt, src }) => <MarkdownImage alt={alt} src={src} />,
        input: props => <input {...props} className="mt-1 h-4 w-4 shrink-0 accent-primary" readOnly />,
      }}
    >
      {text}
    </ReactMarkdown>
  </div>
);

const ThreadMessage = () => (
  <MessagePrimitive.Root className="w-full px-4 py-3">
    <MessagePrimitive.If assistant>
      <div className="flex justify-start gap-3">
        <div className="mt-1 h-8 w-8 shrink-0 rounded-full bg-muted text-center text-xs font-semibold leading-8 text-muted-foreground">
          A
        </div>
        <div className="min-w-0 max-w-[78%] rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm leading-6 shadow-sm">
          <MessagePrimitive.Content components={{ Text: MarkdownText, Reasoning, tools: { Override: ToolCall } }} />
          <div className="text-red-300">
            <MessagePrimitive.Error />
          </div>
        </div>
      </div>
    </MessagePrimitive.If>
    <MessagePrimitive.If user>
      <div className="flex justify-end gap-3">
        <div className="min-w-0 max-w-[78%] rounded-xl border border-primary/40 bg-user px-4 py-3 text-sm leading-6 text-user-foreground shadow-sm">
          <MessagePrimitive.Content components={{ Text: MarkdownText, Reasoning, tools: { Override: ToolCall } }} />
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
  const { data: modelOptions = fallbackModelOptions } = useQuery({
    queryKey: ['models-dev', 'openrouter'],
    queryFn: fetchModelsDevModelOptions,
    staleTime: 1000 * 60 * 60,
  });
  const [modelInput, setModelInput] = useState(getResolvedModelDisplayName(selectedModel, modelOptions));

  useEffect(() => {
    setModelInput(getResolvedModelDisplayName(selectedModel, modelOptions));
  }, [modelOptions, selectedModel]);

  const commitModelInput = (input: string) => {
    const resolvedModel = resolveModelInput(input, modelOptions);
    if (resolvedModel) {
      setSelectedModel(resolvedModel);
      setModelInput(getResolvedModelDisplayName(resolvedModel, modelOptions));
      return;
    }

    setModelInput(getResolvedModelDisplayName(selectedModel, modelOptions));
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
  const [emptyPlaceholder] = useState(getRandomEmptyThreadPlaceholder);

  return (
    <ComposerPrimitive.Root className="mx-0 rounded-[2rem] border border-border bg-muted/70 px-6 py-5 shadow-lg sm:mx-11">
      <ComposerPrimitive.Input
        autoFocus
        placeholder={isEmpty ? emptyPlaceholder : ''}
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
    <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
      <ThreadPrimitive.Empty>
        <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 text-center">
          <img src="/mage-hand.png" alt="" className="h-24 w-24 object-contain" />
        </div>
      </ThreadPrimitive.Empty>
      <ThreadPrimitive.Messages components={{ UserMessage: ThreadMessage, AssistantMessage: ThreadMessage }} />
    </ThreadPrimitive.Viewport>
    <div className="shrink-0 bg-gradient-to-t from-background via-background p-4">
      <Composer />
    </div>
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
      <ThreadIdContext.Provider value={threadId}>
        <ThreadRunningTracker threadId={threadId} />
        <Thread />
      </ThreadIdContext.Provider>
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
