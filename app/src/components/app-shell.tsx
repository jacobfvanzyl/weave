import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons';
import type { AppController, BotSummary, CreatedThread, OpenSession, SessionSummary, ThreadSummary } from '@/app/app-controller';
import { sessionKey, sessionOfKey } from '@/app/app-controller';
import { useCommand, useCommandKeys } from '@/app/commands';
import { useOpenThreadRequests } from '@/app/open-thread';
import { platform } from '@/app/platform';
import { usePhoneLayout } from '@/app/use-phone-layout';
import { BotPage } from '@/components/bots/bot-page';
import { BotView } from '@/components/bots/bot-view';
import { NewBotDialog } from '@/components/bots/new-bot-dialog';
import { CommandPalette } from '@/components/command-palette';
import { EndSessionDialog } from '@/components/end-session-dialog';
import { HostsDialog } from '@/components/hosts-dialog';
import { type NewThreadTarget, NewThreadDialog } from '@/components/new-thread-dialog';
import { PairingScreen } from '@/components/pair-dispatcher';
import { SessionList } from '@/components/session-list';
import { SessionView } from '@/components/session/session-view';
import { ResizableSidebarProvider, SidebarResizeHandle } from '@/components/sidebar-resize';
import { ThreadHeader } from '@/components/thread-view';
import { WaitingBanner } from '@/components/waiting-banner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Sidebar, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { botOfThread, botSelection, selectedBot, waitingBots } from '@/session/bots';
import { botSessionKey, directoryName, sessionListView, sessionSummaries, sessionWith, threadDirectories, threadDirectory, waitingSessions } from '@/session/sessions';
import { loadLastSession, saveLastSession } from '@/session/view';
import type { SurfaceLink } from '@/surface/surface-link';
import { useSurface } from '@/surface/use-surface';

function WaitingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <Badge className='bg-warning text-background' aria-label={`${count} waiting`}>{count}</Badge>;
}

/** iPhone: Back to the list, with how many other Sessions have something waiting on the person. */
function BackButton({ count, onBack }: { count: number; onBack(): void }) {
  return (
    <Button variant='ghost' size='lg' aria-label={count ? `Sessions, ${count} waiting` : 'Sessions'} className='min-h-11 shrink-0 px-1.5' onClick={onBack}>
      <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
      <WaitingBadge count={count} />
    </Button>
  );
}

/** iPad and wider: shows and hides the list of Sessions, with a count while it is hidden. */
function SidebarToggle({ waiting }: { waiting: number }) {
  const { isMobile, openMobile, state, toggleSidebar } = useSidebar();
  const hidden = isMobile ? !openMobile : state === 'collapsed';
  const count = hidden ? waiting : 0;
  return (
    <Button variant='ghost' size='lg' aria-label={hidden ? (count ? `Show Sessions, ${count} waiting` : 'Show Sessions') : 'Hide Sessions'}
      aria-expanded={!hidden} className='min-h-11 shrink-0 px-1.5 aria-expanded:bg-transparent' onClick={toggleSidebar}>
      <HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} />
      <WaitingBadge count={count} />
    </Button>
  );
}

/** What's beside the list, or in its place on the iPhone, while no Session shows. */
function NoSession({ controller, selected, known, leading }: {
  controller: AppController;
  selected?: string;
  /** Whether a Host keeps the Session picked: one it doesn't, as one that ended, isn't waited for. */
  known: boolean;
  leading?: React.ReactNode;
}) {
  const { model } = controller;
  const picked = selected ? model.hosts.find(({ id }) => id === sessionOfKey(selected).hostId) : undefined;
  // Until its Host has listed its Sessions, the one picked may yet be among them.
  const host = picked && (known || picked.status !== 'connected' || model.session?.key !== selected) ? picked : undefined;
  const directory = selected ? directoryName(sessionOfKey(selected).directory) : undefined;
  return (
    <>
      <ThreadHeader leading={leading} />
      <Empty className='flex-1'>
        <EmptyHeader>
          {selected && host
            ? (
              <>
                <EmptyTitle>{directory}</EmptyTitle>
                <EmptyDescription>
                  {host.status === 'connected'
                    ? <><Spinner className='mr-1.5 inline size-3' />Opening the Session…</>
                    : `${host.name} isn't connected.${host.error ? ` ${host.error}` : ''}`}
                </EmptyDescription>
              </>
            )
            : (
              <>
                <EmptyTitle>No Session open</EmptyTitle>
                <EmptyDescription>Pick a Session from the list, or start a thread in a directory to open one.</EmptyDescription>
              </>
            )}
        </EmptyHeader>
      </Empty>
    </>
  );
}

