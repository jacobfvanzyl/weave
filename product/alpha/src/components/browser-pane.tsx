import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Add01Icon,
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  BrowserIcon,
  Cancel01Icon,
  Delete02Icon,
  LinkSquare01Icon,
  Loading03Icon,
  MoreHorizontalIcon,
  ReloadIcon,
  StopIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { resolveAlphaBrowserLocation } from '@/app/alpha-browser-location';
import { useAlphaBrowserSession } from '@/app/use-alpha-browser-session';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const tabLabel = (title: string | undefined, url: string) => {
  if (title?.trim()) return title.trim();
  if (!url) return 'New tab';
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
};

export function BrowserPane({
  className,
  maximized = false,
  onClose,
  onToggleMaximized,
}: {
  className?: string;
  maximized?: boolean;
  onClose?(): void;
  onToggleMaximized?(): void;
}) {
  const [externalRequest, setExternalRequest] = useState<{
    url: string;
    restoreAddress: boolean;
  }>();
  const [resetOpen, setResetOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const presentationSuspended = Boolean(externalRequest) || resetOpen || optionsOpen;
  const browser = useAlphaBrowserSession(presentationSuspended);
  const addressRef = useRef<HTMLInputElement>(null);
  const lastFocusedBlankTab = useRef<string | undefined>(undefined);
  const previousSelectedTabId = useRef(browser.state.selectedTabId);
  const [location, setLocation] = useState(browser.state.url);
  const [editingLocation, setEditingLocation] = useState(false);
  const [locationError, setLocationError] = useState<string>();
  const selectedTab = useMemo(
    () => browser.state.tabs.find(({ id }) => id === browser.state.selectedTabId),
    [browser.state.selectedTabId, browser.state.tabs],
  );

  useEffect(() => {
    if (!editingLocation) setLocation(browser.state.url);
  }, [browser.state.url, editingLocation]);

  useEffect(() => {
    if (previousSelectedTabId.current === browser.state.selectedTabId) return;
    previousSelectedTabId.current = browser.state.selectedTabId;
    setLocation(browser.state.url);
    setLocationError(undefined);
    setEditingLocation(false);
    addressRef.current?.blur();
  }, [browser.state.selectedTabId, browser.state.url]);

  useEffect(() => {
    const tabId = browser.state.selectedTabId;
    if (!browser.state.supported || !tabId || browser.state.url || lastFocusedBlankTab.current === tabId) {
      return;
    }
    lastFocusedBlankTab.current = tabId;
    addressRef.current?.focus();
  }, [browser.state.selectedTabId, browser.state.supported, browser.state.url]);

  useEffect(() => {
    const requestExternal = (event: Event) => {
      const url = (event as CustomEvent<unknown>).detail;
      if (typeof url === 'string') setExternalRequest({ url, restoreAddress: false });
    };
    window.addEventListener('weave:alpha-browser-open-external', requestExternal);
    return () => window.removeEventListener('weave:alpha-browser-open-external', requestExternal);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (document.activeElement === addressRef.current) {
          event.preventDefault();
          setLocation(browser.state.url);
          setLocationError(undefined);
          setEditingLocation(false);
          addressRef.current?.blur();
        } else if (browser.state.loading && browser.state.selectedTabId) {
          event.preventDefault();
          browser.send({ type: 'stop', tabId: browser.state.selectedTabId });
        }
        return;
      }
      const command = event.metaKey || event.ctrlKey;
      if (!command || event.altKey) return;
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault();
        addressRef.current?.focus();
        addressRef.current?.select();
        return;
      }
      if (!browser.state.supported) return;
      if (event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault();
        onClose?.();
      } else if (event.shiftKey && event.key.toLowerCase() === 'o' && browser.state.url) {
        event.preventDefault();
        browser.send({ type: 'open.external', url: browser.state.url });
      } else if (event.key === '[' && browser.state.canGoBack) {
        event.preventDefault();
        browser.send({ type: 'back', tabId: browser.state.selectedTabId });
      } else if (event.key === ']' && browser.state.canGoForward) {
        event.preventDefault();
        browser.send({ type: 'forward', tabId: browser.state.selectedTabId });
      } else if (event.key.toLowerCase() === 'r' && browser.state.selectedTabId) {
        event.preventDefault();
        browser.send({ type: 'reload', tabId: browser.state.selectedTabId });
      } else if (event.key === '.' && browser.state.loading && browser.state.selectedTabId) {
        event.preventDefault();
        browser.send({ type: 'stop', tabId: browser.state.selectedTabId });
      } else if (event.key.toLowerCase() === 't') {
        event.preventDefault();
        browser.send({ type: 'tab.new' });
      } else if (event.key.toLowerCase() === 'w' && browser.state.selectedTabId) {
        event.preventDefault();
        browser.send({ type: 'tab.close', tabId: browser.state.selectedTabId });
      } else if (event.key === 'Tab' && browser.state.tabs.length > 1) {
        event.preventDefault();
        const current = browser.state.tabs.findIndex(({ id }) => id === browser.state.selectedTabId);
        const delta = event.shiftKey ? -1 : 1;
        const next = (current + delta + browser.state.tabs.length) % browser.state.tabs.length;
        browser.send({ type: 'tab.select', tabId: browser.state.tabs[next].id });
      } else if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        const tab = browser.state.tabs[index];
        if (tab) {
          event.preventDefault();
          browser.send({ type: 'tab.select', tabId: tab.id });
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    browser.send,
    browser.state.canGoBack,
    browser.state.canGoForward,
    browser.state.loading,
    browser.state.selectedTabId,
    browser.state.supported,
    browser.state.tabs,
    browser.state.url,
    onClose,
  ]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const destination = resolveAlphaBrowserLocation(location);
    setLocationError(undefined);
    if (destination.kind === 'empty') return;
    if (destination.kind === 'invalid') {
      setLocationError(destination.message);
      return;
    }
    if (destination.kind === 'external') {
      setExternalRequest({ url: destination.url, restoreAddress: true });
      return;
    }
    browser.send({
      type: 'navigate',
      tabId: browser.state.selectedTabId,
      url: destination.url,
    });
    setEditingLocation(false);
    addressRef.current?.blur();
  };

  const activeUrl = selectedTab?.url ?? '';
  const activeLabel = tabLabel(selectedTab?.title, activeUrl);
  const selectedTabId = browser.state.selectedTabId;
  const closeExternalRequest = () => {
    if (externalRequest?.restoreAddress) {
      setLocation(browser.state.url);
      setEditingLocation(false);
      setLocationError(undefined);
      window.requestAnimationFrame(() => addressRef.current?.blur());
    }
    setExternalRequest(undefined);
  };

  return (
    <section
      aria-label='Browser Pane'
      data-slot='browser-pane'
      className={cn('@container/browser flex min-h-0 min-w-0 flex-1 flex-col bg-background', className)}
    >
      <Tabs
        value={selectedTabId ?? ''}
        onValueChange={(tabId) => browser.send({ type: 'tab.select', tabId })}
        className='min-h-0 flex-1 gap-0'
      >
        <header data-slot='browser-chrome' className='shrink-0 border-b border-border bg-title-bar'>
          <div className='flex h-11 min-w-0 items-stretch border-b border-border/70'>
            <TabsList
              variant='editor'
              aria-label='Browser tabs'
              className='h-full min-w-0 flex-1 justify-start overflow-x-auto'
            >
              {browser.state.tabs.map((tab) => {
                const label = tabLabel(tab.title, tab.url);
                return (
                  <div
                    key={tab.id}
                    className='group/tab flex h-full min-w-28 max-w-52 items-stretch border-r border-border/70 data-[active=true]:bg-background'
                    data-active={tab.id === selectedTabId}
                  >
                    <TabsTrigger
                      value={tab.id}
                      aria-label={tab.loading ? `${label} (loading)` : label}
                      aria-busy={tab.loading}
                      className='min-w-0 justify-start'
                    >
                      <HugeiconsIcon
                        data-icon='inline-start'
                        icon={tab.loading ? Loading03Icon : BrowserIcon}
                        className={cn(tab.loading && 'animate-spin motion-reduce:animate-none')}
                        strokeWidth={2}
                      />
                      <span className='truncate'>{label}</span>
                    </TabsTrigger>
                    <Button
                      type='button'
                      size='icon'
                      variant='ghost'
                      aria-label={`Close ${label}`}
                      className='h-full w-11 shrink-0 rounded-none opacity-70 hover:opacity-100'
                      onClick={() => browser.send({ type: 'tab.close', tabId: tab.id })}
                    >
                      <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                    </Button>
                  </div>
                );
              })}
            </TabsList>
            <Button
              type='button'
              size='icon'
              variant='ghost'
              aria-label='New Tab'
              title='New Tab (⌘T)'
              className='h-full w-11 shrink-0 rounded-none'
              disabled={!browser.state.supported}
              onClick={() => browser.send({ type: 'tab.new' })}
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            </Button>
          </div>

          <div data-slot='browser-toolbar' className='flex h-11 min-w-0 items-stretch'>
            <div className='flex h-full shrink-0 items-stretch'>
              <Button type='button' size='icon' variant='ghost' aria-label='Back' className='h-full w-11 rounded-none' disabled={!browser.state.supported || !browser.state.canGoBack} onClick={() => browser.send({ type: 'back', tabId: selectedTabId })}>
                <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
              </Button>
              <Button type='button' size='icon' variant='ghost' aria-label='Forward' className='h-full w-11 rounded-none @max-[28rem]/browser:hidden' disabled={!browser.state.supported || !browser.state.canGoForward} onClick={() => browser.send({ type: 'forward', tabId: selectedTabId })}>
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
              </Button>
              <Button
                type='button' size='icon' variant='ghost'
                aria-label={browser.state.loading ? 'Stop Loading' : 'Reload'}
                className='h-full w-11 rounded-none'
                disabled={!browser.state.supported || !selectedTabId || (!activeUrl && !browser.state.loading)}
                onClick={() => browser.send({ type: browser.state.loading ? 'stop' : 'reload', tabId: selectedTabId })}
              >
                <HugeiconsIcon icon={browser.state.loading ? StopIcon : ReloadIcon} strokeWidth={2} />
              </Button>
            </div>

            <form className='flex min-w-0 flex-1 items-center px-1.5' onSubmit={navigate}>
              <Input
                ref={addressRef} aria-label='Browser address' value={location}
                spellCheck={false} autoCapitalize='none' autoCorrect='off'
                placeholder='Search Google or enter an address'
                aria-invalid={Boolean(locationError)}
                disabled={!browser.state.supported || !selectedTabId}
                className='bg-background'
                onFocus={(event) => { event.currentTarget.select(); }}
                onBlur={() => setEditingLocation(false)}
                onChange={(event) => { setEditingLocation(true); setLocation(event.currentTarget.value); setLocationError(undefined); }}
              />
            </form>

            <div className='flex h-full shrink-0 items-stretch'>
              <Button
                type='button'
                size='icon'
                variant='ghost'
                aria-label='Open in System Browser'
                title='Open in System Browser (⌘⇧O)'
                className='h-full w-11 rounded-none @max-[28rem]/browser:hidden'
                disabled={!activeUrl}
                onClick={() => browser.send({ type: 'open.external', url: activeUrl })}
              >
                <HugeiconsIcon icon={LinkSquare01Icon} strokeWidth={2} />
              </Button>
              <DropdownMenu open={optionsOpen} onOpenChange={setOptionsOpen}>
                <DropdownMenuTrigger
                  disabled={!browser.state.supported}
                  render={<Button type='button' size='icon' variant='ghost' aria-label='Browser Options' className='h-full w-11 rounded-none' />}
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align='end' className='w-64'>
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Private Browser Session</DropdownMenuLabel>
                    <DropdownMenuItem disabled>Browsing data is cleared when Alpha quits</DropdownMenuItem>
                    <DropdownMenuItem disabled>New-window links open in Alpha tabs</DropdownMenuItem>
                    <DropdownMenuItem disabled>Uploads use the system picker</DropdownMenuItem>
                    <DropdownMenuItem disabled>Downloads and camera/microphone are unavailable</DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuItem
                      disabled={!browser.state.canGoForward}
                      onClick={() => browser.send({ type: 'forward', tabId: selectedTabId })}
                    >
                      <HugeiconsIcon data-icon='inline-start' icon={ArrowRight01Icon} strokeWidth={2} />
                      Forward
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!selectedTabId || (!activeUrl && !browser.state.loading)}
                      onClick={() => browser.send({
                        type: browser.state.loading ? 'stop' : 'reload',
                        tabId: selectedTabId,
                      })}
                    >
                      <HugeiconsIcon data-icon='inline-start' icon={browser.state.loading ? StopIcon : ReloadIcon} strokeWidth={2} />
                      {browser.state.loading ? 'Stop Loading' : 'Reload'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!activeUrl}
                      onClick={() => activeUrl && browser.send({ type: 'open.external', url: activeUrl })}
                    >
                      <HugeiconsIcon data-icon='inline-start' icon={LinkSquare01Icon} strokeWidth={2} />
                      Open in System Browser
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={onToggleMaximized}
                    >
                      <HugeiconsIcon data-icon='inline-start' icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} strokeWidth={2} />
                      {maximized ? 'Restore Browser' : 'Maximize Browser'}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={onClose}
                    >
                      <HugeiconsIcon data-icon='inline-start' icon={Cancel01Icon} strokeWidth={2} />
                      Close Browser
                    </DropdownMenuItem>
                    <DropdownMenuItem variant='destructive' onClick={() => setResetOpen(true)}>
                      <HugeiconsIcon data-icon='inline-start' icon={Delete02Icon} strokeWidth={2} />
                      Reset Browser
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button type='button' size='icon' variant='ghost' aria-label={maximized ? 'Restore Browser' : 'Maximize Browser'} aria-pressed={maximized} title={maximized ? 'Restore Browser' : 'Maximize Browser'} className='h-full w-11 rounded-none @max-[28rem]/browser:hidden' onClick={onToggleMaximized}>
                <HugeiconsIcon data-symbol={maximized ? 'collapse-browser' : 'expand-browser'} icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} strokeWidth={2} />
              </Button>
              <Button type='button' size='icon' variant='ghost' aria-label='Close Browser' className='h-full w-11 rounded-none @max-[28rem]/browser:hidden' onClick={onClose}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </div>
          </div>
        </header>

        {(locationError || browser.state.error) && (
          <div role='alert' className='flex shrink-0 items-center gap-2 border-b border-destructive/25 bg-destructive/5 px-3 py-1.5 text-xs text-destructive'>
            <span className='min-w-0 flex-1'>{locationError || browser.state.error}</span>
            {browser.state.error && selectedTabId && (
              <>
                <Button size='xs' variant='outline' onClick={() => browser.send({ type: 'reload', tabId: selectedTabId })}>Retry</Button>
                <Button
                  size='xs'
                  variant='ghost'
                  onClick={() => {
                    browser.send({ type: 'tab.new' });
                    browser.send({ type: 'tab.close', tabId: selectedTabId });
                  }}
                >
                  New tab
                </Button>
              </>
            )}
          </div>
        )}
        {browser.state.notice && (
          <div role='status' className='shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground'>{browser.state.notice}</div>
        )}

        <div ref={browser.surfaceRef} data-slot='browser-surface-slot' data-browser-supported={browser.state.supported} className='relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-white'>
          {!browser.state.supported
            ? (
              <Empty className='border-0'>
                <EmptyHeader>
                  <EmptyMedia variant='icon'><HugeiconsIcon icon={BrowserIcon} strokeWidth={2} /></EmptyMedia>
                  <EmptyTitle>Browser unavailable</EmptyTitle>
                  <EmptyDescription>The embedded Browser requires an Apple native Alpha host.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
            : !activeUrl && (
              <Empty className='border-0'>
                <EmptyHeader>
                  <EmptyMedia variant='icon'><HugeiconsIcon icon={BrowserIcon} strokeWidth={2} /></EmptyMedia>
                  <EmptyTitle>Start browsing</EmptyTitle>
                  <EmptyDescription>
                    Search Google or enter a web address above. Browsing data is cleared when Alpha quits.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
        </div>
      </Tabs>

      <AlertDialog open={Boolean(externalRequest)} onOpenChange={(open) => !open && closeExternalRequest()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Open outside Alpha?</AlertDialogTitle>
            <AlertDialogDescription>This address uses a link type handled by another app or your system browser.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              if (externalRequest) browser.send({ type: 'open.external', url: externalRequest.url });
              closeExternalRequest();
            }}>Open</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset Browser?</AlertDialogTitle>
            <AlertDialogDescription>This closes every tab and clears the ephemeral Browser Session, including cookies, site data, and history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={() => { browser.send({ type: 'reset' }); setResetOpen(false); }}>Reset Browser</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <span className='sr-only' aria-live='polite'>{browser.state.loading ? `Loading ${activeUrl}` : activeLabel}</span>
    </section>
  );
}
