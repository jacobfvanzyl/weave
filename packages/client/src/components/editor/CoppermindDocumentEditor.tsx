import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ColorScheme,
  EditPropsStore,
  EdgelessEditorBlockSpecs,
  LineColor,
  LineWidth,
  OverrideThemeExtension,
  PageEditorBlockSpecs,
  ShapeFillColor,
  ShapeType,
  type ShapeName,
} from '@blocksuite/blocks';
import { effects as registerBlockSuiteBlockEffects } from '@blocksuite/blocks/effects';
import { EdgelessEditor, PageEditor } from '@blocksuite/presets';
import { effects as registerBlockSuitePresetEffects } from '@blocksuite/presets/effects';
import type { Doc } from '@blocksuite/store';
import type { Signal } from '@preact/signals-core';
import '@toeverything/theme/style.css';
import {
  ChevronRight,
  Circle,
  Diamond,
  Eraser,
  Focus,
  GitBranch,
  GripVertical,
  Hand,
  Maximize2,
  Minus,
  MousePointer2,
  Pencil,
  Plus,
  Rows3,
  Square,
  SquareRoundCorner,
  Trash2,
  Triangle,
  type LucideIcon,
} from 'lucide-react';
import { type DragEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  addCoppermindBlockSuiteSection,
  coppermindCanvasCellGapPx,
  coppermindCellWidthPx,
  createCoppermindNextCanvasCellXYWH,
  createCoppermindSectionXYWHAtTopLeft,
  deleteCoppermindBlockSuiteSection,
  disposeCoppermindBlockSuiteRuntime,
  exportCoppermindBlockSuiteSnapshot,
  getCoppermindBlockSuiteSections,
  importCoppermindBlockSuiteRuntime,
  placeCoppermindBlockSuiteSection,
  reorderCoppermindBlockSuiteSection,
  unplaceCoppermindBlockSuiteSection,
  type CoppermindBlockSuiteSection,
  type CoppermindBlockSuiteRuntime,
  type CoppermindBlockSuiteSectionXYWH,
} from '../../lib/coppermind-blocksuite';
import {
  isCoppermindDocumentV2,
  isLegacyCoppermindDocument,
  migrateCoppermindDocumentToV2,
  parseCoppermindDocument,
  serializeCoppermindDocument,
  withCoppermindDocumentSnapshot,
  type CoppermindDocMode,
  type CoppermindDocument,
} from '../../lib/coppermind-document';
import { cn } from '../../lib/cn';
import { Button } from '../ui/button';

export type CoppermindDocumentEditorProps = {
  focusRequest?: number;
  value: string;
  onChange: (value: string) => void;
};

type CoppermindEditorMode = CoppermindDocMode;

type CoppermindCanvasToolId = 'default' | 'pan' | 'connector' | 'brush' | 'eraser' | 'shape';
type CoppermindCanvasMenuId = 'brush' | 'shape';

type CoppermindCanvasToolController = {
  currentToolOption$: {
    value: {
      shapeName?: ShapeName;
      type?: string;
    };
  };
  setTool: (toolName: unknown, option?: unknown) => void;
};

type CoppermindCanvasToolState = {
  activeTool?: CoppermindCanvasToolId;
  brushColor: string;
  brushLineWidth: LineWidth;
  shapeFillColor: string;
  shapeName: ShapeName;
};

type CoppermindCanvasPoint = {
  x: number;
  y: number;
};

type CoppermindCanvasApi = {
  clearSelection: () => void;
  fitToPageWidth: () => void;
  fitToScreen: () => void;
  focusSectionForEditing: (xywh: CoppermindBlockSuiteSectionXYWH) => void;
  getViewportSnapshot: () => CoppermindCanvasViewportSnapshot | undefined;
  getModelPointFromClientPoint: (clientX: number, clientY: number) => CoppermindCanvasPoint | undefined;
  locateSection: (
    sectionId: string,
    xywh: CoppermindBlockSuiteSectionXYWH,
    options?: { editing?: boolean },
  ) => void;
  resetZoom: () => void;
  restoreViewport: (snapshot: CoppermindCanvasViewportSnapshot) => void;
  zoomIn: () => void;
  zoomOut: () => void;
};

type CoppermindBlockSuiteTextChild = {
  id: string;
  text?: unknown;
};

type CoppermindBlockSuiteNoteModel = {
  children?: CoppermindBlockSuiteTextChild[];
};

type CoppermindCanvasViewport = {
  ZOOM_MAX?: number;
  ZOOM_MIN?: number;
  center?: { x: number; y: number };
  centerX?: number;
  centerY?: number;
  height?: number;
  left?: number;
  smoothZoom?: (zoom: number) => void;
  top?: number;
  zoom: number;
  setViewport: (zoom: number, center: [number, number], smooth?: boolean) => void;
  setZoom?: (zoom: number) => void;
  toModelCoord?: (viewX: number, viewY: number) => [number, number];
  toModelCoordFromClientCoord?: (point: [number, number]) => [number, number];
  viewportUpdated?: {
    on: (callback: () => void) => { dispose: () => void };
  };
  width?: number;
};

type CoppermindCanvasSelection = {
  clear?: () => void;
  clearLast?: () => void;
  editing?: boolean;
  selectedIds?: string[];
  set: (selection: { elements: string[]; editing?: boolean }) => void;
  slots?: {
    updated?: {
      on: (callback: () => void) => { dispose: () => void };
    };
  };
  surfaceSelections?: Array<{ editing?: boolean }>;
};

type CoppermindEdgelessRootBlock = HTMLElement & {
  gfx?: {
    selection?: CoppermindCanvasSelection;
    tool?: CoppermindCanvasToolController;
    viewport?: CoppermindCanvasViewport;
  };
  service?: {
    setZoomByStep?: (step: number) => void;
    selection?: CoppermindCanvasSelection;
    viewport?: CoppermindCanvasViewport;
    zoomToFit?: () => void;
  };
};

type CoppermindCanvasViewportState = {
  zoom: number;
};

type CoppermindBlockElement = HTMLElement & {
  model?: {
    id?: string;
  };
};

type CoppermindCanvasViewportSnapshot = {
  center: [number, number];
  zoom: number;
};

type CoppermindCanvasSelectionState = {
  editing: boolean;
  selectedIds: string[];
};

type CoppermindCanvasEditViewportSession = {
  sectionId: string;
  viewport: CoppermindCanvasViewportSnapshot;
};

type LoadedCoppermindState =
  | { status: 'loading' }
  | { status: 'invalid'; message: string }
  | {
    status: 'ready';
    document: CoppermindDocument;
    migratedFromLegacy: boolean;
    runtime: CoppermindBlockSuiteRuntime;
  };

const modeOptions: Array<{ id: CoppermindEditorMode; label: string }> = [
  { id: 'page', label: 'Page' },
  { id: 'edgeless', label: 'Canvas' },
];

const canvasLineWidths = [
  LineWidth.Two,
  LineWidth.Four,
  LineWidth.Six,
  LineWidth.Eight,
  LineWidth.Ten,
  LineWidth.Twelve,
];

const canvasLineColors = [
  LineColor.Yellow,
  LineColor.Orange,
  LineColor.Red,
  LineColor.Magenta,
  LineColor.Purple,
  LineColor.Blue,
  LineColor.Teal,
  LineColor.Green,
  LineColor.Grey,
  LineColor.White,
];

const canvasShapeFillColors = [
  ShapeFillColor.Yellow,
  ShapeFillColor.Orange,
  ShapeFillColor.Red,
  ShapeFillColor.Magenta,
  ShapeFillColor.Purple,
  ShapeFillColor.Blue,
  ShapeFillColor.Teal,
  ShapeFillColor.Green,
  ShapeFillColor.Grey,
  ShapeFillColor.White,
];

const canvasFitPageWidthPaddingPx = 96;
const canvasEditViewportTopPaddingPx = 32;
const canvasEditViewportVerticalPaddingPx = 64;
const canvasZoomStep = 0.25;
const canvasZoomMin = 0.1;
const canvasZoomMax = 6;

const canvasShapeTools: Array<{
  icon: LucideIcon;
  label: string;
  shapeName: ShapeName;
}> = [
  { icon: Square, label: 'Square', shapeName: ShapeType.Rect },
  { icon: Circle, label: 'Ellipse', shapeName: ShapeType.Ellipse },
  { icon: Diamond, label: 'Diamond', shapeName: ShapeType.Diamond },
  { icon: Triangle, label: 'Triangle', shapeName: ShapeType.Triangle },
  { icon: SquareRoundCorner, label: 'Rounded rectangle', shapeName: 'roundedRect' },
];

const darkBlockSuiteThemeSignal = {
  value: ColorScheme.Dark,
  peek: () => ColorScheme.Dark,
  subscribe: () => () => undefined,
} as unknown as Signal<ColorScheme>;

const coppermindBlockSuiteDarkThemeExtension = OverrideThemeExtension({
  getAppTheme: () => darkBlockSuiteThemeSignal,
  getEdgelessTheme: () => darkBlockSuiteThemeSignal,
});

const coppermindPageEditorBlockSpecs = [
  ...PageEditorBlockSpecs,
  coppermindBlockSuiteDarkThemeExtension,
];

const coppermindEdgelessEditorBlockSpecs = [
  ...EdgelessEditorBlockSpecs,
  coppermindBlockSuiteDarkThemeExtension,
];

