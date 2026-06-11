import {
  AssistantRuntimeProvider,
  AuiIf,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useMessage,
  useThread,
} from '@assistant-ui/react';
import type { ReasoningMessagePartProps, ToolCallMessagePartProps } from '@assistant-ui/react';
import type { ThreadMessage } from '@assistant-ui/core';
import type { AttachmentAdapter } from '@assistant-ui/core';
import type { ChatTransport, UIMessage } from 'ai';
import { useChat } from '@ai-sdk/react';
import { AssistantChatTransport, useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Brain, Check, ChevronRight, Clipboard, ImageIcon, KeyRound, ListChecks, Loader2, Plus, Search, Send, Square, SquareTerminal, UserRoundCog, X } from 'lucide-react';
import { createContext, memo, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cancelThreadRun, getThreadContextUsage, getThreadRunState, listServerMessages, type ContextUsage } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { fuzzyScore } from '../../lib/fuzzy';
import { getChatGPTAuthStatus, startChatGPTLogin } from '../../lib/chatgpt-auth-api';
import { getAuthHeaders, getChatUrl } from '../../lib/mastra-client';
import { fetchModelConfig, getResolvedModelDisplayName, resolveModelInput } from '../../lib/models';
import { listProfiles, type DynamicProfileSummary, type ProfileResolutionContext } from '../../lib/profiles-api';
import { expandPrompt, listPrompts, type PromptSummary } from '../../lib/prompts-api';
import { useChatStore, type ChatThread, type ReasoningEffort } from '../../stores/chat-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../ui/collapsible';
import { CommandPanel } from '../ui/command';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { CodeBlock } from './CodeBlock';
import {
  getAssistantContentRanges,
  getPartType,
  getReasoningText,
  isVisibleNonReasoningOutputPart,
} from './assistant-content-ranges';
import {
  getToolActivitySideEffect,
  getToolActivityStatus,
  getToolChipDetail,
  getToolResultText,
  isDegradedToolCall,
  isHiddenToolCall,
  isRenameThreadTool,
  isUpdatePlanTool,
  shouldRenderToolActivityChildren,
  summarizeToolActivity,
  toToolActivityCall,
  type ToolActivityCall,
} from './tool-activity';

const ThreadIdContext = createContext<string | null>(null);
const toolCallCache = new Map<string, Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result' | 'isError'>>();

const fallbackProfile: DynamicProfileSummary = {
  id: 'builtin-default',
  name: 'Default',
  source: 'builtin',
  tools: [],
  skills: [],
  prompts: [],
  mcp: [],
};

const profileContextForThread = (threadId: string | null, thread: ChatThread | undefined): ProfileResolutionContext => ({
  threadId: threadId ?? undefined,
  projectId: thread?.projectId,
  workspaceId: thread?.workspaceId,
  profileId: thread?.profileId,
});

const readFileAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read image data'));
    });
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Could not read image data')));
    reader.readAsDataURL(file);
  });

const imageAttachmentAdapter: AttachmentAdapter = {
  accept: 'image/*',
  async add({ file }) {
    if (!file.type.startsWith('image/')) throw new Error('Only image attachments are supported');
    return {
      id: crypto.randomUUID(),
      type: 'image',
      name: file.name || 'image',
      file,
      contentType: file.type,
      content: [],
      status: { type: 'requires-action', reason: 'composer-send' },
    };
  },
  async send(attachment) {
    return {
      ...attachment,
      status: { type: 'complete' },
      content: [
        {
          type: 'file',
          mimeType: attachment.contentType ?? 'image/png',
          filename: attachment.name,
          data: await readFileAsDataUrl(attachment.file),
        },
      ],
    };
  },
  async remove() {},
};

const Reasoning = ({ text }: ReasoningMessagePartProps) => {
  const showReasoning = useChatStore(state => state.showReasoning);
  if (!showReasoning) return null;

  return (
    <div className="my-2 text-muted-foreground/80">
      <MarkdownText text={text} />
    </div>
  );
};

const ToolCall = (props: ToolCallMessagePartProps) => {
  const showToolCalls = useChatStore(state => state.showToolCalls);
  const cached = toolCallCache.get(props.toolCallId);
  const display = isDegradedToolCall(props) && cached ? { ...props, ...cached } : props;
  const rawStatus = display.status.type;
  const displayStatus = display.result !== undefined
    ? (display.isError ? 'error' : 'complete')
    : rawStatus === 'incomplete'
      ? 'running'
      : rawStatus;
  const [isResultCopied, setIsResultCopied] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const resultText = useMemo(
    () => isOpen && display.result !== undefined ? getToolResultText(display.toolName, display.result) : '',
    [display.result, display.toolName, isOpen],
  );

  if (!isDegradedToolCall(display)) {
    toolCallCache.set(props.toolCallId, {
      toolName: display.toolName,
      args: display.args,
      result: display.result,
      isError: display.isError,
    });
  }

  if (isRenameThreadTool(display.toolName)) return null;
  if (isUpdatePlanTool(display.toolName)) return null;
  if (!showToolCalls) return null;

  const chipDetail = getToolChipDetail(display.toolName, display.args);
  const isBusy = displayStatus === 'running';

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={open => setIsOpen(open)}
      className="my-2 max-w-full overflow-hidden rounded-lg border border-border bg-card px-3 py-2 text-xs"
    >
      <CollapsibleTrigger className="flex min-w-0 cursor-pointer select-none items-center gap-2 font-medium text-muted-foreground">
        {isBusy ? <Loader2 size={12} className="shrink-0 animate-spin text-primary" /> : null}
        <span className="min-w-0 truncate">
          <span className="font-bold italic text-mauve">{display.toolName}</span>
          {chipDetail ? <span className="text-foreground">: {chipDetail}</span> : null}
        </span>
        <Badge className="ml-auto" size="sm" variant={display.isError ? 'error' : isBusy ? 'info' : 'success'}>
          {displayStatus}
        </Badge>
      </CollapsibleTrigger>
      {display.result !== undefined && isOpen ? (
        <CollapsiblePanel className="chat-tool-detail-panel mt-2">
          <div className="mb-1 flex justify-end">
            <Button
              size="xs"
              variant="ghost"
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
            </Button>
          </div>
          <pre className={cn('max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-[11px] leading-4', display.isError ? 'text-destructive' : 'text-foreground')}>
            {resultText}
          </pre>
        </CollapsiblePanel>
      ) : null}
    </Collapsible>
  );
};

