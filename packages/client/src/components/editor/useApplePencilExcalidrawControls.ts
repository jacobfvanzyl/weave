import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { subscribeApplePencilPalette, subscribeApplePencilSqueeze } from '../../lib/apple-pencil';

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
) => {
  const [isPencilHandModeActive, setIsPencilHandModeActive] = useState(false);
  const [isNativePaletteVisible, setIsNativePaletteVisible] = useState(false);
  const isPencilHandModeActiveRef = useRef(false);
  const isNativePaletteVisibleRef = useRef(false);
  const fingerPanRef = useRef<{
    source: 'pointer' | 'touch';
    identifier: number;
    lastX: number;
    lastY: number;
  } | null>(null);
  const wasSqueezingRef = useRef(false);
  const previousToolRef = useRef<ExcalidrawActiveToolSnapshot | null>(null);

  useEffect(() => {
    isPencilHandModeActiveRef.current = isPencilHandModeActive;
  }, [isPencilHandModeActive]);

  useEffect(() => {
    isNativePaletteVisibleRef.current = isNativePaletteVisible;
  }, [isNativePaletteVisible]);

  useEffect(() => {
    if (!enabled) {
      wasSqueezingRef.current = false;
      previousToolRef.current = null;
      isPencilHandModeActiveRef.current = false;
      isNativePaletteVisibleRef.current = false;
      fingerPanRef.current = null;
      setIsPencilHandModeActive(false);
      setIsNativePaletteVisible(false);
      return undefined;
    }

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
      if (event.preferredAction === 'ignore') return;

      const api = excalidrawApiRef.current;
      if (!api) return;

      if (event.phase === 'began' || event.phase === 'changed') {
        if (!wasSqueezingRef.current) {
          previousToolRef.current = toRestorableTool(api.getAppState().activeTool);
          wasSqueezingRef.current = true;
        }
        isPencilHandModeActiveRef.current = true;
        setIsPencilHandModeActive(true);
        api.setActiveTool({ type: 'hand' });
        return;
      }

      if (event.phase === 'ended' || event.phase === 'cancelled') {
        restorePreviousTool();
      }
    });

    const unsubscribePalette = subscribeApplePencilPalette(event => {
      isNativePaletteVisibleRef.current = event.visible;
      setIsNativePaletteVisible(event.visible);
    });

    return () => {
      unsubscribeSqueeze();
      unsubscribePalette();
      restorePreviousTool();
    };
  }, [enabled, excalidrawApiRef]);

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

      const canvas = surface.querySelector('canvas.interactive');
      const boundsTarget = canvas instanceof HTMLElement ? canvas : surface.querySelector('.excalidraw');
      if (!(boundsTarget instanceof HTMLElement)) return false;

      const bounds = boundsTarget.getBoundingClientRect();
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
  }, [enabled, excalidrawApiRef, surfaceRef]);

  return isPencilHandModeActive || isNativePaletteVisible;
};
