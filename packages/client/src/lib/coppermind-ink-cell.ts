import {
  BlockComponent,
  BlockViewExtension,
  FlavourExtension,
  type ExtensionType,
} from '@blocksuite/block-std';
import { BlockModel, defineBlockSchema } from '@blocksuite/store';
import { css, html, type PropertyValues } from 'lit';
import { styleMap } from 'lit/directives/style-map.js';
import { literal } from 'lit/static-html.js';

import {
  coppermindA4PageHeightPx,
  coppermindCellWidthPx,
  coppermindInkAutoExpandDistancePx,
  coppermindInkCellMinHeightPx,
  coppermindInkClampReservePx,
  coppermindInkContentPaddingPx,
} from './coppermind-layout';

export const coppermindInkCellFlavour = 'coppermind:ink-cell';
export const coppermindInkCellElementName = 'coppermind-ink-cell';
export const coppermindInkCellSchemaVersion = 1;

export type CoppermindInkBackground = 'college' | 'irish' | 'grid';
export type CoppermindInkHeightMode = 'clamped' | 'full';
export type CoppermindInkStackState = 'auto' | 'unstacked';

const coppermindInkBackgroundDefault: CoppermindInkBackground = 'college';

const coppermindInkBackgroundOptions: Array<{ id: CoppermindInkBackground; label: string }> = [
  { id: 'college', label: 'College' },
  { id: 'irish', label: 'Irish' },
  { id: 'grid', label: 'Grid' },
];

export type CoppermindInkPoint = {
  pressure?: number;
  t: number;
  tiltX?: number;
  tiltY?: number;
  twist?: number;
  x: number;
  y: number;
};

export type CoppermindInkStroke = {
  color: string;
  id: string;
  points: CoppermindInkPoint[];
  width: number;
};

export type CoppermindInkCellPayload = {
  strokes: CoppermindInkStroke[];
  version: 1;
};

export type CoppermindInkCellProps = {
  background: CoppermindInkBackground;
  height: number;
  heightMode: CoppermindInkHeightMode;
  inkVersion: 1;
  stackState: CoppermindInkStackState;
  strokeData: string;
};

const emptyInkPayload: CoppermindInkCellPayload = {
  strokes: [],
  version: 1,
};

const createEmptyStrokeData = () => JSON.stringify(emptyInkPayload);

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const normalizeCoppermindInkHeightMode = (
  value: unknown,
): CoppermindInkHeightMode => (value === 'full' ? 'full' : 'clamped');

export const normalizeCoppermindInkBackground = (
  value: unknown,
): CoppermindInkBackground => (
  coppermindInkBackgroundOptions.some(option => option.id === value)
    ? value as CoppermindInkBackground
    : coppermindInkBackgroundDefault
);

type CoppermindInkDebugFields = Record<string, boolean | number | string | null | undefined>;

let coppermindInkDebugSequence = 0;
let coppermindInkDebugLastTime = 0;

const coppermindInkDebugStorageKey = 'coppermind:ink-debug';

const isCoppermindInkDebugEnabled = () => {
  if (typeof window === 'undefined' || window.location.port !== '5174') return false;

  try {
    return window.localStorage.getItem(coppermindInkDebugStorageKey) === 'true';
  } catch {
    return false;
  }
};

const shouldPreferStylusTouchEvents = () => (
  typeof navigator !== 'undefined'
  && typeof window !== 'undefined'
  && 'TouchEvent' in window
  && navigator.maxTouchPoints > 0
);

const debugTargetName = (target: EventTarget | null) => {
  if (!(target instanceof Element)) return null;
  const classes = typeof target.className === 'string'
    ? target.className.trim().replace(/\s+/g, '.')
    : '';
  return classes ? `${target.localName}.${classes}` : target.localName;
};

const roundDebugNumber = (value: number | undefined) => (
  typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : undefined
);

const postCoppermindInkDebug = (event: string, fields: CoppermindInkDebugFields = {}) => {
  if (!isCoppermindInkDebugEnabled()) return;

  const now = performance.now();
  const dt = coppermindInkDebugLastTime > 0
    ? Math.round((now - coppermindInkDebugLastTime) * 10) / 10
    : null;
  coppermindInkDebugLastTime = now;

  const body = JSON.stringify({
    dt,
    event,
    fields,
    scope: 'ink',
    seq: ++coppermindInkDebugSequence,
  });

  if (navigator.sendBeacon?.('/__weave_mobile_log', body)) return;
  void fetch('/__weave_mobile_log', {
    body,
    headers: { 'content-type': 'application/json' },
    keepalive: true,
    method: 'POST',
  }).catch(() => undefined);
};

export const parseCoppermindInkStrokeData = (value: unknown): CoppermindInkCellPayload => {
  if (typeof value !== 'string' || !value.trim()) return emptyInkPayload;

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyInkPayload;
    const payload = parsed as Partial<CoppermindInkCellPayload>;
    if (payload.version !== 1 || !Array.isArray(payload.strokes)) return emptyInkPayload;

    return {
      strokes: payload.strokes.filter((stroke): stroke is CoppermindInkStroke => (
        Boolean(stroke)
        && typeof stroke === 'object'
        && typeof stroke.id === 'string'
        && typeof stroke.color === 'string'
        && typeof stroke.width === 'number'
        && Array.isArray(stroke.points)
      )),
      version: 1,
    };
  } catch {
    return emptyInkPayload;
  }
};

export const getCoppermindInkStrokeCount = (value: unknown) => (
  parseCoppermindInkStrokeData(value).strokes.length
);

const getCoppermindInkMaxY = (strokes: CoppermindInkStroke[]) => (
  strokes.reduce((currentMax, stroke) => (
    Math.max(currentMax, ...stroke.points.map(point => point.y))
  ), 0)
);

export const getCoppermindInkContentHeight = (strokes: CoppermindInkStroke[]) => {
  const maxY = getCoppermindInkMaxY(strokes);

  if (maxY <= 0) return coppermindInkCellMinHeightPx;
  return clamp(
    Math.ceil(maxY + coppermindInkContentPaddingPx),
    coppermindInkCellMinHeightPx,
    coppermindA4PageHeightPx,
  );
};

export const getCoppermindInkClampedHeight = (strokes: CoppermindInkStroke[]) => {
  const maxY = getCoppermindInkMaxY(strokes);

  if (maxY <= 0) return coppermindInkCellMinHeightPx;
  return clamp(
    Math.ceil(maxY + coppermindInkContentPaddingPx + coppermindInkClampReservePx),
    coppermindInkCellMinHeightPx,
    coppermindA4PageHeightPx,
  );
};

export const getCoppermindInkCellHeight = (
  strokes: CoppermindInkStroke[],
  heightMode: CoppermindInkHeightMode = 'clamped',
) => (
  normalizeCoppermindInkHeightMode(heightMode) === 'full'
    ? coppermindA4PageHeightPx
    : getCoppermindInkClampedHeight(strokes)
);