const cacheToolActivityCall = (call: ToolActivityCall) => {
  if (isDegradedToolCall(call)) return;

  toolCallCache.set(call.toolCallId, {
    toolName: call.toolName,
    args: call.args,
    result: call.result,
    isError: Boolean(call.isError),
  });
};

const AssistantToolSideEffects = ({ message }: { message: ThreadMessage }) => {
  const threadId = useContext(ThreadIdContext);
  const appliedEffectsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (message.role !== 'assistant') return;

    for (const part of message.content) {
      const call = toToolActivityCall(part);
      if (!call) continue;

      cacheToolActivityCall(call);

      const effect = getToolActivitySideEffect(call);
      if (!effect) continue;

      const effectKey = `${call.toolCallId}:${effect.type}`;
      const effectVersion = [
        getToolActivityStatus(call),
        getStableValueVersion(call.args),
        getStableValueVersion(call.result),
      ].join(':');
      if (appliedEffectsRef.current[effectKey] === effectVersion) continue;
      appliedEffectsRef.current[effectKey] = effectVersion;

      const targetThreadId = threadId ?? useChatStore.getState().threadId;
      if (effect.type === 'renameThread') {
        useChatStore.setState(state => ({
          threads: state.threads.map(thread => (thread.id === targetThreadId ? { ...thread, title: effect.title } : thread)),
        }));
      } else {
        useChatStore.getState().setThreadPlan(targetThreadId, effect.plan);
      }
    }
  }, [message.content, message.role, threadId]);

  return null;
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
        className="my-3 block rounded-lg border border-border bg-card p-3 text-sm text-primary underline underline-offset-2"
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

const MarkdownText = memo(({ text, deferCodeHighlight = false }: { text: string; deferCodeHighlight?: boolean }) => (
  <div className="min-w-0 max-w-full space-y-3 overflow-hidden break-words text-inherit [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
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
        a: ({ children, href }) => <a href={href} className="break-all text-primary underline underline-offset-2" target="_blank" rel="noreferrer">{children}</a>,
        code: ({ children, className }) =>
          className?.startsWith('language-') ? (
            <CodeBlock className={className} deferHighlight={deferCodeHighlight}>{String(children)}</CodeBlock>
          ) : (
            <code className={cn('break-words rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]', className)}>{children}</code>
          ),
        pre: ({ children }) => <div className="my-3 max-w-full overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-5">{children}</div>,
        blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
        table: ({ children }) => <div className="my-3 max-w-full overflow-x-auto"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
        thead: ({ children }) => <thead className="border-b border-border bg-muted">{children}</thead>,
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
));

MarkdownText.displayName = 'MarkdownText';

const RunningIndicator = () => (
  <span aria-label="Agent working" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
    <Loader2 size={14} className="shrink-0 animate-spin text-primary" />
    <span>Working...</span>
  </span>
);

const RunningIndicatorTail = () => {
  const isRunning = useThread(state => state.isRunning);
  if (!isRunning) return null;

  return (
    <div className="chat-message-shell mx-auto w-full max-w-[var(--weave-chat-content-max-width)] px-4 py-3 sm:px-[38px]">
      <div className="chat-message-row flex min-w-0 justify-start">
        <div className="chat-message-bubble min-w-0 max-w-full text-base leading-6">
          <RunningIndicator />
        </div>
      </div>
    </div>
  );
};

const getAttachmentImageUrl = (attachment: unknown) => {
  const record = attachment && typeof attachment === 'object' ? attachment as Record<string, unknown> : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const firstImagePart = content.find(part => {
    if (!part || typeof part !== 'object') return false;
    const partRecord = part as Record<string, unknown>;
    const mediaType = typeof partRecord.mediaType === 'string'
      ? partRecord.mediaType
      : typeof partRecord.mimeType === 'string'
        ? partRecord.mimeType
        : undefined;
    return partRecord.type === 'image' || (partRecord.type === 'file' && mediaType?.startsWith('image/'));
  }) as Record<string, unknown> | undefined;

  if (typeof firstImagePart?.image === 'string') return firstImagePart.image;
  if (typeof firstImagePart?.url === 'string') return firstImagePart.url;
  if (typeof firstImagePart?.data === 'string') return firstImagePart.data;

  return undefined;
};

const ImageAttachmentPreview = ({ attachment, removable = false }: { attachment: unknown; removable?: boolean }) => {
  const record = attachment && typeof attachment === 'object' ? attachment as Record<string, unknown> : {};
  const file = typeof File !== 'undefined' && record.file instanceof File ? record.file : undefined;
  const [objectUrl, setObjectUrl] = useState<string | undefined>();
  const [fetchedUrl, setFetchedUrl] = useState<string | undefined>();
  const attachmentImageUrl = getAttachmentImageUrl(attachment);
  const imageUrl = fetchedUrl ?? attachmentImageUrl ?? objectUrl;
  const name = typeof record.name === 'string' ? record.name : 'image';

  useEffect(() => {
    if (!file || !file.type.startsWith('image/')) {
      setObjectUrl(undefined);
      return undefined;
    }

    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!attachmentImageUrl || attachmentImageUrl.startsWith('data:') || attachmentImageUrl.startsWith('blob:')) {
      setFetchedUrl(undefined);
      return undefined;
    }

    let cancelled = false;
    let localUrl: string | undefined;
    void fetch(attachmentImageUrl, { headers: getAuthHeaders() })
      .then(response => {
        if (!response.ok) throw new Error(`Attachment fetch failed: ${response.status}`);
        return response.blob();
      })
      .then(blob => {
        if (cancelled) return;
        localUrl = URL.createObjectURL(blob);
        setFetchedUrl(localUrl);
      })
      .catch(() => {
        if (!cancelled) setFetchedUrl(undefined);
      });

    return () => {
      cancelled = true;
      if (localUrl) URL.revokeObjectURL(localUrl);
    };
  }, [attachmentImageUrl]);

  return (
    <AttachmentPrimitive.Root className="group relative h-16 w-16 overflow-hidden rounded-md border border-border bg-muted">
      {imageUrl ? (
        <img src={imageUrl} alt={name} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
          <ImageIcon size={18} />
        </div>
      )}
      {removable ? (
        <AttachmentPrimitive.Remove
          render={<Button type="button" size="icon-xs" variant="ghost" className="absolute right-1 top-1 h-5 w-5 bg-background/85 opacity-0 shadow-sm transition-opacity group-hover:opacity-100" />}
        >
          <X size={12} />
        </AttachmentPrimitive.Remove>
      ) : null}
    </AttachmentPrimitive.Root>
  );
};