const coppermindBlockSuiteStyles = `
  :root[data-theme="mocha"] [data-weave-editor-coppermind],
  :root[data-theme="mocha"] [data-weave-editor-coppermind] [data-theme="dark"] {
    color-scheme: dark;
    --coppermind-cell-width: ${coppermindCellWidthPx}px;
    --coppermind-page-cell-gap: 24px;
    --affine-font-family: var(--font-ui);
    --affine-font-code-family: var(--font-code);
    --affine-font-mono-family: var(--font-code);
    --affine-blue: var(--ctp-mauve);
    --affine-brand-color: var(--ctp-mauve);
    --affine-primary-color: var(--ctp-mauve);
    --affine-primary-color-04: color-mix(in oklab, var(--ctp-mauve) 10%, transparent);
    --affine-secondary-color: var(--ctp-lavender);
    --affine-text-primary-color: var(--ctp-text);
    --affine-text-secondary-color: var(--ctp-subtext0);
    --affine-text-disable-color: var(--ctp-overlay0);
    --affine-text-emphasis-color: var(--ctp-mauve);
    --affine-placeholder-color: var(--ctp-overlay1);
    --affine-link-color: var(--ctp-sapphire);
    --affine-quote-color: var(--ctp-overlay1);
    --affine-list-color: var(--ctp-overlay2);
    --affine-icon-color: var(--ctp-subtext1);
    --affine-icon-secondary: color-mix(in oklab, var(--ctp-subtext0) 70%, transparent);
    --affine-border-color: color-mix(in oklab, var(--ctp-text) 11%, transparent);
    --affine-divider-color: color-mix(in oklab, var(--ctp-text) 12%, transparent);
    --affine-hover-color: color-mix(in oklab, var(--ctp-surface1) 58%, transparent);
    --affine-hover-color-filled: var(--ctp-surface0);
    --affine-background-primary-color: var(--ctp-base);
    --affine-background-overlay-panel-color: var(--ctp-surface0);
    --affine-background-secondary-color: var(--ctp-mantle);
    --affine-background-tertiary-color: var(--ctp-surface1);
    --affine-background-code-block: color-mix(in oklab, var(--ctp-crust) 78%, var(--ctp-surface0));
    --affine-edgeless-grid-color: color-mix(in oklab, var(--ctp-text) 10%, transparent);
    --affine-active-shadow: 0 0 0 2px color-mix(in oklab, var(--ctp-mauve) 34%, transparent);
    --affine-overlay-panel-shadow: 0 10px 22px rgba(17, 17, 27, 0.34), 0 0 0 1px color-mix(in oklab, var(--ctp-text) 8%, transparent);
    --affine-menu-shadow: 0 14px 28px rgba(17, 17, 27, 0.42), 0 0 0 1px color-mix(in oklab, var(--ctp-text) 8%, transparent);
    --affine-shadow-1: 0 0 0 1px color-mix(in oklab, var(--ctp-text) 8%, transparent), 0 4px 10px rgba(17, 17, 27, 0.18);
    --affine-shadow-2: 0 0 0 1px color-mix(in oklab, var(--ctp-text) 8%, transparent), 0 8px 18px rgba(17, 17, 27, 0.24);
    --affine-shadow-3: 0 0 0 1px color-mix(in oklab, var(--ctp-text) 9%, transparent), 0 12px 28px rgba(17, 17, 27, 0.28);
    --affine-note-shadow-box: 0 0 0 1px color-mix(in oklab, var(--ctp-text) 8%, transparent), 0 10px 22px rgba(17, 17, 27, 0.22);
    --affine-note-background-white: var(--ctp-surface0);
    --affine-note-background-black: var(--ctp-crust);
    --affine-note-background-grey: var(--ctp-surface1);
    --affine-note-background-blue: color-mix(in oklab, var(--ctp-blue) 24%, var(--ctp-surface0));
    --affine-note-background-purple: color-mix(in oklab, var(--ctp-mauve) 22%, var(--ctp-surface0));
    --affine-note-background-green: color-mix(in oklab, var(--ctp-green) 18%, var(--ctp-surface0));
    --affine-note-background-red: color-mix(in oklab, var(--ctp-red) 18%, var(--ctp-surface0));
    --affine-note-background-yellow: color-mix(in oklab, var(--ctp-yellow) 18%, var(--ctp-surface0));
    --affine-note-background-orange: color-mix(in oklab, var(--ctp-peach) 20%, var(--ctp-surface0));
    --affine-note-background-teal: color-mix(in oklab, var(--ctp-teal) 20%, var(--ctp-surface0));
    --affine-note-background-magenta: color-mix(in oklab, var(--ctp-pink) 20%, var(--ctp-surface0));
    --affine-black: var(--ctp-text);
    --affine-black-10: color-mix(in oklab, var(--ctp-text) 10%, transparent);
    --affine-black-30: color-mix(in oklab, var(--ctp-text) 30%, transparent);
    --affine-black-50: color-mix(in oklab, var(--ctp-text) 50%, transparent);
    --affine-black-60: color-mix(in oklab, var(--ctp-text) 60%, transparent);
    --affine-black-80: color-mix(in oklab, var(--ctp-text) 80%, transparent);
    --affine-black-90: color-mix(in oklab, var(--ctp-text) 90%, transparent);
    --affine-white: var(--ctp-crust);
    --affine-white-10: color-mix(in oklab, var(--ctp-crust) 10%, transparent);
    --affine-white-30: color-mix(in oklab, var(--ctp-crust) 30%, transparent);
    --affine-white-50: color-mix(in oklab, var(--ctp-crust) 50%, transparent);
    --affine-white-60: color-mix(in oklab, var(--ctp-crust) 60%, transparent);
    --affine-white-80: color-mix(in oklab, var(--ctp-crust) 80%, transparent);
    --affine-white-90: color-mix(in oklab, var(--ctp-crust) 90%, transparent);
  }

  :root[data-theme="mocha"] [data-weave-editor-coppermind] page-editor,
  :root[data-theme="mocha"] [data-weave-editor-coppermind] edgeless-editor {
    background: var(--ctp-base);
    color: var(--ctp-text);
  }

  [data-weave-editor-coppermind] page-editor,
  [data-weave-editor-coppermind] page-editor .affine-page-viewport {
    overflow-x: visible;
  }

  [data-weave-editor-coppermind] page-editor affine-note {
    display: block;
    position: relative;
    box-sizing: border-box;
    width: var(--coppermind-cell-width);
    max-width: var(--coppermind-cell-width);
    overflow: visible;
    margin: 0;
    padding: 18px;
    border: 1px solid rgba(15, 23, 42, 0.14);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.98);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05);
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }

  :root[data-theme="mocha"] [data-weave-editor-coppermind] page-editor affine-note {
    border-color: color-mix(in oklab, var(--ctp-text) 10%, transparent);
    background: color-mix(in oklab, var(--ctp-surface0) 92%, var(--ctp-base));
    box-shadow: 0 0 0 1px color-mix(in oklab, var(--ctp-crust) 48%, transparent), 0 8px 18px rgba(17, 17, 27, 0.24);
  }

  [data-weave-editor-coppermind] page-editor affine-note:not(:last-of-type) {
    margin-bottom: var(--coppermind-page-cell-gap, 24px);
  }

  [data-weave-editor-coppermind] page-editor affine-note[data-coppermind-active-section="true"] {
    border-color: rgba(124, 58, 237, 0.48);
    box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.13), 0 1px 2px rgba(15, 23, 42, 0.05);
  }

  :root[data-theme="mocha"] [data-weave-editor-coppermind] page-editor affine-note[data-coppermind-active-section="true"] {
    border-color: color-mix(in oklab, var(--ctp-mauve) 58%, transparent);
    box-shadow: 0 0 0 2px color-mix(in oklab, var(--ctp-mauve) 18%, transparent), 0 8px 18px rgba(17, 17, 27, 0.24);
  }

  [data-weave-editor-coppermind] page-editor .affine-page-root-block-container {
    display: block;
    position: relative;
    overflow: visible;
    padding-block: var(--coppermind-page-cell-gap, 24px);
    --affine-editor-side-padding: 24px;
  }

  [data-weave-editor-coppermind] affine-drag-handle-widget {
    display: none !important;
  }

  [data-weave-editor-coppermind] page-editor .with-drag-handle .heading-icon,
  [data-weave-editor-coppermind] page-editor affine-paragraph-heading-icon {
    display: none !important;
    opacity: 0 !important;
    pointer-events: none !important;
  }

  [data-weave-editor-coppermind] page-editor .affine-note-block-container {
    min-height: 96px;
  }

  :root[data-theme="mocha"] [data-weave-editor-coppermind] page-editor .affine-note-block-container.selected {
    background-color: color-mix(in oklab, var(--ctp-surface1) 54%, transparent);
  }

  :root[data-theme="mocha"] [data-weave-editor-coppermind] :is(affine-code, .affine-code-block-container) {
    color: var(--ctp-text);
  }

  :root[data-theme="mocha"] [data-weave-editor-coppermind] .affine-code-block-container {
    border-color: color-mix(in oklab, var(--ctp-text) 8%, transparent);
    background: var(--affine-background-code-block);
  }

  :root[data-theme="mocha"] [data-weave-editor-coppermind] .affine-paragraph-placeholder {
    color: var(--ctp-overlay1);
  }

  :root[data-theme="mocha"] [data-weave-editor-coppermind] ::selection {
    background: color-mix(in oklab, var(--ctp-mauve) 34%, transparent);
    color: var(--ctp-text);
  }

  [data-weave-editor-coppermind] affine-edgeless-zoom-toolbar-widget,
  [data-weave-editor-coppermind] edgeless-toolbar-widget,
  [data-weave-editor-coppermind] edgeless-zoom-toolbar,
  [data-weave-editor-coppermind] zoom-bar-toggle-button {
    display: none !important;
  }

  [data-weave-editor-coppermind] affine-edgeless-note:not([data-coppermind-canvas-editing="true"]) :is(rich-text, [contenteditable="true"]) {
    caret-color: transparent;
    pointer-events: none;
    user-select: none;
  }

`;

const getElementFromNode = (node: Node | null) => (
  node instanceof Element ? node : node?.parentElement ?? null
);

const getClosestSectionElement = (element: Element | null, root: HTMLElement) => {
  const note = element?.closest<HTMLElement>('affine-note');
  return note && root.contains(note) ? note : undefined;
};

const getBlockElementId = (element: CoppermindBlockElement | undefined) => (
  element?.dataset.blockId
    ?? element?.getAttribute('data-block-id')
    ?? element?.model?.id
);

let blockSuiteElementsRegistered = false;

const registerBlockSuiteElements = () => {
  if (typeof customElements === 'undefined' || blockSuiteElementsRegistered) return;

  if (
    !customElements.get('affine-page-root')
    || !customElements.get('affine-paragraph')
    || !customElements.get('affine-drag-handle-widget')
  ) {
    registerBlockSuiteBlockEffects();
  }

  if (!customElements.get('page-editor') || !customElements.get('edgeless-editor')) {
    registerBlockSuitePresetEffects();
  }

  blockSuiteElementsRegistered = true;
};

const normalizeMode = (mode: unknown): CoppermindEditorMode => (
  mode === 'edgeless' ? 'edgeless' : 'page'
);