export const CoppermindInkCellSchema = defineBlockSchema({
  flavour: coppermindInkCellFlavour,
  props: (): CoppermindInkCellProps => ({
    background: coppermindInkBackgroundDefault,
    height: coppermindInkCellMinHeightPx,
    heightMode: 'clamped',
    inkVersion: 1,
    stackState: 'auto',
    strokeData: createEmptyStrokeData(),
  }),
  metadata: {
    version: coppermindInkCellSchemaVersion,
    role: 'content',
    parent: ['affine:note'],
    children: [],
  },
  toModel: () => new CoppermindInkCellModel(),
});

export class CoppermindInkCellModel extends BlockModel<CoppermindInkCellProps> {
  declare flavour: typeof coppermindInkCellFlavour;
}

type CoppermindInkInputPoint = {
  clientX: number;
  clientY: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
  timeStamp: number;
  twist?: number;
};

type CoppermindInkSheetMetrics = {
  height: number;
  left: number;
  top: number;
  width: number;
};

const getSheetMetrics = (sheet: HTMLElement): CoppermindInkSheetMetrics => {
  const rect = sheet.getBoundingClientRect();
  return {
    height: rect.height,
    left: rect.left,
    top: rect.top,
    width: rect.width,
  };
};

const pointFromInput = (
  input: CoppermindInkInputPoint,
  metrics: CoppermindInkSheetMetrics,
): CoppermindInkPoint => {
  const x = metrics.width > 0
    ? (input.clientX - metrics.left) * (coppermindCellWidthPx / metrics.width)
    : 0;
  const y = metrics.height > 0
    ? (input.clientY - metrics.top) * (coppermindA4PageHeightPx / metrics.height)
    : 0;

  return {
    pressure: input.pressure,
    t: Math.round(input.timeStamp),
    tiltX: input.tiltX,
    tiltY: input.tiltY,
    twist: input.twist,
    x: clamp(x, 0, coppermindCellWidthPx),
    y: clamp(y, 0, coppermindA4PageHeightPx),
  };
};

const pointFromPointerEvent = (
  event: PointerEvent,
  metrics: CoppermindInkSheetMetrics,
): CoppermindInkPoint => (
  pointFromInput(event, metrics)
);

const pointerDebugFields = (event: PointerEvent): CoppermindInkDebugFields => ({
  button: event.button,
  buttons: event.buttons,
  cancelable: event.cancelable,
  isPrimary: event.isPrimary,
  pointerId: event.pointerId,
  pointerType: event.pointerType,
  pressure: roundDebugNumber(event.pressure),
  target: debugTargetName(event.target),
  x: Math.round(event.clientX),
  y: Math.round(event.clientY),
});

const isStylusTouch = (touch: Touch) => (
  (touch as Touch & { touchType?: string }).touchType === 'stylus'
);

const touchDebugFields = (touch: Touch | undefined): CoppermindInkDebugFields => {
  if (!touch) return {};
  const extendedTouch = touch as Touch & {
    altitudeAngle?: number;
    azimuthAngle?: number;
    radiusX?: number;
    radiusY?: number;
    touchType?: string;
  };
  return {
    altitudeAngle: roundDebugNumber(extendedTouch.altitudeAngle),
    azimuthAngle: roundDebugNumber(extendedTouch.azimuthAngle),
    force: roundDebugNumber(touch.force),
    radiusX: roundDebugNumber(extendedTouch.radiusX),
    radiusY: roundDebugNumber(extendedTouch.radiusY),
    target: debugTargetName(touch.target),
    touchId: touch.identifier,
    touchType: extendedTouch.touchType ?? null,
    x: Math.round(touch.clientX),
    y: Math.round(touch.clientY),
  };
};

const summarizeTouches = (touches: TouchList) => (
  Array.from(touches).map(touch => {
    const type = (touch as Touch & { touchType?: string }).touchType ?? '?';
    const force = Number.isFinite(touch.force) ? Math.round(touch.force * 100) / 100 : '?';
    return `${touch.identifier}:${type}:${force}`;
  }).join(',')
);

const pointFromTouch = (
  touch: Touch,
  event: TouchEvent,
  metrics: CoppermindInkSheetMetrics,
): CoppermindInkPoint => {
  const force = Number.isFinite(touch.force) ? touch.force : undefined;
  return pointFromInput({
    clientX: touch.clientX,
    clientY: touch.clientY,
    pressure: force,
    timeStamp: event.timeStamp,
  }, metrics);
};

const strokeColorVarPattern = /^var\((--[^,\s)]+)(?:,\s*([^)]+))?\)$/;

const resolveStrokeColor = (host: HTMLElement, color: string) => {
  const match = color.match(strokeColorVarPattern);
  if (!match) return color;

  const [, propertyName, fallback] = match;
  return getComputedStyle(host).getPropertyValue(propertyName).trim()
    || fallback?.trim()
    || '#111827';
};

const prepareStrokeContext = (
  context: CanvasRenderingContext2D,
  host: HTMLElement,
  stroke: CoppermindInkStroke,
) => {
  const color = resolveStrokeColor(host, stroke.color);
  context.fillStyle = color;
  context.strokeStyle = color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = stroke.width;
};

const drawStrokePoint = (
  context: CanvasRenderingContext2D,
  host: HTMLElement,
  stroke: CoppermindInkStroke,
  point: CoppermindInkPoint,
) => {
  prepareStrokeContext(context, host, stroke);
  context.beginPath();
  context.arc(point.x, point.y, Math.max(1.5, stroke.width / 2), 0, Math.PI * 2);
  context.fill();
};

const drawStrokeSegment = (
  context: CanvasRenderingContext2D,
  host: HTMLElement,
  stroke: CoppermindInkStroke,
  from: CoppermindInkPoint,
  to: CoppermindInkPoint,
) => {
  prepareStrokeContext(context, host, stroke);
  context.beginPath();
  context.moveTo(from.x, from.y);
  context.lineTo(to.x, to.y);
  context.stroke();
};

const drawStrokePath = (
  context: CanvasRenderingContext2D,
  host: HTMLElement,
  stroke: CoppermindInkStroke,
) => {
  const firstPoint = stroke.points[0];
  if (!firstPoint) return;

  if (stroke.points.length === 1) {
    drawStrokePoint(context, host, stroke, firstPoint);
    return;
  }

  prepareStrokeContext(context, host, stroke);
  context.beginPath();
  context.moveTo(firstPoint.x, firstPoint.y);
  for (let index = 1; index < stroke.points.length; index += 1) {
    const point = stroke.points[index];
    if (point) context.lineTo(point.x, point.y);
  }
  context.stroke();
};

const expandInkCellIcon = html`
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
    <path d="M15 3h6v6"></path>
    <path d="m21 3-7 7"></path>
    <path d="M9 21H3v-6"></path>
    <path d="m3 21 7-7"></path>
  </svg>
`;

const collapseInkCellIcon = html`
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
    <path d="M9 3v6H3"></path>
    <path d="m3 9 7-7"></path>
    <path d="M15 21v-6h6"></path>
    <path d="m21 15-7 7"></path>
  </svg>
`;

const inkCellMoreIcon = html`
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
    <circle cx="12" cy="12" r="1"></circle>
    <circle cx="19" cy="12" r="1"></circle>
    <circle cx="5" cy="12" r="1"></circle>
  </svg>
`;

