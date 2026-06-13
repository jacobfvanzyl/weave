import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import ReactMarkdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import {
  FilePlus2,
  FolderPlus,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PencilRuler,
  RefreshCw,
  Save,
  Search,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { createVaultBackend, type VaultBackend, type VaultFile, type VaultIndexResult, type VaultNote, type VaultTarget } from '../../lib/vault-backend';
import { configureExcalidrawAssetPath } from '../../lib/excalidraw-assets';
import { getResolvedTheme, useThemeStore } from '../../stores/theme-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { CodeMirrorEditor, type CodeMirrorEditorHandle } from './CodeMirrorEditor';

type NotesPanelTarget = VaultTarget & {
  projectName: string;
  workspaceName: string;
};

type NotesPanelProps = {
  focusRequest?: number;
  isExpanded: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
  target: NotesPanelTarget;
  onHide: () => void;
};

type ExcalidrawComponentProps = ComponentProps<typeof Excalidraw>;
type ExcalidrawChangeHandler = NonNullable<ExcalidrawComponentProps['onChange']>;

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const isExcalidrawPath = (path: string | undefined) => Boolean(path && /\.excalidraw$/i.test(path));
const isMarkdownPath = (path: string | undefined) => Boolean(path && /\.(md|markdown)$/i.test(path));
const stripExtension = (path: string) => path.split('/').pop()?.replace(/\.[^.]+$/, '') ?? path;
const normalizeNotePath = (value: string) => {
  const trimmed = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!trimmed) return '';
  return /\.(md|markdown|excalidraw)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
};

const markdownForPreview = (content: string) => content
  .replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (_match, target) => `**${target}**`)
  .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target, alias) => `[${alias || target}](${target})`);

const createEmptyExcalidrawFile = () => JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'weave',
  elements: [],
  appState: {},
  files: {},
}, null, 2);

const parseExcalidrawInitialData = (content: string): ExcalidrawComponentProps['initialData'] => {
  try {
    const parsed = content ? JSON.parse(content) as Record<string, unknown> : {};
    return {
      elements: Array.isArray(parsed.elements) ? parsed.elements as any : [],
      appState: parsed.appState && typeof parsed.appState === 'object' ? parsed.appState as any : {},
      files: parsed.files && typeof parsed.files === 'object' ? parsed.files as any : {},
    };
  } catch {
    return { elements: [], appState: {}, files: {} };
  }
};

const serializeExcalidrawScene = ([elements, appState, files]: Parameters<ExcalidrawChangeHandler>) => JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'weave',
  elements,
  appState: {
    ...appState,
    collaborators: undefined,
  },
  files,
}, null, 2);

const noteMatchesQuery = (note: VaultNote, query: string) => {
  const lower = query.toLowerCase();
  return !lower
    || note.path.toLowerCase().includes(lower)
    || note.title.toLowerCase().includes(lower)
    || note.tags.some(tag => tag.toLowerCase().includes(lower))
    || note.preview?.toLowerCase().includes(lower);
};

const useVaultIndex = (backend: VaultBackend, target: VaultTarget) => {
  const [index, setIndex] = useState<VaultIndexResult>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);
    try {
      setIndex(await backend.index(target));
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [backend, target]);

  return { index, error, isLoading, refresh };
};

