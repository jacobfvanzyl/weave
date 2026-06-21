import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { subscribeApplePencilPalette, subscribeApplePencilSqueeze, subscribeApplePencilTap, type ApplePencilHoverPose } from '../../lib/apple-pencil';

export type ExcalidrawPencilTool =
  | 'selection'
  | 'freedraw'
  | 'eraser'
  | 'hand'
  | 'text'
  | 'arrow'
  | 'line'
  | 'rectangle'
  | 'diamond'
  | 'ellipse';

export type ExcalidrawPencilToolOverlayState = {
  activeTool?: ExcalidrawPencilTool;
  left: number;
  top: number;
};

export type ApplePencilExcalidrawControls = {
  closeToolOverlay: () => void;
  isPencilChromeHidden: boolean;
  isPencilInputActive: boolean;
  selectTool: (tool: ExcalidrawPencilTool) => void;
  toolOverlay: ExcalidrawPencilToolOverlayState | null;
};

type ExcalidrawActiveToolSnapshot = {
  type: string;
  customType?: string | null;
  locked?: boolean;
};

type ExcalidrawApiForPencil = {
  getAppState: () => {
    activeTool?: ExcalidrawActiveToolSnapshot;
    penMode?: boolean;
    scrollX?: number;
    scrollY?: number;
    zoom?: {
      value?: number;
    };
  };
  updateScene: (sceneData: {
    appState?: {
      scrollX: number;
      scrollY: number;
    };
    captureUpdate?: typeof CaptureUpdateAction.NEVER;
  }) => void;
  setActiveTool: (tool: any) => void;
};

const selectionTool: ExcalidrawActiveToolSnapshot = { type: 'selection' };
const pencilToolOverlaySize = 184;
const pencilToolOverlayInset = 8;
const pencilSqueezeHoldActivationDelaySeconds = 0.42;
const pencilToolOverlayOpenPointerGraceMs = 1000;
const pencilTapLikeSqueezeMaximumDurationMs = 520;
const pencilDoubleTapMaximumIntervalSeconds = 0.42;
const pencilNativeTapSuppressionSeconds = 0.7;
const pencilInputActiveInactivityMs = 1600;

const pencilToolTypes = new Set<ExcalidrawPencilTool>([
  'selection',
  'freedraw',
  'eraser',
  'hand',
  'text',
  'arrow',
  'line',
  'rectangle',
  'diamond',
  'ellipse',
]);

const isPencilTool = (tool: string | undefined): tool is ExcalidrawPencilTool =>
  Boolean(tool && pencilToolTypes.has(tool as ExcalidrawPencilTool));

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(Math.max(value, minimum), maximum);

const isViewportPointInsideRect = (point: { x: number; y: number }, rect: DOMRect) =>
  point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;

const getInteractiveCanvasBounds = (surface: HTMLElement) => {
  const canvas = surface.querySelector('canvas.interactive');
  const boundsTarget = canvas instanceof HTMLElement ? canvas : surface.querySelector('.excalidraw');
  if (!(boundsTarget instanceof HTMLElement)) return null;

  const bounds = boundsTarget.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return null;
  return bounds;
};

const getViewportCandidatesForHoverPose = (hoverPose: ApplePencilHoverPose) => {
  const candidates = [{ x: hoverPose.x, y: hoverPose.y }];
  const pixelRatio = window.devicePixelRatio;
  const visualViewport = window.visualViewport;

  if (Number.isFinite(pixelRatio) && pixelRatio > 0 && pixelRatio !== 1) {
    candidates.push({ x: hoverPose.x / pixelRatio, y: hoverPose.y / pixelRatio });
  }

  if (visualViewport) {
    candidates.push({
      x: hoverPose.x - visualViewport.offsetLeft,
      y: hoverPose.y - visualViewport.offsetTop,
    });

    if (visualViewport.scale > 0 && visualViewport.scale !== 1) {
      candidates.push({
        x: (hoverPose.x - visualViewport.offsetLeft) / visualViewport.scale,
        y: (hoverPose.y - visualViewport.offsetTop) / visualViewport.scale,
      });
    }
  }

  return candidates;
};

