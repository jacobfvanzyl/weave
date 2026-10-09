import { HugeiconsIcon } from '@hugeicons/react';
import { UserCircleIcon } from '@hugeicons/core-free-icons';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu';

export function ClientBrowserProfileButton({ available }: { available: boolean }) {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button type='button' size='icon-sm' variant='ghost' aria-label='Profiles' title='Profile on this device' disabled={!available} />}><HugeiconsIcon icon={UserCircleIcon} /></DropdownMenuTrigger>
    <DropdownMenuContent align='end' finalFocus={false}>
      <DropdownMenuGroup>
        <DropdownMenuLabel>On this device</DropdownMenuLabel>
        <DropdownMenuItem disabled>Default profile ✓</DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