const ComposerImageAttachments = () => (
  <ComposerPrimitive.Attachments>
    {({ attachment }) => <ImageAttachmentPreview attachment={attachment} removable />}
  </ComposerPrimitive.Attachments>
);

const MessageImageAttachments = () => (
  <MessagePrimitive.Attachments>
    {({ attachment }) => <ImageAttachmentPreview attachment={attachment} />}
  </MessagePrimitive.Attachments>
);

const hasRenderableAssistantContent = (message: ThreadMessage, showReasoning: boolean) => {
  if (message.role !== 'assistant') return true;
  return message.content.some(part => {
    if (part.type === 'text' && typeof part.text === 'string') return part.text.trim().length > 0;
    if (part.type === 'reasoning' && showReasoning && typeof part.text === 'string') return part.text.trim().length > 0;
    return part.type.startsWith('tool-') || part.type === 'tool-call';
  });
};

type ToolActivityGroupProps = {
  indices: readonly number[];
  children: ReactNode;
};

const ToolActivityGroup = ({ indices, children }: ToolActivityGroupProps) => {
  const message = useMessage();
  const parts = useAuiState(state => state.message.parts);
  const showToolCalls = useChatStore(state => state.showToolCalls);
  const firstIndex = indices[0] ?? 0;
  const groupId = `${message.id}:${firstIndex}`;
  const storedCollapsed = useChatStore(state => state.toolActivityCollapsed[groupId]);
  const setToolActivityCollapsed = useChatStore(state => state.setToolActivityCollapsed);

  const calls = useMemo(
    () => indices.map(index => toToolActivityCall(parts[index])).filter((call): call is ToolActivityCall => call !== null),
    [indices, parts],
  );
  const visibleCalls = useMemo(() => calls.filter(call => !isHiddenToolCall(call)), [calls]);

  if (!showToolCalls || visibleCalls.length === 0) {
    return null;
  }

  const isBusy = visibleCalls.some(call => !['complete', 'error'].includes(getToolActivityStatus(call)));
  const defaultCollapsed = true;
  const isCollapsed = storedCollapsed ?? defaultCollapsed;
  const summary = summarizeToolActivity(visibleCalls);
  const SummaryIcon = visibleCalls.some(call => call.toolName === 'bash') && !visibleCalls.some(call => ['read', 'webSearch', 'webExtract'].includes(call.toolName))
    ? SquareTerminal
    : Search;
  const renderChildren = shouldRenderToolActivityChildren(showToolCalls, visibleCalls.length, isCollapsed);

  return (
    <div className="my-2">
      <button
        type="button"
        className="group flex max-w-full items-center gap-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
        aria-expanded={!isCollapsed}
        onClick={() => setToolActivityCollapsed(groupId, !isCollapsed)}
      >
        <ChevronRight size={15} className={cn('shrink-0 transition-transform', !isCollapsed && 'rotate-90')} />
        {isBusy ? (
          <Loader2 size={15} className="shrink-0 animate-spin text-primary" />
        ) : (
          <SummaryIcon size={15} className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        )}
        <span className="min-w-0 truncate">{summary}</span>
      </button>
      {renderChildren ? <div className="mt-2">{children}</div> : null}
    </div>
  );
};

type ReasoningGroupProps = {
  indices: readonly number[];
  deferCodeHighlight: boolean;
};

const normalizeReasoningText = (text: string) => text.replace(/\s+/g, ' ').trim();

const getDedupedReasoningGroupText = (parts: readonly unknown[], indices: readonly number[]) => {
  const seen = new Set<string>();
  const sections: string[] = [];

  for (const index of indices) {
    const text = getReasoningText(parts[index]);
    if (!text) continue;

    const normalized = normalizeReasoningText(text);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    sections.push(text);
  }

  return sections.join('\n\n');
};

const ReasoningTextBlock = ({ text, deferCodeHighlight, className }: { text: string; deferCodeHighlight: boolean; className?: string }) => (
  <div className={cn('min-w-0 max-w-full text-muted-foreground/80', className)}>
    <MarkdownText text={text} deferCodeHighlight={deferCodeHighlight} />
  </div>
);

const ReasoningGroup = ({ indices, deferCodeHighlight }: ReasoningGroupProps) => {
  const parts = useAuiState(state => state.message.parts);
  const showReasoning = useChatStore(state => state.showReasoning);
  const [isManuallyOpen, setIsManuallyOpen] = useState(false);
  const text = useMemo(() => getDedupedReasoningGroupText(parts, indices), [indices, parts]);
  const lastIndex = indices[indices.length - 1] ?? -1;
  const hasFollowingOutput = useMemo(
    () => parts.slice(lastIndex + 1).some(isVisibleNonReasoningOutputPart),
    [lastIndex, parts],
  );

  if (!showReasoning || !text) return null;

  if (!hasFollowingOutput) {
    return (
      <div className="my-2">
        <ReasoningTextBlock text={text} deferCodeHighlight={deferCodeHighlight} />
      </div>
    );
  }

  return (
    <div className="my-2">
      <button
        type="button"
        className="group flex max-w-full items-center gap-2 text-left text-xs font-medium text-muted-foreground/70 transition-colors hover:text-muted-foreground"
        aria-expanded={isManuallyOpen}
        onClick={() => setIsManuallyOpen(open => !open)}
      >
        <ChevronRight size={13} className={cn('shrink-0 transition-transform', isManuallyOpen && 'rotate-90')} />
        <span>Reasoning</span>
      </button>
      {isManuallyOpen ? <ReasoningTextBlock className="mt-2" text={text} deferCodeHighlight={deferCodeHighlight} /> : null}
    </div>
  );
};

const assistantPartByIndexComponents = {
  Text: MarkdownText,
  Reasoning,
  tools: { Override: ToolCall },
};