const inkCellMenuChevronIcon = html`
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
    <path d="m9 18 6-6-6-6"></path>
  </svg>
`;

export class CoppermindInkCellComponent extends BlockComponent<CoppermindInkCellModel> {
  static override styles = css`
    coppermind-ink-cell {
      --coppermind-ink-grid-color: rgba(148, 163, 184, 0.14);
      --coppermind-ink-margin-color: rgba(248, 113, 113, 0.28);
      --coppermind-ink-paper-color: var(--affine-note-background-white, #fff);
      --coppermind-ink-rule-color: rgba(148, 163, 184, 0.18);
      --coppermind-ink-rule-subtle-color: rgba(148, 163, 184, 0.1);
      display: block;
      height: var(--coppermind-ink-cell-height, ${coppermindInkCellMinHeightPx}px);
      max-height: var(--coppermind-ink-a4-height, ${coppermindA4PageHeightPx}px);
      outline: none;
      overflow: hidden;
      touch-action: auto;
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }

    .coppermind-ink-cell-viewport {
      display: block;
      height: var(--coppermind-ink-cell-height, ${coppermindInkCellMinHeightPx}px);
      max-height: var(--coppermind-ink-a4-height, ${coppermindA4PageHeightPx}px);
      overflow: hidden;
      position: relative;
      touch-action: auto;
      transition: height 140ms ease;
      user-select: none;
      width: 100%;
    }

    .coppermind-ink-cell-sheet {
      background:
        linear-gradient(to bottom, rgba(148, 163, 184, 0.18) 1px, transparent 1px)
          0 48px / 100% 32px,
        var(--coppermind-ink-paper-color);
      height: var(--coppermind-ink-a4-height, ${coppermindA4PageHeightPx}px);
      position: relative;
      touch-action: auto;
      width: 100%;
    }

    coppermind-ink-cell[data-coppermind-ink-background="college"] .coppermind-ink-cell-sheet,
    .coppermind-ink-cell-viewport[data-coppermind-ink-background="college"] .coppermind-ink-cell-sheet {
      background:
        linear-gradient(to bottom, var(--coppermind-ink-rule-color) 1px, transparent 1px)
          0 48px / 100% 32px,
        var(--coppermind-ink-paper-color);
    }

    coppermind-ink-cell[data-coppermind-ink-background="irish"] .coppermind-ink-cell-sheet,
    .coppermind-ink-cell-viewport[data-coppermind-ink-background="irish"] .coppermind-ink-cell-sheet {
      background:
        linear-gradient(to right, transparent 0 64px, var(--coppermind-ink-margin-color) 64px 65px, transparent 65px),
        linear-gradient(to bottom, transparent 0 23px, var(--coppermind-ink-rule-subtle-color) 23px 24px, transparent 24px 47px, var(--coppermind-ink-rule-color) 47px 48px)
          0 48px / 100% 48px,
        var(--coppermind-ink-paper-color);
    }

    coppermind-ink-cell[data-coppermind-ink-background="grid"] .coppermind-ink-cell-sheet,
    .coppermind-ink-cell-viewport[data-coppermind-ink-background="grid"] .coppermind-ink-cell-sheet {
      background:
        linear-gradient(to right, var(--coppermind-ink-grid-color) 1px, transparent 1px) 0 0 / 24px 24px,
        linear-gradient(to bottom, var(--coppermind-ink-grid-color) 1px, transparent 1px) 0 0 / 24px 24px,
        var(--coppermind-ink-paper-color);
    }

    .coppermind-ink-cell-canvas {
      display: block;
      height: var(--coppermind-ink-a4-height, ${coppermindA4PageHeightPx}px);
      inset: 0;
      pointer-events: none;
      position: absolute;
      touch-action: auto;
      width: 100%;
    }

    .coppermind-ink-cell-controls {
      display: flex;
      gap: 6px;
      left: 8px;
      position: absolute;
      top: 8px;
      z-index: 3;
    }

    .coppermind-ink-cell-control-button {
      align-items: center;
      background: color-mix(in srgb, var(--coppermind-ink-paper-color) 82%, transparent);
      border: 1px solid color-mix(in srgb, var(--affine-icon-color, #64748b) 22%, transparent);
      border-radius: 6px;
      color: var(--affine-icon-color, #64748b);
      cursor: pointer;
      display: flex;
      height: 28px;
      justify-content: center;
      opacity: 0.72;
      padding: 0;
      transition: opacity 120ms ease, background-color 120ms ease, border-color 120ms ease;
      width: 28px;
    }

    .coppermind-ink-cell-control-button:hover,
    .coppermind-ink-cell-control-button:focus-visible,
    .coppermind-ink-cell-control-button[aria-expanded="true"] {
      background: color-mix(in srgb, var(--coppermind-ink-paper-color) 94%, transparent);
      border-color: color-mix(in srgb, var(--affine-icon-color, #64748b) 44%, transparent);
      opacity: 1;
    }

    .coppermind-ink-cell-control-button:focus-visible,
    .coppermind-ink-cell-menu button:focus-visible {
      outline: 2px solid var(--affine-primary-color, #8b5cf6);
      outline-offset: 2px;
    }

    .coppermind-ink-cell-control-button svg,
    .coppermind-ink-cell-menu svg {
      display: block;
      height: 16px;
      pointer-events: none;
      width: 16px;
    }

    .coppermind-ink-cell-menu {
      background: color-mix(in srgb, var(--coppermind-ink-paper-color) 94%, transparent);
      border: 1px solid color-mix(in srgb, var(--affine-icon-color, #64748b) 22%, transparent);
      border-radius: 6px;
      box-shadow: 0 8px 18px rgba(17, 17, 27, 0.24);
      color: var(--affine-text-primary-color, #111827);
      left: 76px;
      min-width: 132px;
      padding: 4px;
      position: absolute;
      top: 8px;
      z-index: 4;
    }

    .coppermind-ink-cell-menu-group {
      position: relative;
    }

    .coppermind-ink-cell-menu-row,
    .coppermind-ink-cell-menu-option {
      align-items: center;
      background: transparent;
      border: 0;
      border-radius: 4px;
      color: inherit;
      display: flex;
      font: inherit;
      gap: 8px;
      height: 28px;
      justify-content: space-between;
      line-height: 1;
      min-width: 100%;
      padding: 0 8px;
      text-align: left;
      white-space: nowrap;
    }

    .coppermind-ink-cell-menu-row {
      color: var(--affine-text-secondary-color, #64748b);
      cursor: default;
    }

    .coppermind-ink-cell-submenu {
      background: color-mix(in srgb, var(--coppermind-ink-paper-color) 94%, transparent);
      border: 1px solid color-mix(in srgb, var(--affine-icon-color, #64748b) 22%, transparent);
      border-radius: 6px;
      box-shadow: 0 8px 18px rgba(17, 17, 27, 0.24);
      left: calc(100% - 1px);
      min-width: 104px;
      padding: 4px;
      position: absolute;
      top: -5px;
    }

    .coppermind-ink-cell-menu-option {
      cursor: pointer;
    }

    .coppermind-ink-cell-menu-option:hover,
    .coppermind-ink-cell-menu-option:focus-visible,
    .coppermind-ink-cell-menu-option[aria-checked="true"] {
      background: color-mix(in srgb, var(--affine-primary-color, #8b5cf6) 16%, transparent);
      color: var(--affine-text-primary-color, #111827);
    }
  `;

