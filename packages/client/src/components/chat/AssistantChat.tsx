import {
  AssistantRuntimeProvider,
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
import type { Attachment, AttachmentAdapter, CompleteAttachment, PendingAttachment, ThreadUserMessagePart } from '@assistant-ui/core';
import type { ChatTransport, UIMessage } from 'ai';
import { useChat } from '@ai-sdk/react';
import { AssistantChatTransport, useAISDKRuntime } from '@assistant-ui/react-ai-sdk';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Clipboard, Crosshair, GitPullRequestArrow, ImageIcon, KeyRound, Loader2, Plus, Search, Send, Square, SquareTerminal, X, Zap } from 'lucide-react';
import { createContext, isValidElement, memo, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cancelThreadRun, getThreadContextUsage, getThreadRunState, listServerMessages, sendThreadSteeringMessage, type ContextUsage } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import {
  abandonComposerDraftServerAck,
  confirmComposerDraftReceived,
  loadComposerDraft,
  markComposerDraftAwaitingServerAck,
  saveComposerDraft,
} from '../../lib/composer-drafts';
import { fuzzyScore } from '../../lib/fuzzy';
import { getChatGPTAuthStatus, startChatGPTLogin } from '../../lib/chatgpt-auth-api';
import { getAuthHeaders, getChatUrl } from '../../lib/mastra-client';
import { fetchModelConfig, getResolvedModelDisplayName, type ModelOption } from '../../lib/models';
import { expandPrompt, listPrompts, type PromptResolutionContext, type PromptSummary } from '../../lib/prompts-api';
import { shouldShowProposalReview } from '../../lib/proposal-review-state';
import { useChatStore, type ChatThread, type ReasoningEffort, type ServiceTier } from '../../stores/chat-store';
import { useWorkspaceSurfaceStore } from '../../stores/workspace-surface-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../ui/collapsible';
import { CommandPanel } from '../ui/command';
import { Menu, MenuGroupLabel, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger } from '../ui/menu';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../ui/tooltip';
import { CodeBlock, getChatCodeBlockRenderMode, shouldDeferCodeFenceHighlight } from './CodeBlock';
import {
  getAutoCollapsedAssistantTextPartIndices,
  getAssistantContentRanges,
  getDefaultAutoCollapsedAssistantTurnIds,
  getPartType,
  getReasoningText,
  isSteeredUserMessagePart,
  isVisibleNonReasoningOutputPart,
} from './assistant-content-ranges';
import {
  getToolActivitySideEffect,
  getToolActivityFollowTarget,
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
import { GuidedTaskCard } from './GuidedTaskCard';
import { buildProposalImplementationUserMessage, getProposalActionDisplay, getProposalActionDisplayLabel } from './proposal-implementation';
import { getWorkedForLabel, getWorkingForLabel } from './turn-timing';

const ThreadIdContext = createContext<string | null>(null);
type AutoCollapsedTurnIds = Record<string, true>;
type AutoCollapsedTurnStateProps = {
  autoCollapseContext: ThreadAutoCollapseContextValue;
  setIsFollowingBottom: (value: boolean) => void;
};
type ThreadAutoCollapseContextValue = {
  autoCollapsedTurnIds: AutoCollapsedTurnIds;
  markAssistantTurnRunning: (messageId: string) => void;
  finishAssistantTurnIfFollowing: (messageId: string, shouldCollapse: boolean) => void;
  expandCollapsedTurn: (messageId: string) => void;
  liveAssistantTurnIds: AutoCollapsedTurnIds;
};
const ThreadAutoCollapseContext = createContext<ThreadAutoCollapseContextValue>({
  autoCollapsedTurnIds: {},
  markAssistantTurnRunning: () => {},
  finishAssistantTurnIfFollowing: () => {},
  expandCollapsedTurn: () => {},
  liveAssistantTurnIds: {},
});
const toolCallCache = new Map<string, Pick<ToolCallMessagePartProps, 'toolName' | 'args' | 'result' | 'isError'>>();

const areAutoCollapsedTurnIdsEqual = (left: AutoCollapsedTurnIds, right: AutoCollapsedTurnIds) => {
  const leftIds = Object.keys(left);
  const rightIds = Object.keys(right);
  return leftIds.length === rightIds.length && leftIds.every(id => right[id]);
};

const useSecondTicker = (enabled: boolean) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [enabled]);

  return nowMs;
};

const promptContextForThread = (threadId: string | null, thread: ChatThread | undefined): PromptResolutionContext => ({
  threadId: threadId ?? undefined,
  projectId: thread?.projectId,
  workspaceId: thread?.workspaceId,
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

const isCompleteAttachment = (attachment: Attachment): attachment is CompleteAttachment =>
  attachment.status.type === 'complete';

const completeComposerAttachment = async (attachment: Attachment) => {
  if (isCompleteAttachment(attachment)) return attachment;
  if (attachment.status.type === 'incomplete') throw new Error('Attachment upload did not complete');
  return imageAttachmentAdapter.send(attachment as PendingAttachment);
};

const toSteeringFilePart = (part: ThreadUserMessagePart): UIMessage['parts'][number] | null => {
  if (part.type === 'file') {
    return {
      type: 'file',
      url: part.data,
      mediaType: part.mimeType,
      ...(part.filename ? { filename: part.filename } : {}),
    };
  }

  if (part.type === 'image') {
    return {
      type: 'file',
      url: part.image,
      mediaType: 'image/png',
      ...(part.filename ? { filename: part.filename } : {}),
    };
  }

  if (part.type === 'text') return { type: 'text', text: part.text };
  return null;
};

const buildSteeringUserMessage = async (
  text: string,
  attachments: readonly Attachment[],
  metadata?: Record<string, unknown>,
): Promise<UIMessage> => {
  const parts: UIMessage['parts'] = text.length > 0 ? [{ type: 'text', text }] : [];
  const completeAttachments = await Promise.all(attachments.map(completeComposerAttachment));

  for (const attachment of completeAttachments) {
    for (const contentPart of attachment.content) {
      const part = toSteeringFilePart(contentPart);
      if (part) parts.push(part);
    }
  }

  if (parts.length === 0) throw new Error('Cannot send an empty steering message');

  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts,
    ...(metadata ? { metadata } : {}),
  };
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
          <span className="font-medium italic text-foreground">{display.toolName}</span>
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
  const followWrites = useChatStore(state => state.followWrites);
  const threadWorkspaceId = useChatStore(state => state.threads.find(thread => thread.id === threadId)?.workspaceId);
  const activeThreadId = useWorkspaceSurfaceStore(state => state.threadId);
  const activeSurface = useWorkspaceSurfaceStore(state => state.activeSurface);
  const requestEditorFollow = useWorkspaceSurfaceStore(state => state.requestEditorFollow);
  const openProposalReview = useWorkspaceSurfaceStore(state => state.openProposalReview);
  const appliedEffectsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    if (message.role !== 'assistant') return;

    for (const part of message.content) {
      const call = toToolActivityCall(part);
      if (!call) continue;

      cacheToolActivityCall(call);

      const effect = getToolActivitySideEffect(call);
      if (effect) {
        const effectKey = `${call.toolCallId}:${effect.type}`;
        const effectVersion = [
          getToolActivityStatus(call),
          getStableValueVersion(call.args),
          getStableValueVersion(call.result),
        ].join(':');
        if (appliedEffectsRef.current[effectKey] !== effectVersion) {
          appliedEffectsRef.current[effectKey] = effectVersion;

          const targetThreadId = threadId ?? useWorkspaceSurfaceStore.getState().threadId;
          if (effect.type === 'renameThread') {
            useChatStore.setState(state => ({
              threads: state.threads.map(thread => (thread.id === targetThreadId ? { ...thread, title: effect.title } : thread)),
            }));
          } else if (effect.type === 'updatePlan') {
            const shouldAutoExpand = useChatStore.getState().runningThreadIds.includes(targetThreadId);
            useChatStore.getState().setThreadPlan(targetThreadId, effect.plan, { autoExpand: shouldAutoExpand });
          } else {
            const shouldAutoExpand = useChatStore.getState().runningThreadIds.includes(targetThreadId);
            useChatStore.getState().setThreadProposal(targetThreadId, effect.proposal, { autoExpand: shouldAutoExpand });
            const proposalReviewPath = shouldShowProposalReview(effect.proposal) ? effect.proposal.path : undefined;
            if (
              targetThreadId === activeThreadId
              && activeSurface.kind === 'thread'
              && getToolActivityStatus(call) === 'complete'
              && proposalReviewPath
            ) {
              openProposalReview(proposalReviewPath);
            }
          }
        }
      }

      const followTarget = getToolActivityFollowTarget(call);
      if (!followTarget || !followWrites || !threadId || !threadWorkspaceId) continue;
      if (activeThreadId !== threadId || activeSurface.kind !== 'thread') continue;

      const followKey = `${call.toolCallId}:followWrite`;
      const followVersion = [
        getToolActivityStatus(call),
        getStableValueVersion(call.args),
        getStableValueVersion(call.result),
      ].join(':');
      if (appliedEffectsRef.current[followKey] === followVersion) continue;
      appliedEffectsRef.current[followKey] = followVersion;

      requestEditorFollow({
        threadId,
        workspaceId: threadWorkspaceId,
        path: followTarget.path,
        line: followTarget.line,
        toolCallId: followTarget.toolCallId,
      });
    }
  }, [activeSurface.kind, activeThreadId, followWrites, message.content, message.role, openProposalReview, requestEditorFollow, threadId, threadWorkspaceId]);

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

