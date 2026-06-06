import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Code2,
  File,
  Folder,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Save,
  X,
} from 'lucide-react';
import { createEditorBackend } from '../../lib/editor-backend';
import type { EditorBackend, EditorEntry, EditorFile, EditorTarget } from '../../lib/editor-types';
import { Button } from '../ui/button';
import { CodeMirrorEditor, type CodeMirrorEditorHandle, type VimMode } from './CodeMirrorEditor';

type EditorPanelTarget = EditorTarget & {
  projectName: string;
  workspaceName: string;
};

type EditorPanelProps = {
  focusRequest?: number;
  isExpanded: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
  target: EditorPanelTarget;
  onHide: () => void;
};

const getParentPath = (path: string) => {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
};

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const editorModeIndicatorStyles: Record<VimMode, { label: string; foreground: string; background: string }> = {
  normal: { label: 'NORMAL', foreground: '#181825', background: '#89b4fa' },
  insert: { label: 'INSERT', foreground: '#1e1e2e', background: '#a6e3a1' },
  visual: { label: 'VISUAL', foreground: '#1e1e2e', background: '#cba6f7' },
  visualLine: { label: 'V-LINE', foreground: '#1e1e2e', background: '#cba6f7' },
  visualBlock: { label: 'V-BLOCK', foreground: '#1e1e2e', background: '#cba6f7' },
  replace: { label: 'REPLACE', foreground: '#1e1e2e', background: '#f38ba8' },
  command: { label: 'COMMAND', foreground: '#1e1e2e', background: '#fab387' },
  terminal: { label: 'TERMINAL', foreground: '#1e1e2e', background: '#a6e3a1' },
};

const dockedFileTreeWidthPx = 16 * 16;
const minimumMainEditorColumns = 80;
const defaultMinimumMainEditorWidthPx = minimumMainEditorColumns * 8;
const fileTreeSlideOverCloseDelayMs = 120;
const columnMeasureText = '0'.repeat(minimumMainEditorColumns);

function useMeasuredElementWidth<T extends HTMLElement>(initialWidth = 0) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(initialWidth);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const updateWidth = () => setWidth(element.getBoundingClientRect().width);
    updateWidth();

    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  return [ref, width] as const;
}

