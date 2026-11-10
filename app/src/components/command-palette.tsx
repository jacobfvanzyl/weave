import { useEffect, useState } from 'react';
import { type CommandId, COMMAND_GROUPS, keysLabel, runCommand, useCommandsOn } from '@/app/commands';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * The commands that do something now (WVE-203), to pick by name: the same ones keys and the Mac's
 * menu bar run. Typing narrows them, the arrows move, and Return runs the one picked.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(0);
  // The palette's own command isn't one to pick from it.
  const commands = useCommandsOn().filter(({ id }) => id !== 'palette.open');
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matching = COMMAND_GROUPS
    .flatMap((group) => commands.filter((command) => command.group === group))
    .filter(({ title, group }) => words.every((word) => `${group} ${title}`.toLocaleLowerCase().includes(word)));
  useEffect(() => {
    if (open) {
      setQuery('');
      setPicked(0);
    }
  }, [open]);
  useEffect(() => setPicked(0), [query]);
  const run = (id: string) => {
    onOpenChange(false);
    // Once the palette has closed, so what the command focuses keeps the keyboard.
    setTimeout(() => runCommand(id as CommandId), 0);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='top-[20%] w-[min(30rem,calc(100%-2rem))] max-w-none translate-y-0 gap-2 p-2 sm:max-w-lg' showCloseButton={false}>
        <DialogHeader className='sr-only'>
          <DialogTitle>Commands</DialogTitle>
          <DialogDescription>Type to find a command, then press Return to run it.</DialogDescription>
        </DialogHeader>
        <Input aria-label='Find a command' placeholder='Find a command' autoFocus value={query}
          role='combobox' aria-expanded='true' aria-controls='command-palette-list'
          aria-activedescendant={matching[picked] ? `command-${matching[picked].id}` : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setPicked((at) => Math.min(matching.length - 1, at + 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setPicked((at) => Math.max(0, at - 1));
            } else if (event.key === 'Enter' && matching[picked]) {
              event.preventDefault();
              run(matching[picked].id);
            }
          }} />
        <ul id='command-palette-list' role='listbox' aria-label='Commands' className='grid max-h-[50dvh] gap-0.5 overflow-y-auto'>
          {matching.map((command, index) => (
            <li key={command.id} id={`command-${command.id}`} role='option' aria-selected={index === picked}
              className={cn('flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs', index === picked && 'bg-muted')}
              onPointerMove={() => setPicked(index)} onClick={() => run(command.id)}>
              <span className='w-14 shrink-0 text-[0.6875rem] text-muted-foreground'>{command.group}</span>
              <span className='min-w-0 flex-1 truncate'>{command.title}</span>
              {command.keys && <kbd className='shrink-0 font-sans text-[0.6875rem] text-muted-foreground'>{keysLabel(command.keys)}</kbd>}
            </li>
          ))}
          {matching.length === 0 && <li className='px-2 py-3 text-center text-xs text-muted-foreground'>No command matches.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