const getErrorMessage = (error: unknown) => (
  error instanceof Error ? error.message : 'Unable to open this Coppermind document.'
);

const normalizeCanvasToolId = (toolType: string | undefined): CoppermindCanvasToolId | undefined => {
  switch (toolType) {
    case 'default':
    case 'pan':
    case 'connector':
    case 'brush':
    case 'eraser':
    case 'shape':
      return toolType;
    default:
      return undefined;
  }
};

const isTransparentColor = (color: string) => color.toLowerCase().endsWith('transparent');

const shapeStrokeFromFill = (fillColor: string) => {
  const strokeColor = fillColor.replace('--affine-palette-shape-', '--affine-palette-line-');
  return isTransparentColor(strokeColor) ? LineColor.Grey : strokeColor;
};

const coppermindSectionDragDataType = 'application/x-coppermind-section-id';

const isSectionDragEvent = (event: DragEvent<HTMLElement>) => (
  Array.from(event.dataTransfer.types).includes(coppermindSectionDragDataType)
);

const getEdgelessRootBlock = (
  editor: EdgelessEditor,
  doc: Doc,
): CoppermindEdgelessRootBlock | undefined => {
  const rootId = doc.root?.id;
  if (!rootId) return undefined;
  return editor.std?.view.getBlock(rootId) as CoppermindEdgelessRootBlock | undefined;
};

const getCanvasToolController = (
  editor: EdgelessEditor,
  doc: Doc,
): CoppermindCanvasToolController | undefined => {
  const rootBlock = getEdgelessRootBlock(editor, doc);
  return rootBlock?.gfx?.tool;
};

const createCanvasApi = (
  editor: EdgelessEditor,
  doc: Doc,
): CoppermindCanvasApi | undefined => {
  const getRootBlock = () => getEdgelessRootBlock(editor, doc);
  const getViewport = () => getRootBlock()?.gfx?.viewport ?? getRootBlock()?.service?.viewport;
  const getService = () => getRootBlock()?.service;
  const getSelection = () => getRootBlock()?.gfx?.selection ?? getRootBlock()?.service?.selection;
  const clearSelection = () => {
    const selection = getSelection();
    selection?.clear?.();
    selection?.clearLast?.();
  };
  const clampZoom = (zoom: number, viewport: CoppermindCanvasViewport) => (
    Math.min(viewport.ZOOM_MAX ?? canvasZoomMax, Math.max(viewport.ZOOM_MIN ?? canvasZoomMin, zoom))
  );
  const getCenter = (viewport: CoppermindCanvasViewport): [number, number] => [
    viewport.centerX ?? viewport.center?.x ?? 0,
    viewport.centerY ?? viewport.center?.y ?? 0,
  ];
  const getViewportSnapshot = (): CoppermindCanvasViewportSnapshot | undefined => {
    const currentViewport = getViewport();
    if (!currentViewport) return undefined;

    return {
      center: getCenter(currentViewport),
      zoom: currentViewport.zoom,
    };
  };
  const smoothZoom = (zoom: number) => {
    const currentViewport = getViewport();
    if (!currentViewport) return;
    const nextZoom = clampZoom(zoom, currentViewport);
    if (currentViewport.smoothZoom) {
      currentViewport.smoothZoom(nextZoom);
      return;
    }
    currentViewport.setViewport(nextZoom, getCenter(currentViewport), true);
  };
  const focusSectionTextStart = (sectionId: string) => {
    const section = doc.getBlockById(sectionId) as CoppermindBlockSuiteNoteModel | null;
    const firstTextChild = section?.children?.find(child => child.text);
    const selection = editor.std?.selection;
    if (!firstTextChild || !selection) return;

    selection.setGroup('note', [
      selection.create('text', {
        from: {
          blockId: firstTextChild.id,
          index: 0,
          length: 0,
        },
        to: null,
      }),
    ]);
  };
  const viewport = getViewport();
  if (!viewport) return undefined;

  return {
    clearSelection: () => {
      clearSelection();
      window.requestAnimationFrame(clearSelection);
    },
    fitToPageWidth: () => {
      const currentViewport = getViewport();
      if (!currentViewport) return;

      const viewportWidth = currentViewport.width ?? 0;
      const availableWidth = Math.max(1, viewportWidth - canvasFitPageWidthPaddingPx);
      const nextZoom = clampZoom(availableWidth / coppermindCellWidthPx, currentViewport);
      const [, centerY] = getCenter(currentViewport);
      currentViewport.setViewport(nextZoom, [0, centerY], true);
    },
    fitToScreen: () => {
      getService()?.zoomToFit?.();
    },
    focusSectionForEditing: xywh => {
      const currentViewport = getViewport();
      if (!currentViewport) return;

      const [x, y, width, height] = xywh;
      const viewportWidth = currentViewport.width ?? 0;
      const viewportHeight = currentViewport.height ?? 0;
      const availableWidth = Math.max(1, viewportWidth - canvasFitPageWidthPaddingPx);
      const nextZoom = clampZoom(availableWidth / Math.max(1, width), currentViewport);
      const availableHeight = Math.max(1, viewportHeight - canvasEditViewportVerticalPaddingPx);
      const nextCenterY = height * nextZoom > availableHeight
        ? y + (viewportHeight / 2 - canvasEditViewportTopPaddingPx) / nextZoom
        : y + height / 2;

      currentViewport.setViewport(
        nextZoom,
        [x + width / 2, nextCenterY],
        true,
      );
    },
    getViewportSnapshot,
    getModelPointFromClientPoint: (clientX, clientY) => {
      const currentViewport = getViewport();
      if (!currentViewport) return undefined;

      const point = currentViewport.toModelCoordFromClientCoord
        ? currentViewport.toModelCoordFromClientCoord([clientX, clientY])
        : currentViewport.toModelCoord?.(
          clientX - (currentViewport.left ?? 0),
          clientY - (currentViewport.top ?? 0),
        );
      if (!point) return undefined;

      const [x, y] = point;
      return { x, y };
    },
    locateSection: (sectionId, xywh, options) => {
      const currentViewport = getViewport();
      if (!currentViewport) return;

      const [x, y, w, h] = xywh;
      if (!options?.editing) {
        currentViewport.setViewport(
          currentViewport.zoom,
          [x + w / 2, y + h / 2],
          true,
        );
      }

      window.requestAnimationFrame(() => {
        getSelection()?.set({ elements: [sectionId], editing: options?.editing ?? false });
        if (options?.editing) {
          window.requestAnimationFrame(() => focusSectionTextStart(sectionId));
        }
      });
    },
    resetZoom: () => {
      smoothZoom(1);
    },
    restoreViewport: snapshot => {
      const currentViewport = getViewport();
      if (!currentViewport) return;
      currentViewport.setViewport(snapshot.zoom, snapshot.center, true);
    },
    zoomIn: () => {
      const service = getService();
      if (service?.setZoomByStep) {
        service.setZoomByStep(canvasZoomStep);
        return;
      }
      const currentViewport = getViewport();
      if (currentViewport) smoothZoom(currentViewport.zoom + canvasZoomStep);
    },
    zoomOut: () => {
      const service = getService();
      if (service?.setZoomByStep) {
        service.setZoomByStep(-canvasZoomStep);
        return;
      }
      const currentViewport = getViewport();
      if (currentViewport) smoothZoom(currentViewport.zoom - canvasZoomStep);
    },
  };
};

const getCanvasToolState = (
  controller: CoppermindCanvasToolController,
  editPropsStore: EditPropsStore,
): CoppermindCanvasToolState => {
  const props = editPropsStore.lastProps$.value;
  const currentTool = controller.currentToolOption$.value;
  const shapeName = currentTool.type === 'shape'
    ? currentTool.shapeName ?? ShapeType.Rect
    : ShapeType.Rect;
  const shapeProps = props[`shape:${shapeName}`];

  return {
    activeTool: normalizeCanvasToolId(currentTool.type),
    brushColor: props.brush.color as string,
    brushLineWidth: props.brush.lineWidth,
    shapeFillColor: shapeProps.fillColor as string,
    shapeName,
  };
};

const getCanvasToolBindings = (
  controller: CoppermindCanvasToolController | undefined,
  editPropsStore: EditPropsStore | undefined,
) => ({
  selectBrush: () => {
    controller?.setTool('brush');
  },
  selectConnector: () => {
    if (!controller || !editPropsStore) return;
    const mode = editPropsStore.lastProps$.value.connector.mode;
    controller.setTool('connector', { mode });
  },
  selectEraser: () => {
    controller?.setTool('eraser');
  },
  selectPointer: (activeTool?: CoppermindCanvasToolId) => {
    if (!controller) return;
    if (activeTool === 'default') {
      controller.setTool('pan', { panning: false });
      return;
    }
    controller?.setTool('default');
  },
  selectShape: (shapeName?: ShapeName) => {
    if (!controller) return;
    const nextShape = shapeName ?? ShapeType.Rect;
    controller.setTool('shape', { shapeName: nextShape });
  },
  updateBrush: (props: { color?: string; lineWidth?: LineWidth }) => {
    if (!controller || !editPropsStore) return;
    editPropsStore.recordLastProps('brush', props);
    controller.setTool('brush');
  },
  updateShapeFill: (shapeName: ShapeName, fillColor: string) => {
    if (!controller || !editPropsStore) return;
    editPropsStore.recordLastProps(`shape:${shapeName}`, {
      filled: !isTransparentColor(fillColor),
      fillColor,
      strokeColor: shapeStrokeFromFill(fillColor),
    });
    controller.setTool('shape', { shapeName });
  },
});

const ColorSwatch = ({
  active,
  color,
  onClick,
  title,
}: {
  active: boolean;
  color: string;
  onClick: () => void;
  title: string;
}) => (
  <button
    type="button"
    aria-label={title}
    title={title}
    className={cn(
      'grid h-6 w-6 place-items-center rounded border border-transparent hover:border-primary/50',
      active && 'border-primary bg-primary/15',
    )}
    onClick={onClick}
  >
    <span
      className="h-4 w-4 rounded-full border border-border"
      style={{ background: color.startsWith('--') ? `var(${color})` : color }}
    />
  </button>
);