const ToolActivityGroupChildren = ({ indices }: { indices: readonly number[] }) => (
  <>
    {indices.map(index => (
      <MessagePrimitive.PartByIndex key={index} index={index} components={assistantPartByIndexComponents} />
    ))}
  </>
);

const AssistantGroupedContent = ({ deferCodeHighlight }: { deferCodeHighlight: boolean }) => {
  const parts = useAuiState(state => state.message.parts);
  const showReasoning = useChatStore(state => state.showReasoning);
  const ranges = useMemo(() => getAssistantContentRanges(parts, showReasoning), [parts, showReasoning]);

  return (
    <>
      {ranges.map(range => {
        if (range.type === 'reasoning') {
          return <ReasoningGroup key={`reasoning-${range.indices[0] ?? 0}`} indices={range.indices} deferCodeHighlight={deferCodeHighlight} />;
        }

        if (range.type === 'tool-activity') {
          return (
            <ToolActivityGroup key={`tool-activity-${range.indices[0] ?? 0}`} indices={range.indices}>
              <ToolActivityGroupChildren indices={range.indices} />
            </ToolActivityGroup>
          );
        }

        const part = parts[range.index];
        if (getPartType(part) === 'text' && part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
          return <MarkdownText key={range.index} text={(part as { text: string }).text} deferCodeHighlight={deferCodeHighlight} />;
        }

        return <MessagePrimitive.PartByIndex key={range.index} index={range.index} components={assistantPartByIndexComponents} />;
      })}
    </>
  );
};

const AssistantMessageContent = () => {
  const message = useMessage();
  const showReasoning = useChatStore(state => state.showReasoning);
  const isEmptyAssistantMessage = message.role === 'assistant' && !hasRenderableAssistantContent(message, showReasoning);
  const isAssistantStreaming = message.role === 'assistant' && message.status?.type === 'running';

  if (isEmptyAssistantMessage) {
    return <AssistantToolSideEffects message={message} />;
  }

  return (
    <>
      <AssistantToolSideEffects message={message} />
      {message.role === 'assistant' ? (
        <AssistantGroupedContent deferCodeHighlight={isAssistantStreaming} />
      ) : (
        <MessagePrimitive.Content components={{ Text: MarkdownText, Reasoning, tools: { Override: ToolCall } }} />
      )}
    </>
  );
};

const ThreadMessage = () => (
  <MessagePrimitive.Root className="chat-message-shell mx-auto w-full max-w-[var(--weave-chat-content-max-width)] px-4 py-3 sm:px-[38px]">
    <MessagePrimitive.If assistant>
      <div className="chat-message-row flex min-w-0 justify-start">
        <div className="chat-message-bubble min-w-0 max-w-full text-base leading-6">
          <AssistantMessageContent />
          <div className="text-red-300">
            <MessagePrimitive.Error />
          </div>
        </div>
      </div>
    </MessagePrimitive.If>
    <MessagePrimitive.If user>
      <div className="chat-message-row flex min-w-0 justify-end">
        <div className="chat-message-bubble min-w-0 max-w-[78%] rounded-lg border border-primary bg-user px-4 py-2 text-base leading-6 text-user-foreground">
          <MessagePrimitive.Content components={{ Text: MarkdownText, Reasoning, tools: { Override: ToolCall } }} />
          <div className="mt-3 flex flex-wrap gap-2 empty:hidden">
            <MessageImageAttachments />
          </div>
          <div className="text-red-950">
            <MessagePrimitive.Error />
          </div>
        </div>
      </div>
    </MessagePrimitive.If>
  </MessagePrimitive.Root>
);