  private _activePointerId: number | undefined;

  private _activeTouchId: number | undefined;

  private _draftStroke: CoppermindInkStroke | undefined;

  private _activeSheetMetrics: CoppermindInkSheetMetrics | undefined;

  private _selectOnlyStylusTouchHandle: number | undefined;

  private _selectOnlyStylusTouchId: number | undefined;

  private _selectOnlyStylusTouchPending = false;

  private _pendingCommitStrokes: CoppermindInkStroke[] = [];

  private _pendingStrokeCommitHandle: number | undefined;

  private _renderFrame: number | undefined;

  private _isMenuOpen = false;

  override connectedCallback() {
    super.connectedCallback();
    this.contentEditable = 'false';
    if (!this.hasAttribute('tabindex')) this.tabIndex = -1;
    window.addEventListener('pointerdown', this._handleWindowPointerStart, { capture: true, passive: false });
    window.addEventListener('pointermove', this._handleWindowPointerMove, { capture: true, passive: false });
    window.addEventListener('pointerup', this._handleWindowPointerEnd, { capture: true, passive: false });
    window.addEventListener('pointercancel', this._handleWindowPointerCancel, { capture: true, passive: false });
    window.addEventListener('touchstart', this._handleWindowTouchStart, { capture: true, passive: false });
    window.addEventListener('touchmove', this._handleWindowTouchMove, { capture: true, passive: false });
    window.addEventListener('touchend', this._handleWindowTouchEnd, { capture: true, passive: false });
    window.addEventListener('touchcancel', this._handleWindowTouchCancel, { capture: true, passive: false });
  }

  override disconnectedCallback() {
    this._flushPendingStrokeCommit({ rescheduleIfActive: false });
    if (this._renderFrame !== undefined) {
      window.cancelAnimationFrame(this._renderFrame);
      this._renderFrame = undefined;
    }
    this._clearSelectOnlyStylusTouch();
    window.removeEventListener('pointerdown', this._handleWindowPointerStart, true);
    window.removeEventListener('pointermove', this._handleWindowPointerMove, true);
    window.removeEventListener('pointerup', this._handleWindowPointerEnd, true);
    window.removeEventListener('pointercancel', this._handleWindowPointerCancel, true);
    window.removeEventListener('touchstart', this._handleWindowTouchStart, true);
    window.removeEventListener('touchmove', this._handleWindowTouchMove, true);
    window.removeEventListener('touchend', this._handleWindowTouchEnd, true);
    window.removeEventListener('touchcancel', this._handleWindowTouchCancel, true);
    super.disconnectedCallback();
  }

  override updated(changedProperties: PropertyValues<this>) {
    super.updated(changedProperties);
    this._syncStrokeCanvases();
  }

  private _getSheet(target: EventTarget | null) {
    const element = target instanceof Element ? target : this;
    return element.closest(coppermindInkCellElementName)
      ?.querySelector<HTMLElement>('.coppermind-ink-cell-sheet') ?? undefined;
  }

  private _isEventInThisInkCell(event: Event) {
    if (event.composedPath().includes(this)) return true;
    const target = event.target instanceof Element ? event.target : null;
    return target?.closest(coppermindInkCellElementName) === this;
  }

  private _isEventInInkControl(event: Event) {
    return event.composedPath().some(item => (
      item instanceof Element
      && item.getAttribute('data-coppermind-ink-control') === 'true'
    ));
  }

  private _stopControlEvent(event: Event) {
    event.preventDefault();
    event.stopPropagation();
  }

  private _getHeightMode() {
    return normalizeCoppermindInkHeightMode(this.model.heightMode);
  }

  private _getBackground() {
    return normalizeCoppermindInkBackground(this.model.background);
  }

  private _appendEventPoints(event: PointerEvent) {
    if (!this._draftStroke || !this._activeSheetMetrics) return;

    const events = event.getCoalescedEvents?.() ?? [event];
    let previousPoint = this._draftStroke.points.at(-1);
    for (const item of events) {
      const point = pointFromPointerEvent(item, this._activeSheetMetrics);
      this._draftStroke.points.push(point);
      if (previousPoint) {
        this._drawDraftSegment(previousPoint, point);
      } else {
        this._drawDraftPoint(point);
      }
      previousPoint = point;
    }
    this._scheduleAutoExpandIfNeeded();
  }

  private _stopInputEvent(event: Event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    event.stopPropagation();
  }

  private _debugInput(event: string, fields: CoppermindInkDebugFields = {}) {
    postCoppermindInkDebug(event, {
      activePointerId: this._activePointerId ?? null,
      activeTouchId: this._activeTouchId ?? null,
      blockId: this.model.id,
      draftPoints: this._draftStroke?.points.length ?? 0,
      hasDraft: Boolean(this._draftStroke),
      isActive: this._isPageModeInkCellActive(),
      pending: this._pendingCommitStrokes.length,
      selectOnlyTouchId: this._selectOnlyStylusTouchId ?? null,
      selectOnlyTouchPending: this._selectOnlyStylusTouchPending,
      ...fields,
    });
  }

  private _dispatchFocus(options: { heightMode?: CoppermindInkHeightMode; scrollToTop?: boolean } = {}) {
    this.focus({ preventScroll: true });
    this.dispatchEvent(new CustomEvent('coppermind-ink-cell-focus', {
      bubbles: true,
      composed: true,
      detail: {
        blockId: this.model.id,
        heightMode: options.heightMode ?? this._getHeightMode(),
        scrollToTop: options.scrollToTop ?? false,
      },
    }));
  }

  private _dispatchSelectFocus() {
    const heightMode = this._getHeightMode();
    this._dispatchFocus({
      heightMode,
      scrollToTop: heightMode === 'full',
    });
  }

  private _isPageModeInkCellActive() {
    if (!this.closest('page-editor')) return true;
    return this.closest<HTMLElement>('affine-note')?.dataset.coppermindActiveSection === 'true';
  }

  private _armSelectOnlyStylusTouch() {
    this._clearSelectOnlyStylusTouch();
    this._selectOnlyStylusTouchPending = true;
    this._selectOnlyStylusTouchHandle = window.setTimeout(() => {
      this._clearSelectOnlyStylusTouch();
    }, 1000);
  }

  private _clearSelectOnlyStylusTouch() {
    if (this._selectOnlyStylusTouchHandle !== undefined) {
      window.clearTimeout(this._selectOnlyStylusTouchHandle);
      this._selectOnlyStylusTouchHandle = undefined;
    }
    this._selectOnlyStylusTouchId = undefined;
    this._selectOnlyStylusTouchPending = false;
  }

