import { useEffect, useMemo, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons';
import type { AppController, CreatedThread, SessionSummary } from '@/app/app-controller';
import { sessionOfKey } from '@/app/app-controller';
import { useCommand, useCommandKeys } from '@/app/commands';
import { useOpenThreadRequests } from '@/app/open-thread';
import { platform } from '@/app/platform';
import { usePhoneLayout } from '@/app/use-phone-layout';
import { CommandPalette } from '@/components/command-palette';
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
import { directoryName, sessionListView, sessionSummaries, sessionWith, waitingSessions } from '@/session/sessions';
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
function NoSession({ controller, selected, leading }: { controller: AppController; selected?: string; leading?: React.ReactNode }) {
  const { model } = controller;
  const host = selected ? model.hosts.find(({ id }) => id === sessionOfKey(selected).hostId) : undefined;
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
  /** The Session to show, by key, and the thread in it to bring to the front. */
  selected?: string;
  reveal?: string;
  onRevealed(): void;
  onOpenSession(key?: string): void;
  onOpenThread(key: string): void;
  onOpenHosts(): void;
  onNewThread(hostId?: string): void;
};

function PhoneShell({ controller, sessions, selected, reveal, onRevealed, onOpenSession, onOpenThread, onOpenHosts, onNewThread, surfaceLink }: ShellProps & {
  surfaceLink?: SurfaceLink;
}) {
  const { model } = controller;
  // A Surface (WVE-183) shows the thread in front, or the one last there while the list is here.
  const surface = useSurface(model, surfaceLink);
  const surfaced = Boolean(surface?.status.connected && model.thread);
  // With the thread on the Surface, the iPhone may turn for a bigger keyboard; elsewhere it stays upright.
  useEffect(() => surfaceLink?.setLandscape(surfaced), [surfaceLink, surfaced]);
  const back = () => onOpenSession(undefined);
  const leading = <BackButton count={waitingSessions(sessions, selected)} onBack={back} />;
  if (!selected) return <SessionList controller={controller} sessions={sessions} onOpen={onOpenSession} onOpenHosts={onOpenHosts} onNewThread={onNewThread} />;
  const session = model.session?.key === selected ? model.session : undefined;
  if (!session) return <NoSession controller={controller} selected={selected} leading={leading} />;
  return (
    <SessionView key={session.key} controller={controller} session={session} members={membersOf(sessions, session.key)} phone leading={leading}
      reveal={reveal} onRevealed={onRevealed} onOpenThread={onOpenThread} surface={surface} onBack={back} />
  );
}

function SplitShell({ controller, sessions, selected, reveal, onRevealed, onOpenSession, onOpenThread, onOpenHosts, onNewThread }: ShellProps) {
  const { model } = controller;
  const { setOpenMobile } = useSidebar();
  const session = model.session?.key === selected ? model.session : undefined;
  const leading = <SidebarToggle waiting={waitingSessions(sessions, selected)} />;
  return (
    <>
      <Sidebar collapsible='offcanvas'>
        <SessionList controller={controller} sessions={sessions} selected={selected} onOpenHosts={onOpenHosts} onNewThread={onNewThread}
          onOpen={(key) => {
            onOpenSession(key);
            setOpenMobile(false);
          }} />
        <SidebarResizeHandle />
      </Sidebar>
      <SidebarInset className='min-h-0 min-w-0 overflow-hidden'>
        {session
          ? <SessionView key={session.key} controller={controller} session={session} members={membersOf(sessions, session.key)} leading={leading}
              reveal={reveal} onRevealed={onRevealed} onOpenThread={onOpenThread} />
          : <NoSession controller={controller} selected={selected} leading={leading} />}
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
  const sessions = useMemo(() => sessionSummaries(model), [model.threads, model.known, model.unread]);
  // The Session on screen: the controller's when it starts with one, as a fixture does, else the
  // one this device last showed.
  const [selected, setSelected] = useState<string | undefined>(() => model.session?.key ?? loadLastSession());
  const [reveal, setReveal] = useState<string>();
  // A thread asked for before its Host listed it, as by the link the app was opened with.
  const [wanted, setWanted] = useState<string>();
  const [hostsOpen, setHostsOpen] = useState(false);
  const [newThread, setNewThread] = useState<NewThreadTarget>();
  const [palette, setPalette] = useState(false);
  const openHosts = () => setHostsOpen(true);
  const unpaired = !model.starting && (!model.dispatcher || model.dispatcher.status === 'revoked');

  useEffect(() => {
    actions.selectSession?.(selected);
    saveLastSession(selected);
  }, [selected]);

  // Its Host names the Session's directory otherwise: the same Session, under that name.
  useEffect(() => {
    if (model.session?.movedFrom && model.session.movedFrom === selected) setSelected(model.session.key);
  }, [model.session?.movedFrom, model.session?.key, selected]);

  const openThread = (key: string) => setWanted(key);
  useEffect(() => {
    if (!wanted) return;
    const session = sessionWith(sessions, wanted);
    if (!session) return;
    setSelected(session.key);
    setReveal(wanted);
    setWanted(undefined);
  }, [wanted, sessions]);
  const created = (thread: CreatedThread) => {
    setSelected(thread.sessionKey);
    setReveal(thread.key);
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
    return [...view.projects.flatMap(({ sessions: under }) => under.map(({ session }) => session.key)), ...view.hosts.flatMap(({ sessions: under }) => under.map(({ key }) => key))];
  }, [sessions, model.hosts, model.projects]);
  const step = (by: number) => {
    if (ordered.length === 0) return;
    const at = selected ? ordered.indexOf(selected) : -1;
    setSelected(ordered[at < 0 ? (by > 0 ? 0 : ordered.length - 1) : (at + by + ordered.length) % ordered.length]);
  };
  const canStart = model.hosts.some(({ status }) => status === 'connected');
  useCommand('session.next', () => step(1), !unpaired && ordered.length > 1);
  useCommand('session.previous', () => step(-1), !unpaired && ordered.length > 1);
  useCommand('session.new', () => setNewThread({}), !unpaired && canStart);
  // With a Session on screen, a new thread starts in it: the Session's own command.
  useCommand('thread.new', () => setNewThread({}), !unpaired && canStart && model.session?.key !== selected);
  useCommand('palette.open', () => setPalette(true), !unpaired);

  if (unpaired) return <PairingScreen controller={controller} offer={pairingOffer} />;
  const shell: ShellProps = {
    controller,
    sessions,
    selected,
    reveal: model.session?.key === selected ? reveal : undefined,
    onRevealed: () => setReveal(undefined),
    onOpenSession: setSelected,
    onOpenThread: openThread,
    onOpenHosts: openHosts,
    onNewThread: (hostId) => setNewThread(hostId ? { hostId } : {}),
  };
  return (
    <ResizableSidebarProvider className='h-dvh min-h-0' cookieName={false} data-layout={phone ? 'phone' : 'split'}>
      {phone ? <PhoneShell {...shell} surfaceLink={surfaceLink} /> : <SplitShell {...shell} />}
      <WaitingBanner controller={controller} onOpen={openThread} />
      <HostsDialog controller={controller} open={hostsOpen} onOpenChange={setHostsOpen} offer={pairingOffer} />
      <NewThreadDialog controller={controller} target={newThread} onCreated={created} onClose={() => setNewThread(undefined)} />
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </ResizableSidebarProvider>
  );
}
