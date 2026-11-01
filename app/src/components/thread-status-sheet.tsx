import type { McpServerStatus } from '@/host/protocol';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const STATES: Record<McpServerStatus['state'], string> = {
  connected: 'Connected',
  declared: 'Waiting for the agent to connect',
  passed: 'Passed to the agent',
  skipped: 'Skipped',
  unavailable: 'Unavailable',
  other: 'Unknown',
};

const SOURCES: Partial<Record<McpServerStatus['source'], string>> = {
  host: "weave's own",
  config: 'From the config',
};

const TRANSPORTS: Record<NonNullable<McpServerStatus['transport']>, string> = {
  acp: 'over ACP',
  stdio: 'stdio',
  http: 'http',
  sse: 'sse',
  other: 'another transport',
};

/** What a server's dot says: working, unknown to the Host, or left out. */
function tone(state: McpServerStatus['state']): 'good' | 'quiet' | 'warning' {
  if (state === 'connected') return 'good';
  if (state === 'skipped' || state === 'unavailable') return 'warning';
  return 'quiet';
}

/**
 * The thread's status, in a sheet from its header (WVE-160): its MCP servers as the Host reports
 * them. Servers from the agent's own configuration only the agent knows of; its `/mcp` lists them
 * when it offers one, and the app never runs it.
 */
export function ThreadStatusSheet({ open, onOpenChange, servers, agentListsServers, side }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** None from a Host that doesn't report them. */
  servers?: McpServerStatus[];
  /** The agent offers `/mcp`. */
  agentListsServers: boolean;
  side: 'right' | 'bottom';
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side={side} data-slot='thread-status' className='gap-0 pb-[env(safe-area-inset-bottom)]'>
        <SheetHeader>
          <SheetTitle>Thread status</SheetTitle>
          <SheetDescription>MCP servers</SheetDescription>
        </SheetHeader>
        <div className='flex flex-col gap-3 overflow-y-auto px-4 pb-4'>
          {servers === undefined ? (
            <p className='text-muted-foreground'>This weave Host doesn't report MCP servers; update it to see them.</p>
          ) : servers.length === 0 ? (
            <p className='text-muted-foreground'>weave gave the agent none.</p>
          ) : (
            <ul aria-label='MCP servers' className='flex flex-col gap-2'>
              {servers.map((server) => <ServerRow key={`${server.source}/${server.name}`} server={server} />)}
            </ul>
          )}
          <p className='text-muted-foreground'>
            {agentListsServers
              ? 'The agent may have more of its own, which only it knows of: its /mcp lists them.'
              : 'The agent may have more of its own, which only it knows of.'}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ServerRow({ server }: { server: McpServerStatus }) {
  const detail = [STATES[server.state], SOURCES[server.source], server.transport ? TRANSPORTS[server.transport] : undefined]
    .filter(Boolean)
    .join(' · ');
  const dot = tone(server.state);
  return (
    <li className='flex min-w-0 items-start gap-2'>
      <span aria-hidden='true' data-tone={dot} className={cn(
        'mt-1.5 size-2 shrink-0 rounded-full',
        dot === 'good' && 'bg-emerald-500',
        dot === 'quiet' && 'bg-muted-foreground/40',
        dot === 'warning' && 'bg-amber-500',
      )} />
      <div className='min-w-0'>
        <p className='font-medium'>{server.name}</p>
        <p className='text-muted-foreground'>{detail}</p>
        {server.reason && <p className='break-words text-muted-foreground'>{server.reason}</p>}
      </div>
    </li>
  );
}
