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
  coppermindDefaultCellHeightPx,
} from './coppermind-layout';

export const coppermindInkCellFlavour = 'coppermind:ink-cell';
export const coppermindInkCellElementName = 'coppermind-ink-cell';
export const coppermindInkCellSchemaVersion = 1;

export type CoppermindInkStackState = 'auto' | 'unstacked';

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
  height: number;
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

export const getCoppermindInkContentHeight = (strokes: CoppermindInkStroke[]) => {
  const maxY = strokes.reduce((currentMax, stroke) => (
    Math.max(currentMax, ...stroke.points.map(point => point.y))
  ), 0);

  if (maxY <= 0) return coppermindDefaultCellHeightPx;
  return clamp(Math.ceil(maxY + 48), coppermindDefaultCellHeightPx, coppermindA4PageHeightPx);
};

export const CoppermindInkCellSchema = defineBlockSchema({
  flavour: coppermindInkCellFlavour,
  props: (): CoppermindInkCellProps => ({
    height: coppermindDefaultCellHeightPx,
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

export class CoppermindInkCellComponent extends BlockComponent<CoppermindInkCellModel> {
  static override styles = css`
    :host {
      display: block;
      outline: none;
      touch-action: auto;
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
      -webkit-user-select: none;
      user-select: none;
    }

    .coppermind-ink-cell-viewport {
      display: block;
      height: var(--coppermind-ink-cell-height);
      max-height: var(--coppermind-ink-a4-height);
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
        var(--affine-note-background-white, #fff);
      height: var(--coppermind-ink-a4-height);
      position: relative;
      touch-action: auto;
      width: 100%;
    }

    .coppermind-ink-cell-canvas {
      display: block;
      height: var(--coppermind-ink-a4-height);
      inset: 0;
      pointer-events: none;
      position: absolute;
      touch-action: auto;
      width: 100%;
    }

    .coppermind-ink-cell-empty {
      align-items: center;
      color: var(--affine-placeholder-color);
      display: flex;
      font: 500 12px/1 var(--affine-font-family);
      inset: 0;
      justify-content: center;
      opacity: 0.74;
      pointer-events: none;
      position: absolute;
    }

    .coppermind-ink-cell-viewport[data-coppermind-ink-empty='false'] .coppermind-ink-cell-empty {
      display: none;
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

  private _dispatchFocus() {
    this.focus({ preventScroll: true });
    this.dispatchEvent(new CustomEvent('coppermind-ink-cell-focus', {
      bubbles: true,
      composed: true,
      detail: { blockId: this.model.id },
    }));
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
    this._getViewport()?.setAttribute(
      'data-coppermind-ink-empty',
      payload.strokes.length > 0 || hasLiveStroke ? 'false' : 'true',
    );
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
    this.doc.updateBlock(this.model, {
      height: getCoppermindInkContentHeight(strokes),
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
    if (event.pointerType !== 'pen') {
      const wasActive = this._isPageModeInkCellActive();
      if (event.pointerType === 'touch' && !wasActive) {
        this._armSelectOnlyStylusTouch();
      }
      this._debugInput('pointerdown-skip-non-pen', {
        ...pointerDebugFields(event),
        armedSelectOnlyTouch: event.pointerType === 'touch' && !wasActive,
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
        this._dispatchFocus();
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
      this._dispatchFocus();
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
    if (!this._isEventInThisInkCell(event)) return;
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
  }

  private _beginTouchStroke(event: TouchEvent) {
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
      this._dispatchFocus();
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
    if (!this._isEventInThisInkCell(event)) return;
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
    const height = clamp(
      Number.isFinite(this.model.height) ? this.model.height : coppermindDefaultCellHeightPx,
      coppermindDefaultCellHeightPx,
      coppermindA4PageHeightPx,
    );

    return html`
      <div
        class="coppermind-ink-cell-viewport"
        contenteditable="false"
        data-coppermind-ink-empty=${hasVisibleInk ? 'false' : 'true'}
        style=${styleMap({
          '--coppermind-ink-a4-height': `${coppermindA4PageHeightPx}px`,
          '--coppermind-ink-cell-height': `${height}px`,
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
        <div class="coppermind-ink-cell-sheet">
          <canvas class="coppermind-ink-cell-canvas coppermind-ink-committed-canvas"></canvas>
          <canvas class="coppermind-ink-cell-canvas coppermind-ink-live-canvas"></canvas>
          ${hasVisibleInk ? null : html`<div class="coppermind-ink-cell-empty">Ink Cell</div>`}
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
