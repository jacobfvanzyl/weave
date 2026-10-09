import type { ReactNode, RefObject } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowLeft01Icon, ArrowRight01Icon, RefreshIcon } from '@hugeicons/core-free-icons';
import { Button } from './ui/button';
import { Input } from './ui/input';

export type BrowserNavigation = 'navigate' | 'back' | 'forward' | 'reload';
export const browserAddress = (address: string) => !address.trim() ? 'about:blank' : /^[a-z][a-z0-9+.-]*:\/\//i.test(address.trim()) || address.trim() === 'about:blank' ? address.trim() : `https://${address.trim()}`;
export function browserShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): BrowserNavigation | 'address' | undefined {
  const command = event.metaKey || event.ctrlKey;
  if (event.altKey && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  if (command && event.key.toLowerCase() === 'l') return 'address';
  if (command && event.key.toLowerCase() === 'r' || event.key === 'F5') return 'reload';
  if (command && event.key === '[' || event.altKey && event.key === 'ArrowLeft') return 'back';
  if (command && event.key === ']' || event.altKey && event.key === 'ArrowRight') return 'forward';
}

/** Navigation chrome is shared; each browser owns its page and profile commands. */
export function BrowserToolbar({ address, addressLabel, addressInput, onAddressChange, onAddressFocus, onNavigate, onSubmit, canGoBack, canGoForward, available, profile }: {
  address: string; addressLabel: string; addressInput: RefObject<HTMLInputElement | null>;
  onAddressChange(address: string): void; onAddressFocus(): void;
  onNavigate(action: BrowserNavigation): void; onSubmit(): void;
  canGoBack?: boolean; canGoForward?: boolean; available?: boolean; profile?: ReactNode;
}) {
  return <form data-slot='browser-toolbar' className='flex shrink-0 items-center gap-1 border-b p-1' onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <Button type='button' size='icon-sm' variant='ghost' aria-label='Back' disabled={!available || !canGoBack} onClick={() => onNavigate('back')}><HugeiconsIcon icon={ArrowLeft01Icon} /></Button>
    <Button type='button' size='icon-sm' variant='ghost' aria-label='Forward' disabled={!available || !canGoForward} onClick={() => onNavigate('forward')}><HugeiconsIcon icon={ArrowRight01Icon} /></Button>
    <Button type='button' size='icon-sm' variant='ghost' aria-label='Reload' disabled={!available} onClick={() => onNavigate('reload')}><HugeiconsIcon icon={RefreshIcon} /></Button>
    <Input ref={addressInput} aria-label={addressLabel} placeholder='Enter URL' onFocus={onAddressFocus} value={address} onChange={event => onAddressChange(event.target.value)} autoCapitalize='none' autoCorrect='off' spellCheck={false} />
    {profile}
  </form>;
}
