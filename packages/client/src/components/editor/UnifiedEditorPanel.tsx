import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CaptureUpdateAction, Excalidraw, restore as restoreExcalidrawData, serializeAsJSON as serializeExcalidrawAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import {
  ChevronDown,
  ChevronRight,
  Code2,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  ImagePlus,
  Info,
  LoaderCircle,
  Maximize2,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  PencilRuler,
  RefreshCw,
  Save,
  Search,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { createEditorBackend } from '../../lib/editor-backend';
import type { EditorEntry, EditorMode, EditorTarget, OpenBuffer } from '../../lib/editor-types';
import { configureExcalidrawAssetPath } from '../../lib/excalidraw-assets';
import { getNoteFileDisplayName } from '../../lib/note-display';
import { getEditorTabTargetKey, getEditorTabId, useEditorTabStore, type EditorTab } from '../../stores/editor-tab-store';
import type { EditorFollowRequest } from '../../stores/workspace-surface-store';
import { createVaultBackend, type VaultAttachment, type VaultIndexResult, type VaultNote, type VaultTarget } from '../../lib/vault-backend';
import { getResolvedTheme, useThemeStore } from '../../stores/theme-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { CodeMirrorEditor, editorCanvasBackgroundColor, type CodeMirrorEditorHandle, type VimMode } from './CodeMirrorEditor';

export type UnifiedEditorTarget = EditorTarget & {
  projectName: string;
  workspaceName: string;
};

type UnifiedEditorPanelProps = {
  followRequest?: EditorFollowRequest;
  focusRequest?: number;
  isExpanded: boolean;
  mode: EditorMode;
  onExpandedChange: (isExpanded: boolean) => void;
  onHide: () => void;
  target: UnifiedEditorTarget;
};

type ExplorerTab = 'explorer' | 'properties';
type CreatePathKind = 'file' | 'drawing' | 'folder';
type CreatePathDialogState = {
  kind: CreatePathKind;
  value: string;
};
type RenameState = {
  path: string;
  value: string;
  origin: 'explorer' | 'tab';
};

type EditorBuffer = OpenBuffer & {
  value: string;
};

type TreeNode = {
  id: string;
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  children: TreeNode[];
  entry?: EditorEntry;
  note?: VaultNote;
  attachment?: VaultAttachment;
  mediaType?: string;
  size?: number;
  mtimeMs?: number;
};

type ExcalidrawComponentProps = ComponentProps<typeof Excalidraw>;
type ExcalidrawImperativeAPI = Parameters<NonNullable<ExcalidrawComponentProps['excalidrawAPI']>>[0];
type ExcalidrawChangeHandler = NonNullable<ExcalidrawComponentProps['onChange']>;
type RestoredExcalidrawData = ReturnType<typeof restoreExcalidrawData>;

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const isMarkdownPath = (path: string | undefined) => Boolean(path && /\.(md|markdown)$/i.test(path));
const isExcalidrawPath = (path: string | undefined) => Boolean(path && /\.excalidraw$/i.test(path));
const isNotesOpenablePath = (path: string | undefined) => isMarkdownPath(path) || isExcalidrawPath(path);
const getParentPath = (path: string) => path.split('/').filter(Boolean).slice(0, -1).join('/');
const getBasename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;
const getFileExtension = (path: string) => {
  const match = /(\.[^/.]+)$/.exec(getBasename(path));
  return match?.[1] ?? '';
};
const normalizeRelativePath = (value: string) => value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
const joinRelativePath = (directoryPath: string, name: string) => directoryPath ? `${directoryPath}/${name}` : name;
const normalizeMarkdownPath = (value: string) => {
  const path = normalizeRelativePath(value);
  if (!path) return '';
  return /\.(md|markdown)$/i.test(path) ? path : `${path}.md`;
};
const normalizeRenameFileName = (value: string, currentPath: string, mode: EditorMode) => {
  const name = normalizeRelativePath(value);
  if (!name || name.includes('/')) return '';
  if (mode !== 'notes' || /\.[^/.]+$/i.test(name)) return name;
  if (isMarkdownPath(currentPath) || isExcalidrawPath(currentPath)) return `${name}${getFileExtension(currentPath) || '.md'}`;
  return name;
};

const getRenameDisplayName = (path: string, mode: EditorMode) => {
  if (mode === 'notes' && isMarkdownPath(path)) return getNoteFileDisplayName(path);
  return getBasename(path);
};

const getEditorFileLabel = (path: string, mode: EditorMode) => {
  if (mode === 'notes' && isMarkdownPath(path)) return getNoteFileDisplayName(path);
  if (mode === 'notes' && isExcalidrawPath(path)) return getBasename(path).replace(/\.excalidraw$/i, '');
  return getBasename(path);
};

const getExplorerFileLabel = (path: string, mode: EditorMode) => {
  if (mode === 'notes' && isExcalidrawPath(path)) return getBasename(path).replace(/\.excalidraw$/i, '');
  return getEditorFileLabel(path, mode);
};

const explorerRailWidthPx = 20 * 16;
const minimumMainEditorColumns = 80;
const defaultMinimumMainEditorWidthPx = minimumMainEditorColumns * 8;
const explorerSlideOverCloseDelayMs = 120;
const explorerFileOpenSingleClickDelayMs = 450;
const editorColumnMeasureText = '0'.repeat(minimumMainEditorColumns);

const getBufferDirty = (buffer: EditorBuffer | undefined) => Boolean(buffer && buffer.value !== buffer.content);

const createLoadedBuffer = (
  file: { path: string; content: string; version: string; size?: number; mtimeMs?: number },
  mediaType?: string,
): EditorBuffer => {
  const content = mediaType === 'excalidraw' ? normalizeExcalidrawContent(file.content) : file.content;
  return {
    path: file.path,
    content,
    value: content,
    version: file.version,
    size: file.size,
    mtimeMs: file.mtimeMs,
    mediaType,
    dirty: false,
  };
};

const withBufferValue = (buffer: EditorBuffer, value: string): EditorBuffer => ({
  ...buffer,
  value,
  dirty: value !== buffer.content,
});

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

const createEmptyExcalidrawFile = () => serializeExcalidrawAsJSON(
  [],
  { viewBackgroundColor: editorCanvasBackgroundColor },
  {},
  'local',
);

const excalidrawDarkFilteredEditorBackgroundColor = '#eeeeff';

const isDefaultExcalidrawBackground = (value: unknown) => {
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  return !normalized || normalized === '#fff' || normalized === '#ffffff' || normalized === 'white' || normalized === 'transparent';
};

const getExcalidrawAppStateWithEditorBackground = (appState: unknown) => {
  const appStateRecord = appState && typeof appState === 'object'
    ? { ...(appState as Record<string, unknown>) }
    : {};
  const hasStoredBackground = Object.prototype.hasOwnProperty.call(appStateRecord, 'viewBackgroundColor');
  if (!hasStoredBackground || isDefaultExcalidrawBackground(appStateRecord.viewBackgroundColor)) {
    appStateRecord.viewBackgroundColor = editorCanvasBackgroundColor;
  }
  return appStateRecord;
};

const isEditorCanvasBackground = (value: unknown) => (
  typeof value === 'string' && value.trim().toLowerCase() === editorCanvasBackgroundColor
);

const isDarkFilteredEditorCanvasBackground = (value: unknown) => (
  typeof value === 'string' && value.trim().toLowerCase() === excalidrawDarkFilteredEditorBackgroundColor
);

const getExcalidrawRuntimeAppState = (appState: RestoredExcalidrawData['appState'], theme: 'light' | 'dark') => {
  const runtimeAppState = { ...appState };
  // Excalidraw dark mode applies invert(93%) hue-rotate(180deg) to canvas pixels.
  // Feed it the pre-filtered equivalent so the visible canvas matches CodeMirror.
  if (theme === 'dark' && isEditorCanvasBackground(runtimeAppState.viewBackgroundColor)) {
    runtimeAppState.viewBackgroundColor = excalidrawDarkFilteredEditorBackgroundColor;
  }
  return runtimeAppState;
};

const getExcalidrawStoredAppState = (appState: Parameters<typeof serializeExcalidrawAsJSON>[1]) => {
  const storedAppState = { ...appState };
  if (isDarkFilteredEditorCanvasBackground(storedAppState.viewBackgroundColor)) {
    storedAppState.viewBackgroundColor = editorCanvasBackgroundColor;
  }
  return storedAppState;
};

const formatDrawingTimestamp = (date: Date) => {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    '.',
    pad(date.getMinutes()),
    '.',
    pad(date.getSeconds()),
  ].join('');
};

const parseExcalidrawStoredData = (content: string): RestoredExcalidrawData => {
  try {
    const parsed = content ? JSON.parse(content) as Record<string, unknown> : {};
    const elements = Array.isArray(parsed.elements) ? parsed.elements as any : [];
    return restoreExcalidrawData(
      {
        elements,
        appState: getExcalidrawAppStateWithEditorBackground(parsed.appState) as any,
        files: parsed.files && typeof parsed.files === 'object' ? parsed.files as any : {},
      },
      { viewBackgroundColor: editorCanvasBackgroundColor },
      null,
    );
  } catch {
    return restoreExcalidrawData(
      { elements: [], appState: { viewBackgroundColor: editorCanvasBackgroundColor }, files: {} },
      { viewBackgroundColor: editorCanvasBackgroundColor },
      null,
    );
  }
};

