import { composerDrafts, composerDraftListeners, discardComposerDraft, writeComposerDraft, type ComposerDraft } from './composer-drafts';
import { transcriptItems } from './transcript-runs';
import { WorkRunView } from './work-run-view';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { PromptImage, QueuedPrompt } from '@/app/app-controller';
import { Capacitor } from '@capacitor/core';
import type {
  CreateElicitationResponse,
  SessionConfigOption,
} from '@/host/protocol';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiBrainIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  ImageAdd01Icon,
  Loading03Icon,
  SendIcon,
  StopIcon,
} from '@hugeicons/core-free-icons';
import type {
  AcpTranscript,
  TranscriptClientTool,
  TranscriptCompaction,
  TranscriptEntry,
  TranscriptMessage,
} from './acp-transcript';
import { ContentBlocksView } from './content-block-view';
import { ElicitationView } from './elicitation-view';
import { requestEndText, sentenceStart } from './pending-request';
import { PlanView } from './plan-view';
import { imagesSize, MAX_PROMPT_IMAGE_BYTES, promptImage } from './prompt-images';
import { SessionMessageView, SubagentRowView } from './subagent-view';
import { ToolCallView } from './tool-call-view';
import { TranscriptContext, type TranscriptContextValue } from './transcript-context';
import { Badge } from '@/components/ui/badge';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input';
import { Bubble, BubbleContent, BubbleGroup } from '@/components/ui/bubble';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import {
  Message,
  MessageContent,
} from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller';
import { Context, ContextContent, ContextTrigger } from '@/components/ai-elements/context';
import { cn } from '@/lib/utils';

export type ChatPaneActions = {
  setDraftText?(sessionId: string, text: string): void;
  /** Starts a turn, or while one runs, steers it or queues the message. */
  send(text: string, images?: PromptImage[]): Promise<void> | void;
  removeQueued?(id: string): void;
  /** Starts the Host's paused queue again. */
  resumeQueue?(): Promise<void> | void;
  cancelTurn(): Promise<void> | void;
  respondToPermission(requestId: string, optionId: string): Promise<void> | void;
  respondToElicitation(requestId: string, response: CreateElicitationResponse): Promise<void> | void;
  setMode(modeId: string): Promise<void> | void;
  setConfigOption(optionId: string, value: string | boolean): Promise<void> | void;
};

function MessageEntryView({
  message,
  isStreaming,
}: {
  message: TranscriptMessage;
  isStreaming: boolean;
}) {
  const isUser = message.role === 'user';
  const note = [message.steer ? 'Steered into the turn' : undefined, message.origin ? `From ${message.origin}` : undefined]
    .filter(Boolean)
    .join(' · ');
  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
        {note && <span className="text-[0.625rem] text-muted-foreground" data-slot="message-origin">{note}</span>}
        <BubbleGroup className={cn(isUser && 'w-full')}>
          {message.chunks.map((chunk, index) => {
            if (chunk.kind === 'thought') {
              return (
                <Reasoning
                  key={`${chunk.messageId ?? 'thought'}-${index}`}
                  isStreaming={isStreaming}
                >
                  <ReasoningTrigger>
                    <HugeiconsIcon data-icon="inline-start" icon={AiBrainIcon} strokeWidth={1.75} />
                    Thinking
                  </ReasoningTrigger>
                  <ReasoningContent>
                    <ContentBlocksView blocks={chunk.content} isStreaming={isStreaming && index === message.chunks.length - 1} />
                  </ReasoningContent>
                </Reasoning>
              );
            }
            return (
              <Bubble
                key={`${chunk.messageId ?? 'message'}-${index}`}
                align={isUser ? 'end' : 'start'}
                variant={isUser ? 'outline' : 'ghost'}
                className={cn(isUser && 'w-max max-w-[90%]')}
              >
                <BubbleContent className={cn(isUser && 'w-max')}>
                  <ContentBlocksView blocks={chunk.content} isStreaming={isStreaming && index === message.chunks.length - 1} />
                </BubbleContent>
              </Bubble>
            );
          })}
        </BubbleGroup>
        {message.optimistic && (
          <span className="text-[0.625rem] text-muted-foreground">Sending…</span>
        )}
      </MessageContent>
    </Message>
  );
}

