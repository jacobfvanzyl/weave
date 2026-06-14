import { useEffect, useMemo, useState } from 'react';
import { ChevronUp, Folder, Loader2, X } from 'lucide-react';
import { browsePortal, type CreateProjectInput, type PortalBrowseResult, type PortalConnection, type PortalRoot } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../ui/dialog';
import { Empty, EmptyDescription } from '../ui/empty';
import { Field, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';

type GitProjectDirectoryPickerProps = {
  portals: PortalConnection[];
  isCreating?: boolean;
  createError?: string | null;
  onCancel: () => void;
  onCreate: (input: CreateProjectInput) => Promise<void> | void;
};

const joinPath = (base: string, name: string) => base ? `${base}/${name}` : name;
const parentPath = (value: string) => value.split('/').filter(Boolean).slice(0, -1).join('/');

const normalizeRoots = (roots: PortalRoot[] | undefined) => {
  const normalized = (roots ?? []).filter(root => root && typeof root.id === 'string' && root.id.trim())
    .map(root => ({ id: root.id.trim(), name: typeof root.name === 'string' ? root.name : undefined }));
  return normalized.length ? normalized : [{ id: 'default', name: 'Default' }];
};

const defaultRootId = (roots: PortalRoot[]) => roots.find(root => root.id === 'default')?.id ?? roots[0]?.id ?? 'default';

const normalizeBrowseResult = (result: PortalBrowseResult | null, requestedPath: string): PortalBrowseResult | null => {
  if (!result) return null;
  return {
    ...result,
    rootId: typeof result.rootId === 'string' ? result.rootId : 'default',
    path: typeof result.path === 'string' ? result.path : requestedPath,
    entries: Array.isArray(result.entries) ? result.entries : [],
    isGitRepo: result.isGitRepo === true,
  };
};

export const GitProjectDirectoryPicker = ({ portals, isCreating = false, createError, onCancel, onCreate }: GitProjectDirectoryPickerProps) => {
  const [projectName, setProjectName] = useState('');
  const [projectKind, setProjectKind] = useState<'general' | 'git' | 'notes'>('general');
  const onlinePortals = useMemo(() => portals.filter(portal => portal.status === 'online'), [portals]);
  const [selectedPortalId, setSelectedPortalId] = useState(() => onlinePortals[0]?.portalId ?? '');
  const selectedPortal = onlinePortals.find(portal => portal.portalId === selectedPortalId) ?? onlinePortals[0];
  const roots = useMemo(() => normalizeRoots(selectedPortal?.roots), [selectedPortal?.roots]);
  const [selectedRootId, setSelectedRootId] = useState(() => defaultRootId(roots));
  const [path, setPath] = useState('');
  const [browseResult, setBrowseResult] = useState<PortalBrowseResult | null>(null);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  useEffect(() => {
    if (onlinePortals.length === 0) {
      if (selectedPortalId) setSelectedPortalId('');
      return;
    }
    if (!onlinePortals.some(portal => portal.portalId === selectedPortalId)) {
      setSelectedPortalId(onlinePortals[0].portalId);
    }
  }, [onlinePortals, selectedPortalId]);

  useEffect(() => {
    const nextRootId = defaultRootId(roots);
    setSelectedRootId(rootId => roots.some(root => root.id === rootId) ? rootId : nextRootId);
  }, [roots]);

  useEffect(() => {
    setPath('');
    setBrowseResult(null);
    setBrowseError(null);
  }, [selectedPortalId, selectedRootId]);

  useEffect(() => {
    if ((projectKind !== 'git' && projectKind !== 'notes') || !selectedPortalId || !selectedRootId) return;
    let cancelled = false;
    setIsBrowsing(true);
    setBrowseError(null);
    browsePortal(selectedPortalId, selectedRootId, path)
      .then(result => {
        if (cancelled) return;
        setBrowseResult(normalizeBrowseResult(result, path));
      })
      .catch(error => {
        if (cancelled) return;
        setBrowseResult(null);
        setBrowseError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setIsBrowsing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectKind, selectedPortalId, selectedRootId, path]);

  const directories = (browseResult?.entries ?? []).filter(entry => entry.type === 'directory');
  const trimmedName = projectName.trim();
  const displayPath = browseResult?.path ?? path;
  const selectedPath = browseResult?.realPath ?? displayPath;
  const canCreate = projectKind === 'general'
    ? Boolean(trimmedName && !isCreating)
    : projectKind === 'git'
    ? Boolean(trimmedName && selectedPortal?.portalId && selectedRootId && browseResult?.isGitRepo && !isBrowsing && !isCreating)
    : Boolean(trimmedName && selectedPortal?.portalId && selectedRootId && browseResult && !isBrowsing && !isCreating);

  return (
    <Dialog open onOpenChange={open => {
      if (!open) onCancel();
    }}>
      <DialogPopup className="max-w-lg" showCloseButton={false}>
        <DialogHeader className="flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription>General, Code, or Notes</DialogDescription>
          </div>
          <DialogClose render={<Button size="icon-sm" variant="ghost" aria-label="Close directory picker" />}>
            <X size={16} />
          </DialogClose>
        </DialogHeader>

        <DialogPanel className="grid gap-3 pt-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input
              nativeInput
              value={projectName}
              onChange={event => setProjectName(event.target.value)}
              disabled={isCreating}
              autoFocus
              placeholder="Project name"
            />
          </Field>
          <Field>
            <FieldLabel>Type</FieldLabel>
            <Select
              value={projectKind}
              onValueChange={value => setProjectKind(value === 'git' || value === 'notes' ? value : 'general')}
              disabled={isCreating}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="general">General</SelectItem>
                <SelectItem value="git">Code</SelectItem>
                <SelectItem value="notes">Notes</SelectItem>
              </SelectPopup>
            </Select>
          </Field>
        </div>

        {projectKind === 'git' || projectKind === 'notes' ? <div className="grid gap-3 sm:grid-cols-2">
          <Field>
            <FieldLabel>Portal</FieldLabel>
            <Select
              value={selectedPortal?.portalId ?? ''}
              onValueChange={value => setSelectedPortalId(value ?? '')}
              disabled={onlinePortals.length === 0 || isCreating}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {onlinePortals.map(portal => (
                  <SelectItem key={portal.portalId} value={portal.portalId}>{portal.name || portal.portalId}</SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Root</FieldLabel>
            <Select
              value={selectedRootId}
              onValueChange={value => setSelectedRootId(value ?? '')}
              disabled={!selectedPortal || isCreating}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {roots.map(root => <SelectItem key={root.id} value={root.id}>{root.name || root.id}</SelectItem>)}
              </SelectPopup>
            </Select>
          </Field>
        </div> : null}

        {projectKind === 'git' || projectKind === 'notes' ? <div className="rounded-md border border-border bg-muted p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-muted-foreground">/{displayPath}</span>
            {path ? (
              <Button size="xs" variant="ghost" className="shrink-0" onClick={() => setPath(parentPath(path))} disabled={isCreating}>
                <ChevronUp size={13} /> Parent
              </Button>
            ) : null}
          </div>
          <div className={cn('mt-2 rounded px-2 py-1', projectKind === 'notes' || browseResult?.isGitRepo ? 'bg-success/15 text-success' : 'bg-background/60 text-muted-foreground')}>
            {projectKind === 'notes' ? 'Vault folder selected' : browseResult?.isGitRepo ? 'Valid git repository root' : 'Select a git repository root'}
          </div>
        </div> : null}

        {projectKind === 'git' || projectKind === 'notes' ? <ScrollArea className="min-h-44 flex-1 rounded-md border border-border bg-background">
          <div className="p-1">
          {isBrowsing ? (
            <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground"><Spinner /> Loading directories</div>
          ) : browseError ? (
            <Alert variant="error"><AlertDescription>{browseError}</AlertDescription></Alert>
          ) : directories.length === 0 ? (
            <Empty><EmptyDescription>No child directories.</EmptyDescription></Empty>
          ) : directories.map(entry => (
            <Button
              key={entry.name}
              className="w-full justify-start text-xs"
              size="sm"
              variant="ghost"
              onClick={() => setPath(joinPath(path, entry.name))}
              disabled={isCreating}
            >
              <Folder size={14} className={cn('shrink-0', entry.hidden ? 'text-muted-foreground' : 'text-success')} />
              <span className="min-w-0 truncate">{entry.name}</span>
            </Button>
          ))}
          </div>
        </ScrollArea> : null}

        {(projectKind === 'git' || projectKind === 'notes') && onlinePortals.length === 0 ? <Alert variant="error"><AlertDescription>Connect a Portal before creating this Project.</AlertDescription></Alert> : null}

        {createError ? <Alert variant="error"><AlertDescription>{createError}</AlertDescription></Alert> : null}
        </DialogPanel>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isCreating}>Cancel</Button>
          <Button
            className="bg-success text-background hover:bg-success/90"
            disabled={!canCreate}
            onClick={() => {
              if (projectKind === 'general') return onCreate({ name: trimmedName, projectKind: 'general' });
              if (projectKind === 'notes') return selectedPortal && onCreate({ name: trimmedName, projectKind: 'notes', portalId: selectedPortal.portalId, rootId: selectedRootId, vaultPath: selectedPath });
              return selectedPortal && onCreate({ name: trimmedName, projectKind: 'git', portalId: selectedPortal.portalId, rootId: selectedRootId, repoPath: displayPath });
            }}
          >
            {isCreating ? <Loader2 size={13} className="animate-spin" /> : null}
            Create Project
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