const LineWidthButton = ({
  active,
  onClick,
  width,
}: {
  active: boolean;
  onClick: () => void;
  width: LineWidth;
}) => (
  <button
    type="button"
    aria-label={`${width}px line width`}
    title={`${width}px`}
    className={cn(
      'grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground',
      active && 'bg-primary/20 text-primary',
    )}
    onClick={onClick}
  >
    <span className="rounded-full bg-current" style={{ height: width, width: width }} />
  </button>
);

const CoppermindCanvasMenu = ({
  bindings,
  menu,
  state,
}: {
  bindings: ReturnType<typeof getCanvasToolBindings>;
  menu: CoppermindCanvasMenuId;
  state: CoppermindCanvasToolState;
}) => {
  if (menu === 'brush') {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          {canvasLineWidths.map(width => (
            <LineWidthButton
              key={width}
              active={state.brushLineWidth === width}
              width={width}
              onClick={() => bindings.updateBrush({ lineWidth: width })}
            />
          ))}
        </div>
        <div className="h-5 w-px bg-border" />
        <div className="flex items-center gap-1">
          {canvasLineColors.map(color => (
            <ColorSwatch
              key={color}
              active={state.brushColor === color}
              color={color}
              title={color.replace('--affine-palette-line-', '')}
              onClick={() => bindings.updateBrush({ color })}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1">
        {canvasShapeTools.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.shapeName}
              type="button"
              aria-label={item.label}
              title={item.label}
              className={cn(
                'grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground',
                state.shapeName === item.shapeName && 'bg-primary/20 text-primary',
              )}
              onClick={() => bindings.selectShape(item.shapeName)}
            >
              <Icon size={16} strokeWidth={2} />
            </button>
          );
        })}
      </div>
      <div className="h-5 w-px bg-border" />
      <div className="flex items-center gap-1">
        {canvasShapeFillColors.map(color => (
          <ColorSwatch
            key={color}
            active={state.shapeFillColor === color}
            color={color}
            title={color.replace('--affine-palette-shape-', '')}
            onClick={() => bindings.updateShapeFill(state.shapeName, color)}
          />
        ))}
      </div>
    </div>
  );
};

const CoppermindCanvasToolbar = ({
  controller,
  editPropsStore,
  state,
}: {
  controller?: CoppermindCanvasToolController;
  editPropsStore?: EditPropsStore;
  state?: CoppermindCanvasToolState;
}) => {
  const [openMenu, setOpenMenu] = useState<CoppermindCanvasMenuId | undefined>(undefined);
  const bindings = getCanvasToolBindings(controller, editPropsStore);
  const disabled = !controller || !editPropsStore || !state;

  useEffect(() => {
    if (disabled) setOpenMenu(undefined);
  }, [disabled]);

  useEffect(() => {
    if (disabled || !controller) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenMenu(undefined);
      controller.setTool('default');
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement
        && activeElement.closest('[data-coppermind-canvas-toolbar="true"]')
      ) {
        activeElement.blur();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [controller, disabled]);

  const toolButton = ({
    icon: Icon,
    id,
    label,
    menu,
    onClick,
  }: {
    icon: LucideIcon;
    id: CoppermindCanvasToolId;
    label: string;
    menu?: CoppermindCanvasMenuId;
    onClick: () => void;
  }) => {
    const isActive = state?.activeTool === id;
    const isMenuOpen = menu && openMenu === menu;

    const button = (
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled}
        className={cn(
          'rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45',
          menu
            ? 'grid h-9 w-[2.875rem] grid-cols-[1.125rem_auto] items-center justify-start gap-0.5 px-1.5 [&>svg:first-child]:justify-self-center'
            : 'grid h-9 w-9 place-items-center p-0',
          (isActive || isMenuOpen) && 'bg-primary/20 text-primary shadow-sm',
        )}
        onClick={() => {
          onClick();
          setOpenMenu(current => (menu ? (current === menu ? undefined : menu) : undefined));
        }}
      >
        <Icon size={18} strokeWidth={2} />
        {menu ? <ChevronRight size={13} strokeWidth={2} /> : null}
      </button>
    );

    if (!menu) return button;

    return (
      <div className="relative">
        {button}
        {isMenuOpen && state ? (
          <div className="absolute left-full top-1/2 z-30 ml-2 max-w-[calc(100vw-7rem)] -translate-y-1/2 overflow-x-auto rounded-lg border border-border bg-card/95 p-2 shadow-xl backdrop-blur">
            <CoppermindCanvasMenu bindings={bindings} menu={menu} state={state} />
          </div>
        ) : null}
      </div>
    );
  };

  const pointerActive = state?.activeTool === 'default' || state?.activeTool === 'pan';
  const PointerIcon = state?.activeTool === 'pan' ? Hand : MousePointer2;
  const pointerLabel = state?.activeTool === 'pan' ? 'Hand' : 'Select';

  return (
    <div className="pointer-events-none absolute bottom-5 left-5 z-20 flex">
      <div className="pointer-events-auto relative">
        <div
          data-coppermind-canvas-toolbar="true"
          className="inline-flex flex-col items-start gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-xl backdrop-blur"
        >
          <button
            type="button"
            aria-label={pointerLabel}
            title={pointerLabel}
            disabled={disabled}
            className={cn(
              'grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45',
              pointerActive && 'bg-primary/20 text-primary shadow-sm',
            )}
            onClick={() => {
              bindings.selectPointer(state?.activeTool);
              setOpenMenu(undefined);
            }}
          >
            <PointerIcon size={18} strokeWidth={2} />
          </button>
          {toolButton({
            icon: Pencil,
            id: 'brush',
            label: 'Pen',
            menu: 'brush',
            onClick: bindings.selectBrush,
          })}
          {toolButton({
            icon: Eraser,
            id: 'eraser',
            label: 'Eraser',
            onClick: bindings.selectEraser,
          })}
          {toolButton({
            icon: Square,
            id: 'shape',
            label: 'Shape',
            menu: 'shape',
            onClick: () => bindings.selectShape(state?.shapeName),
          })}
          {toolButton({
            icon: GitBranch,
            id: 'connector',
            label: 'Connector',
            onClick: bindings.selectConnector,
          })}
        </div>
      </div>
    </div>
  );
};

const CoppermindCanvasViewportToolbar = ({
  api,
  editPunchInEnabled,
  onArrangeAsPage,
  onToggleEditPunchIn,
  zoom,
}: {
  api?: CoppermindCanvasApi;
  editPunchInEnabled: boolean;
  onArrangeAsPage: () => void;
  onToggleEditPunchIn: () => void;
  zoom?: number;
}) => {
  const disabled = !api;
  const formattedZoom = `${Math.round((zoom ?? 1) * 100)}%`;
  const viewportButton = ({
    active,
    icon: Icon,
    label,
    onClick,
  }: {
    active?: boolean;
    icon: LucideIcon;
    label: string;
    onClick: () => void;
  }) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      className={cn(
        'grid h-8 w-full place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45',
        active && 'bg-primary/20 text-primary shadow-sm hover:bg-primary/25 hover:text-primary',
      )}
      onClick={onClick}
    >
      <Icon size={17} strokeWidth={2} />
    </button>
  );

  return (
    <div className="pointer-events-none absolute left-4 top-4 z-30">
      <div
        className="pointer-events-auto inline-flex flex-col gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-xl backdrop-blur"
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onPointerDown={event => event.stopPropagation()}
      >
        <div className="grid w-36 grid-cols-3 gap-1">
          {viewportButton({
            icon: Maximize2,
            label: 'Fit to screen',
            onClick: () => api?.fitToScreen(),
          })}
          {viewportButton({
            icon: Rows3,
            label: 'Arrange as page',
            onClick: onArrangeAsPage,
          })}
          {viewportButton({
            active: editPunchInEnabled,
            icon: Focus,
            label: editPunchInEnabled ? 'Disable edit punch-in' : 'Enable edit punch-in',
            onClick: onToggleEditPunchIn,
          })}
        </div>
        <div className="grid w-36 grid-cols-3 gap-1 border-t border-border pt-1">
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={disabled}
            className="grid h-8 w-full place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => api?.zoomOut()}
          >
            <Minus size={17} strokeWidth={2.2} />
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            title="Reset zoom"
            disabled={disabled}
            className="h-8 w-full rounded-md px-2 text-sm tabular-nums text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => api?.resetZoom()}
          >
            {formattedZoom}
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={disabled}
            className="grid h-8 w-full place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => api?.zoomIn()}
          >
            <Plus size={18} strokeWidth={2.1} />
          </button>
        </div>
      </div>
    </div>
  );
};

