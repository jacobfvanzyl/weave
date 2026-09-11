import { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import type {
  CreateElicitationResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiBrainIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Loading03Icon,
  SendIcon,
} from '@hugeicons/core-free-icons';
import type {
  AcpTranscript,
  TranscriptCompaction,
  TranscriptEntry,
  TranscriptMessage,
} from './acp-transcript';
import { ContentBlocksView } from './content-block-view';
import { ElicitationView } from './elicitation-view';
import { PlanView } from './plan-view';
import { ToolCallView } from './tool-call-view';
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
  sendPrompt(text: string): Promise<void> | void;
  cancelPrompt(): Promise<void> | void;
  respondToPermission(requestId: string, optionId: string): void;
  respondToElicitation(requestId: string, response: CreateElicitationResponse): void;
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
  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
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
                    <ContentBlocksView blocks={chunk.content} />
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
                  <ContentBlocksView blocks={chunk.content} />
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

function EntryView({
  entry,
  actions,
  isStreaming,
}: {
  entry: TranscriptEntry;
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
    case 'diagnostic':
      return (
        <Marker variant="border" className={cn(entry.severity === 'error' && 'text-destructive')}>
          <MarkerContent>{entry.title}{entry.detail ? ` — ${entry.detail}` : ''}</MarkerContent>
        </Marker>
      );
  }
}

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

type ComposerDraft = {
  revision: number;
  text: string;
};

const composerDrafts = new Map<string, ComposerDraft>();
const composerDraftListeners = new Map<string, Set<(draft: ComposerDraft) => void>>();

const writeComposerDraft = (sessionId: string, draft: ComposerDraft) => {
  composerDrafts.set(sessionId, draft);
  composerDraftListeners.get(sessionId)?.forEach((listener) => listener(draft));
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

function Composer({
  model,
  actions,
  focusRequest,
  discardDraftOnUnmount,
}: {
  model: AcpTranscript;
  actions: ChatPaneActions;
  focusRequest?: number;
  discardDraftOnUnmount?: boolean;
}) {
  const [draft, setDraft] = useState<ComposerDraft>(
    () => composerDrafts.get(model.sessionId) ?? { revision: 0, text: '' },
  );
  const draftRef = useRef(draft);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const running = model.turn.status === 'running';
  const text = draft.text;
  useEffect(() => {
    const listeners = composerDraftListeners.get(model.sessionId) ?? new Set();
    const updateDraft = (nextDraft: ComposerDraft) => {
      draftRef.current = nextDraft;
      setDraft(nextDraft);
    };
    listeners.add(updateDraft);
    composerDraftListeners.set(model.sessionId, listeners);
    return () => {
      listeners.delete(updateDraft);
      if (listeners.size === 0) composerDraftListeners.delete(model.sessionId);
      if (discardDraftOnUnmount) composerDrafts.delete(model.sessionId);
    };
  }, [discardDraftOnUnmount, model.sessionId]);
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
    writeComposerDraft(model.sessionId, updated);
  };
  const submit = async () => {
    const prompt = text.trim();
    if (!prompt || running) return;
    const submittedDraft = draftRef.current;
    const clearedDraft = { revision: submittedDraft.revision + 1, text: '' };
    writeComposerDraft(model.sessionId, clearedDraft);
    if (
      Capacitor.isNativePlatform() ||
      window.matchMedia?.('(max-width: 767px)').matches
    ) {
      textareaRef.current?.blur();
    }
    try {
      await actions.sendPrompt(prompt);
    } catch {
      const currentDraft = composerDrafts.get(model.sessionId);
      if (currentDraft?.revision !== clearedDraft.revision) return;
      const restoredDraft = {
        revision: currentDraft.revision + 1,
        text: submittedDraft.text,
      };
      writeComposerDraft(model.sessionId, restoredDraft);
    }
  };

  return (
    <div className="shrink-0 border-t bg-background">
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
                placeholder="Message agent — @ to include context, / for commands"
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
              <ConfigControls model={model} actions={actions} />
            </PromptInputTools>
            <div
              className="flex shrink-0 items-center gap-1.5"
              data-slot="composer-actions"
            >
              <ContextUsage usage={model.usage} />
              <Button
                size="icon-sm"
                type={running ? 'button' : 'submit'}
                aria-label={running ? 'Stop response' : 'Send message'}
                onClick={running ? () => void actions.cancelPrompt() : undefined}
                disabled={!running && text.trim().length === 0}
                variant={running ? 'secondary' : 'send'}
              >
                <HugeiconsIcon
                  data-icon="inline-start"
                  data-symbol={running ? 'cancel' : 'paper-plane'}
                  icon={running ? Cancel01Icon : SendIcon}
                  strokeWidth={2}
                />
              </Button>
            </div>
          </PromptInputFooter>
        </FieldGroup>
      </PromptInput>
    </div>
  );
}

export function ChatPane({
  model,
  actions,
  focusRequest,
  discardDraftOnUnmount,
}: {
  model: AcpTranscript;
  actions: ChatPaneActions;
  focusRequest?: number;
  discardDraftOnUnmount?: boolean;
}) {
  const running = model.turn.status === 'running';
  return (
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
      <MessageScrollerProvider autoScroll>
        <MessageScroller>
          <MessageScrollerViewport>
            <MessageScrollerContent className="mx-auto w-full max-w-4xl gap-4 px-3 py-5">
              {model.entries.map((entry) => (
                <MessageScrollerItem key={entry.id} scrollAnchor={entry.kind === 'message' && entry.role === 'user'}>
                  <EntryView
                    entry={entry}
                    actions={actions}
                    isStreaming={running && entry.id === model.entries.at(-1)?.id}
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
      </MessageScrollerProvider>
      <Composer
        key={model.sessionId}
        model={model}
        actions={actions}
        focusRequest={focusRequest}
        discardDraftOnUnmount={discardDraftOnUnmount}
      />
    </div>
  );
}