function CompactionView({ entry }: { entry: TranscriptCompaction }) {
  return (
    <Marker variant="separator">
      <MarkerIcon>
        {entry.status === 'completed'
          ? <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.75} />
          : <HugeiconsIcon icon={Loading03Icon} strokeWidth={1.75} />}
      </MarkerIcon>
      <MarkerContent>
        {entry.summary.length > 0
          ? <ContentBlocksView blocks={entry.summary} />
          : `Context compaction ${entry.status.replace('_', ' ')}`}
        {entry.error && <span className="text-destructive">{entry.error}</span>}
      </MarkerContent>
    </Marker>
  );
}

/** A client tool call another client runs: the agent waits on it, and nobody answers it here. */
function ClientToolView({ entry }: { entry: TranscriptClientTool }) {
  const runner = sentenceStart(entry.runner);
  const text = entry.status === 'pending'
    ? `Waiting for ${entry.runner} to run ${entry.tool}`
    : entry.status === 'answered' || entry.status === 'elsewhere'
      ? `${runner} ran ${entry.tool}`
      : entry.status === 'cancelled'
        ? `${runner} didn't run ${entry.tool}`
        : requestEndText[entry.status];
  return (
    <Marker variant="border" data-slot="client-tool">
      <MarkerIcon>
        <HugeiconsIcon icon={entry.status === 'pending' ? Loading03Icon : CheckmarkCircle02Icon} strokeWidth={1.75} />
      </MarkerIcon>
      <MarkerContent>{text}</MarkerContent>
    </Marker>
  );
}

// Entries don't change once written, apart from the one streaming, so each renders only when it does.
const EntryView = memo(function EntryView({
  entry,
  transcript,
  actions,
  isStreaming,
}: {
  entry: TranscriptEntry;
  transcript: AcpTranscript;
  actions: ChatPaneActions;
  isStreaming: boolean;
}) {
  switch (entry.kind) {
    case 'message':
      return <MessageEntryView message={entry} isStreaming={isStreaming} />;
    case 'tool':
      return <ToolCallView tool={entry} onPermission={actions.respondToPermission} />;
    case 'plan':
      return <PlanView plan={entry} />;
    case 'compaction':
      return <CompactionView entry={entry} />;
    case 'elicitation':
      return <ElicitationView entry={entry} onRespond={actions.respondToElicitation} />;
    case 'client-tool':
      return <ClientToolView entry={entry} />;
    case 'diagnostic':
      return (
        <Marker variant="border" className={cn(entry.severity === 'error' && 'text-destructive')}>
          <MarkerContent>{entry.title}{entry.detail ? ` — ${entry.detail}` : ''}</MarkerContent>
        </Marker>
      );
    case 'subagent':
      return <SubagentRowView entry={entry} />;
    case 'session-message':
      return <SessionMessageView entry={entry} transcript={transcript} />;
  }
}, (previous, next) =>
  previous.entry === next.entry
  && previous.isStreaming === next.isStreaming
  && previous.actions === next.actions
  // Only messages between sessions read the transcript around them, for its subagents' names.
  && (previous.entry.kind !== 'session-message' || previous.transcript.subagents === next.transcript.subagents));

const selectOptions = (option: Extract<SessionConfigOption, { type: 'select' }>) =>
  option.options.flatMap((item) => 'options' in item ? item.options : [item]);

const selectedOptionName = (
  option: Extract<SessionConfigOption, { type: 'select' }>,
) => selectOptions(option).find(({ value }) => value === option.currentValue)?.name ?? option.currentValue;

const compactBooleanName = (name: string) => name.replace(/\s+mode$/i, '');

