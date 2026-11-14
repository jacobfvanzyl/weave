// A Project's heading in the list of Sessions, and what its menu does (WVE-220): rename it, give
// it a location on another Host, take one away, or forget it. A long press, or a right-click,
// opens the menu, as on a Session's tile.
import { useEffect, useState, type FormEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Cancel01Icon, Delete02Icon, Edit02Icon, Folder01Icon, FolderAddIcon } from '@hugeicons/core-free-icons';
import type { AppController, ProjectSummary } from '@/app/app-controller';
import { type GroupFold, GroupHeading } from '@/components/group-heading';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SidebarGroupAction } from '@/components/ui/sidebar';

type Asking = { kind: 'rename' } | { kind: 'removeHost'; hostId: string } | { kind: 'remove' };

/** One thing asked of a Project, confirmed or typed, with why the Dispatcher refused when it did. */
function ProjectDialog({ controller, project, asking, onClose }: {
  controller: AppController;
  project: ProjectSummary;
  asking?: Asking;
  onClose(): void;
}) {
  const { model, actions } = controller;
  const [name, setName] = useState(project.name);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    setName(project.name);
    setError(undefined);
    setWorking(false);
  }, [asking]);
  const hostName = (hostId: string) => model.hosts.find(({ id }) => id === hostId)?.name ?? hostId;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!asking) return;
    setError(undefined);
    setWorking(true);
    try {
      if (asking.kind === 'rename') {
        if (name.trim() !== project.name) await actions.updateProject?.(project.id, { name: name.trim() });
      } else if (asking.kind === 'removeHost') {
        await actions.updateProject?.(project.id, { removeHost: asking.hostId });
      } else {
        await actions.removeProject?.(project.id);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };
  const title = asking?.kind === 'rename'
    ? `Rename ${project.name}`
    : asking?.kind === 'removeHost'
      ? `Remove ${project.name} from ${hostName(asking.hostId)}?`
      : `Remove ${project.name}?`;
  return (
    <Dialog open={asking !== undefined} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className='w-[min(24rem,calc(100%-2rem))] max-w-none sm:max-w-sm'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={asking?.kind === 'rename' ? 'sr-only' : undefined}>
            {asking?.kind === 'rename'
              ? 'A name no other Project has.'
              : asking?.kind === 'removeHost'
                ? 'Its directory there stays, and its Sessions there list under the Host.'
                : 'Its directories stay, and its Sessions list under their Hosts.'}
          </DialogDescription>
        </DialogHeader>
        <form aria-label={title} className='grid gap-3' onSubmit={submit}>
          {asking?.kind === 'rename' && (
            <div className='grid gap-1.5'>
              <Label htmlFor={`project-name-${project.id}`}>Name</Label>
              <Input id={`project-name-${project.id}`} required autoFocus autoComplete='off' autoCapitalize='off' autoCorrect='off' maxLength={80}
                value={name} onChange={(event) => setName(event.target.value)} />
            </div>
          )}
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type='button' variant='ghost' onClick={onClose}>Cancel</Button>
            {asking?.kind === 'rename'
              ? <Button type='submit' disabled={!name.trim() || working}>Rename</Button>
              : <Button type='submit' variant='destructive' disabled={working}>{asking?.kind === 'removeHost' ? 'Remove location' : 'Remove Project'}</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A Project's heading: its name, over its Sessions on every Host, which a click collapses
 * (WVE-231), a Session to start in it, and its menu.
 */
export function ProjectHeading({ controller, project, fold, onNewSession, onAddLocation }: {
  controller: AppController;
  project: ProjectSummary;
  fold?: GroupFold;
  /** None while none of its Hosts is connected. */
  onNewSession?(): void;
  /** Asks for a location of it on another Host. */
  onAddLocation?(): void;
}) {
  const { model, actions } = controller;
  const [asking, setAsking] = useState<Asking>();
  const manages = Boolean(model.canManageProjects && actions.updateProject && actions.removeProject);
  const elsewhere = model.hosts.some(({ id, status }) => status === 'connected' && !project.locations.some(({ hostId }) => hostId === id));
  const hostName = (hostId: string) => model.hosts.find(({ id }) => id === hostId)?.name ?? hostId;
  const label = <GroupHeading name={project.name} icon={Folder01Icon} iconClassName='text-green' fold={fold} />;
  return (
    <>
      {manages
        ? (
          <ContextMenu>
            <ContextMenuTrigger className='[-webkit-touch-callout:none]'>{label}</ContextMenuTrigger>
            <ContextMenuContent aria-label={`${project.name} actions`}>
              <ContextMenuItem onClick={() => setAsking({ kind: 'rename' })}>
                <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
                Rename…
              </ContextMenuItem>
              {elsewhere && onAddLocation && (
                <ContextMenuItem onClick={onAddLocation}>
                  <HugeiconsIcon icon={FolderAddIcon} strokeWidth={2} />
                  Add a location…
                </ContextMenuItem>
              )}
              {project.locations.map(({ hostId }) => (
                <ContextMenuItem key={hostId} onClick={() => setAsking({ kind: 'removeHost', hostId })}>
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                  Remove from {hostName(hostId)}…
                </ContextMenuItem>
              ))}
              <ContextMenuItem variant='destructive' onClick={() => setAsking({ kind: 'remove' })}>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                Remove Project…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
        : label}
      <SidebarGroupAction aria-label={`New Session in ${project.name}`} title={`New Session in ${project.name}`}
        className='top-3.5 right-2.5' disabled={!onNewSession} onClick={onNewSession}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      </SidebarGroupAction>
      {manages && <ProjectDialog controller={controller} project={project} asking={asking} onClose={() => setAsking(undefined)} />}
    </>
  );
}