const parseExcalidrawInitialData = (content: string, theme: 'light' | 'dark'): RestoredExcalidrawData => {
  const storedData = parseExcalidrawStoredData(content);
  return {
    ...storedData,
    appState: getExcalidrawRuntimeAppState(storedData.appState, theme),
  };
};

const serializeExcalidrawScene = ([elements, appState, files]: Parameters<ExcalidrawChangeHandler>) => (
  serializeExcalidrawAsJSON(elements, getExcalidrawStoredAppState(appState), files, 'local')
);

const serializeRestoredExcalidrawData = (data: RestoredExcalidrawData) => (
  serializeExcalidrawAsJSON(data.elements, getExcalidrawStoredAppState(data.appState), data.files, 'local')
);

function normalizeExcalidrawContent(content: string) {
  return serializeRestoredExcalidrawData(parseExcalidrawStoredData(content));
}

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

const createRootNode = (name: string): TreeNode => ({
  id: 'root',
  name,
  path: '',
  type: 'directory',
  children: [],
});

const isIgnoredExplorerPath = (path: string) =>
  path.split('/').filter(Boolean).some(part => part === '.obsidian' || part === '.DS_Store');

const ensureDirectory = (root: TreeNode, directoryPath: string) => {
  let current = root;
  let currentPath = '';
  for (const part of directoryPath.split('/').filter(Boolean)) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    let child = current.children.find(item => item.path === currentPath && item.type === 'directory');
    if (!child) {
      child = {
        id: `directory:${currentPath}`,
        name: part,
        path: currentPath,
        type: 'directory',
        children: [],
      };
      current.children.push(child);
    }
    current = child;
  }
  return current;
};

const insertPath = (root: TreeNode, path: string, type: TreeNode['type'], data: Partial<TreeNode> = {}) => {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return root;
  const parent = ensureDirectory(root, parts.slice(0, -1).join('/'));
  const existing = parent.children.find(item => item.path === path);
  if (existing) {
    Object.assign(existing, data, { type });
    return existing;
  }
  const node: TreeNode = {
    id: `${type}:${path}`,
    name: parts[parts.length - 1],
    path,
    type,
    children: [],
    ...data,
  };
  parent.children.push(node);
  return node;
};

const sortTree = (node: TreeNode) => {
  node.children.sort((left, right) => {
    if (left.type !== right.type) {
      if (left.type === 'directory') return -1;
      if (right.type === 'directory') return 1;
      if (left.type === 'file') return -1;
      if (right.type === 'file') return 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
  node.children.forEach(sortTree);
  return node;
};

const collectTreePaths = (node: TreeNode, paths = new Set<string>()) => {
  if (node.path) paths.add(node.path.toLowerCase());
  node.children.forEach(child => collectTreePaths(child, paths));
  return paths;
};

const createUniquePath = (directoryPath: string, baseName: string, extension: string, existingPaths: Set<string>) => {
  const firstPath = joinRelativePath(directoryPath, `${baseName}${extension}`);
  if (!existingPaths.has(firstPath.toLowerCase())) return firstPath;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = joinRelativePath(directoryPath, `${baseName} ${index}${extension}`);
    if (!existingPaths.has(candidate.toLowerCase())) return candidate;
  }
  return joinRelativePath(directoryPath, `${baseName} ${Date.now()}${extension}`);
};

const buildCodeTree = (directories: Record<string, EditorEntry[]>, rootName: string) => {
  const root = createRootNode(rootName);
  Object.keys(directories).forEach(path => {
    if (!isIgnoredExplorerPath(path)) ensureDirectory(root, path);
  });
  Object.values(directories).flat().forEach(entry => {
    if (isIgnoredExplorerPath(entry.path)) return;
    insertPath(root, entry.path, entry.type, {
      entry,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
    });
  });
  return sortTree(root);
};

const buildNotesTree = (index: VaultIndexResult | undefined, rootName: string) => {
  const root = createRootNode(rootName);
  for (const note of index?.notes ?? []) {
    if (isIgnoredExplorerPath(note.path)) continue;
    insertPath(root, note.path, 'file', {
      note,
      mediaType: 'markdown',
      size: note.size,
      mtimeMs: note.mtimeMs,
    });
  }
  for (const attachment of index?.attachments ?? []) {
    if (isIgnoredExplorerPath(attachment.path)) continue;
    insertPath(root, attachment.path, 'file', {
      attachment,
      mediaType: attachment.mediaType,
      size: attachment.size,
      mtimeMs: attachment.mtimeMs,
    });
  }
  return sortTree(root);
};

const filterTree = (node: TreeNode, query: string, isRoot = false): TreeNode | undefined => {
  const lowerQuery = query.trim().toLowerCase();
  if (!lowerQuery) return node;
  const children = node.children
    .map(child => filterTree(child, query))
    .filter((child): child is TreeNode => Boolean(child));
  const matches = node.name.toLowerCase().includes(lowerQuery)
    || node.path.toLowerCase().includes(lowerQuery)
    || node.note?.title.toLowerCase().includes(lowerQuery)
    || node.note?.tags.some(tag => tag.toLowerCase().includes(lowerQuery));
  if (isRoot || matches || children.length > 0) return { ...node, children };
  return undefined;
};

const formatBytes = (value: number | undefined) => {
  if (value === undefined) return 'Unknown';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDate = (value: number | undefined) => value === undefined ? 'Unknown' : new Date(value).toLocaleString();

const PropertyRow = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="grid gap-1">
    <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className="min-w-0 text-xs text-foreground">{children}</div>
  </div>
);

type SortableEditorTabProps = {
  canClose: boolean;
  isDirty: boolean;
  isRenaming: boolean;
  isSelected: boolean;
  icon: ReactNode;
  label: string;
  onClose: () => void;
  onRename: () => void;
  onSelect: () => void;
  renameInput?: ReactNode;
  tab: EditorTab;
};

const SortableEditorTab = ({
  canClose,
  isDirty,
  isRenaming,
  isSelected,
  icon,
  label,
  onClose,
  onRename,
  onSelect,
  renameInput,
  tab,
}: SortableEditorTabProps) => {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
  const { role: _sortableRole, ...sortableAttributes } = attributes;
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'relative -ml-px flex h-7 min-w-36 max-w-64 shrink-0 items-center overflow-hidden rounded-t-md rounded-b-none border border-b-0 text-xs first:ml-0',
        isSelected
          ? 'z-10 border-primary/40 bg-primary/10 text-foreground'
          : 'z-0 border-border bg-transparent text-muted-foreground hover:z-10 hover:bg-primary/5 hover:text-foreground',
        isDragging && 'z-20 opacity-90 shadow-lg',
      )}
      style={style}
      data-weave-editor-tab={tab.path}
    >
      {isRenaming ? (
        <div className="min-w-0 flex-1 px-1">{renameInput}</div>
      ) : (
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="flex h-full min-w-0 flex-1 cursor-grab items-center overflow-hidden px-2 text-left active:cursor-grabbing"
          role="tab"
          aria-selected={isSelected}
          title={tab.path}
          style={{ touchAction: 'none' }}
          onClick={onSelect}
          onDoubleClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onRename();
          }}
          {...sortableAttributes}
          {...listeners}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
            <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl] [text-align:left]">
              <span className="[direction:ltr] [unicode-bidi:isolate]">
                {label}
              </span>
            </span>
            <span
              className={cn('h-1.5 w-1.5 shrink-0 rounded-full', isDirty ? 'bg-mauve' : 'bg-transparent')}
              aria-hidden="true"
            />
          </span>
        </button>
      )}
      {canClose ? (
        <button
          type="button"
          className="grid h-7 w-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
          aria-label={`Close ${label}`}
          onClick={event => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X size={12} />
        </button>
      ) : null}
    </div>
  );
};

