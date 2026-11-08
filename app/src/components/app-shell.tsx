import { useEffect, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons';
import type { AppController } from '@/app/app-controller';
import { waitingCount } from '@/app/thread-list';
import { usePhoneLayout } from '@/app/use-phone-layout';
import { HostsDialog } from '@/components/hosts-dialog';
import { PairingScreen } from '@/components/pair-dispatcher';
import { ResizableSidebarProvider, SidebarResizeHandle } from '@/components/sidebar-resize';
import { ThreadList } from '@/components/thread-list';
import { ThreadHeader, ThreadView } from '@/components/thread-view';
import { WaitingBanner } from '@/components/waiting-banner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Sidebar, SidebarInset, useSidebar } from '@/components/ui/sidebar';
import type { SurfaceLink } from '@/surface/surface-link';
import { useSurface } from '@/surface/use-surface';

function WaitingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <Badge className='bg-warning text-background' aria-label={`${count} waiting`}>{count}</Badge>;
}

/** iPhone: Back to the list, with how many other threads wait on the person. */
function BackButton({ controller }: { controller: AppController }) {
  const { model, actions } = controller;
  const count = waitingCount(model.threads, model.selectedKey);
  return (
    <Button variant='ghost' size='lg' aria-label={count ? `Threads, ${count} waiting` : 'Threads'} className='min-h-11 shrink-0 px-1.5'
      onClick={() => actions.selectThread(undefined)}>
      <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
      <WaitingBadge count={count} />
    </Button>
  );
}

/** iPad and wider: shows and hides the thread list, with a count while it is hidden. */
function SidebarToggle({ controller }: { controller: AppController }) {
  const { model } = controller;
  const { isMobile, openMobile, state, toggleSidebar } = useSidebar();
  const hidden = isMobile ? !openMobile : state === 'collapsed';
  const count = hidden ? waitingCount(model.threads, model.selectedKey) : 0;
  return (
    <Button variant='ghost' size='lg' aria-label={hidden ? (count ? `Show threads, ${count} waiting` : 'Show threads') : 'Hide threads'}
      aria-expanded={!hidden} className='min-h-11 shrink-0 px-1.5 aria-expanded:bg-transparent' onClick={toggleSidebar}>
      <HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={2} />
      <WaitingBadge count={count} />
    </Button>
  );
}

function PhoneShell({ controller, onOpenHosts, surfaceLink }: {
  controller: AppController;
  onOpenHosts(): void;
  surfaceLink?: SurfaceLink;
}) {
  const { model, actions } = controller;
  // A Surface (WVE-183) shows the open thread, or the one last open while the list is here.
  const surface = useSurface(model, surfaceLink);
  const surfaced = Boolean(surface?.status.connected && model.thread);
  // With the thread on the Surface, the iPhone may turn for a bigger keyboard; elsewhere it stays upright.
  useEffect(() => surfaceLink?.setLandscape(surfaced), [surfaceLink, surfaced]);
  if (!model.thread) return <ThreadList controller={controller} onOpenHosts={onOpenHosts} />;
  return (
    <ThreadView controller={controller} thread={model.thread} leading={<BackButton controller={controller} />}
      onSwipeBack={() => actions.selectThread(undefined)} surface={surface} />
  );
}

function SplitShell({ controller, onOpenHosts }: { controller: AppController; onOpenHosts(): void }) {
  const { model } = controller;
  const { setOpenMobile } = useSidebar();
  return (
    <>
      <Sidebar collapsible='offcanvas'>
        <ThreadList controller={controller} onOpen={() => setOpenMobile(false)} onOpenHosts={onOpenHosts} />
        <SidebarResizeHandle />
      </Sidebar>
      <SidebarInset className='min-h-0 min-w-0 overflow-hidden'>
        {model.thread
          ? <ThreadView controller={controller} thread={model.thread} leading={<SidebarToggle controller={controller} />} />
          : (
            <>
              <ThreadHeader leading={<SidebarToggle controller={controller} />} />
              <Empty className='flex-1'>
                <EmptyHeader>
                  <EmptyTitle>No thread open</EmptyTitle>
                  <EmptyDescription>Pick a thread from the list, or start a new one.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            </>
          )}
      </SidebarInset>
    </>
  );
}

/**
 * The app's layout. An iPhone stacks the list and a thread; an iPad, or anything wider, shows the
 * list as a sidebar beside one thread, as wide as its edge is dragged. Which follows the device,
 * not the window's width. Until the app is paired with the Dispatcher, or once the Dispatcher
 * revoked it, it shows the pairing screen instead.
 */
export function AppShell({ controller, pairingOffer, surfaceLink }: {
  controller: AppController;
  /** A `weave dispatcher pair` link the app was opened with, for the person to confirm. */
  pairingOffer?: { url: string; code: string };
  /** The iPhone's way to a Surface, a display it's connected to (WVE-183). */
  surfaceLink?: SurfaceLink;
}) {
  const phone = usePhoneLayout();
  const [hostsOpen, setHostsOpen] = useState(false);
  const openHosts = () => setHostsOpen(true);
  const { model } = controller;
  const unpaired = !model.starting && (!model.dispatcher || model.dispatcher.status === 'revoked');
  useEffect(() => {
    if (pairingOffer && !unpaired) setHostsOpen(true);
    // A link opened while paired asks in the Hosts dialog; unpaired, on the pairing screen.
  }, [pairingOffer]);
  if (unpaired) return <PairingScreen controller={controller} offer={pairingOffer} />;
  return (
    <ResizableSidebarProvider className='h-dvh min-h-0' cookieName={false} data-layout={phone ? 'phone' : 'split'}>
      {phone ? <PhoneShell controller={controller} onOpenHosts={openHosts} surfaceLink={surfaceLink} /> : <SplitShell controller={controller} onOpenHosts={openHosts} />}
      <WaitingBanner controller={controller} />
      <HostsDialog controller={controller} open={hostsOpen} onOpenChange={setHostsOpen} offer={pairingOffer} />
    </ResizableSidebarProvider>
  );
}
