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
import type { UIMessage } from 'ai';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/react-ai-sdk';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clipboard, ImageIcon, KeyRound, Loader2, Paperclip, Send, X } from 'lucide-react';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { listServerMessages } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { fuzzyScore } from '../../lib/fuzzy';
import { getChatGPTAuthStatus, startChatGPTLogin } from '../../lib/chatgpt-auth-api';
import { chatUrl, getAuthHeaders } from '../../lib/mastra-client';
import { fetchModelConfig, getResolvedModelDisplayName, resolveModelInput } from '../../lib/models';
import { expandPrompt, listPrompts, type PromptSummary } from '../../lib/prompts-api';
import { useChatStore, type PlanStepStatus, type ThreadPlan, type ThreadPlanStep } from '../../stores/chat-store';
import { MageHandIcon } from '../icons/MageHandIcon';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../ui/collapsible';
import { CommandPanel } from '../ui/command';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { CodeBlock } from './CodeBlock';

const ThreadIdContext = createContext<string | null>(null);
const toolCallCache = new Map<string, Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result' | 'isError'>>();

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

const isEmptyObject = (value: unknown) =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

const isDegradedToolCall = ({ toolName, args, result }: Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result'>) =>
  (toolName === 'call' || toolName === 'tool') && isEmptyObject(args) && result === undefined;

const isRenameThreadTool = (toolName: string) => ['renameThreadTool', 'rename-thread'].includes(toolName);
const isUpdatePlanTool = (toolName: string) => ['updatePlanTool', 'update_plan', 'update-plan'].includes(toolName);

type PlanPayload = {
  plan: ThreadPlanStep[];
  completed?: number;
  total?: number;
};

const isPlanStepStatus = (value: unknown): value is PlanStepStatus =>
  value === 'pending' || value === 'in_progress' || value === 'completed';

const getPlanPayload = (result: unknown, args: unknown): PlanPayload | null => {
  const source = result && typeof result === 'object' ? result : args;
  if (!source || typeof source !== 'object') return null;

  const record = source as Record<string, unknown>;
  if (!Array.isArray(record.plan)) return null;

  const plan = record.plan
    .map(item => {
      if (!item || typeof item !== 'object') return null;
      const step = (item as Record<string, unknown>).step;
      const status = (item as Record<string, unknown>).status;
      if (typeof step !== 'string' || !isPlanStepStatus(status)) return null;
      return { step, status };
    })
    .filter((item): item is ThreadPlanStep => item !== null);

  if (plan.length === 0) return null;

  return {
    plan,
    completed: typeof record.completed === 'number' ? record.completed : undefined,
    total: typeof record.total === 'number' ? record.total : undefined,
  };
};

const toThreadPlan = (payload: PlanPayload, isBusy: boolean): ThreadPlan => ({
  plan: payload.plan,
  completed: payload.completed ?? payload.plan.filter(item => item.status === 'completed').length,
  total: payload.total ?? payload.plan.length,
  updatedAt: new Date().toISOString(),
  isBusy,
});

const Reasoning = ({ text }: ReasoningMessagePartProps) => (
  <Collapsible className="my-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
    <CollapsibleTrigger className="flex w-full items-center gap-2 text-left font-medium text-primary">
      Reasoning
      <Badge size="sm" variant="info">summary</Badge>
    </CollapsibleTrigger>
    <CollapsiblePanel>
      <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-[11px] leading-4 text-foreground">
        {text}
      </pre>
    </CollapsiblePanel>
  </Collapsible>
);

const getToolChipDetail = (toolName: string, args: unknown) => {
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : undefined;
  if (toolName === 'bash' && typeof record?.command === 'string') return record.command;
  if (['read', 'write', 'edit'].includes(toolName) && typeof record?.path === 'string') return record.path;
  return '';
};

const getToolResultText = (toolName: string, result: unknown) => {
  if (result === undefined) return '';
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.content === 'string') return record.content;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.stdout === 'string' || typeof record.stderr === 'string') {
      return [record.stdout, record.stderr].filter(item => typeof item === 'string' && item.trim()).join('\n');
    }
    if (typeof record.diff === 'string' && record.diff.trim()) return record.diff;
    if (toolName === 'write' && typeof record.bytes === 'number') return `Wrote ${record.bytes} bytes.`;
    if (toolName === 'edit' && typeof record.replacements === 'number') return `Applied ${record.replacements} replacement${record.replacements === 1 ? '' : 's'}.`;
    if (typeof record.error === 'string') return record.error;
  }
  return JSON.stringify(result, null, 2);
};

