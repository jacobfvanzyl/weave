// New Session (WVE-220): a Project first, then what the Session starts with. A Session is a
// directory on one Host, so a Project gives both; "Other directory" is for one no Project has.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, Folder01Icon, FolderAddIcon, FolderOpenIcon, GitBranchIcon } from '@hugeicons/core-free-icons';
import type { AppController, CreatedThread, ProjectSummary, SessionSummary, StartedTerminal } from '@/app/app-controller';
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
import { projectsByUse } from '@/session/sessions';

/** What New Session opens for: nothing chosen, a Project, or a directory to pick on a Host. */
export type NewSessionTarget = { projectId?: string; hostId?: string };

/** What a Session starts with, as the select's value: an agent's id, or a terminal. */
const TERMINAL = '\u0000terminal';

type Row = { id: string; kind: 'project'; project: ProjectSummary } | { id: 'add' | 'other'; kind: 'add' | 'other' };

export function NewSessionDialog({ controller, sessions, target, onClose, onCreated, onStarted, onAddProject }: {
  controller: AppController;
  /** The Sessions there are, which say which Projects were worked in last. */
  sessions: readonly SessionSummary[];
  target?: NewSessionTarget;
  onClose(): void;
  /** The thread it started, and the Session it's in, before it closes. */
  onCreated?(created: CreatedThread): void;
  /** The terminal it started instead, and the Session it's in. */
  onStarted?(started: StartedTerminal): void;
  /** Asks for a Project to be added, which New Session then opens with. */
  onAddProject?(): void;
}) {
  const { model, actions } = controller;
  const connected = model.hosts.filter(({ status }) => status === 'connected');
  const isConnected = (id: string) => connected.some((host) => host.id === id);
  const projects = useMemo(() => projectsByUse(model.projects ?? [], sessions), [model.projects, sessions]);
  const canAdd = Boolean(model.canManageProjects && actions.addProject && onAddProject);
  // Without Projects, and no way to add one, there's only a directory to choose.
  const lists = projects.length > 0 || canAdd;
  const [view, setView] = useState<'projects' | 'form' | 'directory' | 'worktree'>('projects');
  const [projectId, setProjectId] = useState<string>();
  const [hostId, setHostId] = useState('');
  const [directory, setDirectory] = useState('');
  const [start, setStart] = useState('');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState(0);
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const project = projectId ? projects.find(({ id }) => id === projectId) : undefined;
  const host = connected.find(({ id }) => id === hostId);
  const agents = model.agents[hostId] ?? [];
  const canTerminal = Boolean(host?.canTerminals && actions.startTerminal);
  const cwd = directory.trim();

  /** What a Session on `on` starts with unless the person says: what this device started with last, where that Host has it. */
  const startOn = (on: string) => {
    const last = loadLastChoices();
    const there = connected.find(({ id }) => id === on);
    if (last.terminal && there?.canTerminals && actions.startTerminal) return TERMINAL;
    return lastUsedFirst(model.agents[on] ?? [], last.agentId)[0]?.id ?? (there?.canTerminals && actions.startTerminal ? TERMINAL : '');
  };
  const onHost = (on: string, at?: string) => {
    setHostId(on);
    // Outside a Project, the directory the Host's threads used last, as a place to start from.
    setDirectory(at ?? knownDirectories(model.threads, on)[0] ?? '');
    setStart(startOn(on));
  };
  const chooseProject = (chosen: ProjectSummary) => {
    const location = chosen.locations.find((there) => isConnected(there.hostId));
    setProjectId(chosen.id);
    onHost(location?.hostId ?? '', location?.path);
    setError(undefined);
    setView('form');
  };
  const chooseOther = (on?: string) => {
    const last = loadLastChoices().hostId;
    setProjectId(undefined);
    onHost(on ?? connected.find(({ id }) => id === last)?.id ?? connected[0]?.id ?? '');
    setError(undefined);
    setView('form');
  };

  useEffect(() => {
    if (!target) return;
    setQuery('');
    setPicked(0);
    setError(undefined);
    setStarting(false);
    const named = target.projectId ? projects.find(({ id }) => id === target.projectId) : undefined;
    if (named) chooseProject(named);
    else if (target.hostId || !lists) chooseOther(target.hostId);
    else setView('projects');
    // Choices reset only when the dialog opens for a new target, not as the lists change.
  }, [target]);

  const worktree = useWorktreeChoice({
    actions,
    on: target !== undefined && view !== 'projects',
    hostId,
    cwd,
    canWorktree: Boolean(host?.canWorktree),
    immediate: Boolean(project || host?.canBrowse),
  });
  const { repository, chosen } = worktree;

  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const hostNames = (listed: ProjectSummary) => listed.locations.map(({ hostId: on }) => model.hosts.find(({ id }) => id === on)?.name ?? on).join(', ');
  const rows: Row[] = [
    ...projects
      .filter((listed) => words.every((word) => `${listed.name} ${hostNames(listed)}`.toLocaleLowerCase().includes(word)))
      .map((listed): Row => ({ id: listed.id, kind: 'project', project: listed })),
    ...(canAdd ? [{ id: 'add', kind: 'add' } as const] : []),
    { id: 'other', kind: 'other' },
  ];
  useEffect(() => setPicked(0), [query]);
  const pick = (row: Row) => {
    if (row.kind === 'project') chooseProject(row.project);
    else if (row.kind === 'other') chooseOther();
    else {
      onClose();
      onAddProject?.();
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setStarting(true);
    try {
      if (start === TERMINAL) {
        const started = await actions.startTerminal?.({ hostId, directory: worktree.directory });
        saveLastChoices({ terminal: true, ...(project ? {} : { hostId }) });
        if (started) onStarted?.(started);
      } else {
        const created = await actions.createThread({ hostId, cwd: worktree.directory, agentId: start });
        saveLastChoices({ agentId: start, terminal: false, ...(project ? {} : { hostId }) });
        if (created) onCreated?.(created);
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  // A Project's Hosts that are connected: more than one, and the person says which.
  const places = project?.locations.filter((there) => isConnected(there.hostId)) ?? [];
  const hostChoices = project ? connected.filter(({ id }) => places.some((there) => there.hostId === id)) : connected;
  const list = view === 'projects';

  return (
    <Dialog open={target !== undefined} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className={cn('w-[min(28rem,calc(100%-2rem))] max-w-none sm:max-w-md', list && 'gap-2')}>
        <DialogHeader>
          <DialogTitle>{view === 'directory' ? 'Choose a directory' : view === 'worktree' ? 'Choose a worktree' : 'New Session'}</DialogTitle>
          <DialogDescription className='sr-only'>A Project, or another directory on one of your Hosts, and what to start in it.</DialogDescription>
        </DialogHeader>
        {list && (
          <>
            <Input aria-label='Find a Project' placeholder='Find a Project' autoFocus value={query}
              role='combobox' aria-expanded='true' aria-controls='new-session-projects'
              aria-activedescendant={rows[picked] ? `new-session-row-${rows[picked].id}` : undefined}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setPicked((at) => Math.min(rows.length - 1, at + 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setPicked((at) => Math.max(0, at - 1));
                } else if (event.key === 'Enter' && rows[picked]) {
                  event.preventDefault();
                  pick(rows[picked]);
                }
              }} />
            <ul id='new-session-projects' role='listbox' aria-label='Projects' className='grid max-h-[50dvh] gap-0.5 overflow-y-auto'>
              {rows.map((row, index) => (
                <li key={row.id} id={`new-session-row-${row.id}`} role='option' aria-selected={index === picked}
                  className={cn('flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs', index === picked && 'bg-muted',
                    // After the Projects, apart from them.
                    row.kind !== 'project' && rows[index - 1]?.kind === 'project' && 'mt-1')}
                  onPointerMove={() => setPicked(index)} onClick={() => pick(row)}>
                  <HugeiconsIcon icon={row.kind === 'project' ? Folder01Icon : row.kind === 'add' ? FolderAddIcon : FolderOpenIcon} strokeWidth={1.75}
                    className='size-3.5 shrink-0 text-icon-muted' aria-hidden />
                  {row.kind === 'project'
                    ? (
                      <>
                        <span className='min-w-0 truncate font-medium'>{row.project.name}</span>
                        <span className={cn('ml-auto min-w-0 shrink-0 truncate text-[0.6875rem] text-muted-foreground')}>
                          {row.project.locations.some((there) => isConnected(there.hostId)) ? hostNames(row.project) : `${hostNames(row.project) || 'no Host'}, not connected`}
                        </span>
                      </>
                    )
                    : <span className='min-w-0 truncate'>{row.kind === 'add' ? 'Add Project…' : 'Other directory…'}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
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
        {view === 'worktree' && repository && (
          <WorktreePicker
            repository={repository}
            selected={chosen?.path}
            create={worktree.create}
            onChoose={(path) => {
              worktree.choose(path);
              setView('form');
            }}
            onCancel={() => setView('form')}
          />
        )}
        <form aria-label='New Session' className={cn('grid gap-3', view !== 'form' && 'hidden')} onSubmit={create}>
          {lists && (
            <div className='grid gap-1.5'>
              <Label htmlFor='new-session-project'>Project</Label>
              <PickerField id='new-session-project' icon={project ? Folder01Icon : FolderOpenIcon} onOpen={() => setView('projects')}>
                {project ? <span className='min-w-0 truncate font-medium'>{project.name}</span> : <span className='text-muted-foreground'>None: another directory</span>}
              </PickerField>
            </div>
          )}
          {project && places.length === 0 && (
            <Alert><AlertDescription>{hostNames(project) ? `${project.name} is on ${hostNames(project)}, which isn't connected.` : `${project.name} has no location on a Host.`}</AlertDescription></Alert>
          )}
          {hostChoices.length > 1 && (
            <div className='grid gap-1.5'>
              <Label htmlFor='new-session-host'>Host</Label>
              <NativeSelect id='new-session-host' value={hostId} onChange={(event) => {
                const on = event.target.value;
                onHost(on, project?.locations.find((there) => there.hostId === on)?.path);
              }}>
                {hostChoices.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
              </NativeSelect>
            </div>
          )}
          {!project && (
            <div className='grid gap-1.5'>
              <Label htmlFor='new-session-directory'>Directory</Label>
              {host?.canBrowse
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
          )}
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
            <Label htmlFor='new-session-start'>Start with</Label>
            <NativeSelect id='new-session-start' value={start} onChange={(event) => setStart(event.target.value)}>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              {canTerminal && <option value={TERMINAL}>Terminal</option>}
            </NativeSelect>
          </div>
          {error && <Alert variant='destructive'><AlertDescription>{error}</AlertDescription></Alert>}
          <DialogFooter>
            <Button type='submit' disabled={!hostId || !cwd || !start || starting}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              Start
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