const latestUserMessageOnly = (messages: UIMessage[]) => {
  if (messages.length <= 1) return messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return [messages[index]];
  }
  return [messages[messages.length - 1]];
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

const getMarkdownNodeText = (node: ReactNode): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(getMarkdownNodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return getMarkdownNodeText(node.props.children);
  return '';
};

const getMarkdownCodeClassName = (node: ReactNode): string | undefined => {
  if (node === null || node === undefined || typeof node === 'boolean') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const className = getMarkdownCodeClassName(child);
      if (className) return className;
    }
    return undefined;
  }
  if (isValidElement<{ className?: unknown; children?: ReactNode }>(node)) {
    if (typeof node.props.className === 'string') return node.props.className;
    return getMarkdownCodeClassName(node.props.children);
  }
  return undefined;
};

const writeClipboardText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();

    try {
      return document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }
};

const MarkdownPre = ({
  children,
  inlinePlainText = false,
  showCopy = true,
}: {
  children: ReactNode;
  inlinePlainText?: boolean;
  showCopy?: boolean;
}) => {
  const [isCopied, setIsCopied] = useState(false);
  const resetCopiedRef = useRef<number | null>(null);
  const copyText = useMemo(() => getMarkdownNodeText(children).replace(/\n$/, ''), [children]);

  useEffect(() => () => {
    if (resetCopiedRef.current !== null) window.clearTimeout(resetCopiedRef.current);
  }, []);

  const copyCode = useCallback(async () => {
    if (!copyText) return;

    const didCopy = await writeClipboardText(copyText);
    if (!didCopy) return;

    setIsCopied(true);
    if (resetCopiedRef.current !== null) window.clearTimeout(resetCopiedRef.current);
    resetCopiedRef.current = window.setTimeout(() => {
      setIsCopied(false);
      resetCopiedRef.current = null;
    }, 1200);
  }, [copyText]);

  const label = isCopied ? 'Copied' : 'Copy code';

  if (inlinePlainText) {
    return (
      <div className="group relative my-2 max-w-full text-inherit leading-[var(--weave-chat-line-height)]">
        <code className="box-decoration-clone whitespace-pre-wrap break-words rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {copyText}
        </code>
        {showCopy ? (
          <Tooltip>
            <TooltipTrigger
              aria-label={label}
              className={cn(
                'ml-1 inline-flex size-5 align-text-bottom items-center justify-center rounded border border-border/70 bg-background/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-[background-color,border-color,color,opacity] hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:size-7 pointer-coarse:opacity-100',
                isCopied && 'text-foreground',
              )}
              disabled={!copyText}
              onClick={copyCode}
              title={label}
              type="button"
            >
              {isCopied ? <Check size={12} /> : <Clipboard size={12} />}
            </TooltipTrigger>
            <TooltipPopup side="right">{label}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    );
  }

  return (
    <div className="group relative my-3 max-w-full rounded-md bg-muted font-mono text-[length:var(--weave-chat-text-size)] leading-[var(--weave-chat-line-height)]">
      <div className="max-w-full overflow-x-auto p-3 pr-10">{children}</div>
      {showCopy ? (
        <Tooltip>
          <TooltipTrigger
            aria-label={label}
            className={cn(
              'absolute right-1.5 top-1.5 z-10 inline-flex size-6 items-center justify-center rounded-md border border-border/70 bg-background/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-[background-color,border-color,color,opacity] hover:bg-accent hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-40 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:size-8 pointer-coarse:opacity-100',
              isCopied && 'text-foreground',
            )}
            disabled={!copyText}
            onClick={copyCode}
            title={label}
            type="button"
          >
            {isCopied ? <Check size={14} /> : <Clipboard size={14} />}
          </TooltipTrigger>
          <TooltipPopup side="left">{label}</TooltipPopup>
        </Tooltip>
      ) : null}
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
        p: ({ children }) => <p className="my-3 leading-[var(--weave-chat-line-height)] first:mt-0 last:mb-0">{children}</p>,
        ul: ({ children, className }) => <ul className={cn('my-3 list-disc space-y-1 pl-6', className?.includes('contains-task-list') && 'list-none pl-0')}>{children}</ul>,
        ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>,
        li: ({ children, className }) => <li className={cn('pl-1 leading-[var(--weave-chat-line-height)] marker:text-muted-foreground', className?.includes('task-list-item') && 'flex items-start gap-2 pl-0')}>{children}</li>,
        strong: ({ children }) => <strong className="font-bold text-inherit">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        del: ({ children }) => <del className="text-muted-foreground line-through">{children}</del>,
        a: ({ children, href }) => <a href={href} className="break-all text-primary underline underline-offset-2" target="_blank" rel="noreferrer">{children}</a>,
        code: ({ children, className, node }) =>
          getChatCodeBlockRenderMode(className) !== 'plain' ? (
            <CodeBlock
              className={className}
              deferHighlight={shouldDeferCodeFenceHighlight(text, node?.position, deferCodeHighlight)}
            >
              {String(children)}
            </CodeBlock>
          ) : (
            <code className={cn('break-words rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]', className)}>{children}</code>
          ),
        pre: ({ children, node }) => {
          const renderMode = getChatCodeBlockRenderMode(getMarkdownCodeClassName(children));
          return (
            <MarkdownPre
              inlinePlainText={renderMode === 'plain'}
              showCopy={!shouldDeferCodeFenceHighlight(text, node?.position, deferCodeHighlight)}
            >
              {children}
            </MarkdownPre>
          );
        },
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

const RunningIndicator = ({ startedAt }: { startedAt: string | undefined }) => {
  const nowMs = useSecondTicker(Boolean(startedAt));
  const label = getWorkingForLabel(startedAt, nowMs);

  return (
    <span aria-label={label} className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 size={14} className="shrink-0 animate-spin text-primary" />
      <span>{label}</span>
    </span>
  );
};

const RunningIndicatorTail = ({ startedAt }: { startedAt: string | undefined }) => {
  const isRunning = useThread(state => state.isRunning);
  if (!isRunning) return null;

  return (
    <div className="chat-message-shell mx-auto w-full max-w-[var(--weave-chat-content-max-width)] px-4 py-3 sm:px-[38px]">
      <div className="chat-message-row flex min-w-0 justify-start">
        <div className="chat-message-bubble min-w-0 max-w-full text-[length:var(--weave-chat-text-size)] leading-[var(--weave-chat-line-height)]">
          <RunningIndicator startedAt={startedAt} />
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

type SteeredUserMessageFile = {
  url: string;
  mediaType: string;
  filename?: string;
};

const asObjectRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const getStringValue = (value: unknown) => typeof value === 'string' && value.length > 0 ? value : undefined;

const getSteeredUserMessageData = (part: unknown) => {
  const record = asObjectRecord(part);
  if (!record) return undefined;
  if (record.type === 'data' && record.name === 'user-message') return asObjectRecord(record.data);
  if (record.type === 'data-user-message') return asObjectRecord(record.data);
  return undefined;
};

const getSteeredUserMessageContent = (part: unknown) => {
  const data = getSteeredUserMessageData(part);
  if (!data) return undefined;

  const metadata = asObjectRecord(data.metadata);
  const originalText = getStringValue(metadata?.slashCommandOriginalText);
  const textParts: string[] = [];
  const files: SteeredUserMessageFile[] = [];
  const collectFile = (record: Record<string, unknown>) => {
    const url = getStringValue(record.url) ?? getStringValue(record.data);
    const mediaType = getStringValue(record.mediaType) ?? getStringValue(record.mimeType);
    if (!url || !mediaType?.startsWith('image/')) return;
    files.push({
      url,
      mediaType,
      ...(getStringValue(record.filename) ? { filename: getStringValue(record.filename) } : {}),
    });
  };

  if (typeof data.contents === 'string') {
    textParts.push(data.contents);
  } else if (Array.isArray(data.contents)) {
    for (const entry of data.contents) {
      const record = asObjectRecord(entry);
      if (!record) continue;
      if (record.type === 'text' && typeof record.text === 'string') textParts.push(record.text);
      if (record.type === 'file') collectFile(record);
    }
  }

  const text = (originalText ?? textParts.join('\n\n')).trim();
  if (!text && files.length === 0) return undefined;
  return { text, files };
};

const SteeredUserMessageBoundary = ({ part }: { part: unknown }) => {
  const content = getSteeredUserMessageContent(part);
  if (!content) return null;

  return (
    <div className="my-3 flex w-full justify-end">
      <div className="chat-message-bubble min-w-0 max-w-[78%] rounded-lg border border-mauve bg-mauve px-3.5 py-2 text-[length:var(--weave-chat-text-size)] leading-[var(--weave-chat-line-height)] text-primary-foreground">
        {content.text ? <MarkdownText text={content.text} /> : null}
        {content.files.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {content.files.map((file, index) => (
              <div key={`${file.url}:${index}`} className="group relative h-24 w-24 overflow-hidden rounded-md border border-primary-foreground/20 bg-primary-foreground/10">
                <img src={file.url} alt={file.filename ?? 'Attached image'} className="h-full w-full object-cover" />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const hasRenderableAssistantContent = (message: ThreadMessage, showReasoning: boolean) => {
  if (message.role !== 'assistant') return true;
  return message.content.some(part => {
    if (part.type === 'text' && typeof part.text === 'string') return part.text.trim().length > 0;
    if (part.type === 'reasoning' && showReasoning && typeof part.text === 'string') return part.text.trim().length > 0;
    if (isSteeredUserMessagePart(part)) return true;
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

const CollapsedTurnWorkToggle = ({ label, onExpand }: { label: string; onExpand: () => void }) => (
  <button
    type="button"
    className="group mb-2 flex max-w-full items-center gap-2 text-left text-xs font-medium text-muted-foreground/70 transition-colors hover:text-muted-foreground"
    aria-label="Show hidden work for this turn"
    onClick={onExpand}
  >
    <ChevronRight size={13} className="shrink-0 transition-transform group-hover:translate-x-0.5" />
    <span>{label}</span>
  </button>
);

const AssistantGroupedContent = ({
  deferCodeHighlight,
  autoCollapsed,
  collapsedWorkLabel,
  onExpandCollapsedTurn,
}: {
  deferCodeHighlight: boolean;
  autoCollapsed: boolean;
  collapsedWorkLabel: string;
  onExpandCollapsedTurn: () => void;
}) => {
  const parts = useAuiState(state => state.message.parts);
  const showReasoning = useChatStore(state => state.showReasoning);
  const autoCollapsedTextIndices = useMemo(
    () => autoCollapsed ? getAutoCollapsedAssistantTextPartIndices(parts, showReasoning) : [],
    [autoCollapsed, parts, showReasoning],
  );
  const ranges = useMemo(() => getAssistantContentRanges(parts, showReasoning), [parts, showReasoning]);

  if (autoCollapsedTextIndices.length > 0) {
    return (
      <>
        <CollapsedTurnWorkToggle label={collapsedWorkLabel} onExpand={onExpandCollapsedTurn} />
        {autoCollapsedTextIndices.map(index => {
          const part = parts[index];
          return getPartType(part) === 'text' && part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string'
            ? <MarkdownText key={index} text={(part as { text: string }).text} deferCodeHighlight={deferCodeHighlight} />
            : null;
        })}
      </>
    );
  }

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
        if (isSteeredUserMessagePart(part)) {
          return <SteeredUserMessageBoundary key={range.index} part={part} />;
        }

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
  const {
    autoCollapsedTurnIds,
    expandCollapsedTurn,
    finishAssistantTurnIfFollowing,
    liveAssistantTurnIds,
    markAssistantTurnRunning,
  } = useContext(ThreadAutoCollapseContext);
  const isEmptyAssistantMessage = message.role === 'assistant' && !hasRenderableAssistantContent(message, showReasoning);
  const isAssistantStreaming = message.role === 'assistant' && message.status?.type === 'running';
  const collapsedWorkLabel = getWorkedForLabel(message.metadata) ?? 'Show work';
  const previousAssistantStatusRef = useRef(message.role === 'assistant' ? message.status?.type : undefined);

  useEffect(() => {
    if (message.role !== 'assistant') return;

    const previousStatus = previousAssistantStatusRef.current;
    const currentStatus = message.status?.type;
    const isRunning = currentStatus === 'running';
    if (isRunning) {
      markAssistantTurnRunning(message.id);
    }

    const finishedLiveTurn = (previousStatus === 'running' || liveAssistantTurnIds[message.id]) && !isRunning;
    previousAssistantStatusRef.current = currentStatus;

    if (!finishedLiveTurn) return;
    finishAssistantTurnIfFollowing(
      message.id,
      getAutoCollapsedAssistantTextPartIndices(message.content, showReasoning).length > 0,
    );
  }, [finishAssistantTurnIfFollowing, liveAssistantTurnIds, markAssistantTurnRunning, message.content, message.id, message.role, message.status?.type, showReasoning]);

  if (isEmptyAssistantMessage) {
    return <AssistantToolSideEffects message={message} />;
  }

  return (
    <>
      <AssistantToolSideEffects message={message} />
      {message.role === 'assistant' ? (
        <AssistantGroupedContent
          autoCollapsed={Boolean(autoCollapsedTurnIds[message.id]) && !isAssistantStreaming}
          collapsedWorkLabel={collapsedWorkLabel}
          deferCodeHighlight={isAssistantStreaming}
          onExpandCollapsedTurn={() => expandCollapsedTurn(message.id)}
        />
      ) : (
        <MessagePrimitive.Content components={{ Text: MarkdownText, Reasoning, tools: { Override: ToolCall } }} />
      )}
    </>
  );
};

const ProposalActionUserBubble = ({ kind }: { kind: 'proposal_review_feedback' | 'proposal_implementation_request' }) => {
  const isFeedback = kind === 'proposal_review_feedback';
  const label = getProposalActionDisplayLabel({ kind });

  return (
    <div
      className={cn(
        'chat-message-bubble inline-flex min-w-0 items-center gap-2 rounded-lg border px-3.5 py-2 text-[length:var(--weave-chat-text-size)] font-medium leading-[var(--weave-chat-line-height)] text-[#11111b]',
        isFeedback
          ? 'border-warning bg-warning'
          : 'border-success-button bg-success-button',
      )}
    >
      <GitPullRequestArrow size={14} className="shrink-0" />
      {label}
      <div className="text-red-950">
        <MessagePrimitive.Error />
      </div>
    </div>
  );
};

const getThreadMessageText = (message: ThreadMessage) =>
  message.content
    .filter((part): part is { type: 'text'; text: string } =>
      part.type === 'text' && 'text' in part && typeof part.text === 'string',
    )
    .map(part => part.text)
    .join('');

const UserMessageContent = () => {
  const message = useMessage();
  const proposalActionDisplay = getProposalActionDisplay(message.metadata, getThreadMessageText(message));

  if (proposalActionDisplay) {
    return <ProposalActionUserBubble kind={proposalActionDisplay.kind} />;
  }

  return (
    <div className="chat-message-bubble min-w-0 max-w-[78%] rounded-lg border border-mauve bg-mauve px-3.5 py-2 text-[length:var(--weave-chat-text-size)] leading-[var(--weave-chat-line-height)] text-primary-foreground">
      <MessagePrimitive.Content components={{ Text: MarkdownText, Reasoning, tools: { Override: ToolCall } }} />
      <div className="mt-3 flex flex-wrap gap-2 empty:hidden">
        <MessageImageAttachments />
      </div>
      <div className="text-red-950">
        <MessagePrimitive.Error />
      </div>
    </div>
  );
};

const ThreadMessage = () => (
  <MessagePrimitive.Root className="chat-message-shell mx-auto w-full max-w-[var(--weave-chat-content-max-width)] px-4 py-3 sm:px-[38px]">
    <MessagePrimitive.If assistant>
      <div className="chat-message-row flex min-w-0 justify-start">
        <div className="chat-message-bubble min-w-0 max-w-full text-[length:var(--weave-chat-text-size)] leading-[var(--weave-chat-line-height)]">
          <AssistantMessageContent />
          <div className="text-red-300">
            <MessagePrimitive.Error />
          </div>
        </div>
      </div>
    </MessagePrimitive.If>
    <MessagePrimitive.If user>
      <div className="chat-message-row flex min-w-0 justify-end">
        <UserMessageContent />
      </div>
    </MessagePrimitive.If>
  </MessagePrimitive.Root>
);

type ReasoningOption = { value: ReasoningEffort; label: string; detail?: string };

const defaultFallbackReasoningOption: ReasoningOption = { value: 'medium', label: 'Medium', detail: 'Balanced reasoning' };
const fallbackReasoningOptions: ReasoningOption[] = [
  { value: 'low', label: 'Low', detail: 'Light reasoning' },
  defaultFallbackReasoningOption,
  { value: 'high', label: 'High', detail: 'Deeper reasoning' },
  { value: 'xhigh', label: 'Extra High', detail: 'Extra reasoning depth' },
];

const asReasoningEffort = (value: unknown): ReasoningEffort | undefined =>
  value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : undefined;

const asServiceTier = (value: unknown): ServiceTier | undefined =>
  value === 'auto' || value === 'default' || value === 'flex' || value === 'priority'
    ? value
    : undefined;

const activeModelId = (selectedModel: string, modelConfig: Awaited<ReturnType<typeof fetchModelConfig>> | undefined) =>
  selectedModel || modelConfig?.defaultModel || '';

const activeModelOption = (modelId: string, modelOptions: ModelOption[]) =>
  modelOptions.find(model => model.id === modelId);

const reasoningOptionsForModel = (model: ModelOption | undefined, isLoaded: boolean): ReasoningOption[] => {
  if (!model) return isLoaded ? [] : fallbackReasoningOptions;

  const options = model?.supportedReasoningEfforts
    ?.map(option => {
      const value = asReasoningEffort(option.effort);
      return value
        ? {
            value,
            label: option.label,
            ...(option.description ? { detail: option.description } : {}),
          }
        : undefined;
    })
    .filter((option): option is ReasoningOption => Boolean(option)) ?? [];
  return options;
};

const reasoningToneClassName = (value: ReasoningEffort | undefined) => {
  switch (value) {
    case 'low':
      return 'text-success hover:text-success';
    case 'medium':
      return 'text-blue hover:text-blue';
    case 'high':
      return 'text-peach hover:text-peach';
    case 'xhigh':
      return 'text-[var(--ctp-maroon)] hover:text-[var(--ctp-maroon)]';
    default:
      return 'text-muted-foreground hover:text-foreground';
  }
};

const reasoningMenuLabel = (option: ReasoningOption) =>
  option.value === 'low' ? 'Light' : option.label;

const ModelSettingsPicker = () => {
  const isRunning = useThread(state => state.isRunning);
  const selectedModel = useChatStore(state => state.selectedModel);
  const setSelectedModel = useChatStore(state => state.setSelectedModel);
  const reasoningEffort = useChatStore(state => state.reasoningEffort);
  const setReasoningEffort = useChatStore(state => state.setReasoningEffort);
  const serviceTier = useChatStore(state => state.serviceTier);
  const setServiceTier = useChatStore(state => state.setServiceTier);
  const { data: modelConfig } = useQuery({
    queryKey: ['models'],
    queryFn: fetchModelConfig,
    staleTime: 1000 * 60 * 5,
  });
  const modelOptions = modelConfig?.options ?? [];
  const activeModel = activeModelId(selectedModel, modelConfig);
  const model = activeModelOption(activeModel, modelOptions);
  const reasoningOptions = useMemo(() => reasoningOptionsForModel(model, Boolean(modelConfig)), [model, modelConfig]);
  const defaultReasoningEffort = asReasoningEffort(model?.defaultReasoningEffort)
    ?? reasoningOptions.find(option => option.value === 'medium')?.value
    ?? reasoningOptions[0]?.value
    ?? 'medium';
  const active = reasoningOptions.find(option => option.value === reasoningEffort)
    ?? reasoningOptions.find(option => option.value === defaultReasoningEffort)
    ?? reasoningOptions[0]
    ?? defaultFallbackReasoningOption;
  const activeReasoningValue = reasoningOptions.length > 0 ? active.value : undefined;
  const activeServiceTier = serviceTier ? asServiceTier(serviceTier) : undefined;
  const priorityTier = model?.serviceTiers?.find(tier => tier.id === 'priority');
  const supportsActiveServiceTier = Boolean(activeServiceTier && model?.serviceTiers?.some(tier => tier.id === activeServiceTier));
  const fastEnabled = activeServiceTier === 'priority' && supportsActiveServiceTier;
  const disabled = isRunning || modelOptions.length === 0;
  const modelLabel = activeModel ? getResolvedModelDisplayName(activeModel, modelOptions) : 'Model';
  const titleParts = [
    modelLabel,
    reasoningOptions.length > 0 ? `Reasoning: ${reasoningMenuLabel(active)}` : undefined,
    priorityTier ? `Speed: ${fastEnabled ? priorityTier.name : 'Standard'}` : undefined,
  ].filter(Boolean);

  useEffect(() => {
    if (!selectedModel && modelConfig?.defaultModel) setSelectedModel(modelConfig.defaultModel);
  }, [modelConfig?.defaultModel, selectedModel, setSelectedModel]);

  useEffect(() => {
    if (reasoningOptions.length > 0 && !reasoningOptions.some(option => option.value === reasoningEffort)) {
      setReasoningEffort(defaultReasoningEffort);
    }
  }, [defaultReasoningEffort, reasoningEffort, reasoningOptions, setReasoningEffort]);

  useEffect(() => {
    if (activeServiceTier && modelConfig && !supportsActiveServiceTier) setServiceTier(null);
  }, [activeServiceTier, modelConfig, setServiceTier, supportsActiveServiceTier]);

  return (
    <div className="model-picker min-w-0 shrink-0">
      <Menu>
        <MenuTrigger
          render={(
            <Button
              type="button"
              aria-label="Model, reasoning, and speed"
              title={titleParts.join(' - ')}
              disabled={disabled}
              variant="ghost"
              className={cn(
                'h-9 min-w-0 max-w-44 justify-start px-2 hover:bg-muted sm:max-w-52',
                reasoningToneClassName(activeReasoningValue),
              )}
            >
              {fastEnabled ? <Zap size={16} className="shrink-0" /> : null}
              <span className="min-w-0 truncate">{modelLabel}</span>
            </Button>
          )}
        />
        <MenuPopup align="start" sideOffset={4} className="w-64 sm:w-72">
          {reasoningOptions.length > 0 ? (
            <>
              <MenuRadioGroup
                value={active.value}
                onValueChange={value => {
                  const next = asReasoningEffort(value);
                  if (next && reasoningOptions.some(option => option.value === next)) {
                    setReasoningEffort(next);
                  }
                }}
              >
                <MenuGroupLabel>Reasoning</MenuGroupLabel>
                {reasoningOptions.map(option => (
                  <MenuRadioItem key={option.value} value={option.value} indicatorPosition="end">
                    <span className="truncate">{reasoningMenuLabel(option)}</span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
              <MenuSeparator />
            </>
          ) : null}
          <MenuSub>
            <MenuSubTrigger className="min-w-0">
              <span className="min-w-0 truncate">{modelLabel}</span>
            </MenuSubTrigger>
            <MenuSubPopup className="w-72">
              <MenuRadioGroup value={activeModel} onValueChange={value => setSelectedModel(value)}>
                {modelOptions.map(option => (
                  <MenuRadioItem key={option.id} value={option.id} indicatorPosition="end" className="min-h-10">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{option.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{option.id}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          {priorityTier ? (
            <MenuSub>
              <MenuSubTrigger>Speed</MenuSubTrigger>
              <MenuSubPopup className="w-64">
                <MenuRadioGroup
                  value={fastEnabled ? 'priority' : 'standard'}
                  onValueChange={value => setServiceTier(value === 'priority' ? 'priority' : null)}
                >
                  <MenuRadioItem value="standard" indicatorPosition="end">
                    <span className="truncate">Standard</span>
                  </MenuRadioItem>
                  <MenuRadioItem value="priority" indicatorPosition="end">
                    <span className="flex min-w-0 items-center gap-2">
                      <Zap size={16} className="shrink-0" />
                      <span className="truncate">{priorityTier.name}</span>
                    </span>
                  </MenuRadioItem>
                </MenuRadioGroup>
              </MenuSubPopup>
            </MenuSub>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
};

const FollowWritesToggle = ({ canFollowWrites }: { canFollowWrites: boolean }) => {
  const followWrites = useChatStore(state => state.followWrites);
  const setFollowWrites = useChatStore(state => state.setFollowWrites);

  if (!canFollowWrites) return null;

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      aria-label={followWrites ? 'Disable follow writes' : 'Enable follow writes'}
      aria-pressed={followWrites}
      title={followWrites ? 'Disable follow writes' : 'Enable follow writes'}
      onClick={() => setFollowWrites(!followWrites)}
      className={cn(
        'h-9 w-9 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground',
        followWrites && 'text-primary hover:text-primary',
      )}
    >
      <Crosshair size={16} />
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
            index === activeIndex ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
          )}
        >
          <span className="w-28 shrink-0 font-medium text-foreground">/{prompt.name}</span>
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
    <div className="relative text-[length:var(--weave-chat-text-size)] leading-[var(--weave-chat-line-height)]">
      {match && isKnownCommand ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 min-h-10 overflow-hidden whitespace-pre-wrap break-words p-0 font-[inherit] leading-[var(--weave-chat-line-height)] text-foreground"
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
          'relative max-h-40 min-h-6 w-full resize-none bg-transparent p-0 text-[length:var(--weave-chat-text-size)] leading-[var(--weave-chat-line-height)] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-70',
          match && isKnownCommand && 'text-transparent caret-foreground',
        )}
      />
    </div>
  );
};

const Composer = ({ canFollowWrites }: { canFollowWrites: boolean }) => {
  const aui = useAui();
  const threadId = useContext(ThreadIdContext);
  const queryClient = useQueryClient();
  const resourceId = useChatStore(state => state.resourceId);
  const composerRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const skippedInitialDraftWriteThreadRef = useRef<string | null>(null);
  const composerTextRef = useRef('');
  const isEmpty = useThread(state => state.messages.length === 0 && !state.isLoading);
  const isLocalThreadRunning = useThread(state => state.isRunning);
  const composerText = useAuiState(state => state.composer.text);
  const isComposerEmpty = useAuiState(state => state.composer.isEmpty);
  const composerAttachments = useAuiState(state => state.composer.attachments);
  const runningThreadIds = useChatStore(state => state.runningThreadIds);
  const thread = useChatStore(state => state.threads.find(item => item.id === threadId));
  const isThreadRunning = isLocalThreadRunning || Boolean(threadId && runningThreadIds.includes(threadId));
  const isRemovedWorkspaceThread = Boolean(thread?.removedWorkspace);
  const [isSteeringSending, setIsSteeringSending] = useState(false);
  const [emptyPlaceholder] = useState(getRandomEmptyThreadPlaceholder);
  const [activeIndex, setActiveIndex] = useState(0);
  const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(composerText);
  const promptContext = useMemo(
    () => promptContextForThread(threadId, thread),
    [threadId, thread?.projectId, thread?.workspaceId],
  );
  const { data: prompts = [] } = useQuery({
    queryKey: ['prompts', promptContext.threadId ?? null, promptContext.projectId ?? null, promptContext.workspaceId ?? null],
    queryFn: () => listPrompts(promptContext),
    staleTime: 1000 * 60,
  });
  const { data: chatgptAuth } = useQuery({
    queryKey: ['chatgpt-auth-status'],
    queryFn: getChatGPTAuthStatus,
    staleTime: 10_000,
  });
  const isChatGPTConnected = chatgptAuth?.connected === true;
  const isSendActive = isChatGPTConnected && !isComposerEmpty && !isRemovedWorkspaceThread;
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

  useEffect(() => {
    composerTextRef.current = composerText;
  }, [composerText]);

  useEffect(() => {
    if (!threadId) return;
    const draft = loadComposerDraft(threadId);
    if (draft.length === 0 || composerTextRef.current.length > 0) {
      skippedInitialDraftWriteThreadRef.current = null;
      return;
    }

    skippedInitialDraftWriteThreadRef.current = threadId;
    aui.composer().setText(draft);
  }, [aui, threadId]);

  useEffect(() => {
    if (!threadId) return;
    if (skippedInitialDraftWriteThreadRef.current === threadId) {
      skippedInitialDraftWriteThreadRef.current = null;
      return;
    }

    saveComposerDraft(threadId, composerText);
  }, [composerText, threadId]);

  const markDraftAwaitingSend = () => {
    if (!threadId || composerText.length === 0) return;
    markComposerDraftAwaitingServerAck(threadId, composerText);
  };

  const selectPrompt = (prompt: PromptSummary) => {
    aui.composer().setText(`/${prompt.name} `);
    setActiveIndex(0);
  };

  const sendSteeringMessage = useCallback(async () => {
    if (!threadId || isSteeringSending || !isSendActive) return;

    const originalText = composerText;
    const attachments = [...composerAttachments];
    markComposerDraftAwaitingServerAck(threadId, originalText);
    setIsSteeringSending(true);

    try {
      const lastUserText = originalText.trim();
      const slashCommand = parseSlashCommand(lastUserText);
      const messageText = slashCommand
        ? await expandPrompt(slashCommand.name, slashCommand.args, promptContext)
        : originalText;
      const metadata = slashCommand
        ? {
            slashCommandOriginalText: lastUserText,
            slashCommandName: slashCommand.name,
          }
        : undefined;
      const message = await buildSteeringUserMessage(messageText, attachments, metadata);
      const result = await sendThreadSteeringMessage(threadId, message);

      if (!result.ok) {
        aui.composer().send();
        return;
      }

      confirmComposerDraftReceived(threadId);
      const currentComposer = aui.composer().getState();
      const sameAttachments =
        currentComposer.attachments.length === attachments.length &&
        currentComposer.attachments.every((attachment, index) => attachment.id === attachments[index]?.id);
      if (currentComposer.text === originalText && sameAttachments) {
        await aui.composer().reset();
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['thread-run', resourceId, threadId] }),
        queryClient.invalidateQueries({ queryKey: ['threads', resourceId] }),
        queryClient.invalidateQueries({ queryKey: ['thread-context-usage', resourceId, threadId] }),
      ]);
    } catch (error) {
      abandonComposerDraftServerAck(threadId);
      const currentText = aui.composer().getState().text;
      saveComposerDraft(threadId, currentText.length > 0 ? currentText : originalText);
      console.error('[chat] failed to send steering message', error);
    } finally {
      setIsSteeringSending(false);
    }
  }, [aui, composerAttachments, composerText, isSendActive, isSteeringSending, promptContext, queryClient, resourceId, threadId]);

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = event => {
    if (slashMatch && promptMatches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex(index => (index + 1) % Math.min(promptMatches.length, 8));
        return;
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex(index => (index - 1 + Math.min(promptMatches.length, 8)) % Math.min(promptMatches.length, 8));
        return;
      } else if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        selectPrompt(promptMatches[Math.min(activeIndex, promptMatches.length - 1)].prompt);
        return;
      } else if (event.key === 'Escape') {
        setActiveIndex(0);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey && isThreadRunning && isSendActive) {
      event.preventDefault();
      void sendSteeringMessage();
    }
  };

  const handleComposerSubmit: React.FormEventHandler<HTMLFormElement> = event => {
    if (!isThreadRunning || !isSendActive) return;
    event.preventDefault();
    void sendSteeringMessage();
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
      onSubmitCapture={markDraftAwaitingSend}
      onSubmit={handleComposerSubmit}
      className="relative mx-auto w-full max-w-[var(--weave-chat-content-max-width)] rounded-xl border border-border bg-card px-4 py-3 shadow-sm"
      data-weave-text-surface="true"
    >
      {slashMatch && isChatGPTConnected ? <PromptSlashMenu prompts={prompts} query={slashMatch[1] ?? ''} activeIndex={activeIndex} onSelect={selectPrompt} /> : null}
      <div className="mb-3 flex flex-wrap gap-2 empty:hidden">
        <ComposerImageAttachments />
      </div>
      <SlashHighlightedInput
        inputRef={inputRef}
        value={composerText}
        placeholder={isRemovedWorkspaceThread
          ? 'Workspace removed; transcript is read-only'
          : isChatGPTConnected
          ? (isEmpty ? emptyPlaceholder : 'Ask for follow-up changes or attach images')
          : 'Connect ChatGPT to start chatting'}
        knownPromptNames={knownPromptNames}
        onKeyDown={handleKeyDown}
        disabled={!isChatGPTConnected || isRemovedWorkspaceThread}
      />
      <div className="mt-5 flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {isRemovedWorkspaceThread ? null : (
            <ComposerPrimitive.AddAttachment
              render={<Button type="button" size="icon" variant="ghost" className="h-9 w-9 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Attach image" />}
            >
              <Plus size={18} strokeWidth={2.5} />
            </ComposerPrimitive.AddAttachment>
          )}
          <ModelSettingsPicker />
          <FollowWritesToggle canFollowWrites={canFollowWrites} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {isEmpty ? null : <ContextUsageRing threadId={threadId} />}
          {!isThreadRunning ? (
            isRemovedWorkspaceThread ? null : isChatGPTConnected ? (
              <ComposerPrimitive.Send
                render={(
                  <Button
                    size="icon-lg"
                    variant={isSendActive ? 'default' : 'ghost'}
                    className={cn(
                      'shrink-0 rounded-full',
                      isSendActive
                        ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90'
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
                className="h-11 w-11 shrink-0 rounded-full text-primary"
              >
                <KeyRound size={20} />
              </Button>
            )
          ) : isSendActive ? (
            <Button
              type="submit"
              aria-label="Send steering message"
              title="Send steering message"
              disabled={isSteeringSending}
              size="icon-lg"
              variant="default"
              className="shrink-0 rounded-full border-primary bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {isSteeringSending ? <Loader2 size={18} className="animate-spin" /> : <Send size={20} />}
            </Button>
          ) : null}
          {isThreadRunning ? (
            <ComposerPrimitive.Cancel
              onClick={() => void stopThreadRun()}
              render={<Button size="icon-lg" variant="ghost" className="h-11 w-11 shrink-0 rounded-full text-primary" aria-label="Stop generation" title="Stop generation" />}
            >
              <Square size={18} fill="currentColor" strokeWidth={2.5} />
            </ComposerPrimitive.Cancel>
          ) : null}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};

const ThreadRunningTracker = ({ threadId }: { threadId: string }) => {
  const wasRunning = useRef(false);
  const resourceId = useChatStore(state => state.resourceId);
  const isLocalRunning = useThread(state => state.isRunning);
  const activeThreadId = useWorkspaceSurfaceStore(state => state.threadId);
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

    if (wasRunning.current && !isRunning) {
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
  const activeThreadId = useWorkspaceSurfaceStore(state => state.threadId);
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

const bottomFollowThresholdPx = 64;

const isViewportAtBottom = (element: HTMLElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight <= bottomFollowThresholdPx;

const Thread = ({
  autoCollapseContext,
  activeRunStartedAt,
  canFollowWrites,
  setIsFollowingBottom,
}: AutoCollapsedTurnStateProps & { activeRunStartedAt: string | undefined; canFollowWrites: boolean }) => {
  const threadId = useContext(ThreadIdContext);
  const isDraft = useChatStore(state => state.threads.find(thread => thread.id === threadId)?.draft === true);
  const pendingProposalImplementationRequest = useChatStore(state => threadId ? state.pendingProposalImplementationRequests[threadId] : undefined);
  const isRunning = useThread(state => state.isRunning);
  const messages = useThread(state => state.messages);
  const isEmptyIdleDraft = isDraft && !isRunning && messages.length === 0;
  const composerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);

  const updateBottomFollowState = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    setIsFollowingBottom(isViewportAtBottom(viewport));
  }, [setIsFollowingBottom]);

  useEffect(() => {
    const composer = composerRef.current;
    if (!composer) return undefined;

    const updateComposerHeight = () => setComposerHeight(composer.getBoundingClientRect().height);
    updateComposerHeight();

    const resizeObserver = new ResizeObserver(updateComposerHeight);
    resizeObserver.observe(composer);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(updateBottomFollowState);
    return () => window.cancelAnimationFrame(frame);
  }, [isRunning, messages, updateBottomFollowState]);

  useEffect(() => {
    if (pendingProposalImplementationRequest?.mode !== 'implement') return undefined;
    setIsFollowingBottom(true);
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      const viewport = viewportRef.current;
      if (viewport) viewport.scrollTop = viewport.scrollHeight;
      secondFrame = window.requestAnimationFrame(() => {
        const nextViewport = viewportRef.current;
        if (nextViewport) nextViewport.scrollTop = nextViewport.scrollHeight;
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, [pendingProposalImplementationRequest?.id, pendingProposalImplementationRequest?.mode, setIsFollowingBottom]);

  return (
    <ThreadAutoCollapseContext.Provider value={autoCollapseContext}>
      <ThreadPrimitive.Root
        className={cn('flex h-full flex-col bg-background', isEmptyIdleDraft && 'justify-center')}
        style={{ '--composer-height': `${composerHeight}px` } as React.CSSProperties}
      >
        <ThreadPrimitive.Viewport
          ref={viewportRef}
          className={cn('min-h-0 flex-1 overflow-y-auto', isEmptyIdleDraft && 'hidden')}
          onScroll={updateBottomFollowState}
        >
          <ThreadPrimitive.Messages components={{ UserMessage: ThreadMessage, AssistantMessage: ThreadMessage }} />
          <RunningIndicatorTail startedAt={activeRunStartedAt} />
        </ThreadPrimitive.Viewport>
        <div ref={composerRef} className={cn('shrink-0 bg-background p-4 pb-[calc(1rem+var(--weave-safe-area-bottom))]', isEmptyIdleDraft && 'w-full pb-4')}>
          {threadId ? <GuidedTaskCard threadId={threadId} /> : null}
          <Composer canFollowWrites={canFollowWrites} />
        </div>
      </ThreadPrimitive.Root>
    </ThreadAutoCollapseContext.Provider>
  );
};

type AssistantChatProps = {
  canFollowWrites: boolean;
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

const AssistantChatRuntime = ({
  canFollowWrites,
  threadId,
  initialMessages,
  autoCollapseContext,
  setIsFollowingBottom,
}: AssistantChatProps & { initialMessages: UIMessage[] } & AutoCollapsedTurnStateProps) => {
  const queryClient = useQueryClient();
  const resourceId = useChatStore(state => state.resourceId);
  const selectedModel = useChatStore(state => state.selectedModel);
  const reasoningEffort = useChatStore(state => state.reasoningEffort);
  const serviceTier = useChatStore(state => state.serviceTier);
  const pendingProposalImplementationRequest = useChatStore(state => state.pendingProposalImplementationRequests[threadId]);
  const consumeProposalImplementationRequest = useChatStore(state => state.consumeProposalImplementationRequest);
  const markThreadCompleted = useChatStore(state => state.markThreadCompleted);
  const chatApi = getChatUrl();
  const resumeRunIdRef = useRef<string | undefined>(undefined);
  const sendingProposalImplementationRequestRef = useRef<string | undefined>(undefined);
  const { data: modelConfig } = useQuery({
    queryKey: ['models'],
    queryFn: fetchModelConfig,
    staleTime: 1000 * 60 * 5,
  });
  const modelOptions = modelConfig?.options ?? [];
  const activeModel = activeModelId(selectedModel, modelConfig);
  const model = activeModelOption(activeModel, modelOptions);
  const requestServiceTier = serviceTier && model?.serviceTiers?.some(tier => tier.id === serviceTier) ? serviceTier : null;
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
        async fetch(input, init) {
          const response = await globalThis.fetch(input, init);
          const method = init?.method?.toUpperCase() ?? 'GET';
          if (method === 'POST' && response.ok && response.body) {
            confirmComposerDraftReceived(threadId);
          }
          return response;
        },
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
          const promptContext = promptContextForThread(threadId, threadBeforePersist);
          markComposerDraftAwaitingServerAck(threadId, lastUserText);
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
              messages: latestUserMessageOnly(requestMessages),
              ...(selectedModel ? { model: selectedModel } : {}),
              reasoningEffort,
              ...(requestServiceTier ? { serviceTier: requestServiceTier } : {}),
              memory: {
                thread: threadId,
              },
            },
          };
        },
      }),
    [chatApi, reasoningEffort, requestServiceTier, selectedModel, threadId],
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
      markThreadCompleted(threadId);
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
    const request = pendingProposalImplementationRequest;
    if (!request) return;
    if (chat.status !== 'ready' || runState?.active === true) return;
    if (sendingProposalImplementationRequestRef.current === request.id) return;

    sendingProposalImplementationRequestRef.current = request.id;
    void chat.sendMessage(buildProposalImplementationUserMessage(request)).then(() => {
      consumeProposalImplementationRequest(threadId, request.id);
    }).catch(error => {
      console.error('[chat] failed to start proposal implementation', error);
    }).finally(() => {
      if (sendingProposalImplementationRequestRef.current === request.id) {
        sendingProposalImplementationRequestRef.current = undefined;
      }
    });
  }, [chat, consumeProposalImplementationRequest, pendingProposalImplementationRequest, runState?.active, threadId]);

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
        <Thread
          autoCollapseContext={autoCollapseContext}
          activeRunStartedAt={runState?.active === true ? runState.startedAt : undefined}
          canFollowWrites={canFollowWrites}
          setIsFollowingBottom={setIsFollowingBottom}
        />
      </ThreadIdContext.Provider>
    </AssistantRuntimeProvider>
  );
};

export const AssistantChat = ({ canFollowWrites, threadId }: AssistantChatProps) => {
  const resourceId = useChatStore(state => state.resourceId);
  const isDraft = useChatStore(state => state.threads.find(thread => thread.id === threadId)?.draft === true);
  const isRunning = useChatStore(state => state.runningThreadIds.includes(threadId));
  const showReasoning = useChatStore(state => state.showReasoning);
  const [autoCollapsedTurnIds, setAutoCollapsedTurnIds] = useState<AutoCollapsedTurnIds>({});
  const [expandedAutoCollapsedTurnIds, setExpandedAutoCollapsedTurnIds] = useState<AutoCollapsedTurnIds>({});
  const [liveAssistantTurnIds, setLiveAssistantTurnIds] = useState<AutoCollapsedTurnIds>({});
  const isFollowingBottomRef = useRef(true);
  const { data: initialMessages = [], isLoading } = useQuery({
    queryKey: ['thread-messages', resourceId, threadId],
    queryFn: () => listServerMessages(threadId),
    enabled: !isDraft,
    staleTime: 0,
  });

  useEffect(() => {
    setAutoCollapsedTurnIds({});
    setExpandedAutoCollapsedTurnIds({});
    setLiveAssistantTurnIds({});
    isFollowingBottomRef.current = true;
  }, [threadId]);

  useEffect(() => {
    const defaults = getDefaultAutoCollapsedAssistantTurnIds(initialMessages, showReasoning, expandedAutoCollapsedTurnIds);
    setAutoCollapsedTurnIds(previous => {
      const next: AutoCollapsedTurnIds = { ...previous };
      for (const id of Object.keys(expandedAutoCollapsedTurnIds)) {
        delete next[id];
      }
      for (const id of Object.keys(defaults)) {
        next[id] = true;
      }
      return areAutoCollapsedTurnIdsEqual(previous, next) ? previous : next;
    });
  }, [expandedAutoCollapsedTurnIds, initialMessages, showReasoning]);

  const setIsFollowingBottom = useCallback((value: boolean) => {
    isFollowingBottomRef.current = value;
  }, []);

  const markAssistantTurnRunning = useCallback((messageId: string) => {
    setLiveAssistantTurnIds(previous => previous[messageId] ? previous : { ...previous, [messageId]: true });
  }, []);

  const finishAssistantTurnIfFollowing = useCallback((messageId: string, shouldCollapse: boolean) => {
    setLiveAssistantTurnIds(previous => {
      if (!previous[messageId]) return previous;
      const next = { ...previous };
      delete next[messageId];
      return next;
    });

    if (!shouldCollapse || !isFollowingBottomRef.current) return;
    setExpandedAutoCollapsedTurnIds(previous => {
      if (!previous[messageId]) return previous;
      const next = { ...previous };
      delete next[messageId];
      return next;
    });
    setAutoCollapsedTurnIds(previous => previous[messageId] ? previous : { ...previous, [messageId]: true });
  }, []);

  const expandCollapsedTurn = useCallback((messageId: string) => {
    setExpandedAutoCollapsedTurnIds(previous => previous[messageId] ? previous : { ...previous, [messageId]: true });
    setAutoCollapsedTurnIds(previous => {
      if (!previous[messageId]) return previous;
      const next = { ...previous };
      delete next[messageId];
      return next;
    });
  }, []);

  const autoCollapseContext = useMemo<ThreadAutoCollapseContextValue>(
    () => ({
      autoCollapsedTurnIds,
      expandCollapsedTurn,
      finishAssistantTurnIfFollowing,
      liveAssistantTurnIds,
      markAssistantTurnRunning,
    }),
    [autoCollapsedTurnIds, expandCollapsedTurn, finishAssistantTurnIfFollowing, liveAssistantTurnIds, markAssistantTurnRunning],
  );

  if (!isDraft && isLoading && !isRunning) return <div className="h-full bg-background" />;

  return (
    <AssistantChatRuntime
      key={`${threadId}:${getMessagesVersion(initialMessages)}`}
      canFollowWrites={canFollowWrites}
      threadId={threadId}
      initialMessages={initialMessages}
      autoCollapseContext={autoCollapseContext}
      setIsFollowingBottom={setIsFollowingBottom}
    />
  );
};