const BlockSuiteEditorMount = ({
  doc,
  mode,
  onCanvasApiChange,
  onCanvasViewportChange,
  onCanvasSelectionChange,
}: {
  doc: Doc;
  mode: CoppermindEditorMode;
  onCanvasApiChange?: (api: CoppermindCanvasApi | undefined) => void;
  onCanvasViewportChange?: (state: CoppermindCanvasViewportState | undefined) => void;
  onCanvasSelectionChange?: (state: CoppermindCanvasSelectionState) => void;
}) => {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [canvasEditPropsStore, setCanvasEditPropsStore] = useState<EditPropsStore>();
  const [canvasToolController, setCanvasToolController] = useState<CoppermindCanvasToolController>();
  const [canvasToolState, setCanvasToolState] = useState<CoppermindCanvasToolState>();

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    registerBlockSuiteElements();
    const editor = mode === 'page' ? new PageEditor() : new EdgelessEditor();
    let disposed = false;
    let resolveFrame: number | undefined;
    let syncFrame: number | undefined;
    let selectionSubscription: { dispose: () => void } | undefined;
    let viewportSubscription: { dispose: () => void } | undefined;
    let lastCanvasSelectionState: CoppermindCanvasSelectionState = {
      editing: false,
      selectedIds: [],
    };
    let isMiddleButtonPanning = false;
    let middleButtonPanClearHandle: number | undefined;
    let canvasCellEditingStateSyncFrame: number | undefined;
    let canvasCellEditingStateObserver: MutationObserver | undefined;
    let suppressCanvasCellTextInput = false;
    let setCanvasSelectionEditing: ((noteId: string, editing: boolean) => void) | undefined;
    let resolveAttempts = 0;

    editor.doc = doc;
    editor.specs = mode === 'page'
      ? coppermindPageEditorBlockSpecs
      : coppermindEdgelessEditorBlockSpecs;
    editor.className = 'block h-full min-h-0 w-full';
    mount.replaceChildren(editor);

    const clearMiddleButtonPanSoon = () => {
      if (middleButtonPanClearHandle !== undefined) {
        window.clearTimeout(middleButtonPanClearHandle);
      }
      middleButtonPanClearHandle = window.setTimeout(() => {
        middleButtonPanClearHandle = undefined;
        isMiddleButtonPanning = false;
      }, 150);
    };
    const handleMiddleButtonPointerDown = (event: PointerEvent) => {
      if (event.button !== 1) return;
      if (middleButtonPanClearHandle !== undefined) {
        window.clearTimeout(middleButtonPanClearHandle);
        middleButtonPanClearHandle = undefined;
      }
      isMiddleButtonPanning = true;
    };
    const handleMiddleButtonPointerEnd = (event: PointerEvent) => {
      if (event.button !== 1 && (event.buttons & 4) !== 0) return;
      clearMiddleButtonPanSoon();
    };
    const clearMiddleButtonPan = () => {
      if (middleButtonPanClearHandle !== undefined) {
        window.clearTimeout(middleButtonPanClearHandle);
        middleButtonPanClearHandle = undefined;
      }
      isMiddleButtonPanning = false;
    };
    const clearNativeLayerText = (layer: HTMLElement) => {
      for (const node of Array.from(layer.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
          node.remove();
        }
      }
    };
    const clearCanvasCellNativeLayerText = () => {
      for (const layer of mount.querySelectorAll<HTMLElement>('.affine-note-mask, .note-background')) {
        clearNativeLayerText(layer);
      }
    };
    const syncCanvasCellEditingState = () => {
      clearCanvasCellNativeLayerText();
      const editableIds = new Set(
        lastCanvasSelectionState.editing ? lastCanvasSelectionState.selectedIds : [],
      );
      for (const note of mount.querySelectorAll<CoppermindBlockElement>('affine-edgeless-note')) {
        const noteId = getBlockElementId(note);
        if (noteId && editableIds.has(noteId)) {
          note.dataset.coppermindCanvasEditing = 'true';
        } else {
          delete note.dataset.coppermindCanvasEditing;
        }
      }
    };
    const scheduleCanvasCellEditingStateSync = () => {
      if (canvasCellEditingStateSyncFrame !== undefined) return;
      canvasCellEditingStateSyncFrame = window.requestAnimationFrame(() => {
        canvasCellEditingStateSyncFrame = undefined;
        syncCanvasCellEditingState();
      });
    };
    const getNativeSelectionElements = () => {
      const selection = mount.ownerDocument.getSelection();
      if (!selection || selection.rangeCount === 0) return [];

      const range = selection.getRangeAt(0);
      const elements = [
        getElementFromNode(range.commonAncestorContainer),
        getElementFromNode(selection.anchorNode),
        getElementFromNode(selection.focusNode),
      ];

      return elements.filter((element): element is Element => Boolean(element && mount.contains(element)));
    };

    const getNativeSelectionNote = () => {
      for (const element of getNativeSelectionElements()) {
        const note = element.closest<HTMLElement>('affine-edgeless-note');
        if (note && mount.contains(note)) return note;
      }
      return undefined;
    };

    const isNativeSelectionInBlockText = () => (
      getNativeSelectionElements().some(element => (
        Boolean(element.closest('rich-text, .inline-editor'))
      ))
    );

    const isCanvasCellNativeLayerInput = () => (
      suppressCanvasCellTextInput
      || (Boolean(getNativeSelectionNote()) && !isNativeSelectionInBlockText())
    );

    const clearNativeSelectionNoteLayerText = () => {
      const note = getNativeSelectionNote();
      if (!note) return;
      for (const layer of note.querySelectorAll<HTMLElement>('.affine-note-mask, .note-background')) {
        clearNativeLayerText(layer);
      }
    };

    const suppressCanvasCellNativeLayerInput = (event: Event) => {
      if (!isCanvasCellNativeLayerInput()) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      clearNativeSelectionNoteLayerText();
      mount.ownerDocument.getSelection()?.removeAllRanges();
      if (mount.ownerDocument.activeElement instanceof HTMLElement) {
        mount.ownerDocument.activeElement.blur();
      }
      suppressCanvasCellTextInput = false;
    };
    const suppressCanvasCellNativeLayerKeydown = (event: KeyboardEvent) => {
      if (
        event.metaKey
        || event.ctrlKey
        || event.altKey
        || (
          event.key.length !== 1
          && !['Backspace', 'Delete', 'Enter'].includes(event.key)
        )
      ) {
        return;
      }
      suppressCanvasCellNativeLayerInput(event);
    };
    const getCanvasCellFromPointerEvent = (event: PointerEvent | MouseEvent) => {
      const path = event.composedPath();
      for (const target of path) {
        if (target instanceof HTMLElement) {
          const note = target.closest<HTMLElement>('affine-edgeless-note');
          if (note && mount.contains(note)) return note;
        }
      }

      const target = mount.ownerDocument.elementFromPoint(event.clientX, event.clientY);
      return target?.closest<HTMLElement>('affine-edgeless-note') ?? undefined;
    };
    const isPointInCanvasCellBlockText = (note: HTMLElement, clientX: number, clientY: number) => (
      [...note.querySelectorAll<HTMLElement>('rich-text, .inline-editor')].some(element => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;

        const hitSlop = 4;
        return (
          clientX >= rect.left - hitSlop
          && clientX <= rect.right + hitSlop
          && clientY >= rect.top - hitSlop
          && clientY <= rect.bottom + hitSlop
        );
      })
    );
    const clearCanvasCellTextSelectionSoon = (note: HTMLElement) => {
      const noteId = getBlockElementId(note as CoppermindBlockElement);
      window.requestAnimationFrame(() => {
        if (!suppressCanvasCellTextInput) return;
        if (noteId) {
          setCanvasSelectionEditing?.(noteId, false);
        }

        if (isNativeSelectionInBlockText()) {
          mount.ownerDocument.getSelection()?.removeAllRanges();
        }
        if (mount.ownerDocument.activeElement instanceof HTMLElement) {
          mount.ownerDocument.activeElement.blur();
        }
      });
    };
    const handleCanvasCellTextPointer = (event: PointerEvent | MouseEvent) => {
      const note = getCanvasCellFromPointerEvent(event);
      if (!note) {
        suppressCanvasCellTextInput = false;
        return;
      }

      suppressCanvasCellTextInput = !isPointInCanvasCellBlockText(note, event.clientX, event.clientY);
      if (suppressCanvasCellTextInput) {
        clearCanvasCellTextSelectionSoon(note);
      }
    };

    if (mode === 'edgeless' && editor instanceof EdgelessEditor) {
      canvasCellEditingStateObserver = new MutationObserver(scheduleCanvasCellEditingStateSync);
      canvasCellEditingStateObserver.observe(mount, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      mount.addEventListener('pointerdown', handleMiddleButtonPointerDown, true);
      mount.addEventListener('pointerdown', handleCanvasCellTextPointer, true);
      mount.addEventListener('click', handleCanvasCellTextPointer, true);
      mount.addEventListener('dblclick', handleCanvasCellTextPointer, true);
      mount.ownerDocument.addEventListener('beforeinput', suppressCanvasCellNativeLayerInput, true);
      mount.ownerDocument.addEventListener('compositionstart', suppressCanvasCellNativeLayerInput, true);
      mount.ownerDocument.addEventListener('paste', suppressCanvasCellNativeLayerInput, true);
      mount.ownerDocument.addEventListener('keydown', suppressCanvasCellNativeLayerKeydown, true);
      window.addEventListener('pointerup', handleMiddleButtonPointerEnd, true);
      window.addEventListener('pointercancel', clearMiddleButtonPan, true);
      window.addEventListener('blur', clearMiddleButtonPan);

      const resolveCanvasController = () => {
        if (disposed || !(editor instanceof EdgelessEditor)) return;

        const controller = getCanvasToolController(editor, doc);
        const editPropsStore = editor.std?.get(EditPropsStore);
        if (!controller || !editPropsStore) {
          if (resolveAttempts < 8) {
            resolveAttempts += 1;
            resolveFrame = window.requestAnimationFrame(resolveCanvasController);
          }
          return;
        }

        setCanvasToolController(controller);
        setCanvasEditPropsStore(editPropsStore);
        onCanvasApiChange?.(createCanvasApi(editor, doc));
        const viewport = getEdgelessRootBlock(editor, doc)?.gfx?.viewport
          ?? getEdgelessRootBlock(editor, doc)?.service?.viewport;
        const emitCanvasViewport = () => {
          onCanvasViewportChange?.(viewport ? { zoom: viewport.zoom } : undefined);
        };
        emitCanvasViewport();
        viewportSubscription?.dispose();
        viewportSubscription = viewport?.viewportUpdated?.on(emitCanvasViewport);
        const selection = getEdgelessRootBlock(editor, doc)?.gfx?.selection
          ?? getEdgelessRootBlock(editor, doc)?.service?.selection;
        setCanvasSelectionEditing = (noteId, editing) => {
          selection?.set({ elements: [noteId], editing });
        };
        const emitCanvasSelection = () => {
          const selectedIds = selection?.selectedIds ?? [];
          const editing = selection?.editing
            ?? selection?.surfaceSelections?.some(item => item.editing)
            ?? false;
          const activeTool = normalizeCanvasToolId(controller.currentToolOption$.value.type);
          const isPanningSelectionGap = (
            (activeTool === 'pan' || isMiddleButtonPanning)
            && selectedIds.length === 0
            && lastCanvasSelectionState.selectedIds.length > 0
          );

          if (isPanningSelectionGap) {
            const preservedSelectedIds = [...lastCanvasSelectionState.selectedIds];
            lastCanvasSelectionState = {
              editing: false,
              selectedIds: preservedSelectedIds,
            };
            syncCanvasCellEditingState();
            window.requestAnimationFrame(() => {
              if (
                (
                  normalizeCanvasToolId(controller.currentToolOption$.value.type) === 'pan'
                  || isMiddleButtonPanning
                )
                && (selection?.selectedIds ?? []).length === 0
              ) {
                selection?.set({ elements: preservedSelectedIds, editing: false });
              }
            });
            onCanvasSelectionChange?.(lastCanvasSelectionState);
            return;
          }

          if (selectedIds.length === 0) {
            selection?.clearLast?.();
          }
          lastCanvasSelectionState = { editing, selectedIds };
          syncCanvasCellEditingState();
          onCanvasSelectionChange?.(lastCanvasSelectionState);
        };
        emitCanvasSelection();
        selectionSubscription?.dispose();
        selectionSubscription = selection?.slots?.updated?.on(emitCanvasSelection);

        const syncToolState = () => {
          if (disposed) return;
          setCanvasToolState(getCanvasToolState(controller, editPropsStore));
          syncFrame = window.requestAnimationFrame(syncToolState);
        };
        syncToolState();
      };

      void editor.updateComplete.then(resolveCanvasController);
    } else {
      onCanvasApiChange?.(undefined);
      onCanvasViewportChange?.(undefined);
      setCanvasToolController(undefined);
      setCanvasEditPropsStore(undefined);
      setCanvasToolState(undefined);
    }

    return () => {
      disposed = true;
      onCanvasApiChange?.(undefined);
      onCanvasViewportChange?.(undefined);
      onCanvasSelectionChange?.({ editing: false, selectedIds: [] });
      selectionSubscription?.dispose();
      viewportSubscription?.dispose();
      if (resolveFrame !== undefined) window.cancelAnimationFrame(resolveFrame);
      if (syncFrame !== undefined) window.cancelAnimationFrame(syncFrame);
      if (middleButtonPanClearHandle !== undefined) window.clearTimeout(middleButtonPanClearHandle);
      if (canvasCellEditingStateSyncFrame !== undefined) {
        window.cancelAnimationFrame(canvasCellEditingStateSyncFrame);
      }
      canvasCellEditingStateObserver?.disconnect();
      setCanvasSelectionEditing = undefined;
      mount.removeEventListener('pointerdown', handleMiddleButtonPointerDown, true);
      mount.removeEventListener('pointerdown', handleCanvasCellTextPointer, true);
      mount.removeEventListener('click', handleCanvasCellTextPointer, true);
      mount.removeEventListener('dblclick', handleCanvasCellTextPointer, true);
      mount.ownerDocument.removeEventListener('beforeinput', suppressCanvasCellNativeLayerInput, true);
      mount.ownerDocument.removeEventListener('compositionstart', suppressCanvasCellNativeLayerInput, true);
      mount.ownerDocument.removeEventListener('paste', suppressCanvasCellNativeLayerInput, true);
      mount.ownerDocument.removeEventListener('keydown', suppressCanvasCellNativeLayerKeydown, true);
      window.removeEventListener('pointerup', handleMiddleButtonPointerEnd, true);
      window.removeEventListener('pointercancel', clearMiddleButtonPan, true);
      window.removeEventListener('blur', clearMiddleButtonPan);
      setCanvasToolController(undefined);
      setCanvasEditPropsStore(undefined);
      setCanvasToolState(undefined);
      editor.remove();
      mount.replaceChildren();
    };
  }, [doc, mode, onCanvasApiChange, onCanvasSelectionChange, onCanvasViewportChange]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={mountRef} className="h-full min-h-0 w-full" />
      {mode === 'edgeless' ? (
        <CoppermindCanvasToolbar
          controller={canvasToolController}
          editPropsStore={canvasEditPropsStore}
          state={canvasToolState}
        />
      ) : null}
    </div>
  );
};