function ConfigControls({
  model,
  actions,
}: {
  model: AcpTranscript;
  actions: ChatPaneActions;
}) {
  const legacyModeControlId = '__legacy-mode__';
  const [activeSelectId, setActiveSelectId] = useState<string | null>(null);
  const hasConfigMode = model.configOptions.some(
    (option) => option.category === 'mode' || option.id === 'mode',
  );
  const legacyMode = !hasConfigMode && model.availableModes.length > 0
    ? model.availableModes.find(({ id }) => id === model.currentModeId)
    : undefined;
  const hasLegacyModeControl = !hasConfigMode && model.availableModes.length > 0;
  const activeSelect = model.configOptions.find(
    (option): option is Extract<SessionConfigOption, { type: 'select' }> =>
      option.type === 'select' && option.id === activeSelectId,
  );
  const isLegacyModeActive = hasLegacyModeControl && activeSelectId === legacyModeControlId;
  const summary = [
    ...model.configOptions
      .filter((option): option is Extract<SessionConfigOption, { type: 'select' }> =>
        option.type === 'select'
      )
      .map(selectedOptionName),
    ...(legacyMode ? [legacyMode.name] : []),
    ...model.configOptions
      .filter((option) => option.type === 'boolean' && option.currentValue)
      .map((option) => compactBooleanName(option.name)),
  ].join(' · ') || 'Agent settings';

  if (!hasLegacyModeControl && model.configOptions.length === 0) {
    return model.currentModeId
      ? (
        <div className="min-w-0" data-slot="config-controls">
          <Badge variant="ghost">{model.currentModeId}</Badge>
        </div>
      )
      : null;
  }

  return (
    <div className="min-w-0 max-w-full" data-slot="config-controls">
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) setActiveSelectId(null);
        }}
      >
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="min-w-0 max-w-full justify-start"
              aria-label={`Composer settings: ${summary}`}
            />
          }
        >
          <span className="truncate">{summary}</span>
          <HugeiconsIcon
            data-icon="inline-end"
            icon={ArrowDown01Icon}
            strokeWidth={2}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-64 max-w-[calc(100vw-1rem)]"
        >
          {isLegacyModeActive
            ? (
              <DropdownMenuGroup>
                <DropdownMenuItem
                  closeOnClick={false}
                  onClick={() => setActiveSelectId(null)}
                >
                  <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
                  Back
                </DropdownMenuItem>
                <DropdownMenuLabel>Mode</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={model.currentModeId}>
                  {model.availableModes.map((mode) => (
                    <DropdownMenuRadioItem
                      key={mode.id}
                      value={mode.id}
                      closeOnClick
                      onClick={() => actions.setMode(mode.id)}
                    >
                      {mode.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            )
            : activeSelect
            ? (
              <DropdownMenuGroup>
                <DropdownMenuItem
                  closeOnClick={false}
                  onClick={() => setActiveSelectId(null)}
                >
                  <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
                  Back
                </DropdownMenuItem>
                <DropdownMenuLabel>{activeSelect.name}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={activeSelect.currentValue}>
                  {selectOptions(activeSelect).map((choice) => (
                    <DropdownMenuRadioItem
                      key={choice.value}
                      value={choice.value}
                      closeOnClick
                      onClick={() =>
                        actions.setConfigOption(activeSelect.id, choice.value)
                      }
                    >
                      {choice.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
            )
            : (
              <DropdownMenuGroup>
                {hasLegacyModeControl && (
                  <DropdownMenuItem
                    closeOnClick={false}
                    onClick={() => setActiveSelectId(legacyModeControlId)}
                  >
                    <span className="flex-1">Mode</span>
                    <span className="text-muted-foreground">
                      {legacyMode?.name ?? model.currentModeId}
                    </span>
                    <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
                  </DropdownMenuItem>
                )}
                {model.configOptions.map((option) => {
                  if (option.type === 'boolean') {
                    return (
                      <DropdownMenuCheckboxItem
                        key={option.id}
                        checked={option.currentValue}
                        closeOnClick={false}
                        onCheckedChange={(checked) =>
                          actions.setConfigOption(option.id, checked)
                        }
                      >
                        {option.name}
                      </DropdownMenuCheckboxItem>
                    );
                  }
                  return (
                    <DropdownMenuItem
                      key={option.id}
                      closeOnClick={false}
                      onClick={() => setActiveSelectId(option.id)}
                    >
                      <span className="flex-1">{option.name}</span>
                      <span className="text-muted-foreground">
                        {selectedOptionName(option)}
                      </span>
                      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuGroup>
            )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const composerRows = (text: string) => {
  const lineCount = text.split('\n').length;
  return lineCount === 1 ? 2 : Math.min(8, Math.max(3, lineCount));
};

function ContextUsage({ usage }: { usage: AcpTranscript['usage'] }) {
  if (!usage) return null;
  return (
    <Context cost={usage.cost} maxTokens={usage.size} usedTokens={usage.used}>
      <ContextTrigger />
      <ContextContent />
    </Context>
  );
}

const promptSummary = (prompt: QueuedPrompt) => {
  const photos = prompt.images?.length ?? 0;
  const attached = photos === 0 ? '' : photos === 1 ? '1 photo' : `${photos} photos`;
  return [prompt.text, attached].filter(Boolean).join(' · ');
};

function QueuedPrompts({
  queued,
  paused = false,
  onRemove,
  onResume,
}: {
  queued: QueuedPrompt[];
  /** The Host's queue waits for someone to start it again. */
  paused?: boolean;
  onRemove?(id: string): void;
  onResume?(): void;
}) {
  if (queued.length === 0) return null;
  return (
    <ol aria-label="Queued messages" className="flex flex-col gap-1 px-3 pt-2" data-slot="queued-prompts">
      {paused && (
        <li className="flex min-w-0 items-center gap-2 py-0.5 pl-2.5 pr-1 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">The queue is paused. Sending a message starts it again.</span>
          {onResume && (
            <Button type="button" size="xs" variant="ghost" onClick={onResume}>
              Resume
            </Button>
          )}
        </li>
      )}
      {queued.map((prompt) => (
        <li key={prompt.id} className="flex min-w-0 items-center gap-2 rounded-md bg-muted/50 py-1 pl-2.5 pr-1 text-xs text-muted-foreground">
          <span className="shrink-0">{prompt.steering ? 'Steering' : 'Queued'}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{promptSummary(prompt)}</span>
          {prompt.origin && <span className="shrink-0">from {prompt.origin}</span>}
          {prompt.steering && <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-3 animate-spin" />}
          {onRemove && !prompt.steering && (
            <Button type="button" size="icon-xs" variant="ghost" aria-label={`Remove queued message: ${prompt.text}`} onClick={() => onRemove(prompt.id)}>
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          )}
        </li>
      ))}
    </ol>
  );
}

const sendLabel = (running: boolean, canSteer: boolean) =>
  !running ? 'Send message' : canSteer ? 'Steer the running turn' : 'Queue message';

/** The agent's commands a draft starting with `/` could be: `/pl` offers `/plan`. */
function commandMatches(model: AcpTranscript, text: string) {
  const match = /^\/(\S*)$/.exec(text);
  if (!match) return [];
  const query = match[1].toLowerCase();
  const named = model.availableCommands.filter(({ name }) => name.toLowerCase().startsWith(query));
  const mentioned = model.availableCommands.filter(({ name }) => !name.toLowerCase().startsWith(query) && name.toLowerCase().includes(query));
  return [...named, ...mentioned];
}

function CommandSuggestions({ model, text, onPick }: { model: AcpTranscript; text: string; onPick(name: string): void }) {
  const matches = commandMatches(model, text);
  if (matches.length === 0) return null;
  return (
    <ul aria-label="Agent commands" className="mx-3 mt-2 max-h-48 overflow-y-auto rounded-md border bg-popover py-1 text-xs shadow-sm" data-slot="command-suggestions">
      {matches.map((command) => (
        <li key={command.name}>
          <button
            type="button"
            className="flex w-full min-w-0 items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
            onClick={() => onPick(command.name)}
          >
            <span className="shrink-0 font-mono font-medium">/{command.name}</span>
            <span className="min-w-0 truncate text-muted-foreground">{command.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AttachedImages({ images, onRemove }: { images: PromptImage[]; onRemove(index: number): void }) {
  if (images.length === 0) return null;
  return (
    <ul aria-label="Attached photos" className="flex flex-wrap gap-1.5 px-3 pt-2" data-slot="attached-images">
      {images.map((image, index) => (
        <li key={`${index}-${image.data.length}`} className="relative size-14 overflow-hidden rounded-md border bg-muted">
          <img alt={image.name ?? `Photo ${index + 1}`} src={`data:${image.mimeType};base64,${image.data}`} className="size-full object-cover" />
          <Button
            type="button"
            size="icon-xs"
            variant="secondary"
            className="absolute top-0.5 right-0.5"
            aria-label={`Remove ${image.name ?? `photo ${index + 1}`}`}
            onClick={() => onRemove(index)}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </li>
      ))}
    </ul>
  );
}

function Composer({
  model,
  actions,
  queued,
  queuePaused,
  canSteer,
  canAttachImages,
  focusRequest,
  discardDraftOnUnmount,
  draftKey,
}: {
  model: AcpTranscript;
  actions: ChatPaneActions;
  queued: QueuedPrompt[];
  queuePaused: boolean;
  canSteer: boolean;
  canAttachImages: boolean;
  focusRequest?: number;
  discardDraftOnUnmount?: boolean;
  draftKey?: string;
}) {
  const [images, setImages] = useState<PromptImage[]>([]);
  const [imageError, setImageError] = useState<string>();
  const fileRef = useRef<HTMLInputElement>(null);
  const composerKey = draftKey ?? model.sessionId;
  const [draft, setDraft] = useState<ComposerDraft>(
    () => composerDrafts.get(composerKey) ?? { revision: 0, text: '' },
  );
  const draftRef = useRef(draft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running = model.turn.status === 'running';
  const text = draft.text;
  useEffect(() => {
    const listeners = composerDraftListeners.get(composerKey) ?? new Set();
    const updateDraft = (nextDraft: ComposerDraft) => {
      draftRef.current = nextDraft;
      setDraft(nextDraft);
    };
    listeners.add(updateDraft);
    composerDraftListeners.set(composerKey, listeners);
    return () => {
      listeners.delete(updateDraft);
      if (listeners.size === 0) composerDraftListeners.delete(composerKey);
      if (discardDraftOnUnmount) discardComposerDraft(composerKey);
    };
  }, [discardDraftOnUnmount, composerKey]);
  useEffect(() => {
    if (focusRequest === undefined) return;
    let frame: number | undefined;
    let focused = false;
    const focus = () => {
      const textarea = textareaRef.current;
      if (focused || !textarea || textarea.closest('[hidden]')) return;
      // A mobile sidebar's closing dialog still owns focus until it leaves.
      const overlay = [...document.querySelectorAll('[role="dialog"], [role="menu"]')].some((item) => item.getBoundingClientRect().height > 0);
      if (overlay) return;
      textarea.focus({ preventScroll: true });
      focused = document.activeElement === textarea;
    };
    const observer = new MutationObserver(() => {
      if (focused || frame !== undefined) return;
      frame = requestAnimationFrame(() => { frame = undefined; focus(); });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'data-open', 'style'] });
    focus();
    return () => { observer.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame); };
  }, [focusRequest]);
  const setText = (next: string) => {
    const updated = { revision: draftRef.current.revision + 1, text: next };
    writeComposerDraft(composerKey, updated);
    actions.setDraftText?.(composerKey, next);
  };
  const attach = async (files: FileList | null) => {
    setImageError(undefined);
    if (!files || files.length === 0) return;
    try {
      const added = await Promise.all([...files].map(promptImage));
      const next = [...images, ...added];
      if (imagesSize(next) > MAX_PROMPT_IMAGE_BYTES) {
        setImageError('Those photos are too large to send in one message. Send fewer at a time.');
        return;
      }
      setImages(next);
    } catch (cause) {
      setImageError(cause instanceof Error ? cause.message : "Couldn't add the photo.");
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const submit = async () => {
    const prompt = text.trim();
    const attached = images;
    if (!prompt && attached.length === 0) return;
    const submittedDraft = draftRef.current;
    setImages([]);
    const clearedDraft = { revision: submittedDraft.revision + 1, text: '' };
    writeComposerDraft(composerKey, clearedDraft);
    if (
      Capacitor.isNativePlatform() ||
      window.matchMedia?.('(max-width: 767px)').matches
    ) {
      textareaRef.current?.blur();
    }
    try {
      const sending = attached.length > 0 ? actions.send(prompt, attached) : actions.send(prompt);
      actions.setDraftText?.(composerKey, '');
      await sending;
    } catch {
      setImages((current) => current.length === 0 ? attached : current);
      const currentDraft = composerDrafts.get(composerKey);
      if (currentDraft?.revision !== clearedDraft.revision) return;
      const restoredDraft = {
        revision: currentDraft.revision + 1,
        text: submittedDraft.text,
      };
      writeComposerDraft(composerKey, restoredDraft);
      actions.setDraftText?.(composerKey, restoredDraft.text);
    }
  };

  return (
    <div className="shrink-0 border-t bg-background pb-[env(safe-area-inset-bottom)]">
      <QueuedPrompts
        queued={queued}
        paused={queuePaused}
        onRemove={actions.removeQueued}
        onResume={actions.resumeQueue ? () => void actions.resumeQueue?.() : undefined}
      />
      <CommandSuggestions
        model={model}
        text={text}
        onPick={(name) => {
          setText(`/${name} `);
          textareaRef.current?.focus({ preventScroll: true });
        }}
      />
      <AttachedImages images={images} onRemove={(index) => setImages((current) => current.filter((_, at) => at !== index))} />
      {imageError && <p role="alert" className="px-3 pt-2 text-xs text-destructive">{imageError}</p>}
      <PromptInput
        aria-label="Message composer"
        className="w-full bg-composer-background"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FieldGroup className="gap-0">
          <PromptInputBody>
            <Field className="gap-0">
              <FieldLabel className="sr-only" htmlFor="composer-message">Message agent</FieldLabel>
              <PromptInputTextarea
                ref={textareaRef}
                id="composer-message"
                aria-label="Message agent"
                className="field-sizing-fixed min-h-0 resize-none overflow-y-auto px-4 pb-1 pt-3 text-xs/relaxed"
                placeholder={model.availableCommands.length > 0 ? 'Message agent — / for commands' : 'Message agent'}
                rows={composerRows(text)}
                variant="frameless"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            </Field>
          </PromptInputBody>
          <PromptInputFooter
            className="flex min-h-8 items-end gap-2 px-3 pb-2"
            data-slot="composer-controls"
          >
            <PromptInputTools className="min-w-0 flex-1 flex-wrap">
              {canAttachImages && (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    aria-label="Photos to attach"
                    onChange={(event) => void attach(event.target.files)}
                  />
                  <Button type="button" size="icon-sm" variant="ghost" aria-label="Attach photos" onClick={() => fileRef.current?.click()}>
                    <HugeiconsIcon icon={ImageAdd01Icon} strokeWidth={2} />
                  </Button>
                </>
              )}
              <ConfigControls model={model} actions={actions} />
            </PromptInputTools>
            <div
              className="flex shrink-0 items-center gap-1.5"
              data-slot="composer-actions"
            >
              <ContextUsage usage={model.usage} />
              {running && (
                <Button
                  size="icon-sm"
                  type="button"
                  aria-label="Stop the turn"
                  onClick={() => void actions.cancelTurn()}
                  variant="secondary"
                >
                  <HugeiconsIcon data-icon="inline-start" data-symbol="stop" icon={StopIcon} strokeWidth={2} />
                </Button>
              )}
              <Button
                size="icon-sm"
                type="submit"
                aria-label={sendLabel(running, canSteer)}
                disabled={text.trim().length === 0 && images.length === 0}
                variant="send"
              >
                <HugeiconsIcon data-icon="inline-start" data-symbol="paper-plane" icon={SendIcon} strokeWidth={2} />
              </Button>
            </div>
          </PromptInputFooter>
        </FieldGroup>
      </PromptInput>
    </div>
  );
}

/**
 * A prompt that arrives while the thread is open moves to the top of the view, as one sent here
 * does. Those replayed as it opens or catches up aren't anchors, so the view stays at the end:
 * the replay renders a frame at a time, and a frame holding one would pull the view to it.
 */
const isScrollAnchor = (entry: TranscriptEntry) =>
  entry.kind === 'message' && entry.role === 'user' && !entry.replayed;

export function ChatPane({
  model,
  actions,
  queued = [],
  queuePaused = false,
  canSteer = false,
  canAttachImages = false,
  readOnly = false,
  root,
  onOpenSubagent,
  focusRequest,
  discardDraftOnUnmount,
  draftKey,
  loading = false,
}: {
  model: AcpTranscript;
  actions: ChatPaneActions;
  queued?: QueuedPrompt[];
  queuePaused?: boolean;
  canSteer?: boolean;
  canAttachImages?: boolean;
  /** Shows the transcript without a composer, as a subagent's is shown. */
  readOnly?: boolean;
  /** The session's own transcript, when `model` is one of its subagents'. */
  root?: AcpTranscript;
  onOpenSubagent?(sessionId: string): void;
  focusRequest?: number;
  discardDraftOnUnmount?: boolean;
  draftKey?: string;
  /**
   * Its history is still replaying as it opens: a spinner shows until it's in, and then the
   * transcript, at its end, without having been laid out a frame at a time.
   */
  loading?: boolean;
}) {
  const running = model.turn.status === 'running';
  const items = useMemo(() => loading ? [] : transcriptItems(model.entries, running), [loading, model.entries, running]);
  const streamingId = running ? model.entries.at(-1)?.id : undefined;
  const session = root ?? model;
  const context = useMemo<TranscriptContextValue>(() => ({ root: session, openSubagent: onOpenSubagent }), [session, onOpenSubagent]);
  return (
    <TranscriptContext.Provider value={context}>
      <div
        aria-busy={running}
        className="flex min-h-0 flex-1 flex-col bg-chat-background"
        data-slot="chat-pane"
      >
        {running && (
          <span className="sr-only" role="status" aria-live="polite">
            Agent response in progress.
          </span>
        )}
        {loading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center" data-slot="chat-loading">
            <Spinner aria-label="Loading the thread" className="size-5 text-muted-foreground" />
          </div>
        ) : <MessageScrollerProvider autoScroll>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent className="mx-auto w-full max-w-4xl gap-4 px-3 py-5">
                {items.map((item) => item.kind === 'entry'
                  ? (
                    <MessageScrollerItem key={item.entry.id} scrollAnchor={isScrollAnchor(item.entry)}>
                      <EntryView entry={item.entry} transcript={model} actions={actions} isStreaming={item.entry.id === streamingId} />
                    </MessageScrollerItem>
                  )
                  : (
                    <MessageScrollerItem key={item.id}>
                      <WorkRunView
                        run={item}
                        renderEntry={(entry) => <EntryView entry={entry} transcript={model} actions={actions} isStreaming={entry.id === streamingId} />}
                      />
                    </MessageScrollerItem>
                  ))}
                {model.entries.length === 0 && (
                  <Empty className="min-h-48 rounded-none p-0">
                    <EmptyHeader>
                      <EmptyDescription>Start a conversation with the agent.</EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>}
        {!readOnly && <Composer
          key={draftKey ?? model.sessionId}
          draftKey={draftKey}
          model={model}
          actions={actions}
          queued={queued}
          queuePaused={queuePaused}
          canSteer={canSteer}
          canAttachImages={canAttachImages}
          focusRequest={focusRequest}
          discardDraftOnUnmount={discardDraftOnUnmount}
        />}
      </div>
    </TranscriptContext.Provider>
  );
}
