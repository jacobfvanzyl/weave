import { useEffect, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { LayoutTwoColumnIcon, LayoutTwoRowIcon } from '@hugeicons/core-free-icons';
import { Button } from './ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu';

type PaneType = 'terminal' | 'agent' | 'browser';
export function PaneSplitMenu({ sourceType, disabled, onSplit }: { sourceType: PaneType; disabled?: boolean; onSplit(axis: 'horizontal' | 'vertical', type: PaneType): void }) {
  const [open, setOpen] = useState(false);
  const [axis, setAxis] = useState<'horizontal' | 'vertical'>();
  const preferred = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => preferred.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, axis]);
  return <DropdownMenu open={open} onOpenChange={value => { setOpen(value); if (!value) setAxis(undefined); }} onOpenChangeComplete={value => { if (value) preferred.current?.focus(); }}>
    <DropdownMenuTrigger render={<Button size='rail' variant='ghost' aria-label='Split pane' title='Split pane' disabled={disabled} />}><HugeiconsIcon icon={LayoutTwoRowIcon} strokeWidth={2} /></DropdownMenuTrigger>
    <DropdownMenuContent align='end' finalFocus={false} aria-label={axis ? 'Pane type' : 'Split direction'}>
      <DropdownMenuGroup>
        {axis && <DropdownMenuLabel>Pane type</DropdownMenuLabel>}
        {!axis ? <>
          <DropdownMenuItem ref={preferred} closeOnClick={false} onClick={() => setAxis('vertical')}><HugeiconsIcon icon={LayoutTwoRowIcon} />Down</DropdownMenuItem>
          <DropdownMenuItem closeOnClick={false} onClick={() => setAxis('horizontal')}><HugeiconsIcon icon={LayoutTwoColumnIcon} />Right</DropdownMenuItem>
        </> : (['terminal', 'agent', 'browser'] as const).map(type => <DropdownMenuItem key={type} ref={type === sourceType ? preferred : undefined} onClick={() => onSplit(axis, type)}>{type === 'terminal' ? 'Terminal' : type === 'agent' ? 'Agent' : 'Browser'}</DropdownMenuItem>)}
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