const resolveTapAnchorPoint = (
  hoverPose: ApplePencilHoverPose | undefined,
  surfaceBounds: DOMRect,
  canvasBounds: DOMRect,
) => {
  if (!hoverPose) {
    return {
      x: canvasBounds.left + canvasBounds.width / 2,
      y: canvasBounds.top + canvasBounds.height / 2,
    };
  }

  const candidates = getViewportCandidatesForHoverPose(hoverPose);
  const canvasCandidate = candidates.find(candidate => isViewportPointInsideRect(candidate, canvasBounds));
  if (canvasCandidate) return canvasCandidate;

  const surfaceCandidate = candidates.find(candidate => isViewportPointInsideRect(candidate, surfaceBounds));
  if (!surfaceCandidate) {
    return {
      x: canvasBounds.left + canvasBounds.width / 2,
      y: canvasBounds.top + canvasBounds.height / 2,
    };
  }

  return {
    x: clamp(surfaceCandidate.x, canvasBounds.left, canvasBounds.right),
    y: clamp(surfaceCandidate.y, canvasBounds.top, canvasBounds.bottom),
  };
};

const toRestorableTool = (tool: ExcalidrawActiveToolSnapshot | undefined): ExcalidrawActiveToolSnapshot => {
  if (!tool || typeof tool.type !== 'string') return selectionTool;
  if (tool.type === 'custom') {
    return typeof tool.customType === 'string'
      ? { type: 'custom', customType: tool.customType, locked: Boolean(tool.locked) }
      : selectionTool;
  }

  return {
    type: tool.type,
    locked: Boolean(tool.locked),
  };
};

