import { type FormEvent, useEffect, useState } from 'react';
import {
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  Delete02Icon,
  ReloadIcon,
  StopIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useAlphaBrowserSession } from '@/app/use-alpha-browser-session';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function BrowserPane({
  className,
  maximized = false,
  onClose,
  onToggleMaximized,
  controlTarget,
}: {
  className?: string;
  maximized?: boolean;
  onClose?(): void;
  onToggleMaximized?(): void;
  controlTarget?: { threadId: string; title: string; controller: string };
}) {
  const browser = useAlphaBrowserSession(controlTarget);
  const [location, setLocation] = useState(browser.state.url);

  useEffect(() => {
    if (browser.state.url) setLocation(browser.state.url);
  }, [browser.state.url]);

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const value = location.trim();
    if (value) browser.send({ type: 'navigate', url: value });
  };

  return (
    <section
      aria-label='Browser Pane'
      data-slot='browser-pane'
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-background', className)}
    >
      <header
        data-slot='browser-top-rail'
        className='flex h-11 shrink-0 items-stretch border-b border-border bg-title-bar'
      >
        <div className='flex h-full shrink-0 items-stretch'>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            aria-label='Back'
            className='h-full w-10 rounded-none'
            disabled={!browser.state.supported || !browser.state.canGoBack}
            onClick={() => browser.send({ type: 'back' })}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          </Button>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            aria-label='Forward'
            className='h-full w-10 rounded-none'
            disabled={!browser.state.supported || !browser.state.canGoForward}
            onClick={() => browser.send({ type: 'forward' })}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
          </Button>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            aria-label={browser.state.loading ? 'Stop Loading' : 'Reload'}
            className='h-full w-10 rounded-none'
            disabled={!browser.state.supported}
            onClick={() => browser.send({
              type: browser.state.loading ? 'stop' : 'reload',
            })}
          >
            <HugeiconsIcon
              icon={browser.state.loading ? StopIcon : ReloadIcon}
              strokeWidth={2}
            />
          </Button>
        </div>
        <form className='flex min-w-0 flex-1 items-center px-1.5' onSubmit={navigate}>
          <input
            aria-label='Browser address'
            value={location}
            spellCheck={false}
            autoCapitalize='none'
            autoCorrect='off'
            className='h-7 min-w-0 flex-1 rounded-md border border-border bg-input px-2 text-xs text-foreground outline-none focus:border-ring'
            onChange={(event) => setLocation(event.currentTarget.value)}
          />
        </form>
        <div className='flex h-full shrink-0 items-stretch border-l border-border'>
          {browser.state.agentAccess === 'off'
            ? (
              <>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  aria-label='Enable Agent Browser Observe'
                  title='Allow the active Thread to inspect this visible Browser without navigating or acting'
                  className='h-full rounded-none px-2 text-[11px]'
                  disabled={!browser.state.supported || !controlTarget}
                  onClick={() => browser.setAgentAccess('observe')}
                >
                  Observe
                </Button>
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  aria-label='Enable Agent Browser Control'
                  title='Allow the active Thread to control this visible Browser'
                  className='h-full rounded-none px-2 text-[11px]'
                  disabled={!browser.state.supported || !controlTarget}
                  onClick={() => browser.setAgentAccess('control')}
                >
                  Control
                </Button>
              </>
            )
            : (
              <Button
                type='button'
                size='sm'
                variant='default'
                aria-label='Take Over Browser'
                aria-pressed='true'
                title='Take over and immediately revoke agent access'
                className='h-full rounded-none px-2 text-[11px]'
                onClick={() => browser.setAgentAccess('off')}
              >
                Take over
              </Button>
            )}
          <Button
            type='button'
            size='icon'
            variant='ghost'
            aria-label='Reset Browser Session'
            title='Reset Browser Session (clears browser history)'
            className='h-full w-11 shrink-0 rounded-none border-0 text-destructive hover:text-destructive'
            disabled={!browser.state.supported}
            onClick={() => browser.send({ type: 'reset' })}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          </Button>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            aria-label={maximized ? 'Restore Browser' : 'Maximize Browser'}
            aria-pressed={maximized}
            title={maximized ? 'Restore Browser' : 'Maximize Browser'}
            className='h-full w-11 shrink-0 rounded-none border-0'
            onClick={onToggleMaximized}
          >
            <HugeiconsIcon
              data-symbol={maximized ? 'collapse-browser' : 'expand-browser'}
              icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon}
              strokeWidth={2}
            />
          </Button>
          <Button
            type='button'
            size='icon'
            variant='ghost'
            aria-label='Close Browser'
            className='h-full w-11 shrink-0 rounded-none border-0'
            onClick={onClose}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </Button>
        </div>
      </header>

      {browser.state.agentAccess !== 'off' && browser.state.controlTarget && (
        <div
          role='status'
          data-slot='browser-agent-access'
          className='shrink-0 border-b border-border bg-primary/10 px-3 py-1 text-xs text-foreground'
        >
          Agent {browser.state.agentAccess} · {browser.state.controlTarget.controller} ·{' '}
          {browser.state.controlTarget.title} ({browser.state.controlTarget.threadId})
        </div>
      )}

      {browser.state.error && (
        <div role='alert' className='shrink-0 border-b border-border px-3 py-1 text-xs text-destructive'>
          {browser.state.error}
        </div>
      )}
      {browser.state.notice && (
        <div role='status' className='shrink-0 border-b border-border px-3 py-1 text-xs text-muted-foreground'>
          {browser.state.notice}
        </div>
      )}
      {browser.state.policy && (
        <div
          data-slot='browser-policy'
          title='Popups stay in this pane. Uploads use the system picker. Downloads and camera/microphone are unavailable. Other permission requests use WebKit defaults.'
          className='shrink-0 overflow-hidden text-ellipsis whitespace-nowrap border-b border-border px-3 py-1 text-xs text-muted-foreground'
        >
          Popup: here · Upload: system picker · Download: off · Camera/mic: off · Other permissions: WebKit
        </div>
      )}
      <div
        ref={browser.surfaceRef}
        data-slot='browser-surface-slot'
        data-browser-supported={browser.state.supported}
        className='relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden bg-white'
      >
        {!browser.state.supported && (
          <div className='max-w-sm px-6 text-center text-sm text-muted-foreground'>
            The embedded Browser requires an Apple native Alpha host.
          </div>
        )}
      </div>
      <span className='sr-only' aria-live='polite'>
        {browser.state.loading
          ? `Loading ${browser.state.url}`
          : browser.state.title || browser.state.url}
      </span>
    </section>
  );
}