const InvalidCoppermindFallback = ({
  message,
  onChange,
  value,
}: {
  message: string;
  onChange: (value: string) => void;
  value: string;
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  return (
    <div className="mx-auto grid max-w-5xl gap-3 p-4">
      <div className="rounded border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        {message} The raw buffer is still editable and can be saved.
      </div>
      <textarea
        ref={textareaRef}
        className="min-h-[28rem] w-full resize-none rounded border border-border bg-card p-3 font-mono text-xs text-foreground outline-none focus:border-primary"
        spellCheck={false}
        value={value}
        onChange={event => onChange(event.currentTarget.value)}
      />
    </div>
  );
};

const CoppermindSectionSortableList = ({
  children,
  items,
  onReorder,
}: {
  children: ReactNode;
  items: string[];
  onReorder: (activeId: string, overId: string) => void;
}) => {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 5 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      onReorder(String(active.id), String(over.id));
    }
  };

  return (
    <DndContext
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      sensors={sensors}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={items} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
};

const CoppermindSortableSectionItem = ({
  children,
  id,
}: {
  children: (props: {
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners;
    ref: (node: HTMLElement | null) => void;
  }) => ReactNode;
  id: string;
}) => {
  const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      className={cn('relative', isDragging && 'z-20 opacity-90 shadow-lg')}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children({
        attributes,
        listeners,
        ref: setActivatorNodeRef,
      })}
    </div>
  );
};

