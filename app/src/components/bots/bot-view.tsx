// A Bot on screen (WVE-178): the Session at its home, as `SessionView` shows a Bot's, once it has a
// thread; before that, an empty conversation whose first prompt goes to the Dispatcher
// (`bots/send`), which starts the Bot's first thread. Once the Bot lists that thread, its Session
// and Thread Block are made, and the conversation carries on there.
import { useState, type ReactNode } from 'react';
import type { AppController, BotSummary, CreatedThread, OpenSession, PromptImage } from '@/app/app-controller';
import { type AcpTranscript, createTranscript, queueOptimisticPrompt, reduceAcpEvent } from '@/chat/acp-transcript';
import { ChatPane } from '@/chat/chat-pane';
import { BotHeading } from '@/components/bots/bot-heading';
import { SessionView } from '@/components/session/session-view';
import { ThreadHeader } from '@/components/thread-view';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import type { ContentBlock } from '@/host/protocol';

const describe = (error: unknown) => error instanceof Error ? error.message : String(error);

const promptOf = (text: string, images: PromptImage[] = []): ContentBlock[] => [
  ...(text ? [{ type: 'text' as const, text }] : []),
  ...images.map(({ mimeType, data }) => ({ type: 'image' as const, mimeType, data })),
];

/** A Bot with no thread yet: an empty conversation, its first prompt the Dispatcher's to deliver. */
function FirstPrompt({ controller, bot, leading, onOpenBot }: { controller: AppController; bot: BotSummary; leading?: ReactNode; onOpenBot?(): void }) {
  const { model, actions } = controller;
  const [transcript, setTranscript] = useState<AcpTranscript>(() => createTranscript(`bot-${bot.id}`));
  const [error, setError] = useState<string>();
  const [sent, setSent] = useState(0);
  const send = async (text: string, images?: PromptImage[]) => {
    setError(undefined);
    const id = `${bot.id}:first:${sent}`;
    setSent((count) => count + 1);
    // It shows at once, as a thread's prompt does, while the Dispatcher starts the thread.
    setTranscript((current) => reduceAcpEvent(queueOptimisticPrompt(current, id, promptOf(text, images)), { type: 'turn/started' }));
    try {
      if (!actions.sendToBot) throw new Error("This app can't reach the Bot's Dispatcher.");
      await actions.sendToBot(bot.id, text, images);
    } catch (cause) {
      setError(describe(cause));
      setTranscript((current) => ({ ...current, entries: current.entries.filter((entry) => entry.id !== id), turn: { status: 'idle' } }));
      throw cause;
    }
  };
  const noop = () => {};
  return (
    <section aria-label={`Bot ${bot.name}`} data-slot='bot-first-prompt' className='flex min-h-0 min-w-0 flex-1 flex-col'>
      <ThreadHeader leading={leading}>
        <BotHeading bot={bot} unread={model.unread} onOpen={onOpenBot} />
      </ThreadHeader>
      {!bot.connected && (
        <p role='status' className='shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-[0.6875rem] text-muted-foreground'>
          {bot.hostName} isn't connected to the Dispatcher: what you send waits for it.
        </p>
      )}
      {error && <Alert variant='destructive' className='m-2 w-auto'><AlertDescription>{error}</AlertDescription></Alert>}
      <p role='status' data-slot='bot-no-thread' className='shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-[0.6875rem] text-muted-foreground'>
        {transcript.entries.length === 0
          ? `${bot.name} has no thread yet. Your first message starts one, in its home on ${bot.hostName}.`
          : `Starting ${bot.name}'s first thread…`}
      </p>
      <ChatPane
        draftKey={`bot:${bot.id}`}
        model={transcript}
        actions={{ send, cancelTurn: noop, respondToPermission: noop, respondToElicitation: noop, setMode: noop, setConfigOption: noop }}
      />
    </section>
  );
}

export function BotView({ controller, bot, session, leading, phone, reveal, onRevealed, onOpenBot, onOpenThread, onCreated, onBack }: {
  controller: AppController;
  bot: BotSummary;
  /** Its Session, once the store shows it: the one at its home. */
  session?: OpenSession;
  leading?: ReactNode;
  phone?: boolean;
  reveal?: string;
  onRevealed?(): void;
  onOpenBot(): void;
  onOpenThread(key: string): void;
  onCreated?(thread: CreatedThread): void;
  onBack?(): void;
}) {
  const { model } = controller;
  if (!bot.thread) return <FirstPrompt key={bot.id} controller={controller} bot={bot} leading={leading} onOpenBot={onOpenBot} />;
  if (session) {
    return (
      <SessionView key={session.key} controller={controller} session={session} members={[]} leading={leading} phone={phone}
        reveal={reveal} onRevealed={onRevealed} onOpenThread={onOpenThread} onCreated={onCreated} onBack={onBack}
        bot={bot} onOpenBot={onOpenBot} />
    );
  }
  const host = model.hosts.find(({ id }) => id === bot.hostId);
  return (
    <section aria-label={`Bot ${bot.name}`} className='flex min-h-0 min-w-0 flex-1 flex-col'>
      <ThreadHeader leading={leading}>
        <BotHeading bot={bot} unread={model.unread} onOpen={onOpenBot} />
      </ThreadHeader>
      <Empty className='flex-1'>
        <EmptyHeader>
          <EmptyDescription>
            {host?.status === 'connected' || !host
              ? <><Spinner className='mr-1.5 inline size-3' />Opening {bot.name}…</>
              : `${host.name} isn't connected.${host.error ? ` ${host.error}` : ''}`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  );
}
