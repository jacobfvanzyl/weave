// Add Project (WVE-220): a directory on one of the person's Hosts, registered with the Dispatcher
// as a Project, or as another Host's location of one it has. What `weave projects add` does.
import { useEffect, useState, type FormEvent } from 'react';
import { Folder01Icon } from '@hugeicons/core-free-icons';
import type { AppController, ProjectLocation, ProjectSummary } from '@/app/app-controller';
import { knownDirectories } from '@/app/thread-list';
import { DirectoryPicker } from '@/components/directory-picker';
import { NativeSelect, PickerField, parentOf } from '@/components/fields';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { directoryName } from '@/lib/display-path';
import { cn } from '@/lib/utils';
import { projectAt, projectLocation, projectsOfRepository } from '@/session/sessions';

/** What Add Project opens for: a Host to start on, or the Project that gets a location on another Host. */
export type AddProjectTarget = { hostId?: string; to?: ProjectSummary };

/** A Project of its own, among the ones a clone may join. */
const OWN = '';

/** How long typing a directory waits before asking where it lies in git. */
const LOOKUP_DELAY_MS = 300;

export function AddProjectDialog({ controller, target, onClose, onAdded }: {
  controller: AppController;
  target?: AddProjectTarget;
  onClose(): void;
  /** The Project it added, added to, or found the directory to be in already. */
  onAdded?(project: ProjectSummary): void;
}) {
  const { model, actions } = controller;
  const to = target?.to;
  const projects = model.projects ?? [];
  // A Project has one location on a Host, so another goes on a Host it isn't on yet.
  const hosts = model.hosts.filter(({ id, status }) => status === 'connected' && !to?.locations.some(({ hostId }) => hostId === id));
  const [hostId, setHostId] = useState('');
  const [directory, setDirectory] = useState('');
  const [name, setName] = useState('');
  // Until the person types one, the name follows the directory.
  const [named, setNamed] = useState(false);
  const [view, setView] = useState<'form' | 'directory'>('form');
  // Where the directory lies, once its Host has said.
  const [located, setLocated] = useState<ProjectLocation>();
  const [join, setJoin] = useState(OWN);
  const [error, setError] = useState<string>();
  const [adding, setAdding] = useState(false);
  const host = hosts.find(({ id }) => id === hostId);
  const hostName = host?.name ?? 'the Host';
  const cwd = directory.trim();

  useEffect(() => {
    if (!target) return;
    setHostId(hosts.find(({ id }) => id === target.hostId)?.id ?? hosts[0]?.id ?? '');
    setDirectory('');
    setName('');
    setNamed(false);
    setView('form');
    setError(undefined);
    setAdding(false);
    // The choices start again each time it opens, not as the list changes.
  }, [target]);

  useEffect(() => {
    setLocated(undefined);
    if (target === undefined || !host || !cwd.startsWith('/')) return;
    if (!host.canWorktree) {
      setLocated(projectLocation(hostId, cwd));
      return;
    }
    let current = true;
    const lookup = setTimeout(() => {
      actions.listWorktrees({ hostId, path: cwd }).then(
        (found) => { if (current) setLocated(projectLocation(hostId, cwd, found)); },
        (cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); },
      );
    }, host.canBrowse ? 0 : LOOKUP_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(lookup);
    };
  }, [target, hostId, cwd, host?.canWorktree]);

  const existing = located && projectAt(projects, located);
  const clones = !to && located && !existing ? projectsOfRepository(projects, located) : [];
  const cloneOf = clones.map(({ id }) => id).join('\n');
  useEffect(() => setJoin(clones[0]?.id ?? OWN), [cloneOf]);
  useEffect(() => {
    if (!named) setName(located ? directoryName(located.path) : '');
  }, [located?.path, named]);
  const joined = to ?? clones.find(({ id }) => id === join);
  const hostsOf = (project: ProjectSummary) =>
    project.locations.map(({ hostId: on }) => model.hosts.find(({ id }) => id === on)?.name ?? on).join(' and ');

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!located) return;
    setError(undefined);
    if (existing) {
      onAdded?.(existing);
      onClose();
      return;
    }
    setAdding(true);
    try {
      const project = joined
        ? await actions.updateProject?.(joined.id, { add: located })
        : await actions.addProject?.({ name: name.trim(), location: located });
      if (project) onAdded?.(project);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAdding(false);
    }
  };

  const title = to ? `Add a location to ${to.name}` : 'Add Project';
  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className='w-[min(28rem,calc(100%-2rem))] max-w-none sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{view === 'directory' ? 'Choose a directory' : title}</DialogTitle>
          <DialogDescription className='sr-only'>A directory on one of your Hosts, kept as a Project.</DialogDescription>
        </DialogHeader>
        {view === 'directory' && (
          <DirectoryPicker
            list={(input) => actions.listDirectory({ hostId, ...input })}
            start={cwd || undefined}
            recent={knownDirectories(model.threads, hostId)}
            onChoose={(path) => {
              setDirectory(path);
              setView('form');
            }}
            onCancel={() => setView('form')}
          />
        )}
        <form aria-label={title} className={cn('grid gap-3', view !== 'form' && 'hidden')} onSubmit={add}>
          {hosts.length === 0 && (
            <Alert><AlertDescription>{to ? `${to.name} is on every Host that's connected.` : 'No Host is connected.'}</AlertDescription></Alert>
          )}
          {hosts.length > 1 && (
            <div className='grid gap-1.5'>
              <Label htmlFor='add-project-host'>Host</Label>
              <NativeSelect id='add-project-host' value={hostId} onChange={(event) => {
                setHostId(event.target.value);
                setDirectory('');
              }}>
                {hosts.map(({ id, name: listed }) => <option key={id} value={id}>{listed}</option>)}
              </NativeSelect>
            </div>
          )}
          <div className='grid gap-1.5'>
            <Label htmlFor='add-project-directory'>Directory</Label>
            {host?.canBrowse
              ? (
                  <PickerField id='add-project-directory' icon={Folder01Icon} title={cwd || undefined} onOpen={() => setView('directory')}>
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
                  <Input id='add-project-directory' required autoCapitalize='off' autoCorrect='off' placeholder='/Users/you/project'
                    value={directory} onChange={(event) => setDirectory(event.target.value)} />
                )}
            {located?.kind === 'git' && located.path !== cwd && (
              <p className='text-[0.6875rem] text-muted-foreground'>In the repository at {located.path}, which is the Project.</p>
            )}
          </div>
          {existing && (
            <p role='status' className='text-xs text-muted-foreground'>{existing.name} has this {located?.kind === 'git' ? 'repository' : 'directory'} on {hostName} already.</p>
          )}
          {clones.length > 0 && (
            <div className='grid gap-1.5'>
              <Label htmlFor='add-project-join'>Project</Label>
              <NativeSelect id='add-project-join' value={join} onChange={(event) => setJoin(event.target.value)}>
                {clones.map((project) => <option key={project.id} value={project.id}>Add this clone to {project.name}</option>)}
                <option value={OWN}>A Project of its own</option>
              </NativeSelect>
              {joined && <p className='text-[0.6875rem] text-muted-foreground'>{joined.name} has this repository on {hostsOf(joined)}.</p>}
            </div>
          )}
          {!joined && !existing && (
            <div className='grid gap-1.5'>
              <Label htmlFor='add-project-name'>Name</Label>
              <Input id='add-project-name' required autoComplete='off' autoCapitalize='off' autoCorrect='off' maxLength={80} value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNamed(true);
                }} />
            </div>
          )}
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type='submit' disabled={!located || adding || (existing ? to !== undefined : !joined && !name.trim())}>
              {existing ? `Use ${existing.name}` : joined ? `Add to ${joined.name}` : 'Add Project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