export const UnifiedEditorPanel = ({
  followRequest,
  focusRequest = 0,
  isExpanded,
  mode,
  onExpandedChange,
  onHide,
  target,
}: UnifiedEditorPanelProps) => {
  const codeBackend = useMemo(() => createEditorBackend(), []);
  const vaultBackend = useMemo(() => createVaultBackend(), []);
  const editorTarget = useMemo<EditorTarget>(() => ({
    projectId: target.projectId,
    workspaceId: target.workspaceId,
    portalId: target.portalId,
    rootId: target.rootId,
    repoPath: target.repoPath,
    workspacePath: target.workspacePath,
  }), [target.portalId, target.projectId, target.repoPath, target.rootId, target.workspaceId, target.workspacePath]);
  const vaultTarget = editorTarget as VaultTarget;
  const editorTabTargetKey = useMemo(() => (
    getEditorTabTargetKey(mode, target.projectId, target.workspaceId)
  ), [mode, target.projectId, target.workspaceId]);
  const editorTabSet = useEditorTabStore(state => state.editorTabsByTarget[editorTabTargetKey]);
  const editorTabs = editorTabSet?.tabs ?? [];
  const activeEditorTabId = editorTabSet?.activeTabId;
  const closePersistedEditorTab = useEditorTabStore(state => state.closeEditorTab);
  const openPersistedEditorTab = useEditorTabStore(state => state.openEditorTab);
  const renamePersistedEditorTab = useEditorTabStore(state => state.renameEditorTab);
  const reorderEditorTabs = useEditorTabStore(state => state.reorderEditorTabs);
  const setActiveEditorTab = useEditorTabStore(state => state.setActiveEditorTab);
  const setPersistedEditorTabs = useEditorTabStore(state => state.setEditorTabs);
  const resolvedTheme = getResolvedTheme(useThemeStore(state => state.mode));
  const editorRef = useRef<CodeMirrorEditorHandle | null>(null);
  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const skippedInitialExcalidrawChangeKeyRef = useRef<string | undefined>(undefined);
  const excalidrawResizeFrameRef = useRef<number | undefined>(undefined);
  const excalidrawResizeTimeoutRef = useRef<number | undefined>(undefined);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const explorerSlideOverCloseTimeoutRef = useRef<number | undefined>(undefined);
  const fileOpenClickTimeoutRef = useRef<number | undefined>(undefined);
  const renameCommitInFlightRef = useRef(false);
  const renameCancelRef = useRef(false);
  const pendingRevealRef = useRef<{ requestId: number; path: string; line: number } | undefined>(
    undefined,
  );
  const handledFollowRequestIdRef = useRef<number | undefined>(undefined);
  const [editorBodyRef, editorBodyWidth] = useMeasuredElementWidth<HTMLDivElement>(typeof window === 'undefined' ? 0 : window.innerWidth);
  const [columnMeasureRef, minimumMainEditorWidthPx] = useMeasuredElementWidth<HTMLSpanElement>(defaultMinimumMainEditorWidthPx);
  const [activeTab, setActiveTab] = useState<ExplorerTab>('explorer');
  const [query, setQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set(['']));
  const [codeDirectories, setCodeDirectories] = useState<Record<string, EditorEntry[]>>({});
  const [vaultIndex, setVaultIndex] = useState<VaultIndexResult>();
  const [selectedNode, setSelectedNode] = useState<TreeNode>();
  const [buffersByTabId, setBuffersByTabId] = useState<Record<string, EditorBuffer | undefined>>({});
  const [failedBufferTabIds, setFailedBufferTabIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string>();
  const [isExplorerLoading, setIsExplorerLoading] = useState(false);
  const [isFileLoading, setIsFileLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isExplorerVisible, setIsExplorerVisible] = useState(true);
  const [isExplorerSlideOverOpen, setIsExplorerSlideOverOpen] = useState(false);
  const [vimMode, setVimMode] = useState<VimMode>('normal');
  const [createPathDialog, setCreatePathDialog] = useState<CreatePathDialogState>();
  const [renameState, setRenameState] = useState<RenameState>();
  const [bufferFocusRequest, setBufferFocusRequest] = useState(0);
  const activeEditorTab = editorTabs.find(tab => tab.id === activeEditorTabId) ?? editorTabs[0];
  const openBuffer = activeEditorTab ? buffersByTabId[activeEditorTab.id] : undefined;
  const activePath = openBuffer?.path ?? activeEditorTab?.path;
  const content = openBuffer?.value ?? '';
  const isDirty = getBufferDirty(openBuffer);
  const hasDirtyBuffers = Object.values(buffersByTabId).some(getBufferDirty);
  const shouldPersistExplorerOpen = !activeEditorTab;
  const canDockExplorer = editorBodyWidth - explorerRailWidthPx >= minimumMainEditorWidthPx;
  const isExplorerSlideOverMode = !canDockExplorer;
  const isExplorerDocked = (isExplorerVisible || shouldPersistExplorerOpen) && canDockExplorer;
  const isExplorerSlideOverVisible = isExplorerSlideOverMode && (isExplorerSlideOverOpen || shouldPersistExplorerOpen);
  const isExplorerActive = isExplorerDocked || isExplorerSlideOverVisible;
  const modeIndicator = editorModeIndicatorStyles[vimMode];
  const statusLabel = isSaving ? 'saving' : isFileLoading ? 'loading' : undefined;
  const activeNote = activePath
    ? vaultIndex?.notes.find(note => note.path === activePath)
    : selectedNode?.note;
  const activeAttachment = activePath
    ? vaultIndex?.attachments.find(attachment => attachment.path === activePath)
    : selectedNode?.attachment;
  const activeBacklinks = activeNote ? vaultIndex?.backlinks[activeNote.path] ?? [] : [];
  const excalidrawInitialData = useMemo(() => {
    if (!openBuffer || mode !== 'notes' || !isExcalidrawPath(openBuffer.path)) return undefined;
    return parseExcalidrawInitialData(openBuffer.value, resolvedTheme);
  }, [mode, openBuffer?.path, openBuffer?.version, resolvedTheme]);
  const excalidrawBufferKey = openBuffer && mode === 'notes' && isExcalidrawPath(openBuffer.path)
    ? `${openBuffer.path}:${openBuffer.version}`
    : undefined;
  const excalidrawInitialSerialized = useMemo(() => (
    excalidrawInitialData ? serializeRestoredExcalidrawData(excalidrawInitialData) : undefined
  ), [excalidrawInitialData]);
  const excalidrawViewBackgroundColor = excalidrawInitialData?.appState.viewBackgroundColor ?? editorCanvasBackgroundColor;

  const tree = useMemo(() => (
    mode === 'code'
      ? buildCodeTree(codeDirectories, target.workspaceName)
      : buildNotesTree(vaultIndex, target.projectName)
  ), [codeDirectories, mode, target.projectName, target.workspaceName, vaultIndex]);
  const visibleTree = useMemo(() => filterTree(tree, query, true) ?? tree, [query, tree]);
  const existingExplorerPaths = useMemo(() => collectTreePaths(tree), [tree]);
  const noteSuggestions = useMemo(() => (vaultIndex?.notes ?? []).map(note => ({
    target: note.path.replace(/\.(md|markdown)$/i, ''),
    label: getNoteFileDisplayName(note.path),
    detail: note.title && note.title !== getNoteFileDisplayName(note.path) ? `${note.path} · ${note.title}` : note.path,
  })), [vaultIndex?.notes]);
  const editorTabSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 5 } }),
  );

  const confirmDiscardBuffer = useCallback((buffer: EditorBuffer | undefined, label = 'this file') => (
    !getBufferDirty(buffer) || window.confirm(`Discard unsaved changes to ${label}?`)
  ), []);

  const confirmDiscardAllDirty = useCallback(() => (
    !hasDirtyBuffers || window.confirm('Discard unsaved editor changes?')
  ), [hasDirtyBuffers]);

  const updateBuffer = useCallback((tabId: string, updater: (buffer: EditorBuffer) => EditorBuffer) => {
    setBuffersByTabId(current => {
      const buffer = current[tabId];
      if (!buffer) return current;
      const nextBuffer = updater(buffer);
      if (nextBuffer === buffer) return current;
      return { ...current, [tabId]: nextBuffer };
    });
  }, []);

  const setActiveBufferValue = useCallback((value: string) => {
    if (!activeEditorTab) return;
    updateBuffer(activeEditorTab.id, buffer => (
      value === buffer.value ? buffer : withBufferValue(buffer, value)
    ));
  }, [activeEditorTab, updateBuffer]);

  const scheduleExcalidrawResize = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (excalidrawResizeFrameRef.current !== undefined) window.cancelAnimationFrame(excalidrawResizeFrameRef.current);
    if (excalidrawResizeTimeoutRef.current !== undefined) window.clearTimeout(excalidrawResizeTimeoutRef.current);

    const notifyResize = () => window.dispatchEvent(new Event('resize'));
    excalidrawResizeFrameRef.current = window.requestAnimationFrame(() => {
      excalidrawResizeFrameRef.current = undefined;
      notifyResize();
    });
    excalidrawResizeTimeoutRef.current = window.setTimeout(() => {
      excalidrawResizeTimeoutRef.current = undefined;
      notifyResize();
    }, 180);
  }, []);

  const handleExcalidrawApi = useCallback((api: ExcalidrawImperativeAPI) => {
    excalidrawApiRef.current = api;
    scheduleExcalidrawResize();
  }, [scheduleExcalidrawResize]);

  useEffect(() => {
    if (!excalidrawBufferKey) return;
    excalidrawApiRef.current?.updateScene({
      appState: { viewBackgroundColor: excalidrawViewBackgroundColor },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, [excalidrawBufferKey, excalidrawViewBackgroundColor]);

  const handleExcalidrawChange = useCallback((...snapshot: Parameters<ExcalidrawChangeHandler>) => {
    const serializedScene = serializeExcalidrawScene(snapshot);
    if (excalidrawBufferKey && skippedInitialExcalidrawChangeKeyRef.current !== excalidrawBufferKey) {
      skippedInitialExcalidrawChangeKeyRef.current = excalidrawBufferKey;
      if (serializedScene === excalidrawInitialSerialized) return;
    }
    setActiveBufferValue(serializedScene);
  }, [excalidrawBufferKey, excalidrawInitialSerialized, setActiveBufferValue]);

  const focusEditorSurface = useCallback(() => {
    if (mode === 'notes' && isExcalidrawPath(openBuffer?.path)) {
      const fallbackTarget = editorBodyRef.current;
      const focusTarget = fallbackTarget?.querySelector<HTMLElement>('[contenteditable="true"], textarea, input, canvas, .excalidraw') ?? fallbackTarget;
      focusTarget?.focus({ preventScroll: true });
      scheduleExcalidrawResize();
      return;
    }

    editorRef.current?.focus();
  }, [editorBodyRef, mode, openBuffer?.path, scheduleExcalidrawResize]);

  const revealLineWithoutFocus = useCallback((line: number) => {
    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        editorRef.current?.revealLine(line, { focus: false });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, []);

  const clearExplorerSlideOverCloseTimeout = useCallback(() => {
    if (explorerSlideOverCloseTimeoutRef.current === undefined) return;
    window.clearTimeout(explorerSlideOverCloseTimeoutRef.current);
    explorerSlideOverCloseTimeoutRef.current = undefined;
  }, []);

  const closeExplorerSlideOver = useCallback(() => {
    clearExplorerSlideOverCloseTimeout();
    setIsExplorerSlideOverOpen(false);
  }, [clearExplorerSlideOverCloseTimeout]);

  const clearPendingFileOpen = useCallback(() => {
    if (fileOpenClickTimeoutRef.current === undefined) return;
    window.clearTimeout(fileOpenClickTimeoutRef.current);
    fileOpenClickTimeoutRef.current = undefined;
  }, []);

  const openExplorerSlideOver = useCallback(() => {
    if (!isExplorerSlideOverMode) return;
    clearExplorerSlideOverCloseTimeout();
    setIsExplorerSlideOverOpen(true);
  }, [clearExplorerSlideOverCloseTimeout, isExplorerSlideOverMode]);

  const scheduleExplorerSlideOverClose = useCallback(() => {
    if (!isExplorerSlideOverMode || shouldPersistExplorerOpen) return;
    clearExplorerSlideOverCloseTimeout();
    explorerSlideOverCloseTimeoutRef.current = window.setTimeout(() => {
      explorerSlideOverCloseTimeoutRef.current = undefined;
      setIsExplorerSlideOverOpen(false);
    }, explorerSlideOverCloseDelayMs);
  }, [clearExplorerSlideOverCloseTimeout, isExplorerSlideOverMode, shouldPersistExplorerOpen]);

  const toggleExplorerRail = useCallback(() => {
    if (isExplorerSlideOverMode) {
      clearExplorerSlideOverCloseTimeout();
      setIsExplorerSlideOverOpen(open => !open);
      return;
    }
    setIsExplorerVisible(visible => !visible);
  }, [clearExplorerSlideOverCloseTimeout, isExplorerSlideOverMode]);

  const handleHidePanel = useCallback(() => {
    if (!confirmDiscardAllDirty()) return;
    onHide();
  }, [confirmDiscardAllDirty, onHide]);

  const startRename = useCallback((path: string, origin: RenameState['origin']) => {
    if (!path) return;
    clearPendingFileOpen();
    setError(undefined);
    renameCancelRef.current = false;
    setRenameState({ path, value: getRenameDisplayName(path, mode), origin });
  }, [clearPendingFileOpen, mode]);

  const refreshVaultIndex = useCallback(async () => {
    setIsExplorerLoading(true);
    setError(undefined);
    try {
      setVaultIndex(await vaultBackend.index(vaultTarget));
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    } finally {
      setIsExplorerLoading(false);
    }
  }, [vaultBackend, vaultTarget]);

  const loadCodeDirectory = useCallback(async (path: string) => {
    setIsExplorerLoading(true);
    setError(undefined);
    try {
      const result = await codeBackend.list(editorTarget, path);
      setCodeDirectories(current => ({ ...current, [result.path]: result.entries }));
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    } finally {
      setIsExplorerLoading(false);
    }
  }, [codeBackend, editorTarget]);

  const refreshExplorer = useCallback(async () => {
    setIsExplorerLoading(true);
    setError(undefined);
    try {
      if (mode === 'notes') {
        setVaultIndex(await vaultBackend.index(vaultTarget));
        return;
      }

      const paths = Array.from(expandedPaths);
      const results = await Promise.all(paths.map(path => codeBackend.list(editorTarget, path)));
      setCodeDirectories(Object.fromEntries(results.map(result => [result.path, result.entries])));
    } catch (refreshError) {
      setError(toErrorMessage(refreshError));
    } finally {
      setIsExplorerLoading(false);
    }
  }, [codeBackend, editorTarget, expandedPaths, mode, vaultBackend, vaultTarget]);

  const loadFile = useCallback(async (path: string, options: { focusEditor?: boolean } = {}) => {
    if (mode === 'notes' && !isNotesOpenablePath(path)) return false;

    const existingTab = editorTabs.find(tab => tab.path === path);
    if (existingTab && buffersByTabId[existingTab.id]) {
      setActiveEditorTab(editorTabTargetKey, existingTab.id);
      if (options.focusEditor ?? true) setBufferFocusRequest(request => request + 1);
      return true;
    }

    const tab = existingTab ?? openPersistedEditorTab(editorTabTargetKey, path);
    if (existingTab) setActiveEditorTab(editorTabTargetKey, existingTab.id);
    setFailedBufferTabIds(current => {
      if (!current.has(tab.id)) return current;
      const next = new Set(current);
      next.delete(tab.id);
      return next;
    });
    setIsFileLoading(true);
    setError(undefined);
    try {
      const file = mode === 'code'
        ? await codeBackend.read(editorTarget, path)
        : await vaultBackend.read(vaultTarget, path);
      const mediaType = mode === 'notes'
        ? isExcalidrawPath(file.path) ? 'excalidraw' : 'markdown'
        : undefined;
      const loadedBuffer = createLoadedBuffer(file, mediaType);
      const loadedTab = file.path === tab.path ? tab : openPersistedEditorTab(editorTabTargetKey, file.path);
      setBuffersByTabId(current => {
        const next = { ...current, [loadedTab.id]: loadedBuffer };
        if (loadedTab.id !== tab.id) delete next[tab.id];
        return next;
      });
      setFailedBufferTabIds(current => {
        if (!current.has(loadedTab.id) && !current.has(tab.id)) return current;
        const next = new Set(current);
        next.delete(loadedTab.id);
        next.delete(tab.id);
        return next;
      });
      if (options.focusEditor ?? true) setBufferFocusRequest(request => request + 1);
      return true;
    } catch (loadError) {
      setError(toErrorMessage(loadError));
      setFailedBufferTabIds(current => new Set(current).add(tab.id));
      if (!existingTab) closePersistedEditorTab(editorTabTargetKey, tab.id);
      return false;
    } finally {
      setIsFileLoading(false);
    }
  }, [
    buffersByTabId,
    closePersistedEditorTab,
    codeBackend,
    editorTabTargetKey,
    editorTabs,
    editorTarget,
    mode,
    openPersistedEditorTab,
    setActiveEditorTab,
    vaultBackend,
    vaultTarget,
  ]);

  useEffect(() => {
    configureExcalidrawAssetPath();
  }, []);

  useEffect(() => {
    if (mode === 'notes' && isExcalidrawPath(openBuffer?.path)) scheduleExcalidrawResize();
  }, [isExpanded, mode, openBuffer?.path, scheduleExcalidrawResize]);

  useEffect(() => () => {
    if (typeof window === 'undefined') return;
    if (excalidrawResizeFrameRef.current !== undefined) window.cancelAnimationFrame(excalidrawResizeFrameRef.current);
    if (excalidrawResizeTimeoutRef.current !== undefined) window.clearTimeout(excalidrawResizeTimeoutRef.current);
    if (fileOpenClickTimeoutRef.current !== undefined) window.clearTimeout(fileOpenClickTimeoutRef.current);
  }, []);

  useEffect(() => {
    clearPendingFileOpen();
    setQuery('');
    setExpandedPaths(new Set(['']));
    setCodeDirectories({});
    setVaultIndex(undefined);
    setSelectedNode(undefined);
    setBuffersByTabId({});
    setFailedBufferTabIds(new Set());
    setError(undefined);
    setVimMode('normal');
    setBufferFocusRequest(0);
  }, [clearPendingFileOpen, mode, target.projectId, target.workspaceId]);

  useEffect(() => {
    if (activeEditorTabId || editorTabs.length === 0) return;
    setActiveEditorTab(editorTabTargetKey, editorTabs[0].id);
  }, [activeEditorTabId, editorTabTargetKey, editorTabs, setActiveEditorTab]);

  useEffect(() => {
    if (!activeEditorTab) return;
    if (buffersByTabId[activeEditorTab.id]) return;
    if (failedBufferTabIds.has(activeEditorTab.id)) return;
    void loadFile(activeEditorTab.path, { focusEditor: false });
  }, [activeEditorTab, buffersByTabId, failedBufferTabIds, loadFile]);

  useEffect(() => {
    if (mode === 'code') {
      void loadCodeDirectory('');
      return;
    }
    void refreshVaultIndex();
  }, [loadCodeDirectory, mode, refreshVaultIndex]);

  useEffect(() => {
    if (focusRequest === 0) return undefined;
    const animationFrame = window.requestAnimationFrame(focusEditorSurface);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusEditorSurface, focusRequest]);

  useEffect(() => {
    if (bufferFocusRequest === 0 || !openBuffer) return undefined;

    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(focusEditorSurface);
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, [bufferFocusRequest, focusEditorSurface, openBuffer?.path]);

  useEffect(() => {
    if (!followRequest || mode !== 'code' || followRequest.workspaceId !== target.workspaceId) return;
    if (handledFollowRequestIdRef.current === followRequest.id) return;
    handledFollowRequestIdRef.current = followRequest.id;

    const requestedLine = Number.isFinite(followRequest.line) ? Math.floor(followRequest.line) : 1;
    const line = Math.max(1, requestedLine);
    pendingRevealRef.current = { requestId: followRequest.id, path: followRequest.path, line };

    if (openBuffer?.path === followRequest.path) {
      const cancelReveal = revealLineWithoutFocus(line);
      pendingRevealRef.current = undefined;
      return cancelReveal;
    }

    void loadFile(followRequest.path, { focusEditor: false }).then(loaded => {
      if (!loaded && pendingRevealRef.current?.requestId === followRequest.id) {
        pendingRevealRef.current = undefined;
      }
    });
  }, [followRequest, loadFile, mode, openBuffer?.path, revealLineWithoutFocus, target.workspaceId]);

  useEffect(() => {
    const pendingReveal = pendingRevealRef.current;
    if (!pendingReveal || openBuffer?.path !== pendingReveal.path) return undefined;

    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        editorRef.current?.revealLine(pendingReveal.line, { focus: false });
        if (pendingRevealRef.current?.requestId === pendingReveal.requestId) {
          pendingRevealRef.current = undefined;
        }
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, [content, openBuffer?.path]);

  useEffect(() => {
    if (canDockExplorer) closeExplorerSlideOver();
  }, [canDockExplorer, closeExplorerSlideOver]);

  useEffect(() => () => clearExplorerSlideOverCloseTimeout(), [clearExplorerSlideOverCloseTimeout]);

  const toggleDirectory = useCallback((path: string) => {
    setExpandedPaths(current => {
      const next = new Set(current);
      if (next.has(path)) {
        if (path) next.delete(path);
      } else {
        next.add(path);
        if (mode === 'code' && codeDirectories[path] === undefined) void loadCodeDirectory(path);
      }
      return next;
    });
  }, [codeDirectories, loadCodeDirectory, mode]);

  const handleNodeClick = useCallback((node: TreeNode, clickDetail = 1) => {
    setSelectedNode(node);
    if (node.type === 'directory') {
      clearPendingFileOpen();
      toggleDirectory(node.path);
      return;
    }
    if (node.type === 'file' && (mode === 'code' || isNotesOpenablePath(node.path))) {
      if (clickDetail > 1) {
        startRename(node.path, 'explorer');
        return;
      }

      clearPendingFileOpen();
      fileOpenClickTimeoutRef.current = window.setTimeout(() => {
        fileOpenClickTimeoutRef.current = undefined;
        void loadFile(node.path);
        if (isExplorerSlideOverMode) closeExplorerSlideOver();
      }, explorerFileOpenSingleClickDelayMs);
    }
  }, [clearPendingFileOpen, closeExplorerSlideOver, isExplorerSlideOverMode, loadFile, mode, startRename, toggleDirectory]);

  const handleNodeDoubleClick = useCallback((node: TreeNode) => {
    if (node.type !== 'file' || (mode !== 'code' && !isNotesOpenablePath(node.path))) return;
    startRename(node.path, 'explorer');
  }, [mode, startRename]);

  const handleSave = useCallback(async () => {
    if (!openBuffer || !activeEditorTab || !isDirty) return;
    setIsSaving(true);
    setError(undefined);
    try {
      const result = mode === 'code'
        ? await codeBackend.write(editorTarget, openBuffer.path, openBuffer.value, openBuffer.version)
        : await vaultBackend.write(vaultTarget, openBuffer.path, openBuffer.value, openBuffer.version);
      const nextBuffer: EditorBuffer = {
        ...openBuffer,
        path: result.path,
        content: openBuffer.value,
        value: openBuffer.value,
        version: result.version,
        size: result.size,
        mtimeMs: result.mtimeMs,
        dirty: false,
      };
      const nextTabId = getEditorTabId(editorTabTargetKey, result.path);
      if (result.path !== openBuffer.path) renamePersistedEditorTab(editorTabTargetKey, openBuffer.path, result.path);
      setBuffersByTabId(current => {
        const next = { ...current, [nextTabId]: nextBuffer };
        if (nextTabId !== activeEditorTab.id) delete next[activeEditorTab.id];
        return next;
      });
      await refreshExplorer();
    } catch (saveError) {
      setError(toErrorMessage(saveError));
    } finally {
      setIsSaving(false);
    }
  }, [activeEditorTab, codeBackend, editorTabTargetKey, editorTarget, isDirty, mode, openBuffer, refreshExplorer, renamePersistedEditorTab, vaultBackend, vaultTarget]);

  const handleReload = useCallback(async () => {
    if (!openBuffer || !activeEditorTab || !confirmDiscardBuffer(openBuffer, openBuffer.path)) return;
    setIsFileLoading(true);
    setError(undefined);
    try {
      const file = mode === 'code'
        ? await codeBackend.read(editorTarget, openBuffer.path)
        : await vaultBackend.read(vaultTarget, openBuffer.path);
      const mediaType = mode === 'notes'
        ? isExcalidrawPath(file.path) ? 'excalidraw' : 'markdown'
        : undefined;
      const nextBuffer = createLoadedBuffer(file, mediaType);
      const nextTabId = getEditorTabId(editorTabTargetKey, file.path);
      if (file.path !== openBuffer.path) renamePersistedEditorTab(editorTabTargetKey, openBuffer.path, file.path);
      setBuffersByTabId(current => {
        const next = { ...current, [nextTabId]: nextBuffer };
        if (nextTabId !== activeEditorTab.id) delete next[activeEditorTab.id];
        return next;
      });
      setBufferFocusRequest(request => request + 1);
    } catch (reloadError) {
      setError(toErrorMessage(reloadError));
    } finally {
      setIsFileLoading(false);
    }
  }, [activeEditorTab, codeBackend, confirmDiscardBuffer, editorTabTargetKey, editorTarget, mode, openBuffer, renamePersistedEditorTab, vaultBackend, vaultTarget]);

  const cancelRename = useCallback(() => {
    renameCancelRef.current = true;
    setRenameState(undefined);
  }, []);

  const commitRename = useCallback(async () => {
    if (renameCancelRef.current) {
      renameCancelRef.current = false;
      return;
    }
    if (renameCommitInFlightRef.current) return;
    if (!renameState) return;

    const sourcePath = renameState.path;
    const fileName = normalizeRenameFileName(renameState.value, sourcePath, mode);
    if (!fileName) {
      setError('Enter a file name without folder separators.');
      return;
    }

    const targetPath = joinRelativePath(getParentPath(sourcePath), fileName);
    if (targetPath === sourcePath) {
      renameCancelRef.current = true;
      setRenameState(undefined);
      return;
    }

    setError(undefined);
    renameCommitInFlightRef.current = true;
    try {
      const sourceTab = editorTabs.find(tab => tab.path === sourcePath);
      const sourceBuffer = sourceTab ? buffersByTabId[sourceTab.id] : undefined;
      if (mode === 'code') await codeBackend.move(editorTarget, sourcePath, targetPath);
      else await vaultBackend.move(vaultTarget, sourcePath, targetPath);

      setSelectedNode(undefined);
      if (sourceTab) {
        if (mode === 'code' || isNotesOpenablePath(targetPath)) {
          const targetTabId = getEditorTabId(editorTabTargetKey, targetPath);
          renamePersistedEditorTab(editorTabTargetKey, sourcePath, targetPath);
          const mediaType = mode === 'notes' ? isExcalidrawPath(targetPath) ? 'excalidraw' : 'markdown' : undefined;
          if (sourceBuffer && getBufferDirty(sourceBuffer)) {
            setBuffersByTabId(current => {
              const next = {
                ...current,
                [targetTabId]: {
                  ...sourceBuffer,
                  path: targetPath,
                  mediaType,
                  dirty: true,
                },
              };
              delete next[sourceTab.id];
              return next;
            });
          } else {
            const file = mode === 'code'
              ? await codeBackend.read(editorTarget, targetPath)
              : await vaultBackend.read(vaultTarget, targetPath);
            setBuffersByTabId(current => {
              const next = {
                ...current,
                [targetTabId]: createLoadedBuffer(file, mediaType),
              };
              delete next[sourceTab.id];
              return next;
            });
          }
        } else {
          closePersistedEditorTab(editorTabTargetKey, sourceTab.id);
          setBuffersByTabId(current => {
            const next = { ...current };
            delete next[sourceTab.id];
            return next;
          });
        }
      } else if (openBuffer?.path === sourcePath && (mode === 'code' || isNotesOpenablePath(targetPath))) {
          const file = mode === 'code'
            ? await codeBackend.read(editorTarget, targetPath)
            : await vaultBackend.read(vaultTarget, targetPath);
          const tab = openPersistedEditorTab(editorTabTargetKey, file.path);
          setBuffersByTabId(current => ({
            ...current,
            [tab.id]: createLoadedBuffer(file, mode === 'notes' ? isExcalidrawPath(file.path) ? 'excalidraw' : 'markdown' : undefined),
          }));
      }

      setExpandedPaths(current => new Set([...current, getParentPath(targetPath)]));
      renameCancelRef.current = true;
      setRenameState(undefined);
      await refreshExplorer();
    } catch (renameError) {
      setError(toErrorMessage(renameError));
    } finally {
      renameCommitInFlightRef.current = false;
    }
  }, [
    buffersByTabId,
    closePersistedEditorTab,
    codeBackend,
    editorTabTargetKey,
    editorTabs,
    editorTarget,
    mode,
    openBuffer?.path,
    openPersistedEditorTab,
    refreshExplorer,
    renamePersistedEditorTab,
    renameState,
    vaultBackend,
    vaultTarget,
  ]);

  const openCreatePathDialog = useCallback((kind: CreatePathKind) => {
    setError(undefined);
    setCreatePathDialog({ kind, value: '' });
  }, []);

  const createFile = useCallback(async (rawPath: string) => {
    const path = mode === 'notes' ? normalizeMarkdownPath(rawPath) : normalizeRelativePath(rawPath);
    if (!path) return false;

    const nextContent = '';
    setError(undefined);
    try {
      const result = mode === 'code'
        ? await codeBackend.write(editorTarget, path, nextContent)
        : await vaultBackend.write(vaultTarget, path, nextContent);
      const tab = openPersistedEditorTab(editorTabTargetKey, result.path);
      setBuffersByTabId(current => ({
        ...current,
        [tab.id]: createLoadedBuffer({
          path: result.path,
          content: nextContent,
          version: result.version,
          size: result.size,
          mtimeMs: result.mtimeMs,
        }, mode === 'notes' ? 'markdown' : undefined),
      }));
      setBufferFocusRequest(request => request + 1);
      setExpandedPaths(current => new Set([...current, getParentPath(result.path)]));
      closeExplorerSlideOver();
      await refreshExplorer();
      return true;
    } catch (createError) {
      setError(toErrorMessage(createError));
      return false;
    }
  }, [closeExplorerSlideOver, codeBackend, editorTabTargetKey, editorTarget, mode, openPersistedEditorTab, refreshExplorer, vaultBackend, vaultTarget]);

  const createDrawing = useCallback(async (rawPath: string) => {
    const path = normalizeRelativePath(rawPath);
    const drawingPath = !path ? '' : /\.excalidraw$/i.test(path) ? path : `${path}.excalidraw`;
    if (!drawingPath) return false;

    const drawingContent = createEmptyExcalidrawFile();
    setError(undefined);
    try {
      const result = await vaultBackend.write(vaultTarget, drawingPath, drawingContent);
      const tab = openPersistedEditorTab(editorTabTargetKey, result.path);
      setBuffersByTabId(current => ({
        ...current,
        [tab.id]: createLoadedBuffer({
          path: result.path,
          content: drawingContent,
          version: result.version,
          size: result.size,
          mtimeMs: result.mtimeMs,
        }, 'excalidraw'),
      }));
      setBufferFocusRequest(request => request + 1);
      setExpandedPaths(current => new Set([...current, getParentPath(result.path)]));
      closeExplorerSlideOver();
      scheduleExcalidrawResize();
      await refreshExplorer();
      return true;
    } catch (createError) {
      setError(toErrorMessage(createError));
      return false;
    }
  }, [closeExplorerSlideOver, editorTabTargetKey, openPersistedEditorTab, refreshExplorer, scheduleExcalidrawResize, vaultBackend, vaultTarget]);

  const getSelectedCreateDirectory = useCallback(() => {
    if (!selectedNode) return '';
    return selectedNode.type === 'directory' ? selectedNode.path : getParentPath(selectedNode.path);
  }, [selectedNode]);

  const createNoteInSelectedDirectory = useCallback(async () => {
    const directoryPath = getSelectedCreateDirectory();
    const path = createUniquePath(directoryPath, 'Untitled', '.md', existingExplorerPaths);
    await createFile(path);
  }, [createFile, existingExplorerPaths, getSelectedCreateDirectory]);

  const createDrawingInSelectedDirectory = useCallback(async () => {
    const directoryPath = getSelectedCreateDirectory();
    const baseName = `Drawing ${formatDrawingTimestamp(new Date())}`;
    const path = createUniquePath(directoryPath, baseName, '.excalidraw', existingExplorerPaths);
    await createDrawing(path);
  }, [createDrawing, existingExplorerPaths, getSelectedCreateDirectory]);

  const createFolder = useCallback(async (rawPath: string) => {
    const path = normalizeRelativePath(rawPath);
    if (!path) return false;
    setError(undefined);
    try {
      if (mode === 'code') await codeBackend.mkdir(editorTarget, path);
      else await vaultBackend.mkdir(vaultTarget, path);
      setExpandedPaths(current => new Set([...current, getParentPath(path)]));
      await refreshExplorer();
      return true;
    } catch (folderError) {
      setError(toErrorMessage(folderError));
      return false;
    }
  }, [codeBackend, editorTarget, mode, refreshExplorer, vaultBackend, vaultTarget]);

  const submitCreatePathDialog = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!createPathDialog?.value.trim()) return;

    const { kind, value } = createPathDialog;
    const created = kind === 'file'
      ? await createFile(value)
      : kind === 'drawing'
        ? await createDrawing(value)
        : await createFolder(value);
    if (created) setCreatePathDialog(undefined);
  }, [createDrawing, createFile, createFolder, createPathDialog]);

  const deleteSelected = useCallback(async () => {
    const sourcePath = selectedNode?.path || activePath;
    if (!sourcePath) return;
    clearPendingFileOpen();
    const isDirectory = selectedNode?.type === 'directory';
    if (!window.confirm(`Delete ${sourcePath}${isDirectory ? ' and everything inside it' : ''}?`)) return;
    const affectedTabs = editorTabs.filter(tab => tab.path === sourcePath || (isDirectory && tab.path.startsWith(`${sourcePath}/`)));
    const hasDirtyAffectedTab = affectedTabs.some(tab => getBufferDirty(buffersByTabId[tab.id]));
    if (hasDirtyAffectedTab && !window.confirm(`Discard unsaved changes in ${affectedTabs.length === 1 ? affectedTabs[0].path : 'deleted files'}?`)) return;
    setError(undefined);
    try {
      if (mode === 'code') await codeBackend.delete(editorTarget, sourcePath, isDirectory);
      else await vaultBackend.delete(vaultTarget, sourcePath, isDirectory);
      setSelectedNode(undefined);
      if (affectedTabs.length > 0) {
        const affectedTabIds = new Set(affectedTabs.map(tab => tab.id));
        setPersistedEditorTabs(editorTabTargetKey, currentTabs => currentTabs.filter(tab => !affectedTabIds.has(tab.id)));
        setBuffersByTabId(current => {
          const next = { ...current };
          affectedTabIds.forEach(tabId => {
            delete next[tabId];
          });
          return next;
        });
      }
      await refreshExplorer();
    } catch (deleteError) {
      setError(toErrorMessage(deleteError));
    }
  }, [
    activePath,
    buffersByTabId,
    clearPendingFileOpen,
    codeBackend,
    editorTabTargetKey,
    editorTabs,
    editorTarget,
    mode,
    refreshExplorer,
    selectedNode?.path,
    selectedNode?.type,
    setPersistedEditorTabs,
    vaultBackend,
    vaultTarget,
  ]);

  const uploadAttachment = useCallback(async (file: globalThis.File | undefined) => {
    if (!file || mode !== 'notes') return;
    const path = normalizeRelativePath(window.prompt('Attachment path', `attachments/${file.name}`) ?? '');
    if (!path) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const base64Content = result.includes(',') ? result.split(',').pop() ?? '' : result;
      setError(undefined);
      try {
        await vaultBackend.upload(vaultTarget, path, base64Content, file.type || undefined);
        await refreshExplorer();
      } catch (uploadError) {
        setError(toErrorMessage(uploadError));
      } finally {
        if (uploadInputRef.current) uploadInputRef.current.value = '';
      }
    };
    reader.readAsDataURL(file);
  }, [mode, refreshExplorer, vaultBackend, vaultTarget]);

  const openWikiLink = useCallback((targetPath: string) => {
    const normalized = /\.(md|markdown)$/i.test(targetPath) ? targetPath : `${targetPath}.md`;
    void loadFile(normalized);
  }, [loadFile]);

  const handleRenameChange = useCallback((value: string) => {
    setRenameState(current => current ? { ...current, value } : current);
  }, []);

  const renderRenameInput = (className?: string) => (
    <input
      autoFocus
      className={cn('h-6 min-w-0 rounded-sm border border-border bg-background px-1 text-xs font-semibold text-foreground outline-none focus:border-primary', className)}
      value={renameState?.value ?? ''}
      onBlur={() => void commitRename()}
      onChange={event => handleRenameChange(event.currentTarget.value)}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onFocus={event => event.currentTarget.select()}
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          void commitRename();
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancelRename();
        }
      }}
      onMouseDown={event => event.stopPropagation()}
    />
  );

  const renderTreeNode = (node: TreeNode, depth: number): ReactNode => {
    const isRoot = depth === -1;
    const isExpandedNode = expandedPaths.has(node.path);
    const isActive = activePath === node.path || selectedNode?.path === node.path;
    const isDirectory = node.type === 'directory';
    const isRenaming = !isDirectory && renameState?.origin === 'explorer' && renameState.path === node.path;
    if (isRoot) return node.children.map(child => renderTreeNode(child, 0));

    const rowClassName = cn(
      'group flex h-8 w-full min-w-0 items-center gap-1.5 rounded-sm pr-2 text-left text-xs text-foreground transition-colors hover:bg-accent',
      isActive && 'bg-selected-thread',
    );
    const rowStyle = { paddingLeft: 8 + depth * 14 };
    const rowIcon = isDirectory ? (
      isExpandedNode ? <FolderOpen size={14} className="shrink-0 text-muted-foreground" /> : <Folder size={14} className="shrink-0 text-muted-foreground" />
    ) : isExcalidrawPath(node.path) ? (
      <PencilRuler size={14} className="shrink-0 text-primary" />
    ) : (
      <FileIcon size={14} className="shrink-0 text-muted-foreground" />
    );
    const rowLabel = isDirectory
      ? node.name
      : node.note ? getNoteFileDisplayName(node.note.path) : getExplorerFileLabel(node.path, mode);

    return (
      <div key={node.id} className="relative">
        {isRenaming ? (
          <div className={rowClassName} style={rowStyle} title={node.path}>
            <span className="w-[13px] shrink-0" />
            {rowIcon}
            {renderRenameInput('flex-1')}
          </div>
        ) : (
          <button
            className={rowClassName}
            style={rowStyle}
            title={node.path}
            onClick={event => handleNodeClick(node, event.detail)}
            onDoubleClick={event => {
              event.preventDefault();
              event.stopPropagation();
              handleNodeDoubleClick(node);
            }}
          >
            {isDirectory ? (
              isExpandedNode ? <ChevronDown size={13} className="shrink-0 text-muted-foreground" /> : <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
            ) : (
              <span className="w-[13px] shrink-0" />
            )}
            {rowIcon}
            <span className="min-w-0 flex-1 truncate">{rowLabel}</span>
          </button>
        )}
        {isDirectory && isExpandedNode && node.children.length > 0 ? (
          <div className="relative before:absolute before:bottom-1 before:left-2 before:top-1 before:w-px before:bg-border/60">
            <div style={{ marginLeft: 0 }}>
              {node.children.map(child => renderTreeNode(child, depth + 1))}
            </div>
          </div>
        ) : null}
      </div>
    );
  };

  const renderProperties = () => {
    const path = activePath ?? selectedNode?.path;
    const size = openBuffer?.size ?? selectedNode?.size;
    const mtimeMs = openBuffer?.mtimeMs ?? selectedNode?.mtimeMs;
    const mediaType = openBuffer?.mediaType ?? selectedNode?.mediaType ?? selectedNode?.type;

    return (
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-3">
        <PropertyRow label="Path">
          {path ? <span className="break-all">{path}</span> : <span className="text-muted-foreground">None</span>}
        </PropertyRow>
        <PropertyRow label="Kind">{mediaType ?? 'Unknown'}</PropertyRow>
        <PropertyRow label="Size">{formatBytes(size)}</PropertyRow>
        <PropertyRow label="Modified">{formatDate(mtimeMs)}</PropertyRow>
        {openBuffer ? (
          <>
            <PropertyRow label="Version"><span className="break-all">{openBuffer.version}</span></PropertyRow>
            <PropertyRow label="Status">{isDirty ? 'Modified' : 'Saved'}</PropertyRow>
          </>
        ) : null}
        {activeNote ? (
          <>
            <PropertyRow label="Tags">
              <div className="flex flex-wrap gap-1">
                {activeNote.tags.length ? activeNote.tags.map(tag => <Badge key={tag} variant="secondary">#{tag}</Badge>) : <span className="text-muted-foreground">None</span>}
              </div>
            </PropertyRow>
            <PropertyRow label="Properties">
              <div className="space-y-1">
                {Object.entries(activeNote.properties).length ? Object.entries(activeNote.properties).map(([key, value]) => (
                  <div key={key} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
                    <span className="truncate text-muted-foreground">{key}</span>
                    <span className="truncate">{value}</span>
                  </div>
                )) : <span className="text-muted-foreground">None</span>}
              </div>
            </PropertyRow>
            <PropertyRow label="Links">
              <div className="space-y-1">
                {activeNote.links.length ? activeNote.links.map(link => (
                  <button key={link} className="block max-w-full truncate text-left text-primary hover:underline" onClick={() => openWikiLink(link)}>
                    {link}
                  </button>
                )) : <span className="text-muted-foreground">None</span>}
              </div>
            </PropertyRow>
            <PropertyRow label="Backlinks">
              <div className="space-y-1">
                {activeBacklinks.length ? activeBacklinks.map(link => (
                  <button key={link} className="block max-w-full truncate text-left text-primary hover:underline" onClick={() => void loadFile(link)}>
                    {link}
                  </button>
                )) : <span className="text-muted-foreground">None</span>}
              </div>
            </PropertyRow>
            <PropertyRow label="Headings">
              <div className="space-y-1">
                {activeNote.headings.length ? activeNote.headings.map(heading => <div key={heading} className="truncate">{heading}</div>) : <span className="text-muted-foreground">None</span>}
              </div>
            </PropertyRow>
          </>
        ) : null}
        {activeAttachment ? (
          <PropertyRow label="Attachment Type">{activeAttachment.mediaType}</PropertyRow>
        ) : null}
      </div>
    );
  };

  const renderEditorBody = () => {
    if (!openBuffer) {
      return <div className="grid h-full place-items-center text-xs text-muted-foreground">No file selected</div>;
    }
    if (mode === 'notes' && isExcalidrawPath(openBuffer.path)) {
      return (
        <div
          className="h-full w-full"
          data-weave-editor-excalidraw
          style={{ '--weave-excalidraw-background': editorCanvasBackgroundColor } as CSSProperties}
        >
          <Excalidraw
            autoFocus
            excalidrawAPI={handleExcalidrawApi}
            key={`${openBuffer.path}:${openBuffer.version}`}
            initialData={excalidrawInitialData}
            name={openBuffer.path}
            onChange={handleExcalidrawChange}
            theme={resolvedTheme}
          />
        </div>
      );
    }

    return (
      <CodeMirrorEditor
        ref={editorRef}
        key={`${mode}:${openBuffer.path}`}
        editorMode={mode}
        path={openBuffer.path}
        value={content}
        wikiLinkSuggestions={noteSuggestions}
        onChange={setActiveBufferValue}
        onOpenWikiLink={openWikiLink}
        onSave={() => void handleSave()}
        onVimModeChange={setVimMode}
      />
    );
  };

  const handleEditorTabDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    reorderEditorTabs(editorTabTargetKey, String(active.id), String(over.id));
  }, [editorTabTargetKey, reorderEditorTabs]);

  const selectEditorTab = useCallback((tab: EditorTab) => {
    setActiveEditorTab(editorTabTargetKey, tab.id);
    if (buffersByTabId[tab.id]) setBufferFocusRequest(request => request + 1);
  }, [buffersByTabId, editorTabTargetKey, setActiveEditorTab]);

  const closeEditorTab = useCallback((tab: EditorTab) => {
    const buffer = buffersByTabId[tab.id];
    if (!confirmDiscardBuffer(buffer, tab.path)) return;
    closePersistedEditorTab(editorTabTargetKey, tab.id);
    setBuffersByTabId(current => {
      if (!current[tab.id]) return current;
      const next = { ...current };
      delete next[tab.id];
      return next;
    });
    setFailedBufferTabIds(current => {
      if (!current.has(tab.id)) return current;
      const next = new Set(current);
      next.delete(tab.id);
      return next;
    });
  }, [buffersByTabId, closePersistedEditorTab, confirmDiscardBuffer, editorTabTargetKey]);

  const renderEditorTabs = () => (
    <DndContext
      collisionDetection={closestCenter}
      modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
      sensors={editorTabSensors}
      onDragEnd={handleEditorTabDragEnd}
    >
      <SortableContext items={editorTabs.map(tab => tab.id)} strategy={horizontalListSortingStrategy}>
        {editorTabs.map(tab => {
          const isSelected = tab.id === activeEditorTab?.id;
          const tabBuffer = buffersByTabId[tab.id];
          const label = getEditorFileLabel(tab.path, mode);
          const isRenaming = renameState?.origin === 'tab' && renameState.path === tab.path;
          const icon = mode === 'notes'
            ? isExcalidrawPath(tab.path)
              ? <PencilRuler size={12} className="text-primary" />
              : <StickyNote size={12} className="text-muted-foreground" />
            : <FileIcon size={12} className="text-muted-foreground" />;
          return (
            <SortableEditorTab
              key={tab.id}
              canClose
              isDirty={getBufferDirty(tabBuffer)}
              isRenaming={isRenaming}
              isSelected={isSelected}
              icon={icon}
              label={label}
              renameInput={isRenaming ? renderRenameInput('h-5 w-full') : undefined}
              tab={tab}
              onClose={() => closeEditorTab(tab)}
              onRename={() => startRename(tab.path, 'tab')}
              onSelect={() => selectEditorTab(tab)}
            />
          );
        })}
      </SortableContext>
    </DndContext>
  );

  const explorerToggleLabel = isExplorerSlideOverMode
    ? 'Open explorer'
    : isExplorerVisible ? 'Hide explorer' : 'Show explorer';
  const explorerToggleHoverHandlers = isExplorerSlideOverMode
    ? {
        onMouseEnter: openExplorerSlideOver,
        onMouseLeave: scheduleExplorerSlideOverClose,
      }
    : {};

  const renderExplorerRail = (presentation: 'docked' | 'slide-over') => {
    const isSlideOver = presentation === 'slide-over';

    return (
      <aside
        className={cn(
          'flex w-80 min-w-64 shrink-0 flex-col bg-card/40',
          isSlideOver
            ? 'absolute bottom-2 right-2 top-2 z-20 max-w-[calc(100%-1rem)] overflow-hidden rounded-md border border-border bg-card/95 shadow-xl backdrop-blur'
            : 'border-l border-border',
        )}
        data-weave-editor-explorer
        data-presentation={presentation}
        onMouseEnter={isSlideOver ? openExplorerSlideOver : undefined}
        onMouseLeave={isSlideOver ? scheduleExplorerSlideOverClose : undefined}
      >
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
          <Button
            className={cn('h-6 flex-1 justify-center text-xs', activeTab === 'explorer' && 'bg-accent')}
            size="xs"
            variant="ghost"
            onClick={() => setActiveTab('explorer')}
          >
            Explorer
          </Button>
          <Button
            className={cn('h-6 flex-1 justify-center text-xs', activeTab === 'properties' && 'bg-accent')}
            size="xs"
            variant="ghost"
            onClick={() => setActiveTab('properties')}
          >
            <Info size={12} />
            Properties
          </Button>
        </div>
        {activeTab === 'explorer' ? (
          <>
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={mode === 'notes' ? 'New note' : 'New file'}
                title={mode === 'notes' ? 'New note' : 'New file'}
                onClick={() => {
                  if (mode === 'notes') void createNoteInSelectedDirectory();
                  else openCreatePathDialog('file');
                }}
              >
                <FilePlus2 size={14} />
              </Button>
              {mode === 'notes' ? (
                <Button size="icon-xs" variant="ghost" aria-label="New drawing" title="New drawing" onClick={() => void createDrawingInSelectedDirectory()}>
                  <PencilRuler size={14} />
                </Button>
              ) : null}
              <Button size="icon-xs" variant="ghost" aria-label="New folder" title="New folder" onClick={() => openCreatePathDialog('folder')}>
                <FolderPlus size={14} />
              </Button>
              {mode === 'notes' ? (
                <>
                  <Button size="icon-xs" variant="ghost" aria-label="Upload attachment" title="Upload attachment" onClick={() => uploadInputRef.current?.click()}>
                    <ImagePlus size={14} />
                  </Button>
                  <input ref={uploadInputRef} className="hidden" type="file" onChange={event => void uploadAttachment(event.currentTarget.files?.[0])} />
                </>
              ) : null}
              <div className="min-w-0 flex-1" />
              <Button size="icon-xs" variant="ghost" aria-label="Delete selected item" title="Delete selected item" disabled={!selectedNode && !activePath} onClick={() => void deleteSelected()}>
                <Trash2 size={14} />
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label="Refresh explorer" title="Refresh explorer" disabled={isExplorerLoading} onClick={() => void refreshExplorer()}>
                <RefreshCw size={14} className={isExplorerLoading ? 'animate-spin' : undefined} />
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label="Collapse all" title="Collapse all" onClick={() => setExpandedPaths(new Set(['']))}>
                <ChevronRight size={14} />
              </Button>
            </div>
            <div className="border-b border-border p-2">
              <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2">
                <Search size={13} className="shrink-0 text-muted-foreground" />
                <Input
                  nativeInput
                  className="h-6 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
                  placeholder="Search"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1">
              {visibleTree.children.length > 0 ? renderTreeNode(visibleTree, -1) : (
                <div className="px-2 py-3 text-xs text-muted-foreground">No files</div>
              )}
            </div>
          </>
        ) : renderProperties()}
      </aside>
    );
  };

  const createPathDialogTitle = createPathDialog?.kind === 'folder'
    ? 'New folder'
    : createPathDialog?.kind === 'drawing'
      ? 'New drawing'
      : mode === 'notes'
        ? 'New note'
        : 'New file';
  const createPathDialogDescription = createPathDialog?.kind === 'folder'
    ? 'Enter a folder path relative to the current root.'
    : createPathDialog?.kind === 'drawing'
      ? 'Enter a drawing path relative to the vault root.'
      : mode === 'notes'
        ? 'Enter a note path relative to the vault root.'
        : 'Enter a file path relative to the workspace root.';
  const createPathDialogPlaceholder = createPathDialog?.kind === 'folder'
    ? 'Folder path'
    : createPathDialog?.kind === 'drawing'
      ? 'Drawing.excalidraw'
      : mode === 'notes'
        ? 'Note.md'
        : 'path/to/file.ts';

  return (
    <>
      <section
        className="relative z-10 flex h-full min-h-0 min-w-0 flex-1 basis-0 flex-col border-l border-border bg-background transition-[width] duration-150 ease-out"
        data-weave-editor-panel
        data-weave-editor-mode={mode}
        data-weave-surface="editor"
        data-expanded={isExpanded ? 'true' : 'false'}
      >
        <span
          ref={columnMeasureRef}
          className="pointer-events-none fixed -left-[9999px] -top-[9999px] font-mono text-sm opacity-0"
          aria-hidden="true"
        >
          {editorColumnMeasureText}
        </span>
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3" data-weave-editor-titlebar data-weave-editor-tab-bar>
          {mode === 'notes' ? <StickyNote size={15} className="shrink-0 text-primary" /> : <Code2 size={15} className="shrink-0 text-primary" />}
          <div
            className="flex min-w-0 flex-1 items-end self-stretch overflow-x-auto pt-2"
            role="tablist"
            aria-label={mode === 'notes' ? 'Open notes' : 'Open code buffers'}
          >
            {editorTabs.length > 0 ? renderEditorTabs() : (
              <div className="self-center text-xs text-muted-foreground">No open files</div>
            )}
          </div>
          {statusLabel ? <span className="self-center shrink-0 text-[11px] text-muted-foreground">{statusLabel}</span> : null}
          <Button size="icon-xs" variant="ghost" aria-label="Save buffer" title="Save buffer" disabled={!openBuffer || !isDirty || isSaving} onClick={() => void handleSave()}>
            <Save size={14} />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label="Reload buffer" title="Reload buffer" disabled={!openBuffer || isFileLoading} onClick={handleReload}>
            <RefreshCw size={14} className={isFileLoading ? 'animate-spin' : undefined} />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label={isExpanded ? 'Restore editor column' : 'Expand editor'} title={isExpanded ? 'Restore editor column' : 'Expand editor'} onClick={() => onExpandedChange(!isExpanded)}>
            {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label={mode === 'notes' ? 'Hide notes' : 'Hide editor'} onClick={handleHidePanel}>
            <X size={14} />
          </Button>
        </div>
        <div ref={editorBodyRef} className="relative flex min-h-0 flex-1">
          <div className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
            {renderEditorBody()}
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
          {isExplorerDocked ? renderExplorerRail('docked') : null}
          {isExplorerSlideOverVisible ? renderExplorerRail('slide-over') : null}
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
          <div className="min-w-0 flex-1" aria-hidden="true" />
          <Button
            className={isExplorerActive ? 'bg-accent' : undefined}
            size="icon-xs"
            variant="ghost"
            aria-label={explorerToggleLabel}
            title={explorerToggleLabel}
            data-active={isExplorerActive ? 'true' : 'false'}
            onClick={toggleExplorerRail}
            {...explorerToggleHoverHandlers}
          >
            {isExplorerActive ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </Button>
        </div>
      </section>
      <Dialog open={Boolean(createPathDialog)} onOpenChange={open => {
        if (!open) setCreatePathDialog(undefined);
      }}>
        <DialogPopup className="max-w-sm" showCloseButton={false}>
          <form className="flex min-h-0 flex-col" onSubmit={event => void submitCreatePathDialog(event)}>
            <DialogHeader>
              <DialogTitle>{createPathDialogTitle}</DialogTitle>
              <DialogDescription>{createPathDialogDescription}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="grid gap-2 pt-1">
              <Input
                nativeInput
                autoFocus
                placeholder={createPathDialogPlaceholder}
                value={createPathDialog?.value ?? ''}
                onChange={event => setCreatePathDialog(current => current ? { ...current, value: event.currentTarget.value } : current)}
              />
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreatePathDialog(undefined)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!createPathDialog?.value.trim()}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
};