  private _consumeSelectOnlyStylusTouch(touch: Touch) {
    if (
      !this._selectOnlyStylusTouchPending
      && this._selectOnlyStylusTouchId !== touch.identifier
    ) {
      return false;
    }

    this._selectOnlyStylusTouchId = touch.identifier;
    this._selectOnlyStylusTouchPending = false;
    return true;
  }

  private _scheduleRender() {
    if (this._renderFrame !== undefined) return;
    this._renderFrame = window.requestAnimationFrame(() => {
      this._renderFrame = undefined;
      this.requestUpdate();
    });
  }

  private _queryInkElement<T extends Element>(selector: string) {
    const root = this.renderRoot instanceof DocumentFragment || this.renderRoot instanceof Element
      ? this.renderRoot
      : this;
    return root.querySelector<T>(selector) ?? this.querySelector<T>(selector);
  }

  private _getViewport() {
    return this._queryInkElement<HTMLElement>('.coppermind-ink-cell-viewport');
  }

  private _getCommittedStrokeCanvas() {
    return this._queryInkElement<HTMLCanvasElement>('.coppermind-ink-committed-canvas');
  }

  private _getLiveStrokeCanvas() {
    return this._queryInkElement<HTMLCanvasElement>('.coppermind-ink-live-canvas');
  }

  private _visibleLiveStrokes() {
    return [
      ...this._pendingCommitStrokes,
      ...(this._draftStroke ? [this._draftStroke] : []),
    ];
  }

  private _getCurrentRenderedHeight() {
    const cssHeight = Number.parseFloat(this.style.getPropertyValue('--coppermind-ink-cell-height'));
    if (Number.isFinite(cssHeight) && cssHeight > 0) return cssHeight;

    const viewportHeight = this._getViewport()?.getBoundingClientRect().height;
    if (viewportHeight && Number.isFinite(viewportHeight) && viewportHeight > 0) return viewportHeight;

    return coppermindInkCellMinHeightPx;
  }

  private _getVisibleStrokeMaxY() {
    const payload = parseCoppermindInkStrokeData(this.model.strokeData);
    return getCoppermindInkMaxY([
      ...payload.strokes,
      ...this._visibleLiveStrokes(),
    ]);
  }

  private _getRenderedHeight(strokes: CoppermindInkStroke[], heightMode: CoppermindInkHeightMode) {
    const contentHeight = getCoppermindInkCellHeight(strokes, heightMode);
    if (heightMode === 'full' || !this._draftStroke) return contentHeight;

    const maxY = getCoppermindInkMaxY(strokes);
    const currentHeight = clamp(
      this._getCurrentRenderedHeight(),
      coppermindInkCellMinHeightPx,
      coppermindA4PageHeightPx,
    );
    if (maxY <= currentHeight - coppermindInkAutoExpandDistancePx) {
      return Math.max(contentHeight, currentHeight);
    }

    return clamp(
      Math.max(contentHeight, currentHeight + coppermindInkAutoExpandDistancePx),
      coppermindInkCellMinHeightPx,
      coppermindA4PageHeightPx,
    );
  }

  private _scheduleAutoExpandIfNeeded() {
    if (this._getHeightMode() === 'full' || !this._draftStroke) return;

    const currentHeight = this._getCurrentRenderedHeight();
    if (this._getVisibleStrokeMaxY() > currentHeight - coppermindInkAutoExpandDistancePx) {
      this._scheduleRender();
    }
  }

  private _getCanvasContext(canvas: HTMLCanvasElement, options: { clear?: boolean } = {}) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const cssWidth = canvas.clientWidth || rect.width || coppermindCellWidthPx;
    const cssHeight = canvas.clientHeight || rect.height || coppermindA4PageHeightPx;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    const resized = canvas.width !== width || canvas.height !== height;

    if (resized) {
      canvas.width = width;
      canvas.height = height;
    }

    const context = canvas.getContext('2d');
    if (!context) return undefined;

    context.setTransform(1, 0, 0, 1, 0, 0);
    if (options.clear) {
      context.clearRect(0, 0, width, height);
    }
    context.setTransform(
      width / coppermindCellWidthPx,
      0,
      0,
      height / coppermindA4PageHeightPx,
      0,
      0,
    );