const ModelPicker = () => {
  const isRunning = useThread(state => state.isRunning);
  const selectedModel = useChatStore(state => state.selectedModel);
  const setSelectedModel = useChatStore(state => state.setSelectedModel);
  const { data: modelConfig } = useQuery({
    queryKey: ['models'],
    queryFn: fetchModelConfig,
    staleTime: 1000 * 60 * 5,
  });
  const modelOptions = modelConfig?.options ?? [];
  const activeModel = selectedModel || modelConfig?.defaultModel || '';
  const activeOption = modelOptions.find(model => model.id === activeModel);

  useEffect(() => {
    if (!selectedModel && modelConfig?.defaultModel) setSelectedModel(modelConfig.defaultModel);
  }, [modelConfig?.defaultModel, selectedModel, setSelectedModel]);

  return (
    <div className="model-picker min-w-0 shrink-0">
      <Select
        value={activeModel}
        onValueChange={value => {
          if (value) setSelectedModel(resolveModelInput(value, modelOptions) ?? value);
        }}
        disabled={isRunning || modelOptions.length === 0}
      >
        <SelectTrigger
          aria-label="Model"
          className="h-9 w-9 justify-center border-transparent bg-transparent px-0 text-muted-foreground shadow-none before:hidden hover:bg-muted hover:text-foreground sm:w-auto sm:max-w-52 sm:justify-start sm:px-2"
          variant="ghost"
        >
          {activeOption?.providerLogoUrl ? (
            <span
              className="h-5 w-5 shrink-0 bg-current sm:mr-1"
              style={{
                WebkitMask: `url("${activeOption.providerLogoUrl}") center / contain no-repeat`,
                mask: `url("${activeOption.providerLogoUrl}") center / contain no-repeat`,
              }}
              title={activeOption.providerName}
              aria-hidden="true"
            />
          ) : (
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground/40 text-[10px] font-semibold sm:mr-1">AI</span>
          )}
          <SelectValue className="hidden min-w-0 text-left sm:block">
            {activeModel ? getResolvedModelDisplayName(activeModel, modelOptions) : 'Model'}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" className="max-h-72">
          {modelOptions.map(model => (
            <SelectItem key={model.id} value={model.id}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{model.label}</span>
                <span className="truncate text-xs text-muted-foreground">{model.id}</span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
};

const ProfilePicker = () => {
  const threadId = useContext(ThreadIdContext);
  const isRunning = useThread(state => state.isRunning);
  const thread = useChatStore(state => state.threads.find(item => item.id === threadId));
  const setDraftThreadProfile = useChatStore(state => state.setDraftThreadProfile);
  const isDraft = thread?.draft === true;
  const context = useMemo(
    () => profileContextForThread(threadId, thread),
    [threadId, thread?.draft, thread?.profileId, thread?.projectId, thread?.workspaceId],
  );
  const { data, isError, isLoading } = useQuery({
    queryKey: ['profiles', context.threadId ?? null, context.projectId ?? null, context.workspaceId ?? null, context.profileId ?? null],
    queryFn: () => listProfiles(context),
    enabled: Boolean(threadId),
    staleTime: 1000 * 60,
  });
  const profiles = data?.profiles?.length ? data.profiles : [fallbackProfile];
  const resolvedProfile = data?.resolved.profile ?? fallbackProfile;
  const loadedActiveProfileId = data && isDraft && thread?.profileId ? thread.profileId : resolvedProfile.id;
  const loadedActiveProfile = profiles.find(profile => profile.id === loadedActiveProfileId) ?? resolvedProfile;
  const activeProfileId = profiles.some(profile => profile.id === loadedActiveProfileId)
    ? loadedActiveProfileId
    : loadedActiveProfile.id;
  const activeProfile = profiles.find(profile => profile.id === activeProfileId) ?? loadedActiveProfile;
  const profileOptions = profiles.some(profile => profile.id === activeProfile.id)
    ? profiles
    : [activeProfile, ...profiles];
  const disabled = !isDraft || isRunning || isLoading || isError || profileOptions.length === 0;
  const title = isError
    ? 'Profile unavailable'
    : isDraft
      ? 'Profile'
      : `Profile locked: ${activeProfile.name}`;

  return (
    <div className="profile-picker min-w-0 shrink-0">
      <Select
        value={activeProfileId}
        onValueChange={value => {
          if (threadId && isDraft) setDraftThreadProfile(threadId, value);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          aria-label="Profile"
          title={title}
          className="h-9 w-9 justify-center border-transparent bg-transparent px-0 text-muted-foreground shadow-none before:hidden hover:bg-muted hover:text-foreground disabled:opacity-60 sm:w-auto sm:max-w-44 sm:justify-start sm:px-2"
          variant="ghost"
        >
          <UserRoundCog size={16} className="shrink-0 sm:mr-1" />
          <SelectValue className="hidden min-w-0 text-left sm:block">{activeProfile.name}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" className="max-h-72">
          {profileOptions.map(profile => (
            <SelectItem key={profile.id} value={profile.id}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{profile.name}</span>
                <span className="truncate text-xs text-muted-foreground">{profile.description ?? profile.id}</span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
};

const reasoningOptions: Array<{ value: ReasoningEffort; label: string; detail: string }> = [
  { value: 'off', label: 'Off', detail: 'No reasoning' },
  { value: 'minimal', label: 'Fast', detail: 'Minimal thinking' },
  { value: 'low', label: 'Low', detail: 'Light reasoning' },
  { value: 'medium', label: 'Medium', detail: 'Balanced reasoning' },
  { value: 'high', label: 'High', detail: 'Deeper reasoning' },
];

const ReasoningPicker = () => {
  const isRunning = useThread(state => state.isRunning);
  const reasoningEffort = useChatStore(state => state.reasoningEffort);
  const setReasoningEffort = useChatStore(state => state.setReasoningEffort);
  const active = reasoningOptions.find(option => option.value === reasoningEffort) ?? reasoningOptions[3];

  return (
    <Select
      value={active.value}
      onValueChange={value => {
        if (value === 'off' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high') {
          setReasoningEffort(value);
        }
      }}
      disabled={isRunning}
    >
      <SelectTrigger
        aria-label="Reasoning level"
        className="h-9 w-9 justify-center border-transparent bg-transparent px-0 text-muted-foreground shadow-none before:hidden hover:bg-muted hover:text-foreground sm:w-auto sm:justify-start sm:px-2"
        variant="ghost"
      >
        <Brain size={16} className="shrink-0" />
        <SelectValue className="hidden min-w-0 text-left sm:block">{active.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" className="max-h-72">
        {reasoningOptions.map(option => (
          <SelectItem key={option.value} value={option.value}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{option.label}</span>
              <span className="truncate text-xs text-muted-foreground">{option.detail}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

const PlanPanelToggle = ({ threadId }: { threadId: string | null }) => {
  const plan = useChatStore(state => threadId ? state.threadPlans[threadId] : undefined);
  const showPlanPanel = useChatStore(state => state.showPlanPanel);
  const setShowPlanPanel = useChatStore(state => state.setShowPlanPanel);

  if (!plan) return null;

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      aria-pressed={showPlanPanel}
      title={showPlanPanel ? 'Hide plan' : 'Show plan'}
      onClick={() => setShowPlanPanel(!showPlanPanel)}
      className={cn(
        'h-9 shrink-0 gap-2 px-2 text-muted-foreground hover:bg-muted hover:text-foreground',
        showPlanPanel && 'text-primary',
      )}
    >
      <ListChecks size={16} />
      <span>Plan</span>
    </Button>
  );
};

type ContextUsageStreamPayload = {
  tokens: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalProcessedTokens?: number;
  updatedAt?: string;
  source: 'provider';
};

const finiteNumberFrom = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const getContextUsageStreamPayload = (dataPart: unknown): ContextUsageStreamPayload | null => {
  if (!dataPart || typeof dataPart !== 'object') return null;
  const record = dataPart as Record<string, unknown>;
  if (record.type !== 'data-context-usage') return null;

  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : undefined;
  const tokens = finiteNumberFrom(data?.tokens);
  if (!data || tokens === undefined || data.source !== 'provider') return null;

  return {
    tokens,
    inputTokens: finiteNumberFrom(data.inputTokens),
    cachedInputTokens: finiteNumberFrom(data.cachedInputTokens),
    outputTokens: finiteNumberFrom(data.outputTokens),
    totalProcessedTokens: finiteNumberFrom(data.totalProcessedTokens),
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
    source: 'provider',
  };
};

const applyContextUsageStreamPayload = (
  queryClient: QueryClient,
  resourceId: string,
  threadId: string,
  payload: ContextUsageStreamPayload,
) => {
  queryClient.setQueriesData<ContextUsage>(
    { queryKey: ['thread-context-usage', resourceId, threadId] },
    previous => {
      const contextWindow = previous?.contextWindow;
      return {
        ...(previous ?? {}),
        tokens: payload.tokens,
        contextWindow,
        percent: contextWindow ? Math.min(100, (payload.tokens / contextWindow) * 100) : undefined,
        source: payload.source,
        updatedAt: payload.updatedAt,
        totalProcessedTokens: payload.totalProcessedTokens,
        inputTokens: payload.inputTokens,
        cachedInputTokens: payload.cachedInputTokens,
        outputTokens: payload.outputTokens,
      };
    },
  );
};

const ContextUsageRing = ({ threadId }: { threadId: string | null }) => {
  const resourceId = useChatStore(state => state.resourceId);
  const selectedModel = useChatStore(state => state.selectedModel);
  const { data: modelConfig } = useQuery({
    queryKey: ['models'],
    queryFn: fetchModelConfig,
    staleTime: 1000 * 60 * 5,
  });
  const activeModel = selectedModel || modelConfig?.defaultModel || '';
  const contextWindow = modelConfig?.options.find(model => model.id === activeModel)?.contextWindow;
  const { data } = useQuery({
    queryKey: ['thread-context-usage', resourceId, threadId, contextWindow],
    queryFn: () => getThreadContextUsage(threadId!, contextWindow),
    enabled: Boolean(threadId),
    staleTime: 15_000,
  });
  const hasPercent = typeof data?.percent === 'number';
  const rawPercent = data?.percent ?? 0;
  const clamped = Math.max(0, Math.min(100, rawPercent));
  const displayedPercent = String(Math.round(clamped));
  const radius = 13;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  const tone = clamped >= 90 ? 'text-destructive' : clamped >= 70 ? 'text-peach' : 'text-muted-foreground';
  const tokenLabel = data?.source === 'provider' ? 'tokens' : 'estimated tokens';

  return (
    <div
      className={cn('relative flex h-9 w-9 shrink-0 items-center justify-center', tone)}
      title={data?.contextWindow ? `${data.tokens} / ${data.contextWindow} ${tokenLabel}` : `${data?.tokens ?? 0} ${tokenLabel}`}
      aria-label={hasPercent ? `Context usage ${displayedPercent}%` : 'Context usage unavailable'}
    >
      <svg viewBox="0 0 32 32" className="absolute inset-0 h-9 w-9 -rotate-90">
        <circle cx="16" cy="16" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="3" />
        <circle
          cx="16"
          cy="16"
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeWidth="3"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <span className="text-[10px] font-semibold tabular-nums">{hasPercent ? displayedPercent : '--'}</span>
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
    <CommandPanel className="absolute bottom-full left-0 z-20 mb-3 w-full overflow-hidden rounded-xl">
      {matches.map(({ prompt }, index) => (
        <Button
          key={prompt.name}
          type="button"
          variant="ghost"
          onMouseDown={event => {
            event.preventDefault();
            onSelect(prompt);
          }}
          className={cn(
            'h-auto w-full justify-start gap-3 rounded-none px-4 py-3 text-left text-sm',
            index === activeIndex ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
          )}
        >
          <span className="w-28 shrink-0 font-bold text-primary">/{prompt.name}</span>
          {prompt.argumentHint ? <span className="shrink-0 text-xs text-muted-foreground">{prompt.argumentHint}</span> : null}
          <span className="min-w-0 truncate">— {prompt.description}</span>
        </Button>
      ))}
    </CommandPanel>
  );
};

const SlashHighlightedInput = ({
  value,
  placeholder,
  knownPromptNames,
  onKeyDown,
  disabled,
  inputRef,
}: {
  value: string;
  placeholder: string;
  knownPromptNames: Set<string>;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  disabled?: boolean;
  inputRef?: React.Ref<HTMLTextAreaElement>;
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
        ref={inputRef}
        autoFocus={!disabled}
        disabled={disabled}
        placeholder={placeholder}
        onKeyDown={onKeyDown}
        className={cn(
          'relative max-h-40 min-h-6 w-full resize-none bg-transparent p-0 text-base leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70',
          match && isKnownCommand && 'text-transparent caret-foreground',
        )}
      />
    </div>
  );
};

const Composer = () => {
  const aui = useAui();
  const threadId = useContext(ThreadIdContext);
  const queryClient = useQueryClient();
  const resourceId = useChatStore(state => state.resourceId);
  const composerRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const isEmpty = useThread(state => state.messages.length === 0 && !state.isLoading);
  const composerText = useAuiState(state => state.composer.text);
  const isComposerEmpty = useAuiState(state => state.composer.isEmpty);
  const thread = useChatStore(state => state.threads.find(item => item.id === threadId));
  const [emptyPlaceholder] = useState(getRandomEmptyThreadPlaceholder);
  const [activeIndex, setActiveIndex] = useState(0);
  const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(composerText);
  const promptContext = useMemo(
    () => profileContextForThread(threadId, thread),
    [threadId, thread?.draft, thread?.profileId, thread?.projectId, thread?.workspaceId],
  );
  const { data: prompts = [] } = useQuery({
    queryKey: ['prompts', promptContext.threadId ?? null, promptContext.projectId ?? null, promptContext.workspaceId ?? null, promptContext.profileId ?? null],
    queryFn: () => listPrompts(promptContext),
    staleTime: 1000 * 60,
  });
  const { data: chatgptAuth } = useQuery({
    queryKey: ['chatgpt-auth-status'],
    queryFn: getChatGPTAuthStatus,
    staleTime: 10_000,
  });
  const isChatGPTConnected = chatgptAuth?.connected === true;
  const isSendActive = isChatGPTConnected && !isComposerEmpty;
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

  const connectChatGPT = async () => {
    const login = await startChatGPTLogin();
    window.open(login.url, 'mage-hand-chatgpt-login', 'width=720,height=820,popup=yes');
  };

  const stopThreadRun = async () => {
    if (!threadId) return;
    try {
      await cancelThreadRun(threadId);
    } catch (error) {
      console.error('[chat] failed to cancel thread run', error);
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['thread-run', resourceId, threadId] }),
        queryClient.invalidateQueries({ queryKey: ['thread-messages', resourceId, threadId] }),
        queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }),
        queryClient.invalidateQueries({ queryKey: ['thread-context-usage', resourceId, threadId] }),
      ]);
    }
  };

  return (
    <ComposerPrimitive.Root
      ref={composerRef}
      className="relative mx-auto w-full max-w-[var(--weave-chat-content-max-width)] rounded-xl border border-primary bg-background px-4 py-3 shadow-[0_0_0_1px_rgba(87,119,255,0.08)]"
      data-weave-text-surface="true"
    >
      {slashMatch && isChatGPTConnected ? <PromptSlashMenu prompts={prompts} query={slashMatch[1] ?? ''} activeIndex={activeIndex} onSelect={selectPrompt} /> : null}
      <div className="mb-3 flex flex-wrap gap-2 empty:hidden">
        <ComposerImageAttachments />
      </div>
      <SlashHighlightedInput
        inputRef={inputRef}
        value={composerText}
        placeholder={isChatGPTConnected ? (isEmpty ? emptyPlaceholder : 'Ask for follow-up changes or attach images') : 'Connect ChatGPT to start chatting'}
        knownPromptNames={knownPromptNames}
        onKeyDown={handleKeyDown}
        disabled={!isChatGPTConnected}
      />
      <div className="mt-5 flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <ComposerPrimitive.AddAttachment
            render={<Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Attach image" />}
          >
            <Plus size={18} strokeWidth={2.5} />
          </ComposerPrimitive.AddAttachment>
          <ModelPicker />
          <ProfilePicker />
          <ReasoningPicker />
          <PlanPanelToggle threadId={threadId} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isEmpty ? null : <ContextUsageRing threadId={threadId} />}
          <AuiIf condition={state => !state.thread.isRunning}>
            {isChatGPTConnected ? (
              <ComposerPrimitive.Send
                render={(
                  <Button
                    size="icon-lg"
                    variant={isSendActive ? 'default' : 'ghost'}
                    className={cn(
                      'h-11 w-11 shrink-0 rounded-full',
                      isSendActive
                        ? 'border-mauve bg-mauve text-background hover:bg-mauve/90'
                        : 'text-primary',
                    )}
                  />
                )}
              >
                <Send size={20} />
              </ComposerPrimitive.Send>
            ) : (
              <Button
                type="button"
                aria-label="Connect ChatGPT"
                onClick={() => void connectChatGPT()}
                size="icon-lg"
                variant="ghost"
                className="h-11 w-11 shrink-0 rounded-full text-peach"
              >
                <KeyRound size={20} />
              </Button>
            )}
          </AuiIf>
          <AuiIf condition={state => state.thread.isRunning}>
            <ComposerPrimitive.Cancel
              onClick={() => void stopThreadRun()}
              render={<Button size="icon-lg" variant="ghost" className="h-11 w-11 shrink-0 rounded-full text-primary" aria-label="Stop generation" title="Stop generation" />}
            >
              <Square size={18} fill="currentColor" strokeWidth={2.5} />
            </ComposerPrimitive.Cancel>
          </AuiIf>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

const ThreadRunningTracker = ({ threadId }: { threadId: string }) => {
  const wasRunning = useRef(false);
  const resourceId = useChatStore(state => state.resourceId);
  const isLocalRunning = useThread(state => state.isRunning);
  const activeThreadId = useChatStore(state => state.threadId);
  const setThreadRunning = useChatStore(state => state.setThreadRunning);
  const markThreadCompleted = useChatStore(state => state.markThreadCompleted);
  const clearThreadCompleted = useChatStore(state => state.clearThreadCompleted);
  const { data: runState } = useQuery({
    queryKey: ['thread-run', resourceId, threadId],
    queryFn: () => getThreadRunState(threadId),
    enabled: activeThreadId === threadId,
    staleTime: 0,
  });
  const isRunning = isLocalRunning || runState?.active === true;

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

const IdleActiveThreadRefresher = ({ threadId }: { threadId: string }) => {
  const queryClient = useQueryClient();
  const resourceId = useChatStore(state => state.resourceId);
  const activeThreadId = useChatStore(state => state.threadId);
  const isLocalRunning = useThread(state => state.isRunning);
  const composerText = useAuiState(state => state.composer.text);
  const [isComposerIdle, setIsComposerIdle] = useState(true);

  useEffect(() => {
    setIsComposerIdle(false);
    const timeout = window.setTimeout(() => setIsComposerIdle(true), 1000);
    return () => window.clearTimeout(timeout);
  }, [composerText]);

  useEffect(() => {
    const isActive = activeThreadId === threadId;
    const hasDraft = composerText.trim().length > 0;
    const isVisible = document.visibilityState === 'visible';
    const canRefresh = isActive && isComposerIdle && !hasDraft && isVisible && navigator.onLine;

    if (!canRefresh) return undefined;

    const refresh = async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['thread-run', resourceId, threadId] }),
        ...(!isLocalRunning
          ? [queryClient.invalidateQueries({ queryKey: ['thread-messages', resourceId, threadId] })]
          : []),
        queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }),
      ]);
    };

    const interval = window.setInterval(() => void refresh(), 6000);
    return () => window.clearInterval(interval);
  }, [activeThreadId, composerText, isComposerIdle, isLocalRunning, queryClient, resourceId, threadId]);

  return null;
};

const hashString = (value: string) => {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index) | 0;
  }
  return `${value.length}:${hash.toString(36)}`;
};

const getStableValueVersion = (value: unknown) => {
  if (value === undefined) return 'u';
  if (typeof value === 'string') return hashString(value);

  try {
    return hashString(JSON.stringify(value));
  } catch {
    return 'unserializable';
  }
};

const getPartVersion = (part: UIMessage['parts'][number]) => {
  const record = part as Record<string, unknown>;
  return [
    record.type,
    getStableValueVersion(record.text),
    getStableValueVersion(record.state),
    getStableValueVersion(record.toolCallId),
    getStableValueVersion(record.input ?? record.args),
    getStableValueVersion(record.output ?? record.result ?? record.errorText),
  ].join(':');
};

const getMessagesVersion = (messages: UIMessage[]) =>
  messages
    .map(message => `${message.id}:${message.role}:${message.parts?.length ?? 0}:${message.parts?.map(getPartVersion).join(',') ?? ''}`)
    .join('|');

const Thread = () => {
  const threadId = useContext(ThreadIdContext);
  const isDraft = useChatStore(state => state.threads.find(thread => thread.id === threadId)?.draft === true);
  const isRunning = useThread(state => state.isRunning);
  const messages = useThread(state => state.messages);
  const isEmptyIdleDraft = isDraft && !isRunning && messages.length === 0;
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
      className={cn('flex h-full flex-col bg-background', isEmptyIdleDraft && 'justify-center')}
      style={{ '--composer-height': `${composerHeight}px` } as React.CSSProperties}
    >
      <ThreadPrimitive.Viewport className={cn('min-h-0 flex-1 overflow-y-auto', isEmptyIdleDraft && 'hidden')}>
        <ThreadPrimitive.Messages components={{ UserMessage: ThreadMessage, AssistantMessage: ThreadMessage }} />
        <RunningIndicatorTail />
      </ThreadPrimitive.Viewport>
      <div ref={composerRef} className={cn('shrink-0 bg-background p-4 pb-[calc(1rem+var(--weave-safe-area-bottom))]', isEmptyIdleDraft && 'w-full pb-4')}>
        <Composer />
      </div>
    </ThreadPrimitive.Root>
  );
};

type AssistantChatProps = {
  threadId: string;
};

const useDynamicChatTransport = <UI_MESSAGE extends UIMessage>(
  transport: ChatTransport<UI_MESSAGE>,
): ChatTransport<UI_MESSAGE> => {
  const transportRef = useRef(transport);

  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);

  return useMemo(
    () =>
      new Proxy(transportRef.current, {
        get(_, prop) {
          const value = transportRef.current[prop as keyof ChatTransport<UI_MESSAGE>];
          return typeof value === 'function' ? value.bind(transportRef.current) : value;
        },
      }),
    [],
  );
};

const AssistantChatRuntime = ({ threadId, initialMessages }: AssistantChatProps & { initialMessages: UIMessage[] }) => {
  const queryClient = useQueryClient();
  const resourceId = useChatStore(state => state.resourceId);
  const selectedModel = useChatStore(state => state.selectedModel);
  const reasoningEffort = useChatStore(state => state.reasoningEffort);
  const chatApi = getChatUrl();
  const resumeRunIdRef = useRef<string | undefined>(undefined);
  const { data: runState } = useQuery({
    queryKey: ['thread-run', resourceId, threadId],
    queryFn: () => getThreadRunState(threadId),
    enabled: true,
    staleTime: 0,
  });

  const currentTransport = useMemo(
    () =>
      new AssistantChatTransport({
        api: chatApi,
        async prepareReconnectToStreamRequest({ id }) {
          return {
            api: `${chatApi}/${id}/stream`,
            headers: getAuthHeaders(),
          };
        },
        async prepareSendMessagesRequest({ messages }) {
          const firstUserText = messages.find(message => message.role === 'user') ? getMessageText(messages.find(message => message.role === 'user')!).trim() : '';
          const lastUserText = getMessageText([...messages].reverse().find(message => message.role === 'user') ?? messages[messages.length - 1]).trim();
          const slashCommand = parseSlashCommand(lastUserText);
          const threadTitle = firstUserText?.slice(0, 64);
          const threadBeforePersist = useChatStore.getState().threads.find(thread => thread.id === threadId);
          const promptContext = profileContextForThread(threadId, threadBeforePersist);
          await useChatStore.getState().ensureThreadPersisted(threadId, threadTitle);
          useChatStore.getState().touchThread(threadId, threadTitle, true);

          const requestMessages = slashCommand
            ? withLastUserText(messages, await expandPrompt(slashCommand.name, slashCommand.args, promptContext), {
                slashCommandOriginalText: lastUserText,
                slashCommandName: slashCommand.name,
              })
            : messages;

          return {
            headers: getAuthHeaders(),
            body: {
              messages: requestMessages,
              ...(selectedModel ? { model: selectedModel } : {}),
              reasoningEffort,
              memory: {
                thread: threadId,
              },
            },
          };
        },
      }),
    [chatApi, reasoningEffort, selectedModel, threadId],
  );
  const transport = useDynamicChatTransport(currentTransport);

  const chat = useChat({
    id: threadId,
    transport,
    messages: initialMessages,
    resume: true,
    experimental_throttle: 80,
    onData: dataPart => {
      const payload = getContextUsageStreamPayload(dataPart);
      if (!payload) return;
      applyContextUsageStreamPayload(queryClient, resourceId, threadId, payload);
    },
    onFinish: async () => {
      await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
      await queryClient.invalidateQueries({ queryKey: ['thread-messages', resourceId, threadId] });
      await queryClient.invalidateQueries({ queryKey: ['thread-run', resourceId, threadId] });
      await queryClient.invalidateQueries({ queryKey: ['thread-context-usage', resourceId, threadId] });
    },
    onError: async error => {
      console.error('[chat] stream failed', error);
      await queryClient.invalidateQueries({ queryKey: ['thread-run', resourceId, threadId] });
    },
  });

  const runtime = useAISDKRuntime(chat, {
    adapters: { attachments: imageAttachmentAdapter },
  });

  if (transport instanceof AssistantChatTransport) transport.setRuntime(runtime);

  useEffect(() => {
    if (runState?.active !== true) {
      resumeRunIdRef.current = undefined;
      return;
    }

    const runId = runState.runId ?? 'active';
    if (chat.status !== 'ready' || resumeRunIdRef.current === runId) return;

    resumeRunIdRef.current = runId;
    void chat.resumeStream().catch(error => {
      resumeRunIdRef.current = undefined;
      console.error('[chat] failed to resume active thread run', error);
    });
  }, [chat, runState?.active, runState?.runId]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadIdContext.Provider value={threadId}>
        <ThreadRunningTracker threadId={threadId} />
        <IdleActiveThreadRefresher threadId={threadId} />
        <Thread />
      </ThreadIdContext.Provider>
    </AssistantRuntimeProvider>
  );
};

export const AssistantChat = ({ threadId }: AssistantChatProps) => {
  const resourceId = useChatStore(state => state.resourceId);
  const isDraft = useChatStore(state => state.threads.find(thread => thread.id === threadId)?.draft === true);
  const isRunning = useChatStore(state => state.runningThreadIds.includes(threadId));
  const { data: initialMessages = [], isLoading } = useQuery({
    queryKey: ['thread-messages', resourceId, threadId],
    queryFn: () => listServerMessages(threadId),
    enabled: !isDraft,
    staleTime: 0,
  });
  if (!isDraft && isLoading && !isRunning) return <div className="h-full bg-background" />;

  return <AssistantChatRuntime key={`${threadId}:${getMessagesVersion(initialMessages)}`} threadId={threadId} initialMessages={initialMessages} />;
};
