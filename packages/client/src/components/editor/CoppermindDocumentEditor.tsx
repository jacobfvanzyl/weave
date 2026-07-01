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
  ChevronDown,
  Circle,
  Diamond,
  Eraser,
  GitBranch,
  Hand,
  MousePointer2,
  Pencil,
  Plus,
  Square,
  SquareRoundCorner,
  Trash2,
  Triangle,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  addCoppermindBlockSuiteSection,
  deleteCoppermindBlockSuiteSection,
  disposeCoppermindBlockSuiteRuntime,
  exportCoppermindBlockSuiteSnapshot,
  getCoppermindBlockSuiteSections,
  importCoppermindBlockSuiteRuntime,
  type CoppermindBlockSuiteSection,
  type CoppermindBlockSuiteRuntime,
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
    --affine-font-family: var(--font-ui);
    --affine-font-code-family: var(--font-code);
    --affine-font-mono-family: var(--font-code);
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
    overflow: visible;
    margin: 8px 0;
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

  [data-weave-editor-coppermind] page-editor affine-note:first-of-type {
    margin-top: 0;
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
    position: relative;
    overflow: visible;
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

  [data-weave-editor-coppermind] edgeless-toolbar-widget {
    display: none !important;
  }
`;

const getElementFromNode = (node: Node | null) => (
  node instanceof Element ? node : node?.parentElement ?? null
);

const getClosestSectionElement = (element: Element | null, root: HTMLElement) => {
  const note = element?.closest<HTMLElement>('affine-note');
  return note && root.contains(note) ? note : undefined;
};

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

const getCanvasToolController = (
  editor: EdgelessEditor,
  doc: Doc,
): CoppermindCanvasToolController | undefined => {
  const rootId = doc.root?.id;
  if (!rootId) return undefined;

  const rootBlock = editor.std?.view.getBlock(rootId) as {
    gfx?: {
      tool?: CoppermindCanvasToolController;
    };
  } | undefined;
  return rootBlock?.gfx?.tool;
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

    return (
      <button
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled}
        className={cn(
          'rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45',
          menu
            ? 'inline-grid h-9 min-w-9 grid-cols-[1fr_auto] items-center gap-0.5 px-2'
            : 'grid h-9 w-9 place-items-center p-0',
          (isActive || isMenuOpen) && 'bg-primary/20 text-primary shadow-sm',
        )}
        onClick={() => {
          onClick();
          setOpenMenu(current => (menu ? (current === menu ? undefined : menu) : undefined));
        }}
      >
        <Icon size={18} strokeWidth={2} />
        {menu ? <ChevronDown size={13} strokeWidth={2} /> : null}
      </button>
    );
  };

  const pointerActive = state?.activeTool === 'default' || state?.activeTool === 'pan';
  const PointerIcon = state?.activeTool === 'pan' ? Hand : MousePointer2;
  const pointerLabel = state?.activeTool === 'pan' ? 'Hand' : 'Select';

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-4">
      <div className="pointer-events-auto relative">
        {openMenu && state ? (
          <div className="absolute bottom-full left-1/2 mb-2 max-w-[calc(100vw-4rem)] -translate-x-1/2 overflow-x-auto rounded-lg border border-border bg-card/95 p-2 shadow-xl backdrop-blur">
            <CoppermindCanvasMenu bindings={bindings} menu={openMenu} state={state} />
          </div>
        ) : null}
        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-card/95 p-1 shadow-xl backdrop-blur">
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
          <div className="mx-1 h-5 w-px bg-border" />
          {toolButton({
            icon: GitBranch,
            id: 'connector',
            label: 'Connector',
            onClick: bindings.selectConnector,
          })}
          <div className="mx-1 h-5 w-px bg-border" />
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
        </div>
      </div>
    </div>
  );
};

const BlockSuiteEditorMount = ({ doc, mode }: { doc: Doc; mode: CoppermindEditorMode }) => {
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
    let resolveAttempts = 0;

    editor.doc = doc;
    editor.specs = mode === 'page'
      ? coppermindPageEditorBlockSpecs
      : coppermindEdgelessEditorBlockSpecs;
    editor.className = 'block h-full min-h-0 w-full';
    mount.replaceChildren(editor);

    if (mode === 'edgeless' && editor instanceof EdgelessEditor) {
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

        const syncToolState = () => {
          if (disposed) return;
          setCanvasToolState(getCanvasToolState(controller, editPropsStore));
          syncFrame = window.requestAnimationFrame(syncToolState);
        };
        syncToolState();
      };

      void editor.updateComplete.then(resolveCanvasController);
    } else {
      setCanvasToolController(undefined);
      setCanvasEditPropsStore(undefined);
      setCanvasToolState(undefined);
    }

    return () => {
      disposed = true;
      if (resolveFrame !== undefined) window.cancelAnimationFrame(resolveFrame);
      if (syncFrame !== undefined) window.cancelAnimationFrame(syncFrame);
      setCanvasToolController(undefined);
      setCanvasEditPropsStore(undefined);
      setCanvasToolState(undefined);
      editor.remove();
      mount.replaceChildren();
    };
  }, [doc, mode]);

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

const CoppermindSectionOutline = ({
  activeSectionId,
  onAddSection,
  onDeleteSection,
  onSelectSection,
  sections,
}: {
  activeSectionId?: string;
  onAddSection: () => void;
  onDeleteSection: (section: CoppermindBlockSuiteSection) => void;
  onSelectSection: (sectionId: string) => void;
  sections: CoppermindBlockSuiteSection[];
}) => (
  <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card/80 text-foreground">
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
      <div className="min-w-0 flex-1 truncate text-xs font-semibold uppercase text-muted-foreground">
        Sections
      </div>
      <Button
        aria-label="Add section"
        title="Add section"
        size="icon-xs"
        variant="ghost"
        className="text-muted-foreground hover:text-foreground"
        onClick={onAddSection}
      >
        <Plus size={14} />
      </Button>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {sections.length ? (
        <div className="grid gap-1">
          {sections.map((section, index) => (
            <div
              key={section.id}
              className={cn(
                'group flex min-h-9 w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs text-muted-foreground hover:border-border hover:bg-accent/70 hover:text-foreground',
                activeSectionId === section.id && 'border-primary/45 bg-accent text-foreground shadow-sm',
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => onSelectSection(section.id)}
              >
                <span className="w-5 shrink-0 text-[11px] tabular-nums text-muted-foreground/75">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{section.title}</span>
              </button>
              <Button
                aria-label={`Delete ${section.title}`}
                title="Delete section"
                size="icon-xs"
                variant="ghost"
                className="opacity-0 text-muted-foreground hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100"
                onClick={event => {
                  event.stopPropagation();
                  onDeleteSection(section);
                }}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-2 py-3 text-xs text-muted-foreground">No sections</div>
      )}
    </div>
  </aside>
);

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
  const [sections, setSections] = useState<CoppermindBlockSuiteSection[]>([]);
  const onChangeRef = useRef(onChange);
  const loadedDocumentRef = useRef<CoppermindDocument | undefined>(undefined);
  const loadedRuntimeRef = useRef<CoppermindBlockSuiteRuntime | undefined>(undefined);
  const lastSerializedRef = useRef<string | undefined>(undefined);
  const loadTokenRef = useRef(0);
  const modeRef = useRef<CoppermindEditorMode>('page');
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

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
    setActiveSectionId(current => (
      current && nextSections.some(section => section.id === current)
        ? current
        : nextSections[0]?.id
    ));
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
    setActiveSectionId(sectionId);
    window.requestAnimationFrame(() => markActiveSection(sectionId, true));
  }, [markActiveSection]);

  const addSection = useCallback(() => {
    const runtime = loadedRuntimeRef.current;
    if (!runtime) return;

    const sectionId = addCoppermindBlockSuiteSection(runtime.doc);
    refreshSections();
    setActiveSectionId(sectionId);
    window.requestAnimationFrame(() => markActiveSection(sectionId, true));
  }, [markActiveSection, refreshSections]);

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
          mode === 'page' ? (
            <div className="flex h-full min-h-0">
              <CoppermindSectionOutline
                activeSectionId={activeSectionId}
                sections={sections}
                onAddSection={addSection}
                onDeleteSection={deleteSection}
                onSelectSection={selectSection}
              />
              <div className="min-h-0 flex-1 overflow-visible">
                <BlockSuiteEditorMount
                  key={`${loadedState.runtime.doc.id}:${mode}`}
                  doc={loadedState.runtime.doc}
                  mode={mode}
                />
              </div>
            </div>
          ) : (
            <BlockSuiteEditorMount
              key={`${loadedState.runtime.doc.id}:${mode}`}
              doc={loadedState.runtime.doc}
              mode={mode}
            />
          )
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
