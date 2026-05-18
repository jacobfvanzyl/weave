import { useEffect, useMemo, useState } from 'react';
import { ChevronUp, Folder, Loader2, X } from 'lucide-react';
import { browsePortal, type CreatePlaneInput, type PortalBrowseResult, type PortalConnection, type PortalRoot } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';

type GitPlaneDirectoryPickerProps = {
  portals: PortalConnection[];
  isCreating?: boolean;
  createError?: string | null;
  onCancel: () => void;
  onCreate: (input: CreatePlaneInput) => Promise<void> | void;
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

export const GitPlaneDirectoryPicker = ({ portals, isCreating = false, createError, onCancel, onCreate }: GitPlaneDirectoryPickerProps) => {
  const [planeName, setPlaneName] = useState('');
  const [projectKind, setProjectKind] = useState<'standard' | 'git'>('standard');
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
    if (projectKind !== 'git' || !selectedPortalId || !selectedRootId) return;
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
  const trimmedName = planeName.trim();
  const displayPath = browseResult?.path ?? path;
  const canCreate = projectKind === 'standard'
    ? Boolean(trimmedName && !isCreating)
    : Boolean(trimmedName && selectedPortal?.portalId && selectedRootId && browseResult?.isGitRepo && !isBrowsing && !isCreating);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-border bg-background p-4 shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Create Plane</h2>
            <p className="mt-1 text-xs text-muted-foreground">Name Plane and choose type before creating it.</p>
          </div>
          <button className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={onCancel} aria-label="Close directory picker">
            <X size={16} />
          </button>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Name</span>
            <input
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
              value={planeName}
              onChange={event => setPlaneName(event.target.value)}
              disabled={isCreating}
              autoFocus
              placeholder="Project name"
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Type</span>
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
              value={projectKind}
              onChange={event => setProjectKind(event.target.value === 'git' ? 'git' : 'standard')}
              disabled={isCreating}
            >
              <option value="standard">Standard</option>
              <option value="git">Code - Portal</option>
            </select>
          </label>
        </div>

        {projectKind === 'git' ? <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Portal</span>
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
              value={selectedPortal?.portalId ?? ''}
              onChange={event => setSelectedPortalId(event.target.value)}
              disabled={onlinePortals.length === 0 || isCreating}
            >
              {onlinePortals.map(portal => (
                <option key={portal.portalId} value={portal.portalId}>{portal.name || portal.portalId}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Root</span>
            <select
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
              value={selectedRootId}
              onChange={event => setSelectedRootId(event.target.value)}
              disabled={!selectedPortal || isCreating}
            >
              {roots.map(root => <option key={root.id} value={root.id}>{root.name || root.id}</option>)}
            </select>
          </label>
        </div> : null}

        {projectKind === 'git' ? <div className="mt-3 rounded-md border border-border bg-muted/40 p-2 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-muted-foreground">/{displayPath}</span>
            {path ? (
              <button className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-muted-foreground transition hover:bg-background hover:text-foreground" onClick={() => setPath(parentPath(path))} disabled={isCreating}>
                <ChevronUp size={13} /> Parent
              </button>
            ) : null}
          </div>
          <div className={cn('mt-2 rounded px-2 py-1', browseResult?.isGitRepo ? 'bg-success/15 text-success' : 'bg-background/60 text-muted-foreground')}>
            {browseResult?.isGitRepo ? 'Valid git repository root' : 'Select a git repository root'}
          </div>
        </div> : null}

        {projectKind === 'git' ? <div className="mt-3 min-h-44 flex-1 overflow-auto rounded-md border border-border bg-background/70 p-1">
          {isBrowsing ? (
            <div className="flex h-32 items-center justify-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" /> Loading directories</div>
          ) : browseError ? (
            <div className="p-3 text-xs text-destructive">{browseError}</div>
          ) : directories.length === 0 ? (
            <div className="p-3 text-xs text-muted-foreground">No child directories.</div>
          ) : directories.map(entry => (
            <button
              key={entry.name}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-foreground transition hover:bg-muted"
              onClick={() => setPath(joinPath(path, entry.name))}
              disabled={isCreating}
            >
              <Folder size={14} className={cn('shrink-0', entry.hidden ? 'text-muted-foreground' : 'text-success')} />
              <span className="min-w-0 truncate">{entry.name}</span>
            </button>
          ))}
        </div> : null}

        {projectKind === 'git' && onlinePortals.length === 0 ? <div className="mt-3 rounded-md bg-destructive/10 p-2 text-xs text-destructive">Connect a Portal before creating a Code - Portal Plane.</div> : null}

        {createError ? <div className="mt-3 rounded-md bg-destructive/10 p-2 text-xs text-destructive">{createError}</div> : null}

        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-md px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground" onClick={onCancel} disabled={isCreating}>Cancel</button>
          <button
            className="flex items-center gap-2 rounded-md bg-success px-3 py-1.5 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-50"
            disabled={!canCreate}
            onClick={() => {
              if (projectKind === 'standard') return onCreate({ name: trimmedName, projectKind: 'standard' });
              return selectedPortal && onCreate({ name: trimmedName, projectKind: 'git', portalId: selectedPortal.portalId, rootId: selectedRootId, repoPath: displayPath });
            }}
          >
            {isCreating ? <Loader2 size={13} className="animate-spin" /> : null}
            Create Plane
          </button>
        </div>
      </div>
    </div>
  );
};
