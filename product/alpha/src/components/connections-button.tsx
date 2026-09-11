import { useId } from 'react';
import { ServerIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { AlphaController } from '@/app/alpha-controller';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

export function ConnectionsButton({ controller }: { controller: AlphaController }) {
  const statusId = useId();
  const unavailable = controller.model.connections.filter(({ status }) => status !== 'connected').length;
  const status = `${unavailable} ${unavailable === 1 ? 'Host' : 'Hosts'} unavailable`;
  return <>
    <Button size='icon-xs' variant='ghost' aria-label='Connections' aria-describedby={unavailable ? statusId : undefined}
      title={unavailable ? `Connections — ${status}` : 'Connections'} className='relative' onClick={controller.actions.openConnections}>
      <HugeiconsIcon icon={ServerIcon} strokeWidth={2} />
      {unavailable > 0 && <Badge aria-hidden='true' className='absolute right-1 top-1 size-1.5 p-0' />}
    </Button>
    <span id={statusId} role='status' className='sr-only'>{unavailable ? status : ''}</span>
  </>;
}
