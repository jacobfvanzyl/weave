import {
  AssistantRuntimeProvider,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
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
import { Check, Clipboard, Loader2, Plus, Send } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { listServerMessages } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { fuzzyScore } from '../../lib/fuzzy';
import { chatUrl, getAuthHeaders } from '../../lib/mastra-client';
import { fetchModelsDevModelOptions, fallbackModelOptions, getResolvedModelDisplayName, resolveModelInput } from '../../lib/models';
import { expandPrompt, listPrompts, type PromptSummary } from '../../lib/prompts-api';
import { useChatStore } from '../../stores/chat-store';
import { MageHandIcon } from '../icons/MageHandIcon';
import { CodeBlock } from './CodeBlock';

const ThreadIdContext = createContext<string | null>(null);
const toolCallCache = new Map<string, Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result' | 'isError'>>();

const isEmptyObject = (value: unknown) =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

const isDegradedToolCall = ({ toolName, args, result }: Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result'>) =>
  (toolName === 'call' || toolName === 'tool') && isEmptyObject(args) && result === undefined;

const isRenameThreadTool = (toolName: string) => ['renameThreadTool', 'rename-thread'].includes(toolName);

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
  const [isResultCopied, setIsResultCopied] = useState(false);
  const resultText = display.result === undefined
    ? ''
    : typeof display.result === 'string'
      ? display.result
      : JSON.stringify(display.result, null, 2);

  useEffect(() => {
    if (!isRenameThreadTool(display.toolName)) return;

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

  if (isRenameThreadTool(display.toolName) || !showToolCalls) return null;

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
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className={display.isError ? 'text-[10px] uppercase tracking-wide text-destructive' : 'text-[10px] uppercase tracking-wide text-muted-foreground'}>
                {display.isError ? 'Error' : 'Result'}
              </div>
              <button
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground transition hover:bg-muted hover:text-foreground"
                type="button"
                onClick={async event => {
                  event.preventDefault();
                  await navigator.clipboard.writeText(resultText);
                  setIsResultCopied(true);
                  window.setTimeout(() => setIsResultCopied(false), 1200);
                }}
              >
                {isResultCopied ? <Check size={12} /> : <Clipboard size={12} />}
                {isResultCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="overflow-x-auto rounded-md bg-muted p-2 text-[11px] leading-4 text-foreground">
              {resultText}
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

const slashCommandPattern = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/;

const parseSlashCommand = (text: string) => {
  const match = slashCommandPattern.exec(text.trim());
  if (!match) return null;
  return { name: match[1], args: match[2] ?? '' };
};

const getMessageText = (message: UIMessage) =>
  message.parts
    ?.filter((part): part is { type: 'text'; text: string } =>
      Boolean(part.type === 'text' && 'text' in part && typeof part.text === 'string'),
    )
    .map(part => part.text)
    .join('') ?? '';

const withLastUserText = (messages: UIMessage[], text: string, metadata: Record<string, unknown>) => {
  const nextMessages = [...messages];
  let index = -1;
  for (let messageIndex = nextMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    if (nextMessages[messageIndex].role === 'user') {
      index = messageIndex;
      break;
    }
  }
  if (index === -1) return messages;

  const message = nextMessages[index];
  nextMessages[index] = {
    ...message,
    metadata: { ...(typeof message.metadata === 'object' && message.metadata ? message.metadata : {}), ...metadata },
    parts: message.parts?.map(part => part.type === 'text' ? { ...part, text } : part),
  };
  return nextMessages;
};

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
    <div className="my-3 flex max-h-[80vh] max-w-full items-center justify-center overflow-hidden">
      <img
        alt={alt ?? ''}
        src={src}
        className="max-h-[calc(100dvh-var(--composer-height,0px)-theme(spacing.16))] max-w-full rounded-lg border border-border object-contain"
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </div>
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
        <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-yellow">
          <MageHandIcon className="h-5 w-5" />
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
        className="h-10 w-64 rounded-lg bg-transparent px-2 text-right text-base leading-6 text-foreground outline-none transition placeholder:text-muted-foreground focus:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <datalist id="weave-models">
        {modelOptions.map(model => (
          <option key={model.id} value={model.label} label={model.id} />
        ))}
      </datalist>
    </div>
  );
};

const PromptSlashMenu = ({
  prompts,
  query,
  activeIndex,
  onSelect,
}: {
  prompts: PromptSummary[];
  query: string;
  activeIndex: number;
  onSelect: (prompt: PromptSummary) => void;
}) => {
  const matches = prompts
    .map(prompt => ({
      prompt,
      score: Math.max(
        fuzzyScore(query, prompt.name),
        fuzzyScore(query, prompt.description),
        ...prompt.tags.map(tag => fuzzyScore(query, tag)),
      ),
    }))
    .filter(match => match.score > 0)
    .sort((a, b) => b.score - a.score || a.prompt.name.localeCompare(b.prompt.name))
    .slice(0, 8);

  if (matches.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 z-20 mb-3 w-full overflow-hidden rounded-xl border border-border bg-background shadow-xl">
      {matches.map(({ prompt }, index) => (
        <button
          key={prompt.name}
          type="button"
          onMouseDown={event => {
            event.preventDefault();
            onSelect(prompt);
          }}
          className={cn(
            'flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition',
            index === activeIndex ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
          )}
        >
          <span className="w-28 shrink-0 font-bold text-primary">/{prompt.name}</span>
          {prompt.argumentHint ? <span className="shrink-0 text-xs text-muted-foreground">{prompt.argumentHint}</span> : null}
          <span className="min-w-0 truncate">— {prompt.description}</span>
        </button>
      ))}
    </div>
  );
};

const SlashHighlightedInput = ({
  value,
  placeholder,
  knownPromptNames,
  onKeyDown,
}: {
  value: string;
  placeholder: string;
  knownPromptNames: Set<string>;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
}) => {
  const match = /^(\/[a-zA-Z0-9_-]+)([\s\S]*)$/.exec(value);
  const commandName = match?.[1].slice(1);
  const isKnownCommand = Boolean(commandName && knownPromptNames.has(commandName));

  return (
    <div className="relative text-base leading-6">
      {match && isKnownCommand ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 min-h-10 overflow-hidden whitespace-pre-wrap break-words p-0 font-[inherit] leading-6 text-foreground"
        >
          <span className="font-bold text-primary">{match[1]}</span>
          <span>{match[2] || ' '}</span>
        </div>
      ) : null}
      <ComposerPrimitive.Input
        autoFocus
        placeholder={placeholder}
        onKeyDown={onKeyDown}
        className={cn(
          'relative min-h-10 w-full resize-none bg-transparent p-0 text-base leading-6 outline-none placeholder:text-muted-foreground',
          match && isKnownCommand && 'text-transparent caret-foreground',
        )}
      />
    </div>
  );
};

const Composer = () => {
  const aui = useAui();
  const isEmpty = useThread(state => state.messages.length === 0 && !state.isLoading);
  const composerText = useAuiState(state => state.composer.text);
  const [emptyPlaceholder] = useState(getRandomEmptyThreadPlaceholder);
  const [activeIndex, setActiveIndex] = useState(0);
  const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(composerText);
  const { data: prompts = [] } = useQuery({ queryKey: ['prompts'], queryFn: listPrompts, staleTime: 1000 * 60 });
  const knownPromptNames = useMemo(() => new Set(prompts.map(prompt => prompt.name)), [prompts]);
  const promptMatches = prompts
    .map(prompt => ({
      prompt,
      score: Math.max(
        fuzzyScore(slashMatch?.[1] ?? '', prompt.name),
        fuzzyScore(slashMatch?.[1] ?? '', prompt.description),
        ...prompt.tags.map(tag => fuzzyScore(slashMatch?.[1] ?? '', tag)),
      ),
    }))
    .filter(match => slashMatch && match.score > 0)
    .sort((a, b) => b.score - a.score || a.prompt.name.localeCompare(b.prompt.name));

  useEffect(() => {
    setActiveIndex(0);
  }, [slashMatch?.[1]]);

  const selectPrompt = (prompt: PromptSummary) => {
    aui.composer().setText(`/${prompt.name} `);
    setActiveIndex(0);
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = event => {
    if (!slashMatch || promptMatches.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(index => (index + 1) % Math.min(promptMatches.length, 8));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(index => (index - 1 + Math.min(promptMatches.length, 8)) % Math.min(promptMatches.length, 8));
    } else if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault();
      selectPrompt(promptMatches[Math.min(activeIndex, promptMatches.length - 1)].prompt);
    } else if (event.key === 'Escape') {
      setActiveIndex(0);
    }
  };

  return (
    <ComposerPrimitive.Root className="relative mx-0 rounded-[2rem] border border-border bg-muted/70 px-6 py-5 shadow-lg sm:mx-11">
      {slashMatch ? <PromptSlashMenu prompts={prompts} query={slashMatch[1] ?? ''} activeIndex={activeIndex} onSelect={selectPrompt} /> : null}
      <SlashHighlightedInput value={composerText} placeholder={isEmpty ? emptyPlaceholder : ''} knownPromptNames={knownPromptNames} onKeyDown={handleKeyDown} />
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

const Thread = () => {
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return undefined;

    const updateComposerHeight = () => setComposerHeight(composer.getBoundingClientRect().height);
    updateComposerHeight();

    const resizeObserver = new ResizeObserver(updateComposerHeight);
    resizeObserver.observe(composer);

    return () => resizeObserver.disconnect();
  }, []);

  return (
    <ThreadPrimitive.Root
      className="flex h-full flex-col bg-background"
      style={{ '--composer-height': `${composerHeight}px` } as React.CSSProperties}
    >
      <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
        <ThreadPrimitive.Empty>
          <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-6 text-center">
            <MageHandIcon className="h-24 w-24 text-yellow" />
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage: ThreadMessage, AssistantMessage: ThreadMessage }} />
      </ThreadPrimitive.Viewport>
      <div ref={composerRef} className="shrink-0 bg-gradient-to-t from-background via-background p-4">
        <Composer />
      </div>
    </ThreadPrimitive.Root>
  );
};

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
        async prepareSendMessagesRequest({ messages }) {
          const firstUserText = messages.find(message => message.role === 'user') ? getMessageText(messages.find(message => message.role === 'user')!).trim() : '';
          const lastUserText = getMessageText([...messages].reverse().find(message => message.role === 'user') ?? messages[messages.length - 1]).trim();
          const slashCommand = parseSlashCommand(lastUserText);
          const requestMessages = slashCommand
            ? withLastUserText(messages, await expandPrompt(slashCommand.name, slashCommand.args), {
                slashCommandOriginalText: lastUserText,
                slashCommandName: slashCommand.name,
              })
            : messages;

          useChatStore.getState().touchThread(threadId, firstUserText?.slice(0, 64), true);

          return {
            headers: getAuthHeaders(),
            body: {
              messages: requestMessages,
              model: selectedModel,
              memory: {
                thread: threadId,
              },
            },
          };
        },
      }),
    [selectedModel, threadId],
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
    queryFn: () => listServerMessages(threadId),
    staleTime: 0,
  });

  if (isLoading) return <div className="h-full bg-background" />;

  return <AssistantChatRuntime key={`${threadId}:${initialMessages.length}`} threadId={threadId} initialMessages={initialMessages} />;
};
