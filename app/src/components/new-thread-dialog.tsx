import { useEffect, useState, type FormEvent } from 'react';
import { Folder01Icon, GitBranchIcon } from '@hugeicons/core-free-icons';
import type { AppController, CreatedThread } from '@/app/app-controller';
import { lastUsedFirst, loadLastChoices, saveLastChoices } from '@/app/last-choices';
import { knownDirectories } from '@/app/thread-list';
import { DirectoryPicker } from '@/components/directory-picker';
import { NativeSelect, PickerField, parentOf } from '@/components/fields';
import { useWorktreeChoice } from '@/components/use-worktree-choice';
import { WorktreePicker } from '@/components/worktree-picker';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { directoryName } from '@/lib/display-path';
import { cn } from '@/lib/utils';

/** Where a new thread starts, as far as the person has chosen already. */
export type NewThreadTarget = { hostId?: string; cwd?: string };

/**
 * Starts a thread: which Host, which directory (one its threads use, or browsed for), which
 * agent. In a git repository, on a Host that manages worktrees, it can start in another of its
 * worktrees, or in one it creates on a branch of its own.
 */
export function NewThreadDialog({ controller, target, onClose, onCreated }: {
  controller: AppController;
  target?: NewThreadTarget;
  onClose(): void;
  /** The thread it started, and the Session it's in, before it closes. */
  onCreated?(created: CreatedThread): void;
}) {
  const { model, actions } = controller;
  const connected = model.hosts.filter(({ status }) => status === 'connected');
  const [hostId, setHostId] = useState('');
  const [directory, setDirectory] = useState('');
  const [agentId, setAgentId] = useState('');
  const [error, setError] = useState<string>();
  // A picker in place of the form.
  const [view, setView] = useState<'form' | 'directory' | 'worktree'>('form');
  const [starting, setStarting] = useState(false);
  const directories = hostId ? knownDirectories(model.threads, hostId) : [];
  const agents = model.agents[hostId] ?? [];
  const hostName = connected.find(({ id }) => id === hostId)?.name ?? 'the Host';

  useEffect(() => {
    if (!target) return;
    const host = target.hostId ?? connected[0]?.id ?? '';
    setHostId(host);
    setDirectory(target.cwd ?? knownDirectories(model.threads, host)[0] ?? '');
    // The agent this device started a thread with last, where the Host has it.
    setAgentId(lastUsedFirst(model.agents[host] ?? [], loadLastChoices().agentId)[0]?.id ?? '');
    setError(undefined);
    setView('form');
    setStarting(false);
    // Choices reset only when the dialog opens for a new target, not as the list changes.
  }, [target]);

  const cwd = directory.trim();
  const canBrowse = connected.some(({ id, canBrowse }) => id === hostId && canBrowse);
  const canWorktree = connected.some(({ id, canWorktree }) => id === hostId && canWorktree);

  const worktree = useWorktreeChoice({ actions, on: target !== undefined, hostId, cwd, canWorktree, immediate: canBrowse });
  const { repository, chosen } = worktree;

  const chooseDirectory = (path: string) => {
    setDirectory(path);
    setView('form');
  };

  const chooseWorktree = (path: string) => {
    worktree.choose(path);
    setView('form');
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setStarting(true);
    try {
      const created = await actions.createThread({ hostId, cwd: worktree.directory, agentId });
      saveLastChoices({ agentId });
      if (created) onCreated?.(created);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className='w-[min(28rem,calc(100%-2rem))] max-w-none sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{view === 'directory' ? 'Choose a directory' : view === 'worktree' ? 'Choose a worktree' : 'New thread'}</DialogTitle>
          <DialogDescription className='sr-only'>An agent in a directory on {hostName}.</DialogDescription>
        </DialogHeader>
        {view === 'directory' && (
          <DirectoryPicker
            list={(input) => actions.listDirectory({ hostId, ...input })}
            start={cwd || undefined}
            recent={directories}
            onChoose={chooseDirectory}
            onCancel={() => setView('form')}
          />
        )}
        {view === 'worktree' && repository && (
          <WorktreePicker
            repository={repository}
            selected={chosen?.path}
            create={worktree.create}
            onChoose={chooseWorktree}
            onCancel={() => setView('form')}
          />
        )}
        <form aria-label='New thread' className={cn('grid gap-3', view !== 'form' && 'hidden')} onSubmit={create}>
          {model.hosts.length > 1 && (
            <div className='grid gap-1.5'>
              <Label htmlFor='new-thread-host'>Host</Label>
              <NativeSelect id='new-thread-host' value={hostId} onChange={(event) => {
                const host = event.target.value;
                setHostId(host);
                setDirectory(knownDirectories(model.threads, host)[0] ?? '');
                setAgentId(model.agents[host]?.[0]?.id ?? '');
              }}>
                {connected.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
              </NativeSelect>
            </div>
          )}
          <div className='grid gap-1.5'>
            <Label htmlFor='new-thread-directory'>Directory</Label>
            {canBrowse
              ? (
                  <PickerField id='new-thread-directory' icon={Folder01Icon} title={cwd || undefined} onOpen={() => setView('directory')}>
                    {cwd
                      ? (
                          <>
                            <span className='shrink-0 font-medium'>{directoryName(cwd)}</span>
                            <span className='min-w-0 truncate text-muted-foreground'>{parentOf(cwd)}</span>
                          </>
                        )
                      : <span className='text-muted-foreground'>Choose a directory…</span>}
                  </PickerField>
                )
              : (
                  // A Host that can't list its directories takes a path as typed.
                  <Input id='new-thread-directory' required autoCapitalize='off' autoCorrect='off' placeholder='/Users/you/project'
                    value={directory} onChange={(event) => setDirectory(event.target.value)} />
                )}
          </div>
          {repository && (
            <div className='grid gap-1.5'>
              <Label htmlFor='new-thread-worktree'>Worktree</Label>
              <PickerField id='new-thread-worktree' icon={GitBranchIcon} title={chosen?.path} onOpen={() => setView('worktree')}>
                {chosen
                  ? (
                      <>
                        <span className='min-w-0 shrink truncate font-medium'>{chosen.branch ?? 'detached HEAD'}</span>
                        <span className='min-w-0 truncate text-muted-foreground'>{directoryName(chosen.path)}</span>
                      </>
                    )
                  : <span className='font-medium'>This directory</span>}
              </PickerField>
            </div>
          )}
          <div className='grid gap-1.5'>
            <Label htmlFor='new-thread-agent'>Agent</Label>
            <NativeSelect id='new-thread-agent' value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
            </NativeSelect>
          </div>
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type='submit' disabled={!hostId || !cwd || !agentId || starting}>Start</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
