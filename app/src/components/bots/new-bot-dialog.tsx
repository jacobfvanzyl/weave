// New Bot (WVE-178): its name, what it's for, the Host its home is on and its agent. The
// Dispatcher makes its home there, a git repository whose `AGENTS.md` starts with the job;
// everything else is set on the Bot's page afterwards.
import { useEffect, useState, type FormEvent } from 'react';
import type { AppController, BotSummary } from '@/app/app-controller';
import { NativeSelect } from '@/components/fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function NewBotDialog({ controller, open, onClose, onAdded }: {
  controller: AppController;
  open: boolean;
  onClose(): void;
  /** The Bot it added, to open. */
  onAdded(bot: BotSummary): void;
}) {
  const { model, actions } = controller;
  const connected = model.hosts.filter(({ status }) => status === 'connected');
  const [name, setName] = useState('');
  const [job, setJob] = useState('');
  const [hostId, setHostId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const agents = model.agents[hostId] ?? [];

  useEffect(() => {
    if (!open) return;
    const host = connected[0]?.id ?? '';
    setName('');
    setJob('');
    setHostId(host);
    setAgentId(model.agents[host]?.[0]?.id ?? '');
    setError(undefined);
    setAdding(false);
    // The choices start again each time it opens, not as the list changes.
  }, [open]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!actions.addBot) return;
    setError(undefined);
    setAdding(true);
    try {
      const bot = await actions.addBot({ name: name.trim(), hostId, agentId, job });
      onAdded(bot);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className='w-[min(28rem,calc(100%-2rem))] max-w-none sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>New Bot</DialogTitle>
          <DialogDescription>
            An assistant you come back to by name. It works in a home of its own on one of your Hosts, a git repository that keeps what it learns.
          </DialogDescription>
        </DialogHeader>
        <form aria-label='New Bot' className='grid gap-3' onSubmit={add}>
          <div className='grid gap-1.5'>
            <Label htmlFor='new-bot-name'>Name</Label>
            <Input id='new-bot-name' required autoComplete='off' maxLength={80} placeholder='Scout' value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='new-bot-job'>What is this Bot for?</Label>
            <Textarea id='new-bot-job' rows={4} className='max-h-48' placeholder='Keep an eye on the nightly builds and tell me what broke.'
              value={job} onChange={(event) => setJob(event.target.value)} />
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='new-bot-host'>Host</Label>
            <NativeSelect id='new-bot-host' value={hostId} onChange={(event) => {
              const host = event.target.value;
              setHostId(host);
              setAgentId(model.agents[host]?.[0]?.id ?? '');
            }}>
              {connected.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
            </NativeSelect>
          </div>
          <div className='grid gap-1.5'>
            <Label htmlFor='new-bot-agent'>Agent</Label>
            <NativeSelect id='new-bot-agent' value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </NativeSelect>
          </div>
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type='submit' disabled={!name.trim() || !hostId || !agentId || adding}>{adding ? 'Adding…' : 'Add Bot'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
