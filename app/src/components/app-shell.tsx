import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons';
import type { AppController } from '@/app/app-controller';
import { waitingCount } from '@/app/session-list';
import { usePhoneLayout } from '@/app/use-phone-layout';
import { HostsDialog } from '@/components/hosts-dialog';
import { SessionList } from '@/components/session-list';
import { SessionHeader, SessionView } from '@/components/session-view';
import { WaitingBanner } from '@/components/waiting-banner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Sidebar, SidebarInset, SidebarProvider, useSidebar } from '@/components/ui/sidebar';

function WaitingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <Badge className='bg-warning text-background' aria-label={`${count} waiting`}>{count}</Badge>;
}

/** iPhone: Back to the list, with how many other sessions wait on the person. */
function BackButton({ controller }: { controller: AppController }) {
  const { model, actions } = controller;
  const count = waitingCount(model.sessions, model.selectedKey);
  return (
    <Button variant='ghost' size='lg' aria-label={count ? `Sessions, ${count} waiting` : 'Sessions'} className='min-h-11 shrink-0 px-1.5'
      onClick={() => actions.selectSession(undefined)}>
      <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
      <WaitingBadge count={count} />
    </Button>
  );
}

/** iPad and wider: shows and hides the session list, with a count while it is hidden. */
function SidebarToggle({ controller }: { controller: AppController }) {
  const { model } = controller;
  const { isMobile, openMobile, state, toggleSidebar } = useSidebar();
  const hidden = isMobile ? !openMobile : state === 'collapsed';
  const count = hidden ? waitingCount(model.sessions, model.selectedKey) : 0;
  return (
    <Button variant='ghost' size='lg' aria-label={hidden ? (count ? `Show sessions, ${count} waiting` : 'Show sessions') : 'Hide sessions'}
      aria-expanded={!hidden} className='min-h-11 shrink-0 px-1.5 aria-expanded:bg-transparent' onClick={toggleSidebar}>
      <HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} />
      <WaitingBadge count={count} />
    </Button>
  );
}

function PhoneShell({ controller, onOpenHosts }: { controller: AppController; onOpenHosts(): void }) {
  const { model, actions } = controller;
  if (!model.session) return <SessionList controller={controller} onOpenHosts={onOpenHosts} />;
  return (
    <SessionView controller={controller} session={model.session} leading={<BackButton controller={controller} />}
      onSwipeBack={() => actions.selectSession(undefined)} />
  );
}

function SplitShell({ controller, onOpenHosts }: { controller: AppController; onOpenHosts(): void }) {
  const { model } = controller;
  const { setOpenMobile } = useSidebar();
  return (
    <>
      <Sidebar collapsible='offcanvas'>
        <SessionList controller={controller} onOpen={() => setOpenMobile(false)} onOpenHosts={onOpenHosts} />
      </Sidebar>
      <SidebarInset className='min-h-0 min-w-0 overflow-hidden'>
        {model.session
          ? <SessionView controller={controller} session={model.session} leading={<SidebarToggle controller={controller} />} />
          : (
            <>
              <SessionHeader leading={<SidebarToggle controller={controller} />} />
              <Empty className='flex-1'>
                <EmptyHeader>
                  <EmptyTitle>No session open</EmptyTitle>
                  <EmptyDescription>Pick a session from the list, or start a new one.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </>
          )}
      </SidebarInset>
    </>
  );
}

/**
 * The app's layout. An iPhone stacks the list and a session; an iPad, or anything wider, shows the
 * list as a sidebar beside one session. Which follows the device, not the window's width.
 */
export function AppShell({ controller, pairingOffer }: {
  controller: AppController;
  /** A `weave pair` link the app was opened with, for the person to confirm. */
  pairingOffer?: { url: string; code: string };
}) {
  const phone = usePhoneLayout();
  const [hostsOpen, setHostsOpen] = useState(false);
  const openHosts = () => setHostsOpen(true);
  useEffect(() => {
    if (pairingOffer) setHostsOpen(true);
  }, [pairingOffer]);
  return (
    <SidebarProvider className='h-dvh min-h-0' cookieName={false} data-layout={phone ? 'phone' : 'split'}>
      {phone ? <PhoneShell controller={controller} onOpenHosts={openHosts} /> : <SplitShell controller={controller} onOpenHosts={openHosts} />}
      <WaitingBanner controller={controller} />
      <HostsDialog controller={controller} open={hostsOpen} onOpenChange={setHostsOpen} offer={pairingOffer} />
    </SidebarProvider>
  );
}