const NONE: readonly string[] = [];
/** A Session's threads, by key. */
const membersOf = (sessions: readonly SessionSummary[], key: string) => sessions.find((session) => session.key === key)?.threads ?? NONE;

type ShellProps = {
  controller: AppController;
  sessions: SessionSummary[];
  /** The Session on screen, once its Host has listed what's in it. */
  session?: OpenSession;
  /** The Session to show, by key, or a Bot (`botSelection`), and the thread in it to bring to the front. */
  selected?: string;
  /** The Bot on screen, and its Session once the store shows it. */
  bot?: BotSummary;
  botSession?: OpenSession;
  /** How many Sessions and Bots other than the one on screen have something waiting on the person. */
  waiting: number;
  onOpenBotPage(): void;
  onNewBot(): void;
  reveal?: string;
  onRevealed(): void;
  onOpenSession(key?: string): void;
  onOpenThread(key: string): void;
  /** A thread was started in a directory with no Session shown: its Session's, which it starts. */
  onCreated(thread: CreatedThread): void;
  onOpenHosts(): void;
  onNewSession(target?: NewThreadTarget): void;
  onEndSession(session: SessionSummary): void;
};

function PhoneShell({ controller, sessions, session, selected, bot, botSession, waiting, onOpenBotPage, onNewBot, reveal, onRevealed, onOpenSession, onOpenThread, onCreated, onOpenHosts, onNewSession, onEndSession, surfaceLink }: ShellProps & {
  surfaceLink?: SurfaceLink;
}) {
  const { model } = controller;
  // A Surface (WVE-183) shows the thread in front, or the one last there while the list is here.
  const surface = useSurface(model, surfaceLink);
  const surfaced = Boolean(surface?.status.connected && model.thread);
  // With the thread on the Surface, the iPhone may turn for a bigger keyboard; elsewhere it stays upright.
  useEffect(() => surfaceLink?.setLandscape(surfaced), [surfaceLink, surfaced]);
  const back = () => onOpenSession(undefined);
  const leading = <BackButton count={waiting} onBack={back} />;
  if (!selected) {
    return <SessionList controller={controller} sessions={sessions} onOpen={onOpenSession} onOpenBot={(id) => onOpenSession(botSelection(id))} onNewBot={onNewBot}
      onOpenHosts={onOpenHosts} onNewSession={onNewSession} onEndSession={onEndSession} />;
  }
  if (bot) {
    return (
      <BotView controller={controller} bot={bot} session={botSession} phone leading={leading} reveal={reveal} onRevealed={onRevealed}
        onOpenBot={onOpenBotPage} onOpenThread={onOpenThread} onCreated={onCreated} surface={surface} onBack={back} />
    );
  }
  if (!session) return <NoSession controller={controller} selected={selected} known={sessions.some(({ key }) => key === selected)} leading={leading} />;
  return (
    <SessionView key={session.key} controller={controller} session={session} members={membersOf(sessions, session.key)} phone leading={leading}
      reveal={reveal} onRevealed={onRevealed} onOpenThread={onOpenThread} onCreated={onCreated} surface={surface} onBack={back} />
  );
}

function SplitShell({ controller, sessions, session, selected, bot, botSession, waiting, onOpenBotPage, onNewBot, reveal, onRevealed, onOpenSession, onOpenThread, onCreated, onOpenHosts, onNewSession, onEndSession }: ShellProps) {
  const { setOpenMobile } = useSidebar();
  const leading = <SidebarToggle waiting={waiting} />;
  const open = (key: string) => {
    onOpenSession(key);
    setOpenMobile(false);
  };
  return (
    <>
      <Sidebar collapsible='offcanvas'>
        <SessionList controller={controller} sessions={sessions} selected={selected} selectedBot={selectedBot(selected)} onOpenHosts={onOpenHosts} onNewSession={onNewSession}
          onEndSession={onEndSession} onOpen={open} onOpenBot={(id) => open(botSelection(id))} onNewBot={onNewBot} />
        <SidebarResizeHandle />
      </Sidebar>
      <SidebarInset className='min-h-0 min-w-0 overflow-hidden'>
        {bot
          ? <BotView controller={controller} bot={bot} session={botSession} leading={leading} reveal={reveal} onRevealed={onRevealed}
              onOpenBot={onOpenBotPage} onOpenThread={onOpenThread} onCreated={onCreated} />
          : session
          ? <SessionView key={session.key} controller={controller} session={session} members={membersOf(sessions, session.key)} leading={leading}
              reveal={reveal} onRevealed={onRevealed} onOpenThread={onOpenThread} onCreated={onCreated} />
          : <NoSession controller={controller} selected={selected} known={sessions.some(({ key }) => key === selected)} leading={leading} />}
      </SidebarInset>
    </>
  );
}

