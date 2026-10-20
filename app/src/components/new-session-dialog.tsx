import { useEffect, useState, type FormEvent } from 'react';
import type { AppController } from '@/app/app-controller';
import { knownDirectories } from '@/app/session-list';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/** Where a new session starts, as far as the person has chosen already. */
export type NewSessionTarget = { hostId?: string; cwd?: string };

const OTHER = '\u0000other';

// Native selects give iOS its own picker.
function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-7 w-full min-w-0 rounded-md border border-input bg-input-background px-2 text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 md:text-xs/relaxed',
        className,
      )}
      {...props}
    />
  );
}

/** Starts a session: which Host, which directory (known or typed), which agent. */
export function NewSessionDialog({ controller, target, onClose }: {
  controller: AppController;
  target?: NewSessionTarget;
  onClose(): void;
}) {
  const { model, actions } = controller;
  const connected = model.hosts.filter(({ status }) => status === 'connected');
  const [hostId, setHostId] = useState('');
  const [directory, setDirectory] = useState('');
  const [typed, setTyped] = useState('');
  const [agentId, setAgentId] = useState('');
  const [error, setError] = useState<string>();
  const directories = hostId ? knownDirectories(model.sessions, hostId) : [];
  const agents = model.agents[hostId] ?? [];

  useEffect(() => {
    if (!target) return;
    const host = target.hostId ?? connected[0]?.id ?? '';
    setHostId(host);
    setDirectory(target.cwd ?? knownDirectories(model.sessions, host)[0] ?? OTHER);
    setTyped('');
    setAgentId(model.agents[host]?.[0]?.id ?? '');
    setError(undefined);
    // Choices reset only when the dialog opens for a new target, not as the list changes.
  }, [target]);

  const cwd = directory === OTHER ? typed.trim() : directory;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    try {
      await actions.createSession({ hostId, cwd, agentId });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className='w-[min(28rem,calc(100%-2rem))] max-w-none sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>An agent in a directory on one of your Hosts.</DialogDescription>
        </DialogHeader>
        <form aria-label='New session' className='grid gap-3' onSubmit={create}>
          {model.hosts.length > 1 && (
            <div className='grid gap-1.5'>
              <Label htmlFor='new-session-host'>Host</Label>
              <NativeSelect id='new-session-host' value={hostId} onChange={(event) => {
                const host = event.target.value;
                setHostId(host);
                setDirectory(knownDirectories(model.sessions, host)[0] ?? OTHER);
                setAgentId(model.agents[host]?.[0]?.id ?? '');
              }}>
                {connected.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
              </NativeSelect>
            </div>
          )}
          <div className='grid gap-1.5'>
            <Label htmlFor='new-session-directory'>Directory</Label>
            <NativeSelect id='new-session-directory' value={directory} onChange={(event) => setDirectory(event.target.value)}>
              {directories.map((path) => <option key={path} value={path}>{path}</option>)}
              <option value={OTHER}>Another directory…</option>
            </NativeSelect>
            {directory === OTHER && (
              <Input aria-label='Directory path' required autoCapitalize='off' autoCorrect='off' placeholder='/Users/you/project'
                value={typed} onChange={(event) => setTyped(event.target.value)} />
            )}
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='new-session-agent'>Agent</Label>
            <NativeSelect id='new-session-agent' value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </NativeSelect>
          </div>
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type='submit' disabled={!hostId || !cwd || !agentId}>Start</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