export const EditorPanel = ({ focusRequest = 0, isExpanded, onExpandedChange, target, onHide }: EditorPanelProps) => {
  const backend = useMemo<EditorBackend>(() => createEditorBackend(), []);
  const editorTarget = useMemo<EditorTarget>(() => ({
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    portalId: target.portalId,
    rootId: target.rootId,
    repoPath: target.repoPath,
    workspacePath: target.workspacePath,
  }), [target.workspaceId, target.projectId, target.portalId, target.repoPath, target.rootId, target.workspacePath]);
  const editorRef = useRef<CodeMirrorEditorHandle | null>(null);
  const fileTreeSlideOverCloseTimeoutRef = useRef<number | undefined>(undefined);
  const [editorBodyRef, editorBodyWidth] = useMeasuredElementWidth<HTMLDivElement>(typeof window === 'undefined' ? 0 : window.innerWidth);
  const [columnMeasureRef, minimumMainEditorWidthPx] = useMeasuredElementWidth<HTMLSpanElement>(defaultMinimumMainEditorWidthPx);
  const [directoryPath, setDirectoryPath] = useState('');
  const [entries, setEntries] = useState<EditorEntry[]>([]);
  const [openFile, setOpenFile] = useState<EditorFile>();
  const [content, setContent] = useState('');
  const [error, setError] = useState<string>();
  const [isDirectoryLoading, setIsDirectoryLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isFileTreeVisible, setIsFileTreeVisible] = useState(true);
  const [isFileTreeSlideOverOpen, setIsFileTreeSlideOverOpen] = useState(false);
  const [vimMode, setVimMode] = useState<VimMode>('normal');
  const [editorFocusRequest, setEditorFocusRequest] = useState(0);
  const isDirty = Boolean(openFile && content !== openFile.content);
  const shouldPersistFileTreeOpen = !openFile;
  const canDockFileTree = editorBodyWidth - dockedFileTreeWidthPx >= minimumMainEditorWidthPx;
  const isFileTreeDocked = (isFileTreeVisible || shouldPersistFileTreeOpen) && canDockFileTree;
  const isFileTreeSlideOverMode = !canDockFileTree;
  const isFileTreeSlideOverVisible = isFileTreeSlideOverMode && (isFileTreeSlideOverOpen || shouldPersistFileTreeOpen);
  const isFileTreeActive = isFileTreeDocked || isFileTreeSlideOverVisible;

  const confirmDiscard = useCallback(() => !isDirty || window.confirm('Discard unsaved changes?'), [isDirty]);

  const clearFileTreeSlideOverCloseTimeout = useCallback(() => {
    if (fileTreeSlideOverCloseTimeoutRef.current === undefined) return;
    window.clearTimeout(fileTreeSlideOverCloseTimeoutRef.current);
    fileTreeSlideOverCloseTimeoutRef.current = undefined;
  }, []);

  const closeFileTreeSlideOver = useCallback(() => {
    clearFileTreeSlideOverCloseTimeout();
    setIsFileTreeSlideOverOpen(false);
  }, [clearFileTreeSlideOverCloseTimeout]);

  const openFileTreeSlideOver = useCallback(() => {
    if (!isFileTreeSlideOverMode) return;
    clearFileTreeSlideOverCloseTimeout();
    setIsFileTreeSlideOverOpen(true);
  }, [clearFileTreeSlideOverCloseTimeout, isFileTreeSlideOverMode]);

  const scheduleFileTreeSlideOverClose = useCallback(() => {
    if (!isFileTreeSlideOverMode) return;
    clearFileTreeSlideOverCloseTimeout();
    fileTreeSlideOverCloseTimeoutRef.current = window.setTimeout(() => {
      setIsFileTreeSlideOverOpen(false);
      fileTreeSlideOverCloseTimeoutRef.current = undefined;
    }, fileTreeSlideOverCloseDelayMs);
  }, [clearFileTreeSlideOverCloseTimeout, isFileTreeSlideOverMode]);

  const loadDirectory = useCallback(async (nextPath: string) => {
    setIsDirectoryLoading(true);
    setError(undefined);

    try {
      const result = await backend.list(editorTarget, nextPath);
      setDirectoryPath(result.path);
      setEntries(result.entries);
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    } finally {
      setIsDirectoryLoading(false);
    }
  }, [backend, editorTarget]);

  const loadFile = useCallback(async (path: string, options: { focusEditor?: boolean } = {}) => {
    setIsFileLoading(true);
    setError(undefined);

    try {
      const file = await backend.read(editorTarget, path);
      setOpenFile(file);
      setContent(file.content);
      if (options.focusEditor) setEditorFocusRequest(request => request + 1);
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    } finally {
      setIsFileLoading(false);
    }
  }, [backend, editorTarget]);

  useEffect(() => {
    setDirectoryPath('');
    setEntries([]);
    setOpenFile(undefined);
    setContent('');
    setError(undefined);
    closeFileTreeSlideOver();
    void loadDirectory('');
  }, [closeFileTreeSlideOver, loadDirectory, target.workspaceId, target.projectId]);

  useEffect(() => {
    if (canDockFileTree) closeFileTreeSlideOver();
  }, [canDockFileTree, closeFileTreeSlideOver]);

  useEffect(() => () => clearFileTreeSlideOverCloseTimeout(), [clearFileTreeSlideOverCloseTimeout]);

  useEffect(() => {
    if (!openFile) setVimMode('normal');
  }, [openFile]);

  useEffect(() => {
    if (editorFocusRequest === 0) return undefined;
    const animationFrame = window.requestAnimationFrame(() => editorRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [editorFocusRequest, openFile?.path]);

  useEffect(() => {
    if (focusRequest === 0) return undefined;
    const animationFrame = window.requestAnimationFrame(() => editorRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusRequest]);

  const handleOpenEntry = useCallback((entry: EditorEntry, options: { closeSlideOverOnFileOpen?: boolean } = {}) => {
    if (entry.type === 'directory') {
      if (!confirmDiscard()) return;
      void loadDirectory(entry.path);
      return;
    }

    if (entry.type === 'file') {
      if (!confirmDiscard()) return;
      void loadFile(entry.path, { focusEditor: true });
      if (options.closeSlideOverOnFileOpen) closeFileTreeSlideOver();
    }
  }, [closeFileTreeSlideOver, confirmDiscard, loadDirectory, loadFile]);

  const handleDirectoryUp = useCallback(() => {
    if (!directoryPath || !confirmDiscard()) return;
    void loadDirectory(getParentPath(directoryPath));
  }, [confirmDiscard, directoryPath, loadDirectory]);

  const handleSave = useCallback(async () => {
    if (!openFile || !isDirty) return;
    setIsSaving(true);
    setError(undefined);

    try {
      const result = await backend.write(editorTarget, openFile.path, content, openFile.version);
      setOpenFile({ ...openFile, content, version: result.version });
    } catch (saveError) {
      setError(toErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }, [backend, content, editorTarget, isDirty, openFile]);

  const handleReloadFile = useCallback(() => {
    if (!openFile || !confirmDiscard()) return;
    void loadFile(openFile.path);
  }, [confirmDiscard, loadFile, openFile]);

  const titlePath = openFile?.path ?? `${target.projectName} / ${target.workspaceName}`;
  const statusLabel = isSaving
    ? 'saving'
    : isFileLoading
      ? 'loading'
      : isDirty
        ? 'modified'
        : undefined;
  const fileTreeToggleLabel = isFileTreeSlideOverMode
    ? 'Open file tree'
    : isFileTreeVisible ? 'Hide file tree' : 'Show file tree';
  const modeIndicator = editorModeIndicatorStyles[vimMode];
  const renderFileTree = (presentation: 'docked' | 'slide-over') => {
    const isSlideOver = presentation === 'slide-over';

    return (
      <aside
        className={isSlideOver
          ? 'absolute bottom-2 right-2 top-2 z-20 flex w-64 max-w-[calc(100%-1rem)] flex-col overflow-hidden rounded-md border border-border bg-card/95 shadow-xl backdrop-blur'
          : 'flex w-64 shrink-0 flex-col border-l border-border bg-card/70'}
        data-weave-editor-file-tree
        data-presentation={presentation}
        onPointerEnter={isSlideOver ? openFileTreeSlideOver : undefined}
        onPointerLeave={isSlideOver ? closeFileTreeSlideOver : undefined}
      >
        <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border px-2">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Open parent folder"
            disabled={!directoryPath || isDirectoryLoading}
            onClick={handleDirectoryUp}
          >
            <ChevronLeft size={14} />
          </Button>
          <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
            /{directoryPath}
          </span>
          {isDirectoryLoading ? (
            <LoaderCircle size={13} className="ml-auto shrink-0 animate-spin text-primary" aria-hidden="true" />
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {entries.map(entry => {
            const isSelected = entry.type === 'file' && entry.path === openFile?.path;
            const isOther = entry.type === 'other';
            return (
              <button
                key={entry.path}
                className={[
                  'flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground transition-colors',
                  isSelected ? 'bg-selected-thread' : 'hover:bg-accent',
                  isOther ? 'cursor-default text-muted-foreground opacity-70' : '',
                ].filter(Boolean).join(' ')}
                disabled={isOther || isDirectoryLoading || isFileLoading}
                title={entry.path}
                onClick={() => handleOpenEntry(entry, { closeSlideOverOnFileOpen: isSlideOver })}
              >
                {entry.type === 'directory' ? (
                  <Folder size={14} className="shrink-0 text-mauve" />
                ) : entry.type === 'file' ? (
                  <File size={14} className="shrink-0 text-muted-foreground" />
                ) : (
                  <File size={14} className="shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate">{entry.name}</span>
              </button>
            );
          })}
        </div>
      </aside>
    );
  };

  return (
    <section
      className="relative z-10 flex h-full min-h-0 min-w-0 flex-1 basis-0 flex-col border-l border-border bg-background transition-[width] duration-150 ease-out"
      data-weave-editor-panel
      data-weave-surface="editor"
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      <span
        ref={columnMeasureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-pre"
        style={{
          fontFamily: 'var(--font-code)',
          fontSize: 'var(--weave-chat-text-size)',
        }}
      >
        {columnMeasureText}
      </span>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Code2 size={15} className="shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">
            {titlePath}
          </span>
          {statusLabel ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {statusLabel}
            </span>
          ) : null}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Save file"
          title="Save file"
          disabled={!openFile || !isDirty || isSaving}
          onClick={() => void handleSave()}
        >
          <Save size={14} />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Reload file"
          title="Reload file"
          disabled={!openFile || isFileLoading}
          onClick={handleReloadFile}
        >
          <RefreshCw size={14} className={isFileLoading ? 'animate-spin' : undefined} />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={isExpanded ? 'Restore editor column' : 'Expand editor'}
          title={isExpanded ? 'Restore editor column' : 'Expand editor'}
          onClick={() => onExpandedChange(!isExpanded)}
        >
          {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Hide editor" onClick={onHide}>
          <X size={14} />
        </Button>
      </div>
      <div ref={editorBodyRef} className="relative flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-hidden bg-background">
          {openFile ? (
            <CodeMirrorEditor
              ref={editorRef}
              key={openFile.path}
              path={openFile.path}
              value={content}
              onChange={setContent}
              onSave={() => void handleSave()}
              onVimModeChange={setVimMode}
            />
          ) : (
            <div className="grid h-full place-items-center text-xs text-muted-foreground">
              No file selected
            </div>
          )}
          {isFileLoading ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/70 text-primary">
              <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
            </div>
          ) : null}
          {error ? (
            <div className="pointer-events-none absolute inset-x-3 top-3 rounded-md border border-destructive/30 bg-background/90 px-3 py-2 text-xs text-destructive shadow-sm">
              {error}
            </div>
          ) : null}
        </div>
        {isFileTreeSlideOverVisible ? renderFileTree('slide-over') : null}
        {isFileTreeDocked ? renderFileTree('docked') : null}
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border px-3">
        <span
          className="inline-flex h-5 min-w-[4.75rem] shrink-0 items-center justify-center rounded-sm px-2 text-[11px] font-bold"
          style={{
            backgroundColor: modeIndicator.background,
            color: modeIndicator.foreground,
          }}
        >
          {modeIndicator.label}
        </span>
        <div className="min-w-0 flex-1" />
        <Button
          className={isFileTreeActive ? 'bg-accent' : ''}
          size="icon-xs"
          variant="ghost"
          aria-label={fileTreeToggleLabel}
          title={fileTreeToggleLabel}
          aria-pressed={isFileTreeActive}
          data-active={isFileTreeActive ? 'true' : 'false'}
          onPointerEnter={openFileTreeSlideOver}
          onPointerLeave={scheduleFileTreeSlideOverClose}
          onFocus={openFileTreeSlideOver}
          onBlur={scheduleFileTreeSlideOverClose}
          onClick={() => {
            if (isFileTreeSlideOverMode) {
              clearFileTreeSlideOverCloseTimeout();
              setIsFileTreeSlideOverOpen(true);
              return;
            }
            setIsFileTreeVisible(visible => !visible);
          }}
        >
          {isFileTreeActive ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </Button>
      </div>
    </section>
  );
};