/**
 * The app's layout (ADR 0031, WVE-203): the person's Sessions in a list, and one of them on
 * screen as tabs of Blocks. An iPhone stacks the list and a Session; an iPad, or anything wider,
 * shows the list as a sidebar beside the Session, as wide as its edge is dragged. Which follows
 * the device, not the window's width. Until the app is paired with the Dispatcher, or once the
 * Dispatcher revoked it, it shows the pairing screen instead.
 */
export function AppShell({ controller, pairingOffer, surfaceLink }: {
  controller: AppController;
  /** A `weave pair` link the app was opened with, for the person to confirm. */
  pairingOffer?: { url: string; code: string };
  /** The iPhone's way to a Surface, a display it's connected to (WVE-183). */
  surfaceLink?: SurfaceLink;
}) {
  const phone = usePhoneLayout();
  const { model, actions } = controller;
  // The Session on screen: the controller's when it starts with one, as a fixture does, else the
  // one this device last showed.
  const [selected, setSelected] = useState<string | undefined>(() => model.session?.key ?? loadLastSession());
  // The Sessions the Hosts keep, and the one on screen before its Host has made it.
  // A Session being started here shows before its Host has it: its first Block makes it.
  const [starting, setStarting] = useState<string>();
  const sessions = useMemo(() => sessionSummaries(model, { also: starting }), [model.threads, model.known, model.unread, model.bots, starting]);
  const [reveal, setReveal] = useState<string>();
  // A thread asked for before its Host listed it, as by the link the app was opened with.
  const [wanted, setWanted] = useState<string>();
  const [hostsOpen, setHostsOpen] = useState(false);
  const [newThread, setNewThread] = useState<NewThreadTarget>();
  const [palette, setPalette] = useState(false);
  // The Session the person asked to end, until they confirm or don't.
  const [ending, setEnding] = useState<SessionSummary>();
  const [botPage, setBotPage] = useState(false);
  const [newBot, setNewBot] = useState(false);
  const openHosts = () => setHostsOpen(true);
  const unpaired = !model.starting && (!model.dispatcher || model.dispatcher.status === 'revoked');
  // A Bot on screen is the Session at its home (WVE-178).
  const botId = selectedBot(selected);
  const bot = botId ? model.bots?.find(({ id }) => id === botId) : undefined;
  const botSessionAt = bot ? botSessionKey(bot, model.threads) : undefined;
  const showing = botId ? botSessionAt : selected;

  useEffect(() => saveLastSession(selected), [selected]);
  useEffect(() => {
    actions.selectSession?.(showing);
  }, [showing]);
  useEffect(() => {
    if (!botId) setBotPage(false);
  }, [botId]);

  // Its Host names the Session's directory otherwise: the same Session, under that name.
  useEffect(() => {
    if (model.session?.movedFrom && model.session.movedFrom === selected) setSelected(model.session.key);
  }, [model.session?.movedFrom, model.session?.key, selected]);

  const openThread = (key: string) => setWanted(key);
  useEffect(() => {
    if (!wanted) return;
    // A Bot's thread opens the Bot, its Session being listed as the Bot.
    const owner = botOfThread(model.bots, wanted);
    if (owner) {
      setSelected(botSelection(owner.id));
      setWanted(undefined);
      return;
    }
    const session = sessionWith(sessions, wanted);
    if (!session) return;
    setSelected(session.key);
    setReveal(wanted);
    setWanted(undefined);
  }, [wanted, sessions, model.bots]);
  const created = (thread: CreatedThread) => {
    setStarting(thread.sessionKey);
    setSelected(thread.sessionKey);
    setReveal(thread.key);
  };
  /**
   * A thread a Bot started elsewhere, given a Block in its directory's Session, which is made if
   * there's none: the Host counts it the Session's, and the Session places it as any Block.
   */
  const bringIn = (thread: ThreadSummary) => {
    setBotPage(false);
    const listed = sessionWith(sessions, thread.key);
    const key = listed?.key ?? sessionKey(thread.hostId, threadDirectories(model.threads, model.known ?? []).get(thread.key) ?? threadDirectory(thread));
    if (!listed) {
      actions.addToSession?.(key, { threads: [thread.threadId], terminals: [] });
      setStarting(key);
    }
    setSelected(key);
    setReveal(thread.key);
  };
  const removed = (gone: BotSummary) => {
    setBotPage(false);
    // Its Session is an ordinary one now, under its Host, if one was made.
    const key = botSessionKey(gone, model.threads);
    setSelected(key && model.known?.some((known) => sessionKey(known.hostId, known.directory) === key) ? key : undefined);
  };
  useOpenThreadRequests(openThread);

  useEffect(() => {
    if (pairingOffer && !unpaired) setHostsOpen(true);
    // A link opened while paired asks in the Hosts dialog; unpaired, on the pairing screen.
  }, [pairingOffer]);

  // On the Mac the menu bar has the keys; elsewhere a hardware keyboard's reach the page.
  useCommandKeys(platform().keys === 'page' && !unpaired);
  const ordered = useMemo(() => {
    const view = sessionListView(sessions, model.hosts, model.projects);
    return [
      ...(model.bots ?? []).map(({ id }) => botSelection(id)),
      ...view.projects.flatMap(({ sessions: under }) => under.map(({ session }) => session.key)),
      ...view.hosts.flatMap(({ sessions: under }) => under.map(({ key }) => key)),
    ];
  }, [sessions, model.hosts, model.projects, model.bots]);
  const step = (by: number) => {
    if (ordered.length === 0) return;
    const at = selected ? ordered.indexOf(selected) : -1;
    setSelected(ordered[at < 0 ? (by > 0 ? 0 : ordered.length - 1) : (at + by + ordered.length) % ordered.length]);
  };
  const canStart = model.hosts.some(({ status }) => status === 'connected');
  useCommand('session.next', () => step(1), !unpaired && ordered.length > 1);
  useCommand('session.previous', () => step(-1), !unpaired && ordered.length > 1);
  useCommand('session.new', () => setNewThread({}), !unpaired && canStart);
  // The Session on screen, where its Host keeps it and closes what's in it when it ends.
  const current = sessions.find(({ key }) => key === selected);
  const currentHost = current ? model.hosts.find(({ id }) => id === current.hostId) : undefined;
  const endable = Boolean(current && currentHost?.status === 'connected' && currentHost.canEndSessions
    && model.known?.some((known) => known.hostId === current.hostId && known.directory === current.directory));
  useCommand('session.end', () => setEnding(current), !unpaired && endable);
  // With a Session on screen, a new thread starts in it: the Session's own command.
  useCommand('thread.new', () => setNewThread({}), !unpaired && canStart && model.session?.key !== showing);
  useCommand('palette.open', () => setPalette(true), !unpaired);

  if (unpaired) return <PairingScreen controller={controller} offer={pairingOffer} />;
  // Only a Session there is shows: one this device last showed may have ended since.
  const shown = model.session?.key === selected && sessions.some(({ key }) => key === selected) ? model.session : undefined;
  const shell: ShellProps = {
    controller,
    sessions,
    session: shown,
    selected,
    bot,
    botSession: bot && botSessionAt && model.session?.key === botSessionAt ? model.session : undefined,
    waiting: waitingSessions(sessions, selected) + waitingBots(model.bots, botId),
    onOpenBotPage: () => setBotPage(true),
    onNewBot: () => setNewBot(true),
    reveal: shown ? reveal : undefined,
    onRevealed: () => setReveal(undefined),
    onOpenSession: setSelected,
    onOpenThread: openThread,
    onCreated: created,
    onOpenHosts: openHosts,
    onNewSession: (target) => setNewThread(target ?? {}),
    onEndSession: setEnding,
  };
  return (
    <ResizableSidebarProvider className='h-dvh min-h-0' cookieName={false} data-layout={phone ? 'phone' : 'split'}>
      {phone ? <PhoneShell {...shell} surfaceLink={surfaceLink} /> : <SplitShell {...shell} />}
      <WaitingBanner controller={controller} onOpen={openThread} />
      <HostsDialog controller={controller} open={hostsOpen} onOpenChange={setHostsOpen} offer={pairingOffer} />
      <NewThreadDialog controller={controller} target={newThread} session onCreated={created} onClose={() => setNewThread(undefined)} />
      <EndSessionDialog controller={controller} session={ending} onClose={() => setEnding(undefined)}
        onEnded={(key) => { if (key === selected) setSelected(undefined); }} />
      <CommandPalette open={palette} onOpenChange={setPalette} />
      <BotPage controller={controller} bot={bot} open={botPage && bot !== undefined} onOpenChange={setBotPage} phone={phone} onBringIn={bringIn} onRemoved={removed} />
      <NewBotDialog controller={controller} open={newBot} onClose={() => setNewBot(false)} onAdded={(added) => setSelected(botSelection(added.id))} />
    </ResizableSidebarProvider>
  );
}