export const NotesPanel = ({ focusRequest = 0, isExpanded, onExpandedChange, target, onHide }: NotesPanelProps) => {
  const backend = useMemo(() => createVaultBackend(), []);
  const vaultTarget = useMemo<VaultTarget>(() => ({
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    portalId: target.portalId,
    rootId: target.rootId,
    repoPath: target.repoPath,
    workspacePath: target.workspacePath,
  }), [target.portalId, target.projectId, target.repoPath, target.rootId, target.workspaceId, target.workspacePath]);
  const { index, error: indexError, isLoading: isIndexLoading, refresh } = useVaultIndex(backend, vaultTarget);
  const mode = useThemeStore(state => state.mode);
  const theme = getResolvedTheme(mode);
  const editorRef = useRef<CodeMirrorEditorHandle | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [openFile, setOpenFile] = useState<VaultFile>();
  const [content, setContent] = useState('');
  const [error, setError] = useState<string>();
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const isDirty = Boolean(openFile && content !== openFile.content);
  const activeNote = openFile ? index?.notes.find(note => note.path === openFile.path) : undefined;
  const activeBacklinks = openFile ? index?.backlinks[openFile.path] ?? [] : [];
  const filteredNotes = useMemo(() => (index?.notes ?? []).filter(note => noteMatchesQuery(note, query)), [index?.notes, query]);
  const filteredDrawings = useMemo(() => (index?.attachments ?? []).filter(item => item.mediaType === 'excalidraw' && (!query || item.path.toLowerCase().includes(query.toLowerCase()))), [index?.attachments, query]);
  const filteredAttachments = useMemo(() => (index?.attachments ?? []).filter(item => item.mediaType !== 'excalidraw' && (!query || item.path.toLowerCase().includes(query.toLowerCase()))), [index?.attachments, query]);
  const titlePath = openFile?.path ?? `${target.projectName} / ${target.workspaceName}`;
  const statusLabel = isSaving ? 'saving' : isFileLoading ? 'loading' : isDirty ? 'modified' : undefined;

  useEffect(() => {
    configureExcalidrawAssetPath();
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setOpenFile(undefined);
    setContent('');
    setError(undefined);
    void refresh();
  }, [refresh, target.projectId, target.workspaceId]);

  useEffect(() => {
    if (focusRequest === 0) return undefined;
    const animationFrame = window.requestAnimationFrame(() => editorRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusRequest]);

  const confirmDiscard = useCallback(() => !isDirty || window.confirm('Discard unsaved changes?'), [isDirty]);

  const loadFile = useCallback(async (path: string) => {
    if (!confirmDiscard()) return;
    setIsFileLoading(true);
    setError(undefined);
    try {
      const file = await backend.read(vaultTarget, path);
      setOpenFile(file);
      setContent(file.content);
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    } finally {
      setIsFileLoading(false);
    }
  }, [backend, confirmDiscard, vaultTarget]);

  const saveFile = useCallback(async () => {
    if (!openFile || !isDirty) return;
    setIsSaving(true);
    setError(undefined);
    try {
      const result = await backend.write(vaultTarget, openFile.path, content, openFile.version);
      setOpenFile({ path: result.path, content, version: result.version });
      await refresh();
    } catch (saveError) {
      setError(toErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }, [backend, content, isDirty, openFile, refresh, vaultTarget]);

  const createNote = useCallback(async () => {
    const path = normalizeNotePath(window.prompt('Note path') ?? '');
    if (!path) return;
    if (!confirmDiscard()) return;
    setError(undefined);
    try {
      const title = stripExtension(path);
      const result = await backend.write(vaultTarget, path, `# ${title}\n`);
      setOpenFile({ path: result.path, content: `# ${title}\n`, version: result.version });
      setContent(`# ${title}\n`);
      await refresh();
    } catch (createError) {
      setError(toErrorMessage(createError));
    }
  }, [backend, confirmDiscard, refresh, vaultTarget]);

  const createDrawing = useCallback(async () => {
    const rawPath = window.prompt('Drawing path') ?? '';
    const path = rawPath.trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path) return;
    const drawingPath = /\.excalidraw$/i.test(path) ? path : `${path}.excalidraw`;
    if (!confirmDiscard()) return;
    const drawingContent = createEmptyExcalidrawFile();
    setError(undefined);
    try {
      const result = await backend.write(vaultTarget, drawingPath, drawingContent);
      setOpenFile({ path: result.path, content: drawingContent, version: result.version });
      setContent(drawingContent);
      await refresh();
    } catch (createError) {
      setError(toErrorMessage(createError));
    }
  }, [backend, confirmDiscard, refresh, vaultTarget]);

  const createFolder = useCallback(async () => {
    const path = (window.prompt('Folder path') ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path) return;
    setError(undefined);
    try {
      await backend.mkdir(vaultTarget, path);
      await refresh();
    } catch (folderError) {
      setError(toErrorMessage(folderError));
    }
  }, [backend, refresh, vaultTarget]);

  const renameOpenFile = useCallback(async () => {
    if (!openFile) return;
    const nextPath = normalizeNotePath(window.prompt('Move to path', openFile.path) ?? '');
    if (!nextPath || nextPath === openFile.path) return;
    setError(undefined);
    try {
      await backend.move(vaultTarget, openFile.path, nextPath);
      const file = await backend.read(vaultTarget, nextPath);
      setOpenFile(file);
      setContent(file.content);
      await refresh();
    } catch (moveError) {
      setError(toErrorMessage(moveError));
    }
  }, [backend, openFile, refresh, vaultTarget]);

  const deleteOpenFile = useCallback(async () => {
    if (!openFile || !window.confirm(`Delete ${openFile.path}?`)) return;
    setError(undefined);
    try {
      await backend.delete(vaultTarget, openFile.path);
      setOpenFile(undefined);
      setContent('');
      await refresh();
    } catch (deleteError) {
      setError(toErrorMessage(deleteError));
    }
  }, [backend, openFile, refresh, vaultTarget]);

  const uploadAttachment = useCallback(async (file: File | undefined) => {
    if (!file) return;
    const path = (window.prompt('Attachment path', `attachments/${file.name}`) ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!path) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64Content = result.includes(',') ? result.split(',').pop() ?? '' : result;
      setError(undefined);
      try {
        await backend.upload(vaultTarget, path, base64Content, file.type || undefined);
        await refresh();
      } catch (uploadError) {
        setError(toErrorMessage(uploadError));
      } finally {
        if (uploadInputRef.current) uploadInputRef.current.value = '';
      }
    };
    reader.readAsDataURL(file);
  }, [backend, refresh, vaultTarget]);

  const renderMarkdownEditor = () => (
    <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_minmax(18rem,0.8fr)]">
      <CodeMirrorEditor
        ref={editorRef}
        key={openFile?.path}
        path={openFile?.path}
        value={content}
        onChange={setContent}
        onSave={() => void saveFile()}
      />
      <div className="min-h-0 overflow-auto border-l border-border bg-card/30 px-5 py-4 text-sm leading-7 text-foreground">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, rehypeSanitize]}
          components={{
            a: ({ href, children }) => (
              <button
                className="text-primary underline-offset-2 hover:underline"
                onClick={() => {
                  if (!href) return;
                  const targetPath = /\.md$/i.test(href) ? href : `${href}.md`;
                  void loadFile(targetPath);
                }}
              >
                {children}
              </button>
            ),
          }}
        >
          {markdownForPreview(content)}
        </ReactMarkdown>
      </div>
    </div>
  );

  const renderExcalidrawEditor = () => (
    <Excalidraw
      key={openFile?.path}
      initialData={parseExcalidrawInitialData(openFile?.content ?? content)}
      name={openFile?.path ?? 'Vault Drawing'}
      onChange={(...snapshot) => setContent(serializeExcalidrawScene(snapshot))}
      theme={theme}
    />
  );

  return (
    <section
      className="relative z-10 flex h-full min-h-0 min-w-0 flex-1 basis-0 flex-col border-l border-border bg-background transition-[width] duration-150 ease-out"
      data-weave-notes-panel
      data-weave-surface="editor"
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <StickyNote size={15} className="shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">{titlePath}</span>
          {statusLabel ? <span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel}</span> : null}
        </div>
        <Button size="icon-xs" variant="ghost" aria-label="New note" title="New note" onClick={() => void createNote()}>
          <FilePlus2 size={14} />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="New drawing" title="New drawing" onClick={() => void createDrawing()}>
          <PencilRuler size={14} />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="New folder" title="New folder" onClick={() => void createFolder()}>
          <FolderPlus size={14} />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Upload attachment" title="Upload attachment" onClick={() => uploadInputRef.current?.click()}>
          <ImagePlus size={14} />
        </Button>
        <input ref={uploadInputRef} className="hidden" type="file" onChange={event => void uploadAttachment(event.currentTarget.files?.[0])} />
        <Button size="icon-xs" variant="ghost" aria-label="Save note" title="Save note" disabled={!openFile || !isDirty || isSaving} onClick={() => void saveFile()}>
          <Save size={14} />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Refresh vault" title="Refresh vault" disabled={isIndexLoading} onClick={() => void refresh()}>
          <RefreshCw size={14} className={isIndexLoading ? 'animate-spin' : undefined} />
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label={isExpanded ? 'Restore notes column' : 'Expand notes'} title={isExpanded ? 'Restore notes column' : 'Expand notes'} onClick={() => onExpandedChange(!isExpanded)}>
          {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Hide notes" onClick={onHide}>
          <X size={14} />
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)_14rem]">
        <aside className="flex min-h-0 flex-col border-r border-border bg-card/60">
          <div className="border-b border-border p-2">
            <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2">
              <Search size={13} className="shrink-0 text-muted-foreground" />
              <Input
                nativeInput
                className="h-6 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-1">
            {filteredNotes.map(note => (
              <button
                key={note.path}
                className={[
                  'flex min-h-8 w-full flex-col rounded-sm px-2 py-1 text-left text-xs transition-colors',
                  openFile?.path === note.path ? 'bg-selected-thread text-foreground' : 'text-foreground hover:bg-accent',
                ].filter(Boolean).join(' ')}
                title={note.path}
                onClick={() => void loadFile(note.path)}
              >
                <span className="min-w-0 max-w-full truncate font-medium">{note.title}</span>
                <span className="min-w-0 max-w-full truncate text-[10px] text-muted-foreground">{note.path}</span>
              </button>
            ))}
            {filteredDrawings.map(drawing => (
              <button
                key={drawing.path}
                className={[
                  'flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs transition-colors',
                  openFile?.path === drawing.path ? 'bg-selected-thread text-foreground' : 'text-foreground hover:bg-accent',
                ].filter(Boolean).join(' ')}
                title={drawing.path}
                onClick={() => void loadFile(drawing.path)}
              >
                <PencilRuler size={13} className="shrink-0 text-primary" />
                <span className="min-w-0 truncate">{drawing.path}</span>
              </button>
            ))}
          </div>
        </aside>
        <div className="relative min-h-0 min-w-0 overflow-hidden bg-background">
          {openFile ? (
            isExcalidrawPath(openFile.path) ? renderExcalidrawEditor() : renderMarkdownEditor()
          ) : (
            <div className="grid h-full place-items-center text-xs text-muted-foreground">No note selected</div>
          )}
          {isFileLoading ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/70 text-primary">
              <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
            </div>
          ) : null}
          {error || indexError ? (
            <div className="pointer-events-none absolute inset-x-3 top-3 rounded-md border border-destructive/30 bg-background/90 px-3 py-2 text-xs text-destructive shadow-sm">
              {error ?? indexError}
            </div>
          ) : null}
        </div>
        <aside className="flex min-h-0 flex-col border-l border-border bg-card/40">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
            <span className="min-w-0 truncate text-xs font-semibold text-foreground">Vault</span>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3 text-xs">
            {activeNote ? (
              <>
                <section className="space-y-2">
                  <div className="font-semibold text-muted-foreground">Tags</div>
                  <div className="flex flex-wrap gap-1">
                    {activeNote.tags.length ? activeNote.tags.map(tag => <Badge key={tag} variant="secondary">#{tag}</Badge>) : <span className="text-muted-foreground">None</span>}
                  </div>
                </section>
                <section className="space-y-2">
                  <div className="font-semibold text-muted-foreground">Links</div>
                  {activeNote.links.length ? activeNote.links.map(link => (
                    <button key={link} className="block max-w-full truncate text-left text-primary hover:underline" onClick={() => void loadFile(/\.md$/i.test(link) ? link : `${link}.md`)}>
                      {link}
                    </button>
                  )) : <span className="text-muted-foreground">None</span>}
                </section>
                <section className="space-y-2">
                  <div className="font-semibold text-muted-foreground">Backlinks</div>
                  {activeBacklinks.length ? activeBacklinks.map(path => (
                    <button key={path} className="block max-w-full truncate text-left text-primary hover:underline" onClick={() => void loadFile(path)}>
                      {path}
                    </button>
                  )) : <span className="text-muted-foreground">None</span>}
                </section>
              </>
            ) : null}
            <section className="space-y-2">
              <div className="font-semibold text-muted-foreground">Attachments</div>
              {filteredAttachments.slice(0, 80).map(attachment => (
                <div key={attachment.path} className="truncate text-muted-foreground" title={attachment.path}>{attachment.path}</div>
              ))}
              {filteredAttachments.length === 0 ? <span className="text-muted-foreground">None</span> : null}
            </section>
          </div>
          <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-t border-border px-3">
            <Button size="icon-xs" variant="ghost" aria-label="Move open note" title="Move open note" disabled={!openFile} onClick={() => void renameOpenFile()}>
              <RefreshCw size={14} />
            </Button>
            <Button size="icon-xs" variant="ghost" aria-label="Delete open note" title="Delete open note" disabled={!openFile} onClick={() => void deleteOpenFile()}>
              <Trash2 size={14} />
            </Button>
          </div>
        </aside>
      </div>
    </section>
  );
};