export const useApplePencilExcalidrawControls = (
  excalidrawApiRef: RefObject<ExcalidrawApiForPencil | null>,
  surfaceRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): ApplePencilExcalidrawControls => {
  const [isPencilHandModeActive, setIsPencilHandModeActive] = useState(false);
  const [isNativePaletteVisible, setIsNativePaletteVisible] = useState(false);
  const [isPencilInputActive, setIsPencilInputActive] = useState(false);
  const [toolOverlay, setToolOverlay] = useState<ExcalidrawPencilToolOverlayState | null>(null);
  const isPencilHandModeActiveRef = useRef(false);
  const isNativePaletteVisibleRef = useRef(false);
  const isPencilInputActiveRef = useRef(false);
  const toolOverlayRef = useRef<ExcalidrawPencilToolOverlayState | null>(null);
  const fingerPanRef = useRef<{
    source: 'pointer' | 'touch';
    identifier: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const wasSqueezingRef = useRef(false);
  const lastToolOverlayOpenedAtRef = useRef(0);
  const squeezeGestureRef = useRef<{
    hoverPose?: ApplePencilHoverPose;
    startedAt: number;
  } | null>(null);
  const previousToolRef = useRef<ExcalidrawActiveToolSnapshot | null>(null);
  const lastPencilSingleTapTimestampRef = useRef<number | null>(null);
  const lastNativePencilTapTimestampRef = useRef<number | null>(null);
  const pencilInputActiveTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    isPencilHandModeActiveRef.current = isPencilHandModeActive;
  }, [isPencilHandModeActive]);

  useEffect(() => {
    isNativePaletteVisibleRef.current = isNativePaletteVisible;
  }, [isNativePaletteVisible]);

  useEffect(() => {
    isPencilInputActiveRef.current = isPencilInputActive;
  }, [isPencilInputActive]);

  useEffect(() => {
    toolOverlayRef.current = toolOverlay;
  }, [toolOverlay]);

  const closeToolOverlay = useCallback(() => {
    setToolOverlay(null);
  }, []);

  const markPencilInputActive = useCallback(() => {
    if (pencilInputActiveTimeoutRef.current !== null) {
      window.clearTimeout(pencilInputActiveTimeoutRef.current);
    }

    isPencilInputActiveRef.current = true;
    setIsPencilInputActive(true);
    pencilInputActiveTimeoutRef.current = window.setTimeout(() => {
      pencilInputActiveTimeoutRef.current = null;
      isPencilInputActiveRef.current = false;
      setIsPencilInputActive(false);
    }, pencilInputActiveInactivityMs);
  }, []);

  const selectTool = useCallback((tool: ExcalidrawPencilTool) => {
    const api = excalidrawApiRef.current;
    if (!api) return;

    api.setActiveTool({ type: tool });
    setToolOverlay(null);
  }, [excalidrawApiRef]);

  const openToolOverlay = useCallback((hoverPose?: ApplePencilHoverPose) => {
    const api = excalidrawApiRef.current;
    const surface = surfaceRef.current;
    if (!api || !surface) return false;

    const surfaceBounds = surface.getBoundingClientRect();
    const canvasBounds = getInteractiveCanvasBounds(surface);
    if (surfaceBounds.width <= 0 || surfaceBounds.height <= 0 || !canvasBounds) return false;
    const anchorPoint = resolveTapAnchorPoint(hoverPose, surfaceBounds, canvasBounds);
    if (!anchorPoint) return false;

    const minimumLeft = canvasBounds.left + pencilToolOverlayInset;
    const minimumTop = canvasBounds.top + pencilToolOverlayInset;
    const maximumLeft = Math.max(minimumLeft, canvasBounds.right - pencilToolOverlaySize - pencilToolOverlayInset);
    const maximumTop = Math.max(minimumTop, canvasBounds.bottom - pencilToolOverlaySize - pencilToolOverlayInset);
    const activeTool = api.getAppState().activeTool?.type;

    lastToolOverlayOpenedAtRef.current = Date.now();
    setToolOverlay({
      ...(isPencilTool(activeTool) ? { activeTool } : {}),
      left: clamp(anchorPoint.x - pencilToolOverlaySize / 2, minimumLeft, maximumLeft),
      top: clamp(anchorPoint.y - pencilToolOverlaySize / 2, minimumTop, maximumTop),
    });
    return true;
  }, [excalidrawApiRef, surfaceRef]);

  useEffect(() => {
    if (!enabled) {
      if (pencilInputActiveTimeoutRef.current !== null) {
        window.clearTimeout(pencilInputActiveTimeoutRef.current);
        pencilInputActiveTimeoutRef.current = null;
      }
      wasSqueezingRef.current = false;
      squeezeGestureRef.current = null;
      previousToolRef.current = null;
      lastPencilSingleTapTimestampRef.current = null;
      lastNativePencilTapTimestampRef.current = null;
      isPencilHandModeActiveRef.current = false;
      isNativePaletteVisibleRef.current = false;
      isPencilInputActiveRef.current = false;
      fingerPanRef.current = null;
      setToolOverlay(null);
      setIsPencilHandModeActive(false);
      setIsNativePaletteVisible(false);
      setIsPencilInputActive(false);
      return undefined;
    }

    const activateSqueezeHandMode = () => {
      if (wasSqueezingRef.current) return;

      const api = excalidrawApiRef.current;
      if (!api) return;

      setToolOverlay(null);
      previousToolRef.current = toRestorableTool(api.getAppState().activeTool);
      wasSqueezingRef.current = true;
      isPencilHandModeActiveRef.current = true;
      setIsPencilHandModeActive(true);
      api.setActiveTool({ type: 'hand' });
    };

    const maybeActivateSqueezeHandMode = (timestamp: number) => {
      const squeezeGesture = squeezeGestureRef.current;
      if (!squeezeGesture) return;
      if (timestamp - squeezeGesture.startedAt < pencilSqueezeHoldActivationDelaySeconds) return;
      activateSqueezeHandMode();
    };

    const handlePencilSingleTap = (timestamp: number, hoverPose?: ApplePencilHoverPose) => {
      markPencilInputActive();

      const lastNativePencilTapTimestamp = lastNativePencilTapTimestampRef.current;
      if (
        lastNativePencilTapTimestamp !== null &&
        Math.abs(timestamp - lastNativePencilTapTimestamp) <= pencilNativeTapSuppressionSeconds
      ) {
        return;
      }

      const previousTapTimestamp = lastPencilSingleTapTimestampRef.current;
      if (
        previousTapTimestamp !== null &&
        timestamp - previousTapTimestamp <= pencilDoubleTapMaximumIntervalSeconds
      ) {
        lastPencilSingleTapTimestampRef.current = null;
        selectTool('freedraw');
        return;
      }

      lastPencilSingleTapTimestampRef.current = timestamp;
      if (toolOverlayRef.current) {
        setToolOverlay(null);
        return;
      }

      openToolOverlay(hoverPose);
    };

    const restorePreviousTool = () => {
      if (!wasSqueezingRef.current) return;
      const api = excalidrawApiRef.current;
      const previousTool = previousToolRef.current ?? selectionTool;
      wasSqueezingRef.current = false;
      previousToolRef.current = null;
      isPencilHandModeActiveRef.current = false;
      setIsPencilHandModeActive(false);
      api?.setActiveTool(previousTool);
    };

    const unsubscribeSqueeze = subscribeApplePencilSqueeze(event => {
      markPencilInputActive();

      if (event.preferredAction === 'ignore') {
        if (event.phase === 'ended' || event.phase === 'cancelled') restorePreviousTool();
        return;
      }

      if (event.isDoubleSqueeze) {
        restorePreviousTool();
        return;
      }

      if (event.phase === 'began') {
        squeezeGestureRef.current = {
          ...(event.hoverPose ? { hoverPose: event.hoverPose } : {}),
          startedAt: event.timestamp,
        };
        return;
      }

      if (event.phase === 'changed') {
        const existingGesture = squeezeGestureRef.current;
        squeezeGestureRef.current = {
          ...(existingGesture ?? { startedAt: event.timestamp }),
          ...(event.hoverPose ? { hoverPose: event.hoverPose } : {}),
        };
        // iPadOS can deliver quick tap-like Pencil interactions as squeeze begin/end pairs.
        // Only a sustained squeeze that continues into changed phases should become hand mode.
        if (existingGesture) {
          maybeActivateSqueezeHandMode(event.timestamp);
        }
        return;
      }

      if (event.phase === 'ended' || event.phase === 'cancelled') {
        const squeezeGesture = squeezeGestureRef.current;
        squeezeGestureRef.current = null;
        if (
          !wasSqueezingRef.current &&
          squeezeGesture &&
          (event.timestamp - squeezeGesture.startedAt) * 1000 <= pencilTapLikeSqueezeMaximumDurationMs
        ) {
          handlePencilSingleTap(event.timestamp, event.hoverPose ?? squeezeGesture.hoverPose);
          return;
        }
        restorePreviousTool();
      }
    });

    const unsubscribePalette = subscribeApplePencilPalette(event => {
      isNativePaletteVisibleRef.current = event.visible;
      setIsNativePaletteVisible(event.visible);
      if (event.visible) setToolOverlay(null);
    });

    const unsubscribeTap = subscribeApplePencilTap(event => {
      markPencilInputActive();
      squeezeGestureRef.current = null;
      lastPencilSingleTapTimestampRef.current = null;
      lastNativePencilTapTimestampRef.current = event.timestamp;
      selectTool('freedraw');
    });

    return () => {
      unsubscribeSqueeze();
      unsubscribePalette();
      unsubscribeTap();
      if (pencilInputActiveTimeoutRef.current !== null) {
        window.clearTimeout(pencilInputActiveTimeoutRef.current);
        pencilInputActiveTimeoutRef.current = null;
      }
      setToolOverlay(null);
      squeezeGestureRef.current = null;
      lastPencilSingleTapTimestampRef.current = null;
      lastNativePencilTapTimestampRef.current = null;
      isPencilInputActiveRef.current = false;
      setIsPencilInputActive(false);
      restorePreviousTool();
    };
  }, [enabled, excalidrawApiRef, markPencilInputActive, openToolOverlay, selectTool, surfaceRef]);

  useEffect(() => {
    if (!enabled || !toolOverlay) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      if (Date.now() - lastToolOverlayOpenedAtRef.current < pencilToolOverlayOpenPointerGraceMs) return;
      if (event.target instanceof Element && event.target.closest('[data-weave-excalidraw-pencil-tool-overlay]')) {
        return;
      }
      setToolOverlay(null);
    };

    window.addEventListener('pointerdown', handlePointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', handlePointerDown, true);
  }, [enabled, toolOverlay]);

  useEffect(() => {
    if (!enabled) return undefined;
    const surface = surfaceRef.current;
    if (!surface) return undefined;

    const isInteractiveSurfaceTarget = (target: EventTarget | null, clientX: number, clientY: number) => {
      if (!(target instanceof Element)) return false;
      if (target.closest('button, input, textarea, select, [role="button"], [contenteditable="true"]')) return false;
      if (target.closest('[data-weave-overlay-titlebar], .App-top-bar, .App-bottom-bar, .mobile-misc-tools-container, .footer-center, .Island')) {
        return false;
      }

      const bounds = getInteractiveCanvasBounds(surface);
      if (!bounds) return false;
      return clientX >= bounds.left && clientX <= bounds.right && clientY >= bounds.top && clientY <= bounds.bottom;
    };

    const shouldTreatFingerAsHandTool = () => {
      if (isPencilHandModeActiveRef.current) return true;
      return excalidrawApiRef.current?.getAppState().penMode === true;
    };

    const stopInputEvent = (event: Event) => {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const panBy = (clientX: number, clientY: number, activePan: NonNullable<typeof fingerPanRef.current>) => {
      const api = excalidrawApiRef.current;
      if (!api) return;

      const appState = api.getAppState();
      const zoomValue = typeof appState.zoom?.value === 'number' && Number.isFinite(appState.zoom.value)
        ? appState.zoom.value
        : 1;
      const deltaX = clientX - activePan.lastX;
      const deltaY = clientY - activePan.lastY;

      activePan.lastX = clientX;
      activePan.lastY = clientY;

      api.updateScene({
        appState: {
          scrollX: (appState.scrollX ?? 0) + deltaX / zoomValue,
          scrollY: (appState.scrollY ?? 0) + deltaY / zoomValue,
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (event.pointerType === 'pen') {
        markPencilInputActive();
      }

      if (
        event.pointerType !== 'touch' ||
        !event.isPrimary ||
        !shouldTreatFingerAsHandTool() ||
        !isInteractiveSurfaceTarget(event.target, event.clientX, event.clientY)
      ) {
        return;
      }

      fingerPanRef.current = {
        source: 'pointer',
        identifier: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      try {
        surface.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already have been released by the time WebKit runs this.
      }
      stopInputEvent(event);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'pen') {
        markPencilInputActive();
      }

      const activePan = fingerPanRef.current;
      if (
        !activePan ||
        activePan.source !== 'pointer' ||
        activePan.identifier !== event.pointerId ||
        event.pointerType !== 'touch'
      ) {
        return;
      }

      if (!shouldTreatFingerAsHandTool()) {
        fingerPanRef.current = null;
        return;
      }

      panBy(event.clientX, event.clientY, activePan);
      stopInputEvent(event);
    };

    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerType === 'pen') {
        markPencilInputActive();
      }

      const activePan = fingerPanRef.current;
      if (!activePan || activePan.source !== 'pointer' || activePan.identifier !== event.pointerId) return;

      fingerPanRef.current = null;
      try {
        surface.releasePointerCapture(event.pointerId);
      } catch {
        // The pointer capture may have already been released by the browser.
      }
      stopInputEvent(event);
    };

    const isDirectFingerTouch = (touch: Touch) => {
      const touchType = (touch as Touch & { touchType?: string }).touchType;
      return touchType === undefined || touchType === 'direct';
    };

    const getTrackedTouch = (event: TouchEvent) => {
      const activePan = fingerPanRef.current;
      if (!activePan || activePan.source !== 'touch') return undefined;

      for (const touch of Array.from(event.changedTouches)) {
        if (touch.identifier === activePan.identifier) return touch;
      }
      return undefined;
    };

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.changedTouches[0];
      if (
        event.touches.length !== 1 ||
        !touch ||
        !isDirectFingerTouch(touch) ||
        !shouldTreatFingerAsHandTool() ||
        !isInteractiveSurfaceTarget(event.target, touch.clientX, touch.clientY)
      ) {
        fingerPanRef.current = null;
        return;
      }

      fingerPanRef.current = {
        source: 'touch',
        identifier: touch.identifier,
        lastX: touch.clientX,
        lastY: touch.clientY,
      };
      stopInputEvent(event);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const activePan = fingerPanRef.current;
      const touch = getTrackedTouch(event);
      if (!activePan || !touch) return;

      if (event.touches.length !== 1 || !isDirectFingerTouch(touch) || !shouldTreatFingerAsHandTool()) {
        fingerPanRef.current = null;
        return;
      }

      panBy(touch.clientX, touch.clientY, activePan);
      stopInputEvent(event);
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (!getTrackedTouch(event)) return;
      fingerPanRef.current = null;
      stopInputEvent(event);
    };

    if ('PointerEvent' in window) {
      surface.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: false });
      surface.addEventListener('pointermove', handlePointerMove, { capture: true, passive: false });
      surface.addEventListener('pointerup', handlePointerEnd, { capture: true, passive: false });
      surface.addEventListener('pointercancel', handlePointerEnd, { capture: true, passive: false });
    } else {
      surface.addEventListener('touchstart', handleTouchStart, { capture: true, passive: false });
      surface.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false });
      surface.addEventListener('touchend', handleTouchEnd, { capture: true, passive: false });
      surface.addEventListener('touchcancel', handleTouchEnd, { capture: true, passive: false });
    }

    return () => {
      fingerPanRef.current = null;
      if ('PointerEvent' in window) {
        surface.removeEventListener('pointerdown', handlePointerDown, true);
        surface.removeEventListener('pointermove', handlePointerMove, true);
        surface.removeEventListener('pointerup', handlePointerEnd, true);
        surface.removeEventListener('pointercancel', handlePointerEnd, true);
      } else {
        surface.removeEventListener('touchstart', handleTouchStart, true);
        surface.removeEventListener('touchmove', handleTouchMove, true);
        surface.removeEventListener('touchend', handleTouchEnd, true);
        surface.removeEventListener('touchcancel', handleTouchEnd, true);
      }
    };
  }, [enabled, excalidrawApiRef, markPencilInputActive, surfaceRef]);

  return {
    closeToolOverlay,
    isPencilChromeHidden: isPencilHandModeActive || isNativePaletteVisible || Boolean(toolOverlay),
    isPencilInputActive,
    selectTool,
    toolOverlay,
  };
};