const ToolCall = (props: ToolCallMessagePartProps) => {
  const threadId = useContext(ThreadIdContext);
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
  const resultText = getToolResultText(display.toolName, display.result);

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

  useEffect(() => {
    if (!isUpdatePlanTool(display.toolName)) return;

    const payload = getPlanPayload(display.result, display.args);
    if (!payload) return;

    const targetThreadId = threadId ?? useChatStore.getState().threadId;
    useChatStore.getState().setThreadPlan(targetThreadId, toThreadPlan(payload, displayStatus === 'running'));
  }, [display.args, display.result, display.toolName, displayStatus, threadId]);

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
    <Collapsible className="my-2 max-w-full overflow-hidden rounded-lg border border-border bg-card px-3 py-2 text-xs">
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
      {display.result !== undefined ? (
        <CollapsiblePanel className="mt-2">
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

const MarkdownText = ({ text }: { text: string }) => (
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
            <CodeBlock className={className}>{String(children)}</CodeBlock>
          ) : (
            <code className={cn('break-words rounded bg-muted px-1 py-0.5 text-[0.9em]', className)}>{children}</code>
          ),
        pre: ({ children }) => <div className="my-3 max-w-full overflow-x-auto rounded-md bg-muted p-3 text-xs leading-5">{children}</div>,
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
);

const getAssistantDisplayedText = (message: ThreadMessage) => {
  if (message.role !== 'assistant') return '';

  return message.content
    .filter((part): part is { type: 'text' | 'reasoning'; text: string } =>
      (part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string',
    )
    .map(part => part.text)
    .join('')
    .trim();
};

const findLastMessageIndex = (messages: readonly ThreadMessage[], role: ThreadMessage['role']) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === role) return index;
  }
  return -1;
};

const RunningEllipsis = () => (
  <span aria-label="Agent working" className="inline-block animate-pulse text-muted-foreground">
    ...
  </span>
);