    return { context, resized };
  }

  private _updateInkEmptyState(payload = parseCoppermindInkStrokeData(this.model.strokeData)) {
    const hasLiveStroke = this._visibleLiveStrokes().some(stroke => stroke.points.length > 0);
    const emptyState = payload.strokes.length > 0 || hasLiveStroke ? 'false' : 'true';
    this._getViewport()?.setAttribute('data-coppermind-ink-empty', emptyState);
    this.dataset.coppermindInkEmpty = emptyState;
  }

  private _syncCommittedStrokeCanvas(payload = parseCoppermindInkStrokeData(this.model.strokeData)) {
    const canvas = this._getCommittedStrokeCanvas();
    if (!canvas) return;

    const canvasContext = this._getCanvasContext(canvas, { clear: true });
    if (!canvasContext) return;

    for (const stroke of payload.strokes) {
      drawStrokePath(canvasContext.context, this, stroke);
    }
  }

  private _syncLiveStrokeCanvas() {
    const canvas = this._getLiveStrokeCanvas();
    if (!canvas) return;

    const canvasContext = this._getCanvasContext(canvas, { clear: true });
    if (!canvasContext) return;

    for (const stroke of this._visibleLiveStrokes()) {
      drawStrokePath(canvasContext.context, this, stroke);
    }
  }

  private _syncStrokeCanvases(payload = parseCoppermindInkStrokeData(this.model.strokeData)) {
    this._syncCommittedStrokeCanvas(payload);
    this._syncLiveStrokeCanvas();
    this._updateInkEmptyState(payload);
  }

  private _drawDraftPoint(point: CoppermindInkPoint) {
    if (!this._draftStroke) return;

    const canvas = this._getLiveStrokeCanvas();
    if (!canvas) return;

    const canvasContext = this._getCanvasContext(canvas);
    if (!canvasContext) return;
    if (canvasContext.resized) {
      this._syncLiveStrokeCanvas();
      this._updateInkEmptyState();
      return;
    }

    drawStrokePoint(canvasContext.context, this, this._draftStroke, point);
    this._updateInkEmptyState();
  }

  private _drawDraftSegment(from: CoppermindInkPoint, to: CoppermindInkPoint) {
    if (!this._draftStroke) return;

    const canvas = this._getLiveStrokeCanvas();
    if (!canvas) return;

    const canvasContext = this._getCanvasContext(canvas);
    if (!canvasContext) return;
    if (canvasContext.resized) {
      this._syncLiveStrokeCanvas();
      this._updateInkEmptyState();
      return;
    }

    drawStrokeSegment(canvasContext.context, this, this._draftStroke, from, to);
  }

  private _syncRenderedLayout(
    height: number,
    hasVisibleInk: boolean,
    heightMode: CoppermindInkHeightMode,
    background: CoppermindInkBackground,
  ) {
    const renderedHeight = `${height}px`;
    const maxHeight = `${coppermindA4PageHeightPx}px`;
    this.style.setProperty('--coppermind-ink-a4-height', maxHeight);
    this.style.setProperty('--coppermind-ink-cell-height', renderedHeight);
    this.style.height = renderedHeight;
    this.style.maxHeight = maxHeight;
    this.dataset.coppermindInkBackground = background;
    this.dataset.coppermindInkEmpty = hasVisibleInk ? 'false' : 'true';
    this.dataset.coppermindInkHeightMode = heightMode;
  }

  private _closeMenu() {
    if (!this._isMenuOpen) return;
    this._isMenuOpen = false;
    this.requestUpdate();
  }

  private _toggleMenu = (event: Event) => {
    this._stopControlEvent(event);
    this._dispatchFocus();
    this._isMenuOpen = !this._isMenuOpen;
    this.requestUpdate();
  };

  private _toggleHeightMode = (event: Event) => {
    this._stopControlEvent(event);
    const payload = parseCoppermindInkStrokeData(this.model.strokeData);
    const strokes = [
      ...payload.strokes,
      ...this._visibleLiveStrokes(),
    ];
    const heightMode: CoppermindInkHeightMode = this._getHeightMode() === 'full'
      ? 'clamped'
      : 'full';

    this.doc.updateBlock(this.model, {
      height: getCoppermindInkCellHeight(strokes, heightMode),
      heightMode,
      inkVersion: 1,
    });
    this._dispatchFocus({
      heightMode,
      scrollToTop: heightMode === 'full',
    });
    this._scheduleRender();
  };

  private _setBackground(event: Event, background: CoppermindInkBackground) {
    this._stopControlEvent(event);
    const normalizedBackground = normalizeCoppermindInkBackground(background);
    this._dispatchFocus();
    this.doc.updateBlock(this.model, {
      background: normalizedBackground,
      inkVersion: 1,
    });
    this._isMenuOpen = false;
    this.requestUpdate();
  }

  private _handleMenuKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    this._stopControlEvent(event);
    this._closeMenu();
  };

  private _beginDraftStroke(point: CoppermindInkPoint) {
    if (this._pendingStrokeCommitHandle !== undefined) {
      window.clearTimeout(this._pendingStrokeCommitHandle);
      this._pendingStrokeCommitHandle = undefined;
    }
    this._draftStroke = {
      color: 'var(--ctp-text, #111827)',
      id: `ink:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      points: [point],
      width: 2.6,
    };
    this._drawDraftPoint(point);
    this._scheduleAutoExpandIfNeeded();
  }

  private _queueDraftStrokeCommit() {
    if (!this._draftStroke) return;
    this._pendingCommitStrokes.push(this._draftStroke);
    this._schedulePendingStrokeCommit();
  }

  private _schedulePendingStrokeCommit(delay = 900) {
    if (this._pendingStrokeCommitHandle !== undefined) {
      window.clearTimeout(this._pendingStrokeCommitHandle);
    }

    this._pendingStrokeCommitHandle = window.setTimeout(() => {
      this._pendingStrokeCommitHandle = undefined;
      this._flushPendingStrokeCommit();
    }, delay);
  }

  private _flushPendingStrokeCommit(options: { rescheduleIfActive?: boolean } = {}) {
    if (this._pendingStrokeCommitHandle !== undefined) {
      window.clearTimeout(this._pendingStrokeCommitHandle);
      this._pendingStrokeCommitHandle = undefined;
    }
    if (this._draftStroke) {
      if (options.rescheduleIfActive ?? true) {
        this._schedulePendingStrokeCommit();
      }
      return;
    }
    if (this._pendingCommitStrokes.length === 0) return;

    const pendingStrokes = this._pendingCommitStrokes;
    this._pendingCommitStrokes = [];
    const startedAt = performance.now();
    this._debugInput('commit-flush-start', {
      pendingCount: pendingStrokes.length,
    });
    const payload = parseCoppermindInkStrokeData(this.model.strokeData);
    const strokes = [...payload.strokes, ...pendingStrokes];
    const heightMode = this._getHeightMode();
    this.doc.updateBlock(this.model, {
      height: getCoppermindInkCellHeight(strokes, heightMode),
      heightMode,
      inkVersion: 1,
      strokeData: JSON.stringify({ strokes, version: 1 } satisfies CoppermindInkCellPayload),
    });
    this._syncStrokeCanvases({ strokes, version: 1 });
    this._scheduleRender();
    this._debugInput('commit-flush-end', {
      duration: Math.round((performance.now() - startedAt) * 10) / 10,
      pendingCount: pendingStrokes.length,
      strokeCount: strokes.length,
    });
  }

  private _finishActiveStroke() {
    this._queueDraftStrokeCommit();
    this._releaseActivePointerCapture();
    this._activePointerId = undefined;
    this._activeTouchId = undefined;
    this._activeSheetMetrics = undefined;
    this._draftStroke = undefined;
    this._updateInkEmptyState();
  }

  private _releaseActivePointerCapture() {
    if (this._activePointerId === undefined) return;

    try {
      if (this.hasPointerCapture(this._activePointerId)) {
        this.releasePointerCapture(this._activePointerId);
      }
    } catch {
      // Pointer capture can already be released by the UA at this point.
    }
  }

  private _clearDraftStroke() {
    this._activePointerId = undefined;
    this._activeTouchId = undefined;
    this._activeSheetMetrics = undefined;
    this._draftStroke = undefined;
    this._syncLiveStrokeCanvas();
    this._updateInkEmptyState();
  }

  private _beginStroke(event: PointerEvent) {
    this._debugInput('pointerdown-received', pointerDebugFields(event));
    if (this._isEventInInkControl(event)) {
      this._debugInput('pointerdown-skip-control', pointerDebugFields(event));
      return;
    }
    if (event.pointerType !== 'pen') {
      const wasActive = this._isPageModeInkCellActive();
      const isPageModeMouseSelect = (
        this.closest('page-editor')
        && (event.pointerType === 'mouse' || event.pointerType === '')
        && event.button === 0
      );
      if (isPageModeMouseSelect && !wasActive) {
        this._dispatchSelectFocus();
      } else if (event.pointerType === 'touch' && !wasActive) {
        this._armSelectOnlyStylusTouch();
      }
      this._debugInput('pointerdown-skip-non-pen', {
        ...pointerDebugFields(event),
        armedSelectOnlyTouch: event.pointerType === 'touch' && !wasActive,
        selectedByMouse: isPageModeMouseSelect && !wasActive,
        wasActive,
      });
      return;
    }
    if (shouldPreferStylusTouchEvents()) {
      const sheet = this._getSheet(event.target);
      if (!sheet) {
        this._debugInput('pointerdown-skip-no-sheet', pointerDebugFields(event));
        return;
      }

      const wasActive = this._isPageModeInkCellActive();
      this._stopInputEvent(event);
      if (!wasActive) {
        this._armSelectOnlyStylusTouch();
        this._dispatchSelectFocus();
      }
      this._debugInput('pointerdown-defer-stylus-touch', {
        ...pointerDebugFields(event),
        wasActive,
      });
      return;
    }
    if (this._draftStroke) {
      if (this._activeTouchId !== undefined) {
        this._debugInput('pointerdown-skip-active-touch', pointerDebugFields(event));
        return;
      }
      this._debugInput('pointerdown-finish-stale-draft', pointerDebugFields(event));
      this._finishActiveStroke();
    }
    const sheet = this._getSheet(event.target);
    if (!sheet) {
      this._debugInput('pointerdown-skip-no-sheet', pointerDebugFields(event));
      return;
    }

    const wasActive = this._isPageModeInkCellActive();
    this._stopInputEvent(event);
    if (!wasActive) {
      this._dispatchSelectFocus();
      this._debugInput('pointerdown-skip-inactive', pointerDebugFields(event));
      return;
    }

    this.setPointerCapture(event.pointerId);
    this._activePointerId = event.pointerId;
    const metrics = getSheetMetrics(sheet);
    this._activeSheetMetrics = metrics;
    this._beginDraftStroke(pointFromPointerEvent(event, metrics));
    this._debugInput('pointerdown-begin', {
      ...pointerDebugFields(event),
      sheetHeight: Math.round(metrics.height),
      sheetWidth: Math.round(metrics.width),
    });
  }

  private _extendStroke(event: PointerEvent) {
    if (this._activePointerId !== event.pointerId) return;
    this._stopInputEvent(event);
    this._appendEventPoints(event);
  }

  private _finishStroke(event: PointerEvent) {
    this._debugInput('pointerup-received', pointerDebugFields(event));
    if (this._activePointerId !== event.pointerId || !this._draftStroke) {
      this._debugInput('pointerup-skip-untracked', pointerDebugFields(event));
      return;
    }
    this._stopInputEvent(event);
    const pointCount = this._draftStroke.points.length;
    this._finishActiveStroke();
    this._debugInput('pointerup-finish', {
      ...pointerDebugFields(event),
      pointCount,
    });
  }

  private _cancelStroke(event: PointerEvent) {
    if (this._activePointerId !== event.pointerId) return;
    this._debugInput('pointercancel', pointerDebugFields(event));
    this._releaseActivePointerCapture();
    this._clearDraftStroke();
  }

  private _handleWindowPointerMove = (event: PointerEvent) => {
    if (this._activePointerId !== event.pointerId) return;
    this._extendStroke(event);
  };

  private _handleWindowPointerStart = (event: PointerEvent) => {
    const isInThisCell = this._isEventInThisInkCell(event);
    if (this._isMenuOpen && (!isInThisCell || !this._isEventInInkControl(event))) {
      this._closeMenu();
    }
    if (!isInThisCell) return;
    this._beginStroke(event);
  };

  private _handleWindowPointerEnd = (event: PointerEvent) => {
    if (this._activePointerId !== event.pointerId) return;
    this._finishStroke(event);
  };

  private _handleWindowPointerCancel = (event: PointerEvent) => {
    if (this._activePointerId !== event.pointerId) return;
    this._cancelStroke(event);
  };

  private _getTrackedTouch(event: TouchEvent) {
    if (this._activeTouchId === undefined) return undefined;
    return Array.from(event.changedTouches).find(touch => touch.identifier === this._activeTouchId);
  }

  private _appendTouchPoint(touch: Touch, event: TouchEvent) {
    if (!this._draftStroke || !this._activeSheetMetrics) return;

    const previousPoint = this._draftStroke.points.at(-1);
    const point = pointFromTouch(touch, event, this._activeSheetMetrics);
    this._draftStroke.points.push(point);
    if (previousPoint) {
      this._drawDraftSegment(previousPoint, point);
    } else {
      this._drawDraftPoint(point);
    }
    this._scheduleAutoExpandIfNeeded();
  }

  private _beginTouchStroke(event: TouchEvent) {
    if (this._isEventInInkControl(event)) {
      this._debugInput('touchstart-skip-control', {
        cancelable: event.cancelable,
        changedTouches: event.changedTouches.length,
        changedTouchSummary: summarizeTouches(event.changedTouches),
        targetTouches: event.targetTouches.length,
        touches: event.touches.length,
        touchSummary: summarizeTouches(event.touches),
      });
      return;
    }
    const touch = event.changedTouches[0];
    this._debugInput('touchstart-received', {
      ...touchDebugFields(touch),
      cancelable: event.cancelable,
      changedTouches: event.changedTouches.length,
      changedTouchSummary: summarizeTouches(event.changedTouches),
      targetTouches: event.targetTouches.length,
      touches: event.touches.length,
      touchSummary: summarizeTouches(event.touches),
    });

    if (this._draftStroke) {
      if (this._activePointerId !== undefined) {
        this._debugInput('touchstart-skip-active-pointer', touchDebugFields(touch));
        return;
      }
      this._debugInput('touchstart-finish-stale-draft', touchDebugFields(touch));
      this._finishActiveStroke();
    }
    if (event.touches.length !== 1) {
      this._debugInput('touchstart-skip-multitouch', {
        ...touchDebugFields(touch),
        touches: event.touches.length,
        touchSummary: summarizeTouches(event.touches),
      });
      return;
    }
    if (touch && !isStylusTouch(touch)) {
      this._clearSelectOnlyStylusTouch();
      this._debugInput('touchstart-skip-non-stylus', touchDebugFields(touch));
      return;
    }

    if (!touch || !isStylusTouch(touch)) {
      this._debugInput('touchstart-skip-not-stylus', touchDebugFields(touch));
      return;
    }
    const sheet = this._getSheet(event.target);
    if (!sheet) {
      this._debugInput('touchstart-skip-no-sheet', touchDebugFields(touch));
      return;
    }

    if (this._consumeSelectOnlyStylusTouch(touch)) {
      this._stopInputEvent(event);
      this._debugInput('touchstart-skip-select-only', touchDebugFields(touch));
      return;
    }

    const wasActive = this._isPageModeInkCellActive();
    this._stopInputEvent(event);
    if (!wasActive) {
      this._dispatchSelectFocus();
      this._debugInput('touchstart-skip-inactive', touchDebugFields(touch));
      return;
    }

    this._activeTouchId = touch.identifier;
    const metrics = getSheetMetrics(sheet);
    this._activeSheetMetrics = metrics;
    this._beginDraftStroke(pointFromTouch(touch, event, metrics));
    this._debugInput('touchstart-begin', {
      ...touchDebugFields(touch),
      sheetHeight: Math.round(metrics.height),
      sheetWidth: Math.round(metrics.width),
    });
  }

  private _extendTouchStroke(event: TouchEvent) {
    const touch = this._getTrackedTouch(event);
    if (!touch || !this._draftStroke || !isStylusTouch(touch)) return;

    this._stopInputEvent(event);
    this._appendTouchPoint(touch, event);
  }

  private _finishTouchStroke(event: TouchEvent) {
    const touch = this._getTrackedTouch(event);
    this._debugInput('touchend-received', {
      ...touchDebugFields(touch),
      changedTouches: event.changedTouches.length,
      changedTouchSummary: summarizeTouches(event.changedTouches),
      touches: event.touches.length,
      touchSummary: summarizeTouches(event.touches),
    });
    if (!touch || !this._draftStroke) {
      this._debugInput('touchend-skip-untracked', touchDebugFields(touch));
      return;
    }

    this._stopInputEvent(event);
    const pointCount = this._draftStroke.points.length;
    this._finishActiveStroke();
    this._debugInput('touchend-finish', {
      ...touchDebugFields(touch),
      pointCount,
    });
  }

  private _cancelTouchStroke(event: TouchEvent) {
    const touch = this._getTrackedTouch(event);
    if (!touch) return;
    this._debugInput('touchcancel', touchDebugFields(touch));
    this._clearDraftStroke();
  }

  private _handleWindowTouchMove = (event: TouchEvent) => {
    if (this._activeTouchId === undefined) return;
    this._extendTouchStroke(event);
  };

  private _handleWindowTouchStart = (event: TouchEvent) => {
    const isInThisCell = this._isEventInThisInkCell(event);
    if (this._isMenuOpen && (!isInThisCell || !this._isEventInInkControl(event))) {
      this._closeMenu();
    }
    if (!isInThisCell) return;
    this._beginTouchStroke(event);
  };

  private _handleWindowTouchEnd = (event: TouchEvent) => {
    if (
      this._selectOnlyStylusTouchId !== undefined
      && Array.from(event.changedTouches).some(touch => touch.identifier === this._selectOnlyStylusTouchId)
    ) {
      this._stopInputEvent(event);
      this._debugInput('touchend-select-only', touchDebugFields(
        Array.from(event.changedTouches).find(touch => touch.identifier === this._selectOnlyStylusTouchId),
      ));
      this._clearSelectOnlyStylusTouch();
      return;
    }
    if (this._activeTouchId === undefined) return;
    this._finishTouchStroke(event);
  };

  private _handleWindowTouchCancel = (event: TouchEvent) => {
    if (
      this._selectOnlyStylusTouchId !== undefined
      && Array.from(event.changedTouches).some(touch => touch.identifier === this._selectOnlyStylusTouchId)
    ) {
      this._debugInput('touchcancel-select-only', touchDebugFields(
        Array.from(event.changedTouches).find(touch => touch.identifier === this._selectOnlyStylusTouchId),
      ));
      this._clearSelectOnlyStylusTouch();
      return;
    }
    if (this._activeTouchId === undefined) return;
    this._cancelTouchStroke(event);
  };

  override renderBlock() {
    const payload = parseCoppermindInkStrokeData(this.model.strokeData);
    const strokes = payload.strokes;
    const hasVisibleInk = strokes.length > 0
      || this._pendingCommitStrokes.length > 0
      || Boolean(this._draftStroke);
    const heightMode = this._getHeightMode();
    const background = this._getBackground();
    const visibleStrokes = [
      ...strokes,
      ...this._visibleLiveStrokes(),
    ];
    const height = this._getRenderedHeight(visibleStrokes, heightMode);
    const toggleLabel = heightMode === 'full' ? 'Collapse ink cell' : 'Expand ink cell';
    this._syncRenderedLayout(height, hasVisibleInk, heightMode, background);

    return html`
      <div
        class="coppermind-ink-cell-viewport"
        contenteditable="false"
        data-coppermind-ink-background=${background}
        data-coppermind-ink-empty=${hasVisibleInk ? 'false' : 'true'}
        data-coppermind-ink-height-mode=${heightMode}
        style=${styleMap({
          '--coppermind-ink-a4-height': `${coppermindA4PageHeightPx}px`,
          '--coppermind-ink-cell-height': `${height}px`,
          height: `${height}px`,
          'max-height': `${coppermindA4PageHeightPx}px`,
        })}
        @pointerdown=${this._beginStroke}
        @pointermove=${this._extendStroke}
        @pointerup=${this._finishStroke}
        @pointercancel=${this._cancelStroke}
        @touchstart=${this._beginTouchStroke}
        @touchmove=${this._extendTouchStroke}
        @touchend=${this._finishTouchStroke}
        @touchcancel=${this._cancelTouchStroke}
      >
        <div class="coppermind-ink-cell-controls" data-coppermind-ink-control="true">
          <button
            class="coppermind-ink-cell-control-button coppermind-ink-cell-toggle"
            contenteditable="false"
            data-coppermind-ink-control="true"
            type="button"
            aria-label=${toggleLabel}
            title=${toggleLabel}
            @click=${this._toggleHeightMode}
          >
            ${heightMode === 'full' ? collapseInkCellIcon : expandInkCellIcon}
          </button>
          <button
            class="coppermind-ink-cell-control-button coppermind-ink-cell-more"
            contenteditable="false"
            data-coppermind-ink-control="true"
            type="button"
            aria-expanded=${this._isMenuOpen ? 'true' : 'false'}
            aria-haspopup="menu"
            aria-label="More ink cell options"
            title="More ink cell options"
            @click=${this._toggleMenu}
          >
            ${inkCellMoreIcon}
          </button>
        </div>
        ${this._isMenuOpen
          ? html`
            <div
              class="coppermind-ink-cell-menu"
              contenteditable="false"
              data-coppermind-ink-control="true"
              role="menu"
              @keydown=${this._handleMenuKeydown}
            >
              <div class="coppermind-ink-cell-menu-group">
                <div
                  class="coppermind-ink-cell-menu-row"
                  aria-haspopup="menu"
                  role="menuitem"
                >
                  <span>Background</span>
                  ${inkCellMenuChevronIcon}
                </div>
                <div class="coppermind-ink-cell-submenu" role="menu" aria-label="Ink cell background">
                  ${coppermindInkBackgroundOptions.map(option => html`
                    <button
                      class="coppermind-ink-cell-menu-option"
                      contenteditable="false"
                      data-coppermind-ink-control="true"
                      type="button"
                      role="menuitemradio"
                      aria-checked=${background === option.id ? 'true' : 'false'}
                      @click=${(event: Event) => this._setBackground(event, option.id)}
                    >
                      ${option.label}
                    </button>
                  `)}
                </div>
              </div>
            </div>
          `
          : null}
        <div class="coppermind-ink-cell-sheet">
          <canvas class="coppermind-ink-cell-canvas coppermind-ink-committed-canvas"></canvas>
          <canvas class="coppermind-ink-cell-canvas coppermind-ink-live-canvas"></canvas>
        </div>
      </div>
    `;
  }
}

export const CoppermindInkCellBlockSpec: ExtensionType[] = [
  FlavourExtension(coppermindInkCellFlavour),
  BlockViewExtension(coppermindInkCellFlavour, literal`coppermind-ink-cell`),
];

let coppermindInkCellElementsRegistered = false;

export const registerCoppermindInkCellElements = () => {
  if (typeof customElements === 'undefined' || coppermindInkCellElementsRegistered) return;
  if (!customElements.get(coppermindInkCellElementName)) {
    customElements.define(coppermindInkCellElementName, CoppermindInkCellComponent);
  }
  coppermindInkCellElementsRegistered = true;
};

declare global {
  namespace BlockSuite {
    interface BlockModels {
      [coppermindInkCellFlavour]: CoppermindInkCellModel;
    }
  }

  interface HTMLElementTagNameMap {
    [coppermindInkCellElementName]: CoppermindInkCellComponent;
  }
}
