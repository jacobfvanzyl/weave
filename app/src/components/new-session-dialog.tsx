import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Folder01Icon, GitBranchIcon, UnfoldMoreIcon } from '@hugeicons/core-free-icons';
import type { AppController, RepositoryListing, WorktreeSummary } from '@/app/app-controller';
import { knownDirectories } from '@/app/session-list';
import { DirectoryPicker } from '@/components/directory-picker';
import { WorktreePicker } from '@/components/worktree-picker';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { directoryName } from '@/lib/display-path';
import { cn } from '@/lib/utils';

/** Where a new session starts, as far as the person has chosen already. */
export type NewSessionTarget = { hostId?: string; cwd?: string };

/** The chosen directory itself, in the worktree it's in. */
const HERE = '\u0000here';

/** How long typing a directory waits before asking whether it's in a repository. */
const LOOKUP_DELAY_MS = 300;

/** The worktree `cwd` is in: the deepest one whose directory holds it. */
const containing = (repository: RepositoryListing, cwd: string) =>
  repository.worktrees
    .filter(({ path }) => cwd === path || cwd.startsWith(`${path}/`))
    .sort((left, right) => right.path.length - left.path.length)[0];

/** The directory a path is in, for showing beside its name. */
const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 1));

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

/** A field that shows a choice and opens its picker in place of the form. */
function PickerField({ id, icon, title, onOpen, children }: {
  id: string;
  icon: typeof Folder01Icon;
  title?: string;
  onOpen(): void;
  children: ReactNode;
}) {
  return (
    <button
      id={id}
      type='button'
      title={title}
      className='flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md border border-input bg-input-background px-2 text-left text-base outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 md:text-xs/relaxed'
      onClick={onOpen}
    >
      <HugeiconsIcon icon={icon} strokeWidth={1.75} className='size-3.5 shrink-0 text-muted-foreground' aria-hidden />
      <span className='flex min-w-0 flex-1 items-baseline gap-1.5'>{children}</span>
      <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className='size-3.5 shrink-0 text-muted-foreground' aria-hidden />
    </button>
  );
}

/**
 * Starts a session: which Host, which directory (one its sessions use, or browsed for), which
 * agent. In a git repository, on a Host that manages worktrees, it can start in another of its
 * worktrees, or in one it creates on a branch of its own.
 */
export function NewSessionDialog({ controller, target, onClose }: {
  controller: AppController;
  target?: NewSessionTarget;
  onClose(): void;
}) {
  const { model, actions } = controller;
  const connected = model.hosts.filter(({ status }) => status === 'connected');
  const [hostId, setHostId] = useState('');
  const [directory, setDirectory] = useState('');
  const [agentId, setAgentId] = useState('');
  const [error, setError] = useState<string>();
  // A picker in place of the form.
  const [view, setView] = useState<'form' | 'directory' | 'worktree'>('form');
  // The repository the directory is in, once the Host has said.
  const [repository, setRepository] = useState<RepositoryListing>();
  const [place, setPlace] = useState(HERE);
  const [starting, setStarting] = useState(false);
  const directories = hostId ? knownDirectories(model.sessions, hostId) : [];
  const agents = model.agents[hostId] ?? [];
  const hostName = connected.find(({ id }) => id === hostId)?.name ?? 'the Host';

  useEffect(() => {
    if (!target) return;
    const host = target.hostId ?? connected[0]?.id ?? '';
    setHostId(host);
    setDirectory(target.cwd ?? knownDirectories(model.sessions, host)[0] ?? '');
    setAgentId(model.agents[host]?.[0]?.id ?? '');
    setError(undefined);
    setView('form');
    setStarting(false);
    // Choices reset only when the dialog opens for a new target, not as the list changes.
  }, [target]);

  const cwd = directory.trim();
  const canBrowse = connected.some(({ id, canBrowse }) => id === hostId && canBrowse);
  const canWorktree = connected.some(({ id, canWorktree }) => id === hostId && canWorktree);

  useEffect(() => {
    setRepository(undefined);
    setPlace(HERE);
    if (target === undefined || !canWorktree || !cwd.startsWith('/')) return;
    let current = true;
    const lookup = setTimeout(() => {
      actions.listWorktrees({ hostId, path: cwd }).then(
        (found) => { if (current) setRepository(found); },
        // Worktrees are on offer only when the Host can list them; the directory still works.
        () => {},
      );
    }, canBrowse ? 0 : LOOKUP_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(lookup);
    };
  }, [target, hostId, cwd, canWorktree]);

  const here = repository && containing(repository, cwd);
  const chosen: WorktreeSummary | undefined = repository && (place === HERE ? here : repository.worktrees.find(({ path }) => path === place));

  const chooseDirectory = (path: string) => {
    setDirectory(path);
    setView('form');
  };

  const chooseWorktree = (path: string) => {
    setPlace(path === here?.path ? HERE : path);
    setView('form');
  };

  const createWorktree = async ({ branch, base }: { branch: string; base?: string }) => {
    const path = await actions.createWorktree({ hostId, repo: cwd, branch, ...(base ? { base } : {}) });
    const made: WorktreeSummary = { path, branch, primary: false, changes: false, sessions: [] };
    setRepository((listed) => listed && { ...listed, worktrees: [...listed.worktrees, made] });
    return path;
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setStarting(true);
    try {
      await actions.createSession({ hostId, cwd: repository && place !== HERE ? place : cwd, agentId });
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
          <DialogTitle>{view === 'directory' ? 'Choose a directory' : view === 'worktree' ? 'Choose a worktree' : 'New session'}</DialogTitle>
          <DialogDescription>
            {view === 'directory'
              ? `Where the session runs, on ${hostName}.`
              : view === 'worktree' && repository
                ? `In ${directoryName(repository.repo)}, on ${hostName}.`
                : 'An agent in a directory on one of your Hosts.'}
          </DialogDescription>
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
            create={createWorktree}
            onChoose={chooseWorktree}
            onCancel={() => setView('form')}
          />
        )}
        <form aria-label='New session' className={cn('grid gap-3', view !== 'form' && 'hidden')} onSubmit={create}>
          {model.hosts.length > 1 && (
            <div className='grid gap-1.5'>
              <Label htmlFor='new-session-host'>Host</Label>
              <NativeSelect id='new-session-host' value={hostId} onChange={(event) => {
                const host = event.target.value;
                setHostId(host);
                setDirectory(knownDirectories(model.sessions, host)[0] ?? '');
                setAgentId(model.agents[host]?.[0]?.id ?? '');
              }}>
                {connected.map((host) => <option key={host.id} value={host.id}>{host.name}</option>)}
              </NativeSelect>
            </div>
          )}
          <div className='grid gap-1.5'>
            <Label htmlFor='new-session-directory'>Directory</Label>
            {canBrowse
              ? (
                  <PickerField id='new-session-directory' icon={Folder01Icon} title={cwd || undefined} onOpen={() => setView('directory')}>
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
                  <Input id='new-session-directory' required autoCapitalize='off' autoCorrect='off' placeholder='/Users/you/project'
                    value={directory} onChange={(event) => setDirectory(event.target.value)} />
                )}
          </div>
          {repository && (
            <div className='grid gap-1.5'>
              <Label htmlFor='new-session-worktree'>Worktree</Label>
              <PickerField id='new-session-worktree' icon={GitBranchIcon} title={chosen?.path} onOpen={() => setView('worktree')}>
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
            <Label htmlFor='new-session-agent'>Agent</Label>
            <NativeSelect id='new-session-agent' value={agentId} onChange={(event) => setAgentId(event.target.value)}>
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