const RunningAssistantPlaceholder = () => {
  const isRunning = useThread(state => state.isRunning);
  const messages = useThread(state => state.messages);

  const shouldShow = useMemo(() => {
    if (!isRunning) return false;

    const lastUserIndex = findLastMessageIndex(messages, 'user');
    const lastAssistantIndex = findLastMessageIndex(messages, 'assistant');
    return lastAssistantIndex < lastUserIndex;
  }, [isRunning, messages]);

  if (!shouldShow) return null;

  return (
    <div className="w-full px-4 py-3 sm:px-[38px]">
      <div className="chat-message-row flex min-w-0 justify-start">
        <div className="chat-message-bubble min-w-0 max-w-[78%] text-sm leading-6">
          <RunningEllipsis />
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

const hasRenderableAssistantContent = (message: ThreadMessage) => {
  if (message.role !== 'assistant') return true;
  return message.content.some(part => {
    if ((part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string') return part.text.trim().length > 0;
    return part.type.startsWith('tool-') || part.type === 'tool-call';
  });
};

const AssistantMessageContent = () => {
  const message = useMessage();
  const isEmptyAssistantMessage = message.role === 'assistant' && !hasRenderableAssistantContent(message);

  if (isEmptyAssistantMessage) {
    return <RunningEllipsis />;
  }

  return <MessagePrimitive.Content components={{ Text: MarkdownText, Reasoning, tools: { Override: ToolCall } }} />;
};

const ThreadMessage = () => (
  <MessagePrimitive.Root className="w-full px-4 py-3 sm:px-[38px]">
    <MessagePrimitive.If assistant>
      <div className="chat-message-row flex min-w-0 justify-start">
        <div className="chat-message-bubble min-w-0 max-w-[78%] text-sm leading-6">
          <AssistantMessageContent />
          <div className="text-red-300">
            <MessagePrimitive.Error />
          </div>
        </div>
      </div>
    </MessagePrimitive.If>
    <MessagePrimitive.If user>
      <div className="chat-message-row flex min-w-0 justify-end">
        <div className="chat-message-bubble min-w-0 max-w-[78%] rounded-lg border border-primary bg-user px-4 py-3 text-sm leading-6 text-user-foreground">
          <MessagePrimitive.Content components={{ Text: MarkdownText, Reasoning, tools: { Override: ToolCall } }} />
          <div className="mt-3 flex flex-wrap gap-2">
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
          className="h-10 w-64 border-transparent bg-transparent text-blue shadow-none before:hidden hover:bg-muted"
          variant="ghost"
        >
          <SelectValue className="text-right">
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
  const composerRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const isEmpty = useThread(state => state.messages.length === 0 && !state.isLoading);
  const composerText = useAuiState(state => state.composer.text);
  const isComposerEmpty = useAuiState(state => state.composer.isEmpty);
  const [shouldStackControls, setShouldStackControls] = useState(false);
  const [emptyPlaceholder] = useState(getRandomEmptyThreadPlaceholder);
  const [activeIndex, setActiveIndex] = useState(0);
  const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(composerText);
  const { data: prompts = [] } = useQuery({ queryKey: ['prompts'], queryFn: listPrompts, staleTime: 1000 * 60 });
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

  useLayoutEffect(() => {
    const composer = composerRef.current;
    const input = inputRef.current;
    const controls = controlsRef.current;
    if (!composer || !input || !controls) return undefined;

    const syncStacking = () => {
      const composerStyle = window.getComputedStyle(composer);
      const inputStyle = window.getComputedStyle(input);
      const composerWidth =
        composer.clientWidth - parseFloat(composerStyle.paddingLeft || '0') - parseFloat(composerStyle.paddingRight || '0');
      const rowGap = 12;
      const visibleControls = Array.from(controls.children).filter(child => {
        const rect = child.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const controlsWidth =
        visibleControls.reduce((width, child) => width + child.getBoundingClientRect().width, 0) +
        Math.max(0, visibleControls.length - 1) * rowGap;
      const constrainedTextWidth = Math.max(0, composerWidth - controlsWidth - rowGap);

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      if (!context) return;

      context.font = `${inputStyle.fontStyle} ${inputStyle.fontVariant} ${inputStyle.fontWeight} ${inputStyle.fontSize} / ${inputStyle.lineHeight} ${inputStyle.fontFamily}`;
      const text = composerText || input.placeholder || '';
      const longestLineWidth = Math.max(
        0,
        ...text.split(/\r?\n/).map(line => context.measureText(line || ' ').width),
      );

      setShouldStackControls(longestLineWidth > constrainedTextWidth);
    };

    syncStacking();

    const resizeObserver = new ResizeObserver(syncStacking);
    resizeObserver.observe(composer);
    resizeObserver.observe(controls);
    return () => resizeObserver.disconnect();
  }, [composerText]);

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

  return (
    <ComposerPrimitive.Root ref={composerRef} className="relative mx-0 rounded-lg border border-input bg-background px-5 py-3 sm:mx-[22px]">
      {slashMatch && isChatGPTConnected ? <PromptSlashMenu prompts={prompts} query={slashMatch[1] ?? ''} activeIndex={activeIndex} onSelect={selectPrompt} /> : null}
      <div className="mb-3 flex flex-wrap gap-2 empty:hidden">
        <ComposerImageAttachments />
      </div>
      <div className={cn('flex min-w-0 gap-3', shouldStackControls ? 'flex-col items-stretch' : 'items-center')}>
        <div className="min-w-0 flex-1">
          <SlashHighlightedInput
            inputRef={inputRef}
            value={composerText}
            placeholder={isChatGPTConnected ? (isEmpty ? emptyPlaceholder : '') : 'Connect ChatGPT to start chatting'}
            knownPromptNames={knownPromptNames}
            onKeyDown={handleKeyDown}
            disabled={!isChatGPTConnected}
          />
        </div>
        <div ref={controlsRef} className={cn('flex shrink-0 items-center gap-3', shouldStackControls && 'justify-end')}>
          <ModelPicker />
          <ComposerPrimitive.AddAttachment
            render={<Button type="button" size="icon-lg" variant="ghost" className="shrink-0 text-blue" aria-label="Attach image" />}
          >
            <Paperclip size={20} />
          </ComposerPrimitive.AddAttachment>
          <AuiIf condition={state => !state.thread.isRunning}>
            {isChatGPTConnected ? (
              <ComposerPrimitive.Send
                render={(
                  <Button
                    size="icon-lg"
                    variant={isSendActive ? 'default' : 'ghost'}
                    className={cn(
                      'shrink-0',
                      isSendActive
                        ? 'border-mauve bg-mauve text-background hover:bg-mauve/90'
                        : 'text-blue',
                    )}
                  />
                )}
              >
                <Send size={22} />
              </ComposerPrimitive.Send>
            ) : (
              <Button
                type="button"
                aria-label="Connect ChatGPT"
                onClick={() => void connectChatGPT()}
                size="icon-lg"
                variant="ghost"
                className="shrink-0 text-peach"
              >
                <KeyRound size={22} />
              </Button>
            )}
          </AuiIf>
          <AuiIf condition={state => state.thread.isRunning}>
            <ComposerPrimitive.Cancel render={<Button size="icon-lg" variant="ghost" className="shrink-0 text-primary" />}>
              <Loader2 size={22} className="animate-spin" />
            </ComposerPrimitive.Cancel>
          </AuiIf>
        </div>
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

const IdleActiveThreadRefresher = ({ threadId }: { threadId: string }) => {
  const queryClient = useQueryClient();
  const resourceId = useChatStore(state => state.resourceId);
  const activeThreadId = useChatStore(state => state.threadId);
  const isRunning = useThread(state => state.isRunning);
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
    const canRefresh = isActive && !isRunning && isComposerIdle && !hasDraft && isVisible && navigator.onLine;

    if (!canRefresh) return undefined;

    const refresh = async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['thread-messages', resourceId, threadId] }),
        queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }),
      ]);
    };

    const interval = window.setInterval(() => void refresh(), 6000);
    return () => window.clearInterval(interval);
  }, [activeThreadId, composerText, isComposerIdle, isRunning, queryClient, resourceId, threadId]);

  return null;
};

const getMessagesVersion = (messages: UIMessage[]) =>
  messages
    .map(message => `${message.id}:${message.role}:${message.parts?.length ?? 0}:${getMessageText(message).length}`)
    .join('|');

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
        <RunningAssistantPlaceholder />
      </ThreadPrimitive.Viewport>
      <div ref={composerRef} className="shrink-0 border-t border-border bg-background p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
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
              ...(selectedModel ? { model: selectedModel } : {}),
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
    adapters: { attachments: imageAttachmentAdapter },
    onFinish: async () => {
      await queryClient.invalidateQueries({ queryKey: ['thread-messages', resourceId, threadId] });
      await queryClient.invalidateQueries({ queryKey: ['threads', resourceId] });
    },
  });

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
  const { data: initialMessages = [], isLoading } = useQuery({
    queryKey: ['thread-messages', resourceId, threadId],
    queryFn: () => listServerMessages(threadId),
    staleTime: 0,
  });

  if (isLoading) return <div className="h-full bg-background" />;

  return <AssistantChatRuntime key={`${threadId}:${getMessagesVersion(initialMessages)}`} threadId={threadId} initialMessages={initialMessages} />;
};
