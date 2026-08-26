import { useEffect, useRef, useState } from 'react';
import type {
  CreateElicitationResponse,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiBrainIcon,
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
import { Checkbox } from '@/components/ui/checkbox';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
        <BubbleGroup>
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
                className={cn(isUser && 'max-w-[90%]')}
              >
                <BubbleContent>
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

function ConfigControls({
  model,
  actions,
}: {
  model: AcpTranscript;
  actions: ChatPaneActions;
}) {
  const hasConfigMode = model.configOptions.some(
    (option) => option.category === 'mode' || option.id === 'mode',
  );
  const modeItems = model.availableModes.map((mode) => ({
    label: mode.name,
    value: mode.id,
  }));

  return (
    <FieldGroup
      className="flex min-w-0 flex-1 flex-row flex-wrap items-center gap-x-1.5 gap-y-1"
      data-slot="config-controls"
    >
      {!hasConfigMode && model.availableModes.length > 0
        ? (
          <Field className="w-auto gap-0">
            <FieldLabel className="sr-only" htmlFor="composer-agent-mode">Agent mode</FieldLabel>
            <Select
              items={modeItems}
              value={model.currentModeId}
              onValueChange={(value) => actions.setMode(String(value))}
            >
              <SelectTrigger id="composer-agent-mode" size="sm" variant="ghost" aria-label="Agent mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Mode</SelectLabel>
                  {model.availableModes.map((mode) => (
                    <SelectItem key={mode.id} value={mode.id}>{mode.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        )
        : !hasConfigMode && model.currentModeId && (
          <Badge variant="ghost">{model.currentModeId}</Badge>
        )}
      {model.configOptions.map((option) => {
        if (option.type === 'boolean') {
          return (
            <Field
              key={option.id}
              orientation="horizontal"
              className="w-auto gap-1.5 px-1"
              data-slot="config-boolean-control"
            >
              <Checkbox
                id={`composer-config-${option.id}`}
                checked={option.currentValue}
                onCheckedChange={(checked) => actions.setConfigOption(option.id, Boolean(checked))}
              />
              <FieldLabel
                htmlFor={`composer-config-${option.id}`}
                className="text-xs/relaxed font-normal text-muted-foreground"
              >
                {option.name}
              </FieldLabel>
            </Field>
          );
        }
        const choices = selectOptions(option);
        const items = choices.map((choice) => ({
          label: choice.name,
          value: choice.value,
        }));
        return (
          <Field key={option.id} className="w-auto gap-0">
            <FieldLabel className="sr-only" htmlFor={`composer-config-${option.id}`}>
              {option.name}
            </FieldLabel>
            <Select
              items={items}
              value={option.currentValue}
              onValueChange={(value) => actions.setConfigOption(option.id, String(value))}
            >
              <SelectTrigger
                id={`composer-config-${option.id}`}
                size="sm"
                variant="ghost"
                aria-label={option.name}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{option.name}</SelectLabel>
                  {choices.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>{choice.name}</SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        );
      })}
    </FieldGroup>
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

function Composer({ model, actions }: { model: AcpTranscript; actions: ChatPaneActions }) {
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
    };
  }, [model.sessionId]);
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
    if (window.matchMedia?.('(max-width: 767px)').matches) textareaRef.current?.blur();
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
}: {
  model: AcpTranscript;
  actions: ChatPaneActions;
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
      <Composer key={model.sessionId} model={model} actions={actions} />
    </div>
  );
}
