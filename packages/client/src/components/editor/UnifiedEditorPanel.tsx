import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { DndContext, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { restrictToHorizontalAxis, restrictToParentElement } from '@dnd-kit/modifiers';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Brain,
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
  PanelLeftClose,
  PanelLeftOpen,
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
import { createEmptyCoppermindDocumentContent, normalizeCoppermindDocumentPath } from '../../lib/coppermind-document';
import {
  getDefaultDocumentExtension,
  getEditorDocumentLabel,
  getEditorDocumentMediaType,
  isEditorPathOpenable,
  resolveEditorDocumentKind,
} from '../../lib/editor-document-kind';
import { createEditorBackend } from '../../lib/editor-backend';
import type { EditorEntry, EditorMode, EditorTarget, EditorWatchSubscription, OpenBuffer } from '../../lib/editor-types';
import { defaultEditorExplorerVisible, getEditorTabTargetKey, getEditorTabId, useEditorTabStore, type EditorTab } from '../../stores/editor-tab-store';
import type { EditorFollowRequest } from '../../stores/workspace-surface-store';
import { createVaultBackend, type VaultAttachment, type VaultIndexResult, type VaultNote, type VaultTarget } from '../../lib/vault-backend';
import { getResolvedTheme, useThemeStore } from '../../stores/theme-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { CodeMirrorEditor, type CodeMirrorEditorHandle, type VimMode } from './CodeMirrorEditor';
import { CoppermindDocumentEditor } from './CoppermindDocumentEditor';
import { createEmptyExcalidrawFile, ExcalidrawDocumentEditor, normalizeExcalidrawContent } from './ExcalidrawDocumentEditor';

export type UnifiedEditorTarget = EditorTarget & {
  projectName: string;
  workspaceName: string;
};

type UnifiedEditorPanelProps = {
  breadcrumb?: ReactNode;
  followRequest?: EditorFollowRequest;
  focusRequest?: number;
  isExpanded: boolean;
  mode: EditorMode;
  onExpandedChange: (isExpanded: boolean) => void;
  onHide: () => void;
  proposalBackFilePath?: string;
  onBackToProposalPreview?: (path: string) => void;
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

const toErrorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const getDocumentKind = (mode: EditorMode, path: string | undefined) => (
  path ? resolveEditorDocumentKind({ mode, path }) : undefined
);
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
const normalizeNotesDocumentPath = (value: string) => {
  const path = normalizeRelativePath(value);
  if (!path) return '';
  return /\.(md|markdown|cpr)$/i.test(path) ? path : normalizeCoppermindDocumentPath(path);
};
const normalizeRenameFileName = (value: string, currentPath: string, mode: EditorMode) => {
  const name = normalizeRelativePath(value);
  if (!name || name.includes('/')) return '';
  if (mode !== 'notes' || /\.[^/.]+$/i.test(name)) return name;
  const kind = getDocumentKind(mode, currentPath);
  if (kind === 'markdown' || kind === 'excalidraw' || kind === 'coppermind') {
    return `${name}${getFileExtension(currentPath) || getDefaultDocumentExtension(kind)}`;
  }
  return name;
};

const getRenameDisplayName = (path: string, mode: EditorMode) => {
  const kind = getDocumentKind(mode, path);
  if (kind === 'markdown' || kind === 'excalidraw' || kind === 'coppermind') return getEditorDocumentLabel(path, mode);
  return getBasename(path);
};

const explorerSlideOverCloseDelayMs = 120;
const explorerFileOpenSingleClickDelayMs = 450;
const explorerBorderHoverWidthPx = 10;
const explorerWindowEdgeExitSlopPx = 32;
const isPointerAtExplorerEdge = (
  clientX: number,
  clientY: number,
  rect: DOMRect,
  verticalSlopPx = 0,
  horizontalSlopPx = explorerBorderHoverWidthPx,
) => (
  clientY >= rect.top - verticalSlopPx &&
  clientY <= rect.bottom + verticalSlopPx &&
  clientX >= rect.right - horizontalSlopPx
);
const isElementInDocument = (target: EventTarget | null, ownerDocument: Document) => (
  target instanceof Element && ownerDocument.documentElement.contains(target)
);
const didPointerLeaveNearExplorerWindowEdge = (
  event: { clientX: number; clientY: number; relatedTarget: EventTarget | null },
  hostElement: HTMLElement,
) => {
  const rect = hostElement.getBoundingClientRect();
  if (!isPointerAtExplorerEdge(
    event.clientX,
    event.clientY,
    rect,
    explorerWindowEdgeExitSlopPx,
    explorerWindowEdgeExitSlopPx,
  )) return false;
  const ownerDocument = hostElement.ownerDocument;
  const relatedElement = event.relatedTarget instanceof Element ? event.relatedTarget : undefined;
  if (!isElementInDocument(relatedElement ?? null, ownerDocument)) return true;
  if (relatedElement === ownerDocument.documentElement || relatedElement === ownerDocument.body) return true;
  return event.clientX >= rect.right;
};

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
      mediaType: note.documentType ?? 'markdown',
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
  onBackToPreview?: () => void;
  onPin: () => void;
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
  onBackToPreview,
  onPin,
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
        'relative -ml-px flex h-full min-w-36 max-w-64 shrink-0 items-center overflow-hidden rounded-none border-x border-y-0 text-xs',
        isSelected
          ? 'z-10 border-border bg-accent text-foreground'
          : 'z-0 border-transparent bg-transparent text-muted-foreground hover:z-10 hover:border-border hover:bg-accent/60 hover:text-foreground',
        isDragging && 'z-20 opacity-90 shadow-md',
      )}
      style={style}
      data-weave-editor-tab={tab.path}
    >
      {onBackToPreview && !isRenaming ? (
        <button
          type="button"
          className="grid h-full w-8 shrink-0 place-items-center border-r border-border/70 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={`Back to preview for ${label}`}
          title="Back to preview"
          onClick={event => {
            event.preventDefault();
            event.stopPropagation();
            onBackToPreview();
          }}
        >
          <span className="font-mono text-[11px]" aria-hidden="true">&lt;-</span>
        </button>
      ) : null}
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
            if (tab.isPreview) onPin();
            else onRename();
          }}
          {...sortableAttributes}
          {...listeners}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">{icon}</span>
            <span className={cn(
              'block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl] [text-align:left]',
              tab.isPreview && 'italic',
            )}>
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
  breadcrumb,
  followRequest,
  focusRequest = 0,
  isExpanded,
  mode,
  onExpandedChange,
  onHide,
  proposalBackFilePath,
  onBackToProposalPreview,
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
  const isExplorerVisible = useEditorTabStore(state => state.explorerVisibleByTarget[editorTabTargetKey] ?? defaultEditorExplorerVisible);
  const closePersistedEditorTab = useEditorTabStore(state => state.closeEditorTab);
  const openPersistedEditorTab = useEditorTabStore(state => state.openEditorTab);
  const pinPersistedEditorTab = useEditorTabStore(state => state.pinEditorTab);
  const renamePersistedEditorTab = useEditorTabStore(state => state.renameEditorTab);
  const reorderEditorTabs = useEditorTabStore(state => state.reorderEditorTabs);
  const setActiveEditorTab = useEditorTabStore(state => state.setActiveEditorTab);
  const setExplorerVisible = useEditorTabStore(state => state.setExplorerVisible);
  const setPersistedEditorTabs = useEditorTabStore(state => state.setEditorTabs);
  const resolvedTheme = getResolvedTheme(useThemeStore(state => state.mode));
  const editorRef = useRef<CodeMirrorEditorHandle | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const explorerSlideOverCloseTimeoutRef = useRef<number | undefined>(undefined);
  const fileOpenClickTimeoutRef = useRef<number | undefined>(undefined);
  const renameCommitInFlightRef = useRef(false);
  const renameCancelRef = useRef(false);
  const explorerBorderHoverRef = useRef(false);
  const explorerWindowEdgeHoldRef = useRef(false);
  const expandedPathsRef = useRef<Set<string>>(new Set(['']));
  const editorWatchSubscriptionRef = useRef<EditorWatchSubscription | undefined>(undefined);
  const refreshCodeDirectoriesRef = useRef<(paths: string[]) => Promise<void>>(async () => undefined);
  const pendingRevealRef = useRef<{ requestId: number; path: string; line: number } | undefined>(
    undefined,
  );
  const handledFollowRequestIdRef = useRef<number | undefined>(undefined);
  const editorBodyRef = useRef<HTMLDivElement | null>(null);
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
  const [isExplorerSlideOverOpen, setIsExplorerSlideOverOpen] = useState(false);
  const [isCoppermindCellsSidebarOpen, setIsCoppermindCellsSidebarOpen] = useState(true);
  const [vimMode, setVimMode] = useState<VimMode>('normal');
  const [createPathDialog, setCreatePathDialog] = useState<CreatePathDialogState>();
  const [renameState, setRenameState] = useState<RenameState>();
  const [bufferFocusRequest, setBufferFocusRequest] = useState(0);
  const [editorGutterWidth, setEditorGutterWidth] = useState(56);
  const activeEditorTab = editorTabs.find(tab => tab.id === activeEditorTabId) ?? editorTabs[0];
  const openBuffer = activeEditorTab ? buffersByTabId[activeEditorTab.id] : undefined;
  const activePath = openBuffer?.path ?? activeEditorTab?.path;
  const content = openBuffer?.value ?? '';
  const isDirty = getBufferDirty(openBuffer);
  const hasDirtyBuffers = Object.values(buffersByTabId).some(getBufferDirty);
  const shouldPersistExplorerOpen = !activeEditorTab;
  const isExplorerLockedOpen = isExplorerVisible || shouldPersistExplorerOpen;
  const canUseExplorerSlideOver = !isExplorerLockedOpen;
  const isExplorerSlideOverVisible = canUseExplorerSlideOver && isExplorerSlideOverOpen;
  const isExplorerOverlayVisible = isExplorerLockedOpen || isExplorerSlideOverVisible;
  const editorPanelStyle = useMemo(() => ({
    '--weave-editor-gutter-width': `${Math.max(44, editorGutterWidth)}px`,
  }) as CSSProperties, [editorGutterWidth]);
  const isExplorerActive = isExplorerOverlayVisible;
  const hasBreadcrumb = Boolean(breadcrumb);
  const modeIndicator = editorModeIndicatorStyles[vimMode];
  const statusLabel = isSaving ? 'saving' : isFileLoading ? 'loading' : undefined;
  const activeNote = activePath
    ? vaultIndex?.notes.find(note => note.path === activePath)
    : selectedNode?.note;
  const activeAttachment = activePath
    ? vaultIndex?.attachments.find(attachment => attachment.path === activePath)
    : selectedNode?.attachment;
  const activeBacklinks = activeNote ? vaultIndex?.backlinks[activeNote.path] ?? [] : [];
  const activeDocumentKind = getDocumentKind(mode, openBuffer?.path);
  const isCodeMirrorOpen = Boolean(openBuffer && (activeDocumentKind === 'code' || activeDocumentKind === 'markdown'));
  const isCoppermindOpen = Boolean(openBuffer && activeDocumentKind === 'coppermind');
  const coppermindCellsToggleLabel = isCoppermindCellsSidebarOpen
    ? 'Collapse cells sidebar'
    : 'Expand cells sidebar';

  const tree = useMemo(() => (
    mode === 'code'
      ? buildCodeTree(codeDirectories, target.workspaceName)
      : buildNotesTree(vaultIndex, target.projectName)
  ), [codeDirectories, mode, target.projectName, target.workspaceName, vaultIndex]);
  const visibleTree = useMemo(() => filterTree(tree, query, true) ?? tree, [query, tree]);
  const existingExplorerPaths = useMemo(() => collectTreePaths(tree), [tree]);
  const noteSuggestions = useMemo(() => (vaultIndex?.notes ?? []).map(note => ({
    target: note.path.replace(/\.(md|markdown|cpr)$/i, ''),
    label: getEditorDocumentLabel(note.path, mode),
    detail: note.title && note.title !== getEditorDocumentLabel(note.path, mode) ? `${note.path} · ${note.title}` : note.path,
  })), [mode, vaultIndex?.notes]);
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

  const clearEditorTabState = useCallback((tabId: string) => {
    setBuffersByTabId(current => {
      if (!current[tabId]) return current;
      const next = { ...current };
      delete next[tabId];
      return next;
    });
    setFailedBufferTabIds(current => {
      if (!current.has(tabId)) return current;
      const next = new Set(current);
      next.delete(tabId);
      return next;
    });
  }, []);

  const clearEditorTabStates = useCallback((tabIds: string[]) => {
    if (tabIds.length === 0) return;
    const tabIdSet = new Set(tabIds);
    setBuffersByTabId(current => {
      let didChange = false;
      const next = { ...current };
      for (const tabId of tabIdSet) {
        if (!next[tabId]) continue;
        didChange = true;
        delete next[tabId];
      }
      return didChange ? next : current;
    });
    setFailedBufferTabIds(current => {
      let didChange = false;
      const next = new Set(current);
      for (const tabId of tabIdSet) {
        if (!next.delete(tabId)) continue;
        didChange = true;
      }
      return didChange ? next : current;
    });
  }, []);

  const closePreviewEditorTab = useCallback((tab: EditorTab | undefined) => {
    if (!tab?.isPreview) return;
    closePersistedEditorTab(editorTabTargetKey, tab.id);
    clearEditorTabState(tab.id);
  }, [clearEditorTabState, closePersistedEditorTab, editorTabTargetKey]);

  const setActiveBufferValue = useCallback((value: string) => {
    if (!activeEditorTab) return;
    const currentBuffer = buffersByTabId[activeEditorTab.id];
    if (activeEditorTab.isPreview && currentBuffer && value !== currentBuffer.value) {
      pinPersistedEditorTab(editorTabTargetKey, activeEditorTab.id);
    }
    updateBuffer(activeEditorTab.id, buffer => (
      value === buffer.value ? buffer : withBufferValue(buffer, value)
    ));
  }, [activeEditorTab, buffersByTabId, editorTabTargetKey, pinPersistedEditorTab, updateBuffer]);

  const focusEditorSurface = useCallback(() => {
    editorRef.current?.focus();
  }, []);

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
    explorerWindowEdgeHoldRef.current = false;
    setIsExplorerSlideOverOpen(false);
  }, [clearExplorerSlideOverCloseTimeout]);

  const clearPendingFileOpen = useCallback(() => {
    if (fileOpenClickTimeoutRef.current === undefined) return;
    window.clearTimeout(fileOpenClickTimeoutRef.current);
    fileOpenClickTimeoutRef.current = undefined;
  }, []);

  const openExplorerSlideOver = useCallback(() => {
    if (!canUseExplorerSlideOver) return;
    clearExplorerSlideOverCloseTimeout();
    setIsExplorerSlideOverOpen(true);
  }, [canUseExplorerSlideOver, clearExplorerSlideOverCloseTimeout]);

  const scheduleExplorerSlideOverClose = useCallback(() => {
    if (!canUseExplorerSlideOver) return;
    clearExplorerSlideOverCloseTimeout();
    explorerWindowEdgeHoldRef.current = false;
    explorerSlideOverCloseTimeoutRef.current = window.setTimeout(() => {
      explorerSlideOverCloseTimeoutRef.current = undefined;
      setIsExplorerSlideOverOpen(false);
    }, explorerSlideOverCloseDelayMs);
  }, [canUseExplorerSlideOver, clearExplorerSlideOverCloseTimeout]);

  const toggleExplorerRail = useCallback(() => {
    clearExplorerSlideOverCloseTimeout();
    setExplorerVisible(editorTabTargetKey, !isExplorerVisible);
    setIsExplorerSlideOverOpen(false);
  }, [clearExplorerSlideOverCloseTimeout, editorTabTargetKey, isExplorerVisible, setExplorerVisible]);

  const holdExplorerSlideOverForWindowEdgeExit = useCallback(() => {
    if (!canUseExplorerSlideOver) return;
    explorerWindowEdgeHoldRef.current = true;
    explorerBorderHoverRef.current = true;
    clearExplorerSlideOverCloseTimeout();
    setIsExplorerSlideOverOpen(true);
  }, [canUseExplorerSlideOver, clearExplorerSlideOverCloseTimeout]);

  const closeExplorerAfterFileOpen = useCallback(() => {
    if (!canUseExplorerSlideOver) return;
    closeExplorerSlideOver();
  }, [canUseExplorerSlideOver, closeExplorerSlideOver]);

  const handleEditorBodyMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!canUseExplorerSlideOver) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-weave-editor-explorer]')) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const isInsideHoverEdge = isPointerAtExplorerEdge(event.clientX, event.clientY, rect);
    if (isInsideHoverEdge) {
      explorerWindowEdgeHoldRef.current = false;
      explorerBorderHoverRef.current = true;
      openExplorerSlideOver();
      return;
    }

    if (explorerWindowEdgeHoldRef.current) {
      explorerWindowEdgeHoldRef.current = false;
      explorerBorderHoverRef.current = false;
      scheduleExplorerSlideOverClose();
      return;
    }

    if (!explorerBorderHoverRef.current) return;
    explorerBorderHoverRef.current = false;
    scheduleExplorerSlideOverClose();
  }, [canUseExplorerSlideOver, openExplorerSlideOver, scheduleExplorerSlideOverClose]);

  const handleExplorerHoverMouseLeave = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!canUseExplorerSlideOver) return;
    const editorBody = editorBodyRef.current;
    if (editorBody && didPointerLeaveNearExplorerWindowEdge(event, editorBody)) {
      holdExplorerSlideOverForWindowEdgeExit();
      return;
    }
    explorerBorderHoverRef.current = false;
    scheduleExplorerSlideOverClose();
  }, [canUseExplorerSlideOver, holdExplorerSlideOverForWindowEdgeExit, scheduleExplorerSlideOverClose]);

  const handleEditorBodyMouseLeave = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    handleExplorerHoverMouseLeave(event);
  }, [handleExplorerHoverMouseLeave]);

  useEffect(() => {
    if (!canUseExplorerSlideOver) return undefined;

    const releaseExplorerWindowEdgeHold = () => {
      explorerWindowEdgeHoldRef.current = false;
      explorerBorderHoverRef.current = false;
    };

    const handleWindowMouseMove = (event: MouseEvent) => {
      if (!explorerWindowEdgeHoldRef.current) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[data-weave-editor-explorer]')) {
        clearExplorerSlideOverCloseTimeout();
        return;
      }

      const editorBody = editorBodyRef.current;
      if (!editorBody) {
        releaseExplorerWindowEdgeHold();
        scheduleExplorerSlideOverClose();
        return;
      }

      const rect = editorBody.getBoundingClientRect();
      if (isPointerAtExplorerEdge(
        event.clientX,
        event.clientY,
        rect,
        explorerWindowEdgeExitSlopPx,
        explorerWindowEdgeExitSlopPx,
      )) {
        clearExplorerSlideOverCloseTimeout();
        setIsExplorerSlideOverOpen(true);
        return;
      }

      releaseExplorerWindowEdgeHold();
      scheduleExplorerSlideOverClose();
    };

    const handleWindowBlur = () => {
      releaseExplorerWindowEdgeHold();
      closeExplorerSlideOver();
    };

    const handleDocumentMouseOut = (event: MouseEvent) => {
      const editorBody = editorBodyRef.current;
      if (!editorBody || !didPointerLeaveNearExplorerWindowEdge(event, editorBody)) return;
      holdExplorerSlideOverForWindowEdgeExit();
    };

    const ownerDocument = editorBodyRef.current?.ownerDocument ?? window.document;
    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('mouseout', handleDocumentMouseOut, true);
    ownerDocument.addEventListener('mouseout', handleDocumentMouseOut, true);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('mouseout', handleDocumentMouseOut, true);
      ownerDocument.removeEventListener('mouseout', handleDocumentMouseOut, true);
    };
  }, [
    canUseExplorerSlideOver,
    clearExplorerSlideOverCloseTimeout,
    closeExplorerSlideOver,
    holdExplorerSlideOverForWindowEdgeExit,
    scheduleExplorerSlideOverClose,
  ]);

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

  const refreshCodeDirectories = useCallback(async (paths: string[]) => {
    const uniquePaths = [...new Set(paths.length ? paths : [''])];
    const results = await Promise.all(uniquePaths.map(async path => {
      try {
        return { ok: true as const, result: await codeBackend.list(editorTarget, path) };
      } catch (refreshError) {
        return { ok: false as const, path, error: refreshError };
      }
    }));
    const rootFailure = results.find(result => !result.ok && result.path === '');
    if (rootFailure && !rootFailure.ok) throw rootFailure.error;

    const failedPaths = results
      .filter((result): result is { ok: false; path: string; error: unknown } => !result.ok)
      .map(result => result.path);
    setCodeDirectories(current => {
      const next = { ...current };
      for (const result of results) {
        if (result.ok) next[result.result.path] = result.result.entries;
      }
      for (const path of failedPaths) {
        delete next[path];
        for (const key of Object.keys(next)) {
          if (key.startsWith(`${path}/`)) delete next[key];
        }
      }
      return next;
    });
    if (failedPaths.length > 0) {
      setExpandedPaths(current => {
        const next = new Set(current);
        for (const path of failedPaths) {
          next.delete(path);
          for (const expandedPath of current) {
            if (expandedPath.startsWith(`${path}/`)) next.delete(expandedPath);
          }
        }
        return next;
      });
      setSelectedNode(current => {
        if (!current) return current;
        return failedPaths.some(path => current.path === path || current.path.startsWith(`${path}/`)) ? undefined : current;
      });
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

      await refreshCodeDirectories(Array.from(expandedPaths));
    } catch (refreshError) {
      setError(toErrorMessage(refreshError));
    } finally {
      setIsExplorerLoading(false);
    }
  }, [expandedPaths, mode, refreshCodeDirectories, vaultBackend, vaultTarget]);

  const loadFile = useCallback(async (path: string, options: { focusEditor?: boolean; preview?: boolean } = {}) => {
    if (!isEditorPathOpenable(mode, path)) return false;

    const shouldPreview = options.preview ?? true;
    const existingTab = editorTabs.find(tab => tab.path === path);
    const previewTabIdsToClose = editorTabs
      .filter(tab => tab.isPreview && tab.path !== path)
      .map(tab => tab.id);
    if (existingTab && buffersByTabId[existingTab.id]) {
      if (activeEditorTab?.id !== existingTab.id) closePreviewEditorTab(activeEditorTab);
      setActiveEditorTab(editorTabTargetKey, existingTab.id);
      if (options.focusEditor ?? true) setBufferFocusRequest(request => request + 1);
      return true;
    }

    const tab = existingTab ?? openPersistedEditorTab(editorTabTargetKey, path, { preview: shouldPreview });
    if (existingTab) {
      if (activeEditorTab?.id !== existingTab.id) closePreviewEditorTab(activeEditorTab);
      setActiveEditorTab(editorTabTargetKey, existingTab.id);
    } else {
      clearEditorTabStates(previewTabIdsToClose);
    }
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
      const mediaType = getEditorDocumentMediaType(getDocumentKind(mode, file.path));
      const loadedBuffer = createLoadedBuffer(file, mediaType);
      const loadedTab = file.path === tab.path
        ? tab
        : openPersistedEditorTab(editorTabTargetKey, file.path, { preview: tab.isPreview });
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
    activeEditorTab,
    buffersByTabId,
    clearEditorTabStates,
    closePersistedEditorTab,
    closePreviewEditorTab,
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

  useEffect(() => () => {
    if (typeof window === 'undefined') return;
    if (fileOpenClickTimeoutRef.current !== undefined) window.clearTimeout(fileOpenClickTimeoutRef.current);
  }, []);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  useEffect(() => {
    refreshCodeDirectoriesRef.current = async paths => {
      await refreshCodeDirectories(paths);
    };
  }, [refreshCodeDirectories]);

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
    if (mode !== 'code' || !codeBackend.watch) return undefined;
    let cancelled = false;
    void codeBackend.watch(editorTarget, Array.from(expandedPathsRef.current), event => {
      const expanded = expandedPathsRef.current;
      const refreshPaths = event.rescan
        ? Array.from(expanded)
        : event.affectedDirectories.filter(path => expanded.has(path));
      if (refreshPaths.length === 0) return;
      void refreshCodeDirectoriesRef.current(refreshPaths).catch(refreshError => {
        setError(toErrorMessage(refreshError));
      });
    }).then(subscription => {
      if (cancelled) {
        subscription.close();
        return;
      }
      editorWatchSubscriptionRef.current = subscription;
      void subscription.update(Array.from(expandedPathsRef.current)).catch(watchError => {
        setError(toErrorMessage(watchError));
      });
    }).catch(watchError => {
      if (!cancelled) setError(toErrorMessage(watchError));
    });

    return () => {
      cancelled = true;
      editorWatchSubscriptionRef.current?.close();
      editorWatchSubscriptionRef.current = undefined;
    };
  }, [codeBackend, editorTarget, mode]);

  useEffect(() => {
    if (mode !== 'code') return;
    void editorWatchSubscriptionRef.current?.update(Array.from(expandedPaths)).catch(watchError => {
      setError(toErrorMessage(watchError));
    });
  }, [expandedPaths, mode]);

  useEffect(() => {
    if (focusRequest === 0) return undefined;
    if (!isCodeMirrorOpen) {
      setBufferFocusRequest(request => request + 1);
      return undefined;
    }
    const animationFrame = window.requestAnimationFrame(focusEditorSurface);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusEditorSurface, focusRequest, isCodeMirrorOpen]);

  useEffect(() => {
    if (bufferFocusRequest === 0 || !openBuffer) return undefined;
    if (!isCodeMirrorOpen) return undefined;

    let secondFrame: number | undefined;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(focusEditorSurface);
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) window.cancelAnimationFrame(secondFrame);
    };
  }, [bufferFocusRequest, focusEditorSurface, isCodeMirrorOpen, openBuffer?.path]);

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
    if (isExplorerLockedOpen) closeExplorerSlideOver();
  }, [closeExplorerSlideOver, isExplorerLockedOpen]);

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
    if (node.type === 'file' && isEditorPathOpenable(mode, node.path)) {
      if (clickDetail > 1) {
        startRename(node.path, 'explorer');
        return;
      }

      clearPendingFileOpen();
      fileOpenClickTimeoutRef.current = window.setTimeout(() => {
        fileOpenClickTimeoutRef.current = undefined;
        void loadFile(node.path);
        closeExplorerAfterFileOpen();
      }, explorerFileOpenSingleClickDelayMs);
    }
  }, [clearPendingFileOpen, closeExplorerAfterFileOpen, loadFile, mode, startRename, toggleDirectory]);

  const handleNodeDoubleClick = useCallback((node: TreeNode) => {
    if (node.type !== 'file' || !isEditorPathOpenable(mode, node.path)) return;
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
      const mediaType = getEditorDocumentMediaType(getDocumentKind(mode, file.path));
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
        if (isEditorPathOpenable(mode, targetPath)) {
          const targetTabId = getEditorTabId(editorTabTargetKey, targetPath);
          renamePersistedEditorTab(editorTabTargetKey, sourcePath, targetPath);
          const mediaType = getEditorDocumentMediaType(getDocumentKind(mode, targetPath));
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
      } else if (openBuffer?.path === sourcePath && isEditorPathOpenable(mode, targetPath)) {
          const file = mode === 'code'
            ? await codeBackend.read(editorTarget, targetPath)
            : await vaultBackend.read(vaultTarget, targetPath);
          const tab = openPersistedEditorTab(editorTabTargetKey, file.path);
          setBuffersByTabId(current => ({
            ...current,
            [tab.id]: createLoadedBuffer(file, getEditorDocumentMediaType(getDocumentKind(mode, file.path))),
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
    const path = mode === 'notes' ? normalizeNotesDocumentPath(rawPath) : normalizeRelativePath(rawPath);
    if (!path) return false;

    const nextContent = mode === 'notes' && getDocumentKind(mode, path) === 'coppermind'
      ? createEmptyCoppermindDocumentContent({ path })
      : '';
    setError(undefined);
    try {
      const result = mode === 'code'
        ? await codeBackend.write(editorTarget, path, nextContent)
        : await vaultBackend.write(vaultTarget, path, nextContent);
      const previewTabIdsToClose = editorTabs
        .filter(tab => tab.isPreview && tab.path !== result.path)
        .map(tab => tab.id);
      const tab = openPersistedEditorTab(editorTabTargetKey, result.path);
      clearEditorTabStates(previewTabIdsToClose);
      setBuffersByTabId(current => ({
        ...current,
        [tab.id]: createLoadedBuffer({
          path: result.path,
          content: nextContent,
          version: result.version,
          size: result.size,
          mtimeMs: result.mtimeMs,
        }, getEditorDocumentMediaType(getDocumentKind(mode, result.path))),
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
  }, [clearEditorTabStates, closeExplorerSlideOver, codeBackend, editorTabTargetKey, editorTabs, editorTarget, mode, openPersistedEditorTab, refreshExplorer, vaultBackend, vaultTarget]);

  const createDrawing = useCallback(async (rawPath: string) => {
    const path = normalizeRelativePath(rawPath);
    const drawingPath = !path ? '' : /\.excalidraw$/i.test(path) ? path : `${path}.excalidraw`;
    if (!drawingPath) return false;

    const drawingContent = createEmptyExcalidrawFile();
    setError(undefined);
    try {
      const result = await vaultBackend.write(vaultTarget, drawingPath, drawingContent);
      const previewTabIdsToClose = editorTabs
        .filter(tab => tab.isPreview && tab.path !== result.path)
        .map(tab => tab.id);
      const tab = openPersistedEditorTab(editorTabTargetKey, result.path);
      clearEditorTabStates(previewTabIdsToClose);
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
      await refreshExplorer();
      return true;
    } catch (createError) {
      setError(toErrorMessage(createError));
      return false;
    }
  }, [clearEditorTabStates, closeExplorerSlideOver, editorTabTargetKey, editorTabs, openPersistedEditorTab, refreshExplorer, vaultBackend, vaultTarget]);

  const getSelectedCreateDirectory = useCallback(() => {
    if (!selectedNode) return '';
    return selectedNode.type === 'directory' ? selectedNode.path : getParentPath(selectedNode.path);
  }, [selectedNode]);

  const createNoteInSelectedDirectory = useCallback(async () => {
    const directoryPath = getSelectedCreateDirectory();
    const path = createUniquePath(directoryPath, 'Untitled', '.cpr', existingExplorerPaths);
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
    const rowKind = getDocumentKind(mode, node.path);
    const rowIcon = isDirectory ? (
      isExpandedNode ? <FolderOpen size={14} className="shrink-0 text-muted-foreground" /> : <Folder size={14} className="shrink-0 text-muted-foreground" />
    ) : rowKind === 'excalidraw' ? (
      <PencilRuler size={14} className="shrink-0 text-muted-foreground" />
    ) : rowKind === 'coppermind' ? (
      <Brain size={14} className="shrink-0 text-muted-foreground" />
    ) : (
      <FileIcon size={14} className="shrink-0 text-muted-foreground" />
    );
    const rowLabel = isDirectory
      ? node.name
      : node.note ? getEditorDocumentLabel(node.note.path, mode) : getEditorDocumentLabel(node.path, mode);

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

    const documentKind = getDocumentKind(mode, openBuffer.path);
    if (documentKind === 'excalidraw') {
      return (
        <ExcalidrawDocumentEditor
          focusRequest={bufferFocusRequest}
          isExpanded={isExpanded}
          path={openBuffer.path}
          theme={resolvedTheme}
          value={openBuffer.value}
          version={openBuffer.version}
          onChange={setActiveBufferValue}
        />
      );
    }

    if (documentKind === 'coppermind') {
      return (
        <CoppermindDocumentEditor
          focusRequest={bufferFocusRequest}
          isCellsSidebarOpen={isCoppermindCellsSidebarOpen}
          value={openBuffer.value}
          onChange={setActiveBufferValue}
        />
      );
    }

    return (
      <CodeMirrorEditor
        ref={editorRef}
        key={`${mode}:${openBuffer.path}`}
        editorMode={mode}
        path={openBuffer.path}
        languageIntelligenceTarget={mode === 'code' ? editorTarget : undefined}
        value={content}
        wikiLinkSuggestions={noteSuggestions}
        onChange={setActiveBufferValue}
        onGutterWidthChange={setEditorGutterWidth}
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
    if (activeEditorTab?.id !== tab.id) closePreviewEditorTab(activeEditorTab);
    setActiveEditorTab(editorTabTargetKey, tab.id);
    if (buffersByTabId[tab.id]) setBufferFocusRequest(request => request + 1);
  }, [activeEditorTab, buffersByTabId, closePreviewEditorTab, editorTabTargetKey, setActiveEditorTab]);

  const closeEditorTab = useCallback((tab: EditorTab) => {
    const buffer = buffersByTabId[tab.id];
    if (!confirmDiscardBuffer(buffer, tab.path)) return;
    closePersistedEditorTab(editorTabTargetKey, tab.id);
    clearEditorTabState(tab.id);
  }, [buffersByTabId, clearEditorTabState, closePersistedEditorTab, confirmDiscardBuffer, editorTabTargetKey]);

  const pinEditorTab = useCallback((tab: EditorTab) => {
    pinPersistedEditorTab(editorTabTargetKey, tab.id);
  }, [editorTabTargetKey, pinPersistedEditorTab]);

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
          const label = getEditorDocumentLabel(tab.path, mode);
          const isRenaming = renameState?.origin === 'tab' && renameState.path === tab.path;
          const tabKind = getDocumentKind(mode, tab.path);
          const icon = tabKind === 'excalidraw'
            ? <PencilRuler size={12} className="text-muted-foreground" />
            : tabKind === 'coppermind'
              ? <Brain size={12} className="text-muted-foreground" />
            : tabKind === 'markdown'
              ? <StickyNote size={12} className="text-muted-foreground" />
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
              onBackToPreview={proposalBackFilePath === tab.path && onBackToProposalPreview ? () => onBackToProposalPreview(tab.path) : undefined}
              onPin={() => pinEditorTab(tab)}
              onRename={() => startRename(tab.path, 'tab')}
              onSelect={() => selectEditorTab(tab)}
            />
          );
        })}
      </SortableContext>
    </DndContext>
  );

  const explorerToggleLabel = isExplorerLockedOpen
    ? 'Hide explorer'
    : isExplorerSlideOverVisible ? 'Keep explorer open' : 'Show explorer';
  const explorerToggleHoverHandlers = canUseExplorerSlideOver
    ? {
        onMouseEnter: openExplorerSlideOver,
        onMouseLeave: handleExplorerHoverMouseLeave,
      }
    : {};

  const renderExplorerRail = (presentation: 'locked' | 'slide-over') => {
    const isSlideOver = presentation === 'slide-over';

    return (
      <aside
        className="absolute bottom-0 right-0 top-0 z-20 flex w-80 max-w-full flex-col overflow-hidden border-l border-border bg-card"
        data-weave-editor-explorer
        data-presentation={presentation}
        onMouseEnter={isSlideOver ? openExplorerSlideOver : undefined}
        onMouseLeave={isSlideOver ? handleExplorerHoverMouseLeave : undefined}
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
              <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-secondary px-2">
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
        ? 'Note.cpr'
        : 'path/to/file.ts';

  return (
    <>
      <section
        className="relative z-10 flex h-full min-h-0 min-w-0 flex-1 basis-0 flex-col bg-background transition-[width] duration-150 ease-out"
        data-weave-editor-panel
        data-weave-editor-mode={mode}
        data-weave-surface="editor"
        data-expanded={isExpanded ? 'true' : 'false'}
        style={editorPanelStyle}
      >
        <div className="flex h-10 shrink-0 items-center border-b border-border" data-weave-editor-titlebar data-weave-editor-tab-bar>
          <div className="flex h-full shrink-0 items-center justify-center border-r border-border" style={{ width: 'var(--weave-editor-gutter-width)' }}>
            {mode === 'notes' ? <StickyNote size={15} className="shrink-0 text-muted-foreground" /> : <Code2 size={15} className="shrink-0 text-muted-foreground" />}
          </div>
          <div
            className={cn(
              'flex min-w-0 items-stretch self-stretch overflow-x-auto',
              hasBreadcrumb ? 'max-w-[55%] shrink' : 'flex-1',
            )}
            role="tablist"
            aria-label={mode === 'notes' ? 'Open notes' : 'Open code buffers'}
          >
            {editorTabs.length > 0 ? renderEditorTabs() : null}
          </div>
          {hasBreadcrumb ? (
            <div className="flex min-w-0 flex-1 items-center justify-center overflow-hidden px-3">
              <div className="min-w-0 max-w-full truncate">{breadcrumb}</div>
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-1 pr-3">
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
        </div>
        <div
          ref={editorBodyRef}
          className="relative flex min-h-0 flex-1"
          onMouseMove={handleEditorBodyMouseMove}
          onMouseLeave={handleEditorBodyMouseLeave}
        >
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
          {isExplorerOverlayVisible ? renderExplorerRail(isExplorerLockedOpen ? 'locked' : 'slide-over') : null}
        </div>
        <div className="relative flex h-9 shrink-0 items-center">
          {isCodeMirrorOpen ? (
            <>
              <div
                className="h-full shrink-0 bg-[var(--weave-editor-gutter-background)]"
                style={{ width: 'var(--weave-editor-gutter-width)' }}
                aria-hidden="true"
              />
              <div
                className="pointer-events-none absolute bottom-0 top-0 w-px bg-border"
                style={{ left: 'calc(var(--weave-editor-gutter-width) - 2px)' }}
                aria-hidden="true"
              />
            </>
          ) : null}
          <div
            className="pointer-events-none absolute right-0 top-0 h-px bg-border"
            style={{ left: isCodeMirrorOpen ? 'calc(var(--weave-editor-gutter-width) - 1px)' : 0 }}
            aria-hidden="true"
          />
          <div className="flex h-full min-w-0 flex-1 items-center gap-2 px-3">
            {isCoppermindOpen ? (
              <Button
                className={isCoppermindCellsSidebarOpen ? 'bg-accent' : undefined}
                size="icon-xs"
                variant="ghost"
                aria-label={coppermindCellsToggleLabel}
                title={coppermindCellsToggleLabel}
                data-active={isCoppermindCellsSidebarOpen ? 'true' : 'false'}
                onClick={() => setIsCoppermindCellsSidebarOpen(current => !current)}
              >
                {isCoppermindCellsSidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
              </Button>
            ) : null}
            {isCodeMirrorOpen ? (
              <span
                className="inline-flex h-5 min-w-[4.75rem] shrink-0 items-center justify-center rounded-sm px-2 text-[11px] font-bold"
                style={{
                  backgroundColor: modeIndicator.background,
                  color: modeIndicator.foreground,
                }}
              >
                {modeIndicator.label}
              </span>
            ) : null}
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
              {isExplorerLockedOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
            </Button>
          </div>
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