const CoppermindSectionOutline = ({
  activeSectionId,
  canPlaceSections = true,
  mode,
  onAddSection,
  onDeleteSection,
  onDragSection,
  onPlaceSection,
  onReorderSection,
  onSelectSection,
  onUnplaceSection,
  sections,
}: {
  activeSectionId?: string;
  canPlaceSections?: boolean;
  mode: CoppermindEditorMode;
  onAddSection?: () => void;
  onDeleteSection: (section: CoppermindBlockSuiteSection) => void;
  onDragSection?: (section: CoppermindBlockSuiteSection, event: DragEvent<HTMLElement>) => void;
  onPlaceSection?: (section: CoppermindBlockSuiteSection) => void;
  onReorderSection: (activeId: string, overId: string) => void;
  onSelectSection: (sectionId: string) => void;
  onUnplaceSection?: (section: CoppermindBlockSuiteSection) => void;
  sections: CoppermindBlockSuiteSection[];
}) => {
  const isCanvasMode = mode === 'edgeless';
  const canAddSection = !isCanvasMode || canPlaceSections;
  const sectionIds = sections.map(section => section.id);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card/80 text-foreground">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1 truncate text-xs font-semibold uppercase text-muted-foreground">
          Cells
        </div>
        {onAddSection ? (
          <Button
            aria-label="Add cell"
            size="icon-xs"
            variant="ghost"
            className="text-muted-foreground hover:text-foreground"
            disabled={!canAddSection}
            title={canAddSection ? 'Add cell' : 'Canvas is still loading'}
            onClick={onAddSection}
          >
            <Plus size={14} />
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sections.length ? (
          <CoppermindSectionSortableList items={sectionIds} onReorder={onReorderSection}>
            <div className="grid gap-1">
              {sections.map((section, index) => {
                const isPlaced = section.placement.state === 'placed';
                const canDrag = isCanvasMode && !isPlaced && canPlaceSections;
                const isSelectable = !isCanvasMode || isPlaced;
                const hasHoverFill = !isCanvasMode || isPlaced;
                const isActive = activeSectionId === section.id && isSelectable;

                return (
                  <CoppermindSortableSectionItem key={section.id} id={section.id}>
                    {({ attributes, listeners, ref }) => (
                      <div
                        className={cn(
                          'group flex min-h-9 w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground',
                          !isActive && 'hover:border-border',
                          hasHoverFill && 'hover:bg-accent/70',
                          isCanvasMode && isPlaced && 'bg-muted/70 text-foreground hover:bg-muted',
                          isActive && 'border-primary/45 bg-accent text-foreground shadow-sm hover:border-primary/45',
                          canDrag && 'cursor-grab active:cursor-grabbing',
                        )}
                        draggable={canDrag}
                        title={
                          isCanvasMode
                            ? isPlaced
                              ? 'Double-click to remove cell from canvas'
                              : canPlaceSections
                                ? 'Double-click to place cell on canvas'
                                : undefined
                            : undefined
                        }
                        onDoubleClick={() => {
                          if (!isCanvasMode) return;
                          if (isPlaced) {
                            onUnplaceSection?.(section);
                            return;
                          }
                          if (canPlaceSections) {
                            onPlaceSection?.(section);
                          }
                        }}
                        onDragStart={event => {
                          const startedOnReorderHandle = event.target instanceof Element
                            && Boolean(event.target.closest('[data-coppermind-section-reorder-handle="true"]'));
                          if (!canDrag || startedOnReorderHandle) {
                            event.preventDefault();
                            return;
                          }
                          onDragSection?.(section, event);
                        }}
                      >
                        <Button
                          ref={ref}
                          aria-label={`Reorder ${section.title}`}
                          title="Drag to reorder cell"
                          size="icon-xs"
                          variant="ghost"
                          className="cursor-grab touch-none select-none text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
                          data-coppermind-section-reorder-handle="true"
                          draggable={false}
                          style={{ touchAction: 'none' }}
                          onClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onDoubleClick={event => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onDragStart={event => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          {...attributes}
                          {...listeners}
                        >
                          <GripVertical size={13} />
                        </Button>
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => {
                            if (!isSelectable) return;
                            onSelectSection(section.id);
                          }}
                        >
                          <span className="w-5 shrink-0 text-[11px] tabular-nums text-muted-foreground/75">
                            {index + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{section.title}</span>
                        </button>
                        <Button
                          aria-label={`Delete ${section.title}`}
                          title="Delete cell"
                          size="icon-xs"
                          variant="ghost"
                          className={cn(
                            'text-muted-foreground hover:text-destructive',
                            !isCanvasMode && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                          )}
                          onClick={event => {
                            event.stopPropagation();
                            onDeleteSection(section);
                          }}
                          onDoubleClick={event => event.stopPropagation()}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    )}
                  </CoppermindSortableSectionItem>
                );
              })}
            </div>
          </CoppermindSectionSortableList>
        ) : (
          <div className="px-2 py-3 text-xs text-muted-foreground">No cells</div>
        )}
      </div>
    </aside>
  );
};

const CoppermindModeToggle = ({
  mode,
  onModeChange,
}: {
  mode: CoppermindEditorMode;
  onModeChange: (mode: CoppermindEditorMode) => void;
}) => (
  <div className="absolute right-4 top-3 z-20 inline-flex rounded-md border border-border bg-card/95 p-0.5 shadow-lg backdrop-blur">
    {modeOptions.map(item => (
      <button
        key={item.id}
        type="button"
        className={cn(
          'h-7 rounded px-2.5 text-sm text-muted-foreground',
          mode === item.id && 'bg-accent text-foreground',
        )}
        onClick={() => onModeChange(item.id)}
      >
        {item.label}
      </button>
    ))}
  </div>
);

export const CoppermindDocumentEditor = ({
  focusRequest = 0,
  value,
  onChange,
}: CoppermindDocumentEditorProps) => {
  const [mode, setMode] = useState<CoppermindEditorMode>('page');
  const [loadedState, setLoadedState] = useState<LoadedCoppermindState>({ status: 'loading' });
  const [activeSectionId, setActiveSectionId] = useState<string | undefined>(undefined);
  const [canvasApi, setCanvasApi] = useState<CoppermindCanvasApi | undefined>(undefined);
  const [canvasEditPunchInEnabled, setCanvasEditPunchInEnabled] = useState(true);
  const [canvasViewport, setCanvasViewport] = useState<CoppermindCanvasViewportState | undefined>(undefined);
  const [sections, setSections] = useState<CoppermindBlockSuiteSection[]>([]);
  const onChangeRef = useRef(onChange);
  const loadedDocumentRef = useRef<CoppermindDocument | undefined>(undefined);
  const loadedRuntimeRef = useRef<CoppermindBlockSuiteRuntime | undefined>(undefined);
  const lastSerializedRef = useRef<string | undefined>(undefined);
  const loadTokenRef = useRef(0);
  const modeRef = useRef<CoppermindEditorMode>('page');
  const canvasApiRef = useRef<CoppermindCanvasApi | undefined>(undefined);
  const canvasEditViewportSessionRef = useRef<CoppermindCanvasEditViewportSession | undefined>(undefined);
  const canvasEditPunchInEnabledRef = useRef(true);
  const canvasSelectionStateRef = useRef<CoppermindCanvasSelectionState>({
    editing: false,
    selectedIds: [],
  });
  const sectionsRef = useRef<CoppermindBlockSuiteSection[]>([]);
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    sectionsRef.current = sections;
  }, [sections]);

  const emitCurrentDocument = useCallback(() => {
    const runtime = loadedRuntimeRef.current;
    const document = loadedDocumentRef.current;
    if (!runtime || !document) return;

    const nextSnapshot = exportCoppermindBlockSuiteSnapshot(runtime, {
      now: new Date(),
      title: document.metadata.title,
    });
    const nextDocument = withCoppermindDocumentSnapshot(document, nextSnapshot, {
      lastMode: modeRef.current,
      now: new Date(),
    });
    const nextValue = serializeCoppermindDocument(nextDocument);

    loadedDocumentRef.current = nextDocument;
    setLoadedState(current => (
      current.status === 'ready'
        ? { ...current, document: nextDocument }
        : current
    ));

    if (nextValue === lastSerializedRef.current) return;
    lastSerializedRef.current = nextValue;
    onChangeRef.current(nextValue);
  }, []);

  const refreshSections = useCallback(() => {
    const runtime = loadedRuntimeRef.current;
    const nextSections = runtime ? getCoppermindBlockSuiteSections(runtime.doc) : [];
    setSections(nextSections);
    setActiveSectionId(current => {
      const currentSection = nextSections.find(section => section.id === current);
      if (
        currentSection
        && (modeRef.current !== 'edgeless' || currentSection.placement.state === 'placed')
      ) {
        return current;
      }

      if (modeRef.current === 'edgeless') {
        return undefined;
      }

      return nextSections[0]?.id;
    });
  }, []);

  const markActiveSection = useCallback((sectionId: string | undefined, shouldScroll = false) => {
    const noteElements = Array.from(
      shellRef.current?.querySelectorAll<HTMLElement>('page-editor affine-note') ?? [],
    );
    let activeElement: HTMLElement | undefined;

    for (const element of noteElements) {
      const isActive = Boolean(sectionId && element.dataset.blockId === sectionId);
      if (isActive) activeElement = element;
      if (isActive) {
        element.dataset.coppermindActiveSection = 'true';
      } else {
        delete element.dataset.coppermindActiveSection;
      }
    }

    if (shouldScroll) {
      activeElement?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, []);

  const updateActiveSectionFromCursor = useCallback(() => {
    const root = shellRef.current;
    if (!root) return;

    const ownerDocument = root.ownerDocument;
    const selection = ownerDocument.getSelection();
    const activeElement = ownerDocument.activeElement instanceof Element
      ? ownerDocument.activeElement
      : null;
    const noteElement = getClosestSectionElement(getElementFromNode(selection?.anchorNode ?? null), root)
      ?? getClosestSectionElement(getElementFromNode(selection?.focusNode ?? null), root)
      ?? getClosestSectionElement(activeElement, root);
    const sectionId = noteElement?.dataset.blockId;

    if (!sectionId) return;
    setActiveSectionId(current => (current === sectionId ? current : sectionId));
  }, []);

  const selectSection = useCallback((sectionId: string) => {
    if (mode === 'edgeless') {
      const section = sections.find(item => item.id === sectionId);
      if (section?.placement.state === 'placed') {
        setActiveSectionId(sectionId);
        canvasApi?.locateSection(section.id, section.placement.xywh);
      }
      return;
    }

    setActiveSectionId(sectionId);
    window.requestAnimationFrame(() => markActiveSection(sectionId, true));
  }, [canvasApi, markActiveSection, mode, sections]);

  const addSection = useCallback(() => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime) return;

    const sectionId = addCoppermindBlockSuiteSection(runtime.doc);
    refreshSections();
    setActiveSectionId(sectionId);
    window.requestAnimationFrame(() => markActiveSection(sectionId, true));
  }, [markActiveSection, refreshSections]);

  const addSectionToCanvas = useCallback(() => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime || !canvasApi) return;

    const xywh = createCoppermindNextCanvasCellXYWH(getCoppermindBlockSuiteSections(runtime.doc));
    const sectionId = addCoppermindBlockSuiteSection(runtime.doc);
    placeCoppermindBlockSuiteSection(runtime.doc, sectionId, xywh);
    refreshSections();
    setActiveSectionId(sectionId);
    window.requestAnimationFrame(() => canvasApi.locateSection(sectionId, xywh, { editing: true }));
  }, [canvasApi, refreshSections]);

  const deleteSection = useCallback((section: CoppermindBlockSuiteSection) => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime) return;

    if (
      !section.isEmpty
      && !window.confirm(`Delete "${section.title}" and all blocks inside it?`)
    ) {
      return;
    }

    deleteCoppermindBlockSuiteSection(runtime.doc, section.id);
    refreshSections();
  }, [refreshSections]);

  const handleCanvasApiChange = useCallback((api: CoppermindCanvasApi | undefined) => {
    canvasApiRef.current = api;
    setCanvasApi(api);
    if (!api) {
      canvasEditViewportSessionRef.current = undefined;
      canvasSelectionStateRef.current = { editing: false, selectedIds: [] };
    }
  }, []);

  const handleCanvasViewportChange = useCallback((state: CoppermindCanvasViewportState | undefined) => {
    setCanvasViewport(state);
  }, []);

  const punchInToEditingCanvasSelection = useCallback((
    selectedSection: CoppermindBlockSuiteSection,
    xywh: CoppermindBlockSuiteSectionXYWH,
  ) => {
    const api = canvasApiRef.current;
    if (!api) return;

    const editSession = canvasEditViewportSessionRef.current;
    if (editSession?.sectionId === selectedSection.id) return;

    const viewport = api.getViewportSnapshot();
    if (viewport) {
      canvasEditViewportSessionRef.current = {
        sectionId: selectedSection.id,
        viewport,
      };
    }
    api.focusSectionForEditing(xywh);
  }, []);

  const restoreCanvasEditViewportSession = useCallback(() => {
    const api = canvasApiRef.current;
    const editSession = canvasEditViewportSessionRef.current;
    if (!api || !editSession) return;

    canvasEditViewportSessionRef.current = undefined;
    api.restoreViewport(editSession.viewport);
  }, []);

  const handleCanvasSelectionChange = useCallback((selectionState: CoppermindCanvasSelectionState) => {
    canvasSelectionStateRef.current = selectionState;
    const selectedIdSet = new Set(selectionState.selectedIds);
    const selectedSection = sectionsRef.current.find(section => (
      section.placement.state === 'placed' && selectedIdSet.has(section.id)
    ));
    const selectedPlacement = selectedSection?.placement;
    setActiveSectionId(selectedSection?.id);
    const api = canvasApiRef.current;
    const editSession = canvasEditViewportSessionRef.current;

    if (api && selectedSection && selectedPlacement?.state === 'placed' && selectionState.editing) {
      if (!canvasEditPunchInEnabledRef.current) {
        restoreCanvasEditViewportSession();
        return;
      }
      punchInToEditingCanvasSelection(selectedSection, selectedPlacement.xywh);
      return;
    }

    if (editSession && (!selectionState.editing || selectedSection?.id !== editSession.sectionId)) {
      restoreCanvasEditViewportSession();
    }
  }, [punchInToEditingCanvasSelection, restoreCanvasEditViewportSession]);

  const toggleCanvasEditPunchIn = useCallback(() => {
    const nextEnabled = !canvasEditPunchInEnabledRef.current;
    canvasEditPunchInEnabledRef.current = nextEnabled;
    setCanvasEditPunchInEnabled(nextEnabled);

    if (!nextEnabled) {
      restoreCanvasEditViewportSession();
      return;
    }

    const selectionState = canvasSelectionStateRef.current;
    if (!selectionState.editing) return;

    const selectedIdSet = new Set(selectionState.selectedIds);
    const selectedSection = sectionsRef.current.find(section => (
      section.placement.state === 'placed' && selectedIdSet.has(section.id)
    ));
    if (!selectedSection || selectedSection.placement.state !== 'placed') return;

    punchInToEditingCanvasSelection(selectedSection, selectedSection.placement.xywh);
  }, [punchInToEditingCanvasSelection, restoreCanvasEditViewportSession]);

  const placeSectionWithXYWH = useCallback((
    section: CoppermindBlockSuiteSection,
    xywh: CoppermindBlockSuiteSectionXYWH,
  ) => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime) return;

    if (!placeCoppermindBlockSuiteSection(runtime.doc, section.id, xywh)) return;
    refreshSections();
    setActiveSectionId(section.id);
    window.requestAnimationFrame(() => canvasApi?.locateSection(section.id, xywh));
  }, [canvasApi, refreshSections]);

  const placeSectionInNextCanvasSlot = useCallback((section: CoppermindBlockSuiteSection) => {
    placeSectionWithXYWH(section, createCoppermindNextCanvasCellXYWH(sections));
  }, [placeSectionWithXYWH, sections]);

  const unplaceSectionFromCanvas = useCallback((section: CoppermindBlockSuiteSection) => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime) return;

    if (!unplaceCoppermindBlockSuiteSection(runtime.doc, section.id)) return;
    canvasApi?.clearSelection();
    refreshSections();
    setActiveSectionId(undefined);
  }, [canvasApi, refreshSections]);

  const arrangeCellsAsPage = useCallback(() => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime) return;

    const orderedSections = getCoppermindBlockSuiteSections(runtime.doc);
    const defaultHeight = createCoppermindNextCanvasCellXYWH([])[3];
    let y = 0;

    for (const section of orderedSections) {
      const height = section.placement.state === 'placed'
        ? section.placement.xywh[3]
        : defaultHeight;
      placeCoppermindBlockSuiteSection(runtime.doc, section.id, [
        -coppermindCellWidthPx / 2,
        y,
        coppermindCellWidthPx,
        height,
      ]);
      y += height + coppermindCanvasCellGapPx;
    }

    refreshSections();
    window.requestAnimationFrame(() => canvasApi?.fitToScreen());
  }, [canvasApi, refreshSections]);

  const reorderSection = useCallback((activeId: string, overId: string) => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime) return;

    if (!reorderCoppermindBlockSuiteSection(runtime.doc, activeId, overId)) return;
    refreshSections();
  }, [refreshSections]);

  const dragSectionFromSidebar = useCallback((
    section: CoppermindBlockSuiteSection,
    event: DragEvent<HTMLElement>,
  ) => {
    if (section.placement.state !== 'unplaced') return;
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(coppermindSectionDragDataType, section.id);
    event.dataTransfer.setData('text/plain', section.title);
  }, []);

  const handleCanvasDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!canvasApi || !isSectionDragEvent(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, [canvasApi]);

  const handleCanvasDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!canvasApi || !isSectionDragEvent(event)) return;
    event.preventDefault();

    const sectionId = event.dataTransfer.getData(coppermindSectionDragDataType);
    const section = sections.find(item => item.id === sectionId);
    if (!section || section.placement.state !== 'unplaced') return;

    const point = canvasApi.getModelPointFromClientPoint(event.clientX, event.clientY);
    if (!point) return;
    placeSectionWithXYWH(section, createCoppermindSectionXYWHAtTopLeft(point.x, point.y));
  }, [canvasApi, placeSectionWithXYWH, sections]);

  useEffect(() => {
    if (value === lastSerializedRef.current) return;

    const token = loadTokenRef.current + 1;
    loadTokenRef.current = token;
    const parsed = parseCoppermindDocument(value);

    disposeCoppermindBlockSuiteRuntime(loadedRuntimeRef.current);
    loadedRuntimeRef.current = undefined;
    loadedDocumentRef.current = undefined;
    setSections([]);
    setActiveSectionId(undefined);

    if (!parsed) {
      setLoadedState({
        status: 'invalid',
        message: 'This `.cpr` file is not valid Coppermind JSON.',
      });
      return;
    }

    const nextDocument = isLegacyCoppermindDocument(parsed)
      ? migrateCoppermindDocumentToV2(parsed)
      : isCoppermindDocumentV2(parsed)
        ? parsed
        : undefined;

    if (!nextDocument) {
      setLoadedState({
        status: 'invalid',
        message: 'This `.cpr` file uses an unsupported Coppermind document version.',
      });
      return;
    }

    setMode(normalizeMode(nextDocument.ui.lastMode));
    setLoadedState({ status: 'loading' });

    void importCoppermindBlockSuiteRuntime(nextDocument.blocksuite.snapshot)
      .then(runtime => {
        if (loadTokenRef.current !== token) {
          disposeCoppermindBlockSuiteRuntime(runtime);
          return;
        }

        loadedRuntimeRef.current = runtime;
        loadedDocumentRef.current = nextDocument;
        setLoadedState({
          status: 'ready',
          document: nextDocument,
          migratedFromLegacy: parsed.version === 1,
          runtime,
        });
        const nextSections = getCoppermindBlockSuiteSections(runtime.doc);
        setSections(nextSections);
        setActiveSectionId(nextSections[0]?.id);
      })
      .catch(error => {
        if (loadTokenRef.current !== token) return;
        setLoadedState({
          status: 'invalid',
          message: getErrorMessage(error),
        });
      });
  }, [value]);

  useEffect(() => () => {
    loadTokenRef.current += 1;
    disposeCoppermindBlockSuiteRuntime(loadedRuntimeRef.current);
    loadedRuntimeRef.current = undefined;
    loadedDocumentRef.current = undefined;
  }, []);

  useEffect(() => {
    if (focusRequest === 0) return;
    const editor = shellRef.current?.querySelector<HTMLElement>(
      mode === 'page' ? 'page-editor' : 'edgeless-editor',
    );
    const fallbackEditor = shellRef.current?.querySelector<HTMLTextAreaElement>('textarea');
    (editor ?? fallbackEditor)?.focus({ preventScroll: true });
  }, [focusRequest, mode]);

  useEffect(() => {
    if (loadedState.status !== 'ready') return;
    let debounceHandle: ReturnType<typeof setTimeout> | undefined;
    const disposable = loadedState.runtime.doc.slots.blockUpdated.on(() => {
      refreshSections();
      if (debounceHandle) clearTimeout(debounceHandle);
      debounceHandle = setTimeout(() => {
        emitCurrentDocument();
      }, 300);
    });

    return () => {
      if (debounceHandle) clearTimeout(debounceHandle);
      disposable.dispose();
    };
  }, [emitCurrentDocument, loadedState, refreshSections]);

  useEffect(() => {
    if (loadedState.status !== 'ready') return;
    if (loadedDocumentRef.current?.ui.lastMode === mode) return;
    emitCurrentDocument();
  }, [emitCurrentDocument, loadedState.status, mode]);

  useEffect(() => {
    if (mode !== 'page' || loadedState.status !== 'ready') return;
    window.requestAnimationFrame(() => markActiveSection(activeSectionId));
  }, [activeSectionId, loadedState.status, markActiveSection, mode, sections]);

  useEffect(() => {
    if (mode !== 'page' || loadedState.status !== 'ready') return;
    const root = shellRef.current;
    if (!root) return;

    let animationFrame: number | undefined;
    const scheduleUpdate = () => {
      if (animationFrame !== undefined) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = undefined;
        updateActiveSectionFromCursor();
      });
    };
    const scheduleFromPageEvent = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('page-editor')) return;
      scheduleUpdate();
    };
    const ownerDocument = root.ownerDocument;

    ownerDocument.addEventListener('selectionchange', scheduleUpdate);
    root.addEventListener('click', scheduleFromPageEvent, true);
    root.addEventListener('focusin', scheduleFromPageEvent, true);
    root.addEventListener('input', scheduleFromPageEvent, true);
    root.addEventListener('keyup', scheduleFromPageEvent, true);
    root.addEventListener('pointerup', scheduleFromPageEvent, true);
    scheduleUpdate();

    return () => {
      if (animationFrame !== undefined) window.cancelAnimationFrame(animationFrame);
      ownerDocument.removeEventListener('selectionchange', scheduleUpdate);
      root.removeEventListener('click', scheduleFromPageEvent, true);
      root.removeEventListener('focusin', scheduleFromPageEvent, true);
      root.removeEventListener('input', scheduleFromPageEvent, true);
      root.removeEventListener('keyup', scheduleFromPageEvent, true);
      root.removeEventListener('pointerup', scheduleFromPageEvent, true);
    };
  }, [loadedState.status, mode, updateActiveSectionFromCursor]);

  return (
    <div
      ref={shellRef}
      className="relative flex h-full min-h-0 flex-col bg-background"
      data-weave-editor-coppermind
    >
      <style>{coppermindBlockSuiteStyles}</style>
      {loadedState.status === 'ready' ? (
        <CoppermindModeToggle mode={mode} onModeChange={setMode} />
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        {loadedState.status === 'ready' ? (
          <div className="flex h-full min-h-0">
            <CoppermindSectionOutline
              activeSectionId={activeSectionId}
              canPlaceSections={Boolean(canvasApi)}
              mode={mode}
              sections={sections}
              onAddSection={mode === 'page' ? addSection : addSectionToCanvas}
              onDeleteSection={deleteSection}
              onDragSection={mode === 'edgeless' ? dragSectionFromSidebar : undefined}
              onPlaceSection={mode === 'edgeless' ? placeSectionInNextCanvasSlot : undefined}
              onReorderSection={reorderSection}
              onSelectSection={selectSection}
              onUnplaceSection={mode === 'edgeless' ? unplaceSectionFromCanvas : undefined}
            />
            <div
              className={cn(
                'relative min-h-0 flex-1',
                mode === 'page' ? 'overflow-visible' : 'overflow-hidden',
              )}
              onDragOver={mode === 'edgeless' ? handleCanvasDragOver : undefined}
              onDrop={mode === 'edgeless' ? handleCanvasDrop : undefined}
            >
              <BlockSuiteEditorMount
                key={`${loadedState.runtime.doc.id}:${mode}`}
                doc={loadedState.runtime.doc}
                mode={mode}
                onCanvasApiChange={mode === 'edgeless' ? handleCanvasApiChange : undefined}
                onCanvasViewportChange={mode === 'edgeless' ? handleCanvasViewportChange : undefined}
                onCanvasSelectionChange={mode === 'edgeless' ? handleCanvasSelectionChange : undefined}
              />
              {mode === 'edgeless' ? (
                <CoppermindCanvasViewportToolbar
                  api={canvasApi}
                  editPunchInEnabled={canvasEditPunchInEnabled}
                  zoom={canvasViewport?.zoom}
                  onArrangeAsPage={arrangeCellsAsPage}
                  onToggleEditPunchIn={toggleCanvasEditPunchIn}
                />
              ) : null}
            </div>
          </div>
        ) : loadedState.status === 'invalid' ? (
          <InvalidCoppermindFallback
            message={loadedState.message}
            value={value}
            onChange={onChange}
          />
        ) : (
          <div className="grid h-full place-items-center text-xs text-muted-foreground">
            Opening Coppermind document...
          </div>
        )}
      </div>
    </div>
  );
};
