import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent as ReactFormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type Touch as ReactTouch,
  type TouchEvent as ReactTouchEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, MonitorUp, Play, Square, X } from 'lucide-react';
import type { PortalConnection } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { normalizeVideoPoint } from '../../lib/window-stream-control';
import { getWindowStreamErrorMessage, listWindowStreamWindows, startWindowStreamSession } from '../../lib/window-stream-transport';
import type { WindowStreamSession } from '../../lib/window-stream-types';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';

type WindowStreamOverlayProps = {
  portals: PortalConnection[];
  onHide: () => void;
  onSessionActiveChange?: (isActive: boolean) => void;
};

const windowSessionCapability = 'portal.window.session';
const windowListCapability = 'portal.window.list';

const controlModifiers = (
  event: ReactKeyboardEvent | ReactMouseEvent | ReactPointerEvent | ReactTouchEvent | ReactWheelEvent,
) => [
  event.shiftKey ? 'shift' : undefined,
  event.altKey ? 'alt' : undefined,
  event.metaKey ? 'meta' : undefined,
  event.ctrlKey ? 'ctrl' : undefined,
].filter((item): item is string => Boolean(item));

const videoPointFromClient = (
  element: HTMLElement,
  video: HTMLVideoElement | null,
  clientX: number,
  clientY: number,
) => {
  const bounds = element.getBoundingClientRect();
  return normalizeVideoPoint(bounds, video?.videoWidth ?? 0, video?.videoHeight ?? 0, clientX, clientY);
};

const videoPointFromEvent = (
  element: HTMLElement,
  video: HTMLVideoElement | null,
  event: ReactMouseEvent | ReactPointerEvent | ReactWheelEvent,
) => {
  return videoPointFromClient(element, video, event.clientX, event.clientY);
};

const formatWindowLabel = (window: { appName?: string; title?: string; id: string }) =>
  [window.appName, window.title || window.id].filter(Boolean).join(' - ');

export const WindowStreamOverlay = ({ portals, onHide, onSessionActiveChange }: WindowStreamOverlayProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const textCaptureRef = useRef<HTMLTextAreaElement | null>(null);
  const activeTouchIdRef = useRef<number | null>(null);
  const lastPointerOrTouchAtRef = useRef(0);
  const sessionRef = useRef<WindowStreamSession | null>(null);
  const startRequestRef = useRef(0);
  const capablePortals = useMemo(() => portals.filter(portal =>
    portal.status === 'online' && portal.capabilities.includes(windowSessionCapability)
  ), [portals]);
  const [selectedPortalId, setSelectedPortalId] = useState(() => capablePortals[0]?.portalId ?? '');
  const selectedPortal = capablePortals.find(portal => portal.portalId === selectedPortalId) ?? capablePortals[0];
  const [selectedWindowId, setSelectedWindowId] = useState('');
  const [session, setSession] = useState<WindowStreamSession | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
  const [streamWindowId, setStreamWindowId] = useState('');
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canListWindows = Boolean(selectedPortal?.capabilities.includes(windowListCapability));
  const { data: windows = [], isFetching: isFetchingWindows, error: windowsError } = useQuery({
    queryKey: ['window-stream-windows', selectedPortal?.portalId],
    queryFn: () => listWindowStreamWindows(selectedPortal!.portalId),
    enabled: Boolean(selectedPortal?.portalId && canListWindows),
  });

  useEffect(() => {
    if (capablePortals.length === 0) {
      setSelectedPortalId('');
      return;
    }
    if (!capablePortals.some(portal => portal.portalId === selectedPortalId)) {
      setSelectedPortalId(capablePortals[0].portalId);
    }
  }, [capablePortals, selectedPortalId]);

  useEffect(() => {
    setSelectedWindowId(windowId => {
      if (windowId && (windows.some(window => window.id === windowId) || sessionRef.current)) return windowId;
      return windows[0]?.id ?? '';
    });
  }, [windows]);

  useEffect(() => {
    sessionRef.current = session;
    onSessionActiveChange?.(Boolean(session));
  }, [onSessionActiveChange, session]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = session?.mediaStream ?? null;
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    return session.onStateChange(nextState => {
      setConnectionState(nextState);
      if (nextState !== 'closed' && nextState !== 'failed' && nextState !== 'disconnected') return;
      if (sessionRef.current !== session) return;
      session.close();
      sessionRef.current = null;
      setSession(null);
      setStreamWindowId('');
    });
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    return session.onError(nextError => {
      setError(getWindowStreamErrorMessage(nextError));
      if (sessionRef.current !== session) return;
      session.close();
      sessionRef.current = null;
      setSession(null);
      setStreamWindowId('');
      setConnectionState('closed');
    });
  }, [session]);

  useEffect(() => () => {
    startRequestRef.current += 1;
    sessionRef.current?.close();
    sessionRef.current = null;
  }, []);

  const startStream = async (windowId: string) => {
    const portal = selectedPortal;
    if (!portal) return;
    const requestId = startRequestRef.current + 1;
    startRequestRef.current = requestId;
    setIsStarting(true);
    setError(null);
    sessionRef.current?.close();
    sessionRef.current = null;
    setSession(null);
    setConnectionState('new');
    setStreamWindowId(windowId);
    try {
      const nextSession = await startWindowStreamSession({
        portalId: portal.portalId,
        windowId: windowId || undefined,
      });
      if (startRequestRef.current !== requestId) {
        nextSession.close();
        return;
      }
      sessionRef.current = nextSession;
      setSession(nextSession);
      setStreamWindowId(windowId);
      window.requestAnimationFrame(() => surfaceRef.current?.focus());
    } catch (startError) {
      if (startRequestRef.current === requestId) {
        setError(getWindowStreamErrorMessage(startError));
        setStreamWindowId('');
        setConnectionState('closed');
      }
    } finally {
      if (startRequestRef.current === requestId) setIsStarting(false);
    }
  };

  const start = () => {
    void startStream(selectedWindowId);
  };

  const stop = () => {
    startRequestRef.current += 1;
    sessionRef.current?.close();
    sessionRef.current = null;
    setSession(null);
    setStreamWindowId('');
    setConnectionState('closed');
    setIsStarting(false);
  };

  const handleWindowChange = (value: string | null) => {
    const nextWindowId = value ?? '';
    setSelectedWindowId(nextWindowId);
    if (!sessionRef.current && !isStarting) return;
    if (nextWindowId === streamWindowId) return;
    void startStream(nextWindowId);
  };

  const sendResize = () => {
    const surface = surfaceRef.current;
    if (!surface || !session) return;
    const bounds = surface.getBoundingClientRect();
    session.sendControl({
      type: 'resize',
      viewportWidth: Math.round(bounds.width),
      viewportHeight: Math.round(bounds.height),
      deviceScaleFactor: window.devicePixelRatio,
    });
  };

  useEffect(() => {
    if (!session) return undefined;
    sendResize();
    window.addEventListener('resize', sendResize);
    return () => window.removeEventListener('resize', sendResize);
  }, [session]);

  const focusInputSurface = (pointerType?: string) => {
    if (pointerType === 'touch') {
      textCaptureRef.current?.focus({ preventScroll: true });
      return;
    }
    surfaceRef.current?.focus({ preventScroll: true });
  };

  const handlePointer = (event: ReactPointerEvent<HTMLDivElement>, action: 'move' | 'down' | 'up') => {
    if (!session) return;
    if (event.pointerType === 'touch') return;
    event.preventDefault();
    lastPointerOrTouchAtRef.current = performance.now();
    const point = videoPointFromEvent(event.currentTarget, videoRef.current, event);
    if (!point) return;
    if (action === 'down') {
      event.currentTarget.setPointerCapture(event.pointerId);
      focusInputSurface(event.pointerType);
      session.sendControl({ type: 'focus' });
    } else if (action === 'up' && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    session.sendControl({
      type: 'pointer',
      action,
      x: point.x,
      y: point.y,
      button: event.button,
      buttons: event.buttons,
      clickCount: event.detail,
      pointerType: event.pointerType,
      pointerId: event.pointerId,
      pressure: event.pressure,
      modifiers: controlModifiers(event),
    });
  };

  const sendTouchPointer = (
    event: ReactTouchEvent<HTMLDivElement>,
    touch: ReactTouch,
    action: 'move' | 'down' | 'up',
  ) => {
    if (!session) return;
    const point = videoPointFromClient(event.currentTarget, videoRef.current, touch.clientX, touch.clientY);
    if (!point) return;
    if (action === 'down') {
      focusInputSurface('touch');
      session.sendControl({ type: 'focus' });
    }
    session.sendControl({
      type: 'pointer',
      action,
      x: point.x,
      y: point.y,
      button: 0,
      buttons: action === 'up' ? 0 : 1,
      clickCount: action === 'down' ? 1 : undefined,
      pointerType: 'touch',
      pointerId: touch.identifier,
      pressure: typeof (touch as ReactTouch & { force?: number }).force === 'number'
        ? (touch as ReactTouch & { force?: number }).force
        : action === 'up'
        ? 0
        : 0.5,
      modifiers: controlModifiers(event),
    });
  };

  const findChangedTouch = (event: ReactTouchEvent<HTMLDivElement>) => {
    const activeTouchId = activeTouchIdRef.current;
    if (activeTouchId === null) return event.changedTouches[0] ?? event.touches[0];
    return Array.from(event.changedTouches).find(touch => touch.identifier === activeTouchId) ??
      Array.from(event.touches).find(touch => touch.identifier === activeTouchId);
  };

  const handleTouch = (event: ReactTouchEvent<HTMLDivElement>, action: 'move' | 'down' | 'up') => {
    if (!session) return;
    event.preventDefault();
    event.stopPropagation();
    lastPointerOrTouchAtRef.current = performance.now();

    const touch = action === 'down' && activeTouchIdRef.current === null
      ? event.changedTouches[0]
      : findChangedTouch(event);
    if (!touch) return;
    if (action === 'down') activeTouchIdRef.current = touch.identifier;
    sendTouchPointer(event, touch, action);
    if (action === 'up' && touch.identifier === activeTouchIdRef.current) {
      activeTouchIdRef.current = null;
    }
  };

  const handleClickFallback = (event: ReactMouseEvent<HTMLDivElement>) => {
    const lastPointerOrTouchAt = lastPointerOrTouchAtRef.current;
    if (!session || (lastPointerOrTouchAt > 0 && performance.now() - lastPointerOrTouchAt < 750)) return;
    event.preventDefault();
    const point = videoPointFromEvent(event.currentTarget, videoRef.current, event);
    if (!point) return;
    focusInputSurface('touch');
    session.sendControl({ type: 'focus' });
    for (const action of ['down', 'up'] as const) {
      session.sendControl({
        type: 'pointer',
        action,
        x: point.x,
        y: point.y,
        button: 0,
        buttons: action === 'down' ? 1 : 0,
        clickCount: 1,
        pointerType: 'touch',
        modifiers: controlModifiers(event),
      });
    }
  };

  const handleKey = (event: ReactKeyboardEvent<HTMLElement>, action: 'down' | 'up') => {
    if (!session) return;
    event.preventDefault();
    event.stopPropagation();
    session.sendControl({
      type: 'key',
      action,
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      modifiers: controlModifiers(event),
    });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!session) return;
    event.preventDefault();
    const point = videoPointFromEvent(event.currentTarget, videoRef.current, event);
    if (!point) return;
    session.sendControl({
      type: 'scroll',
      dx: event.deltaX,
      dy: event.deltaY,
      x: point.x,
      y: point.y,
      deltaMode: event.deltaMode,
      modifiers: controlModifiers(event),
    });
  };

  const handleTextInput = (event: ReactFormEvent<HTMLTextAreaElement>) => {
    if (!session) return;
    const target = event.currentTarget;
    const text = target.value;
    target.value = '';
    if (!text) return;
    session.sendControl({
      type: 'key',
      action: 'text',
      key: text,
      text,
    });
  };

  const displayError = error ?? (windowsError ? getWindowStreamErrorMessage(windowsError) : null);
  const selectedPortalLabel = selectedPortal ? selectedPortal.name || selectedPortal.portalId : undefined;
  const selectedWindow = windows.find(window => window.id === selectedWindowId);
  const selectedWindowLabel = selectedWindow ? formatWindowLabel(selectedWindow) : undefined;

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground" data-weave-window-stream-overlay>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3" data-weave-overlay-titlebar>
        <div className="flex min-w-0 items-center gap-2">
          <MonitorUp size={18} className="shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Window Stream</h2>
            <p className="truncate text-xs text-muted-foreground">
              {session ? `WebRTC ${connectionState}` : 'Direct WebRTC over local candidates'}
            </p>
          </div>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <Select value={selectedPortal?.portalId ?? ''} onValueChange={value => setSelectedPortalId(value ?? '')} disabled={Boolean(session)}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue placeholder="Portal">{selectedPortalLabel}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {capablePortals.map(portal => (
                <SelectItem key={portal.portalId} value={portal.portalId}>{portal.name || portal.portalId}</SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select value={selectedWindowId} onValueChange={handleWindowChange} disabled={windows.length === 0 || (!session && isFetchingWindows)}>
            <SelectTrigger className="h-8 w-56">
              <SelectValue placeholder={isFetchingWindows ? 'Loading windows' : 'Window'}>
                {selectedWindowLabel}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {windows.map(window => (
                <SelectItem key={window.id} value={window.id}>
                  {formatWindowLabel(window)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          {session ? (
            <Button size="sm" variant="secondary" onClick={stop}>
              <Square size={15} />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={!selectedPortal || isStarting || (canListWindows && !selectedWindowId)}>
              {isStarting ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />}
              Start
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" aria-label="Hide window stream" onClick={onHide}>
            <X size={16} />
          </Button>
        </div>
      </header>
      <div className="relative min-h-0 flex-1 bg-black">
        {displayError ? (
          <Alert className="absolute left-3 top-3 z-10 max-w-xl border-destructive/50 bg-background text-foreground">
            <AlertDescription>{displayError}</AlertDescription>
          </Alert>
        ) : null}
        {capablePortals.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No online Portal advertises window streaming.
          </div>
        ) : isFetchingWindows && !session ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading windows
          </div>
        ) : (
          <div
            ref={surfaceRef}
            className={cn(
              'relative h-full w-full outline-none',
              session ? 'touch-none cursor-crosshair select-none' : 'flex items-center justify-center text-sm text-muted-foreground',
            )}
            tabIndex={0}
            onKeyDown={event => handleKey(event, 'down')}
            onKeyUp={event => handleKey(event, 'up')}
            onPointerDown={event => handlePointer(event, 'down')}
            onPointerMove={event => {
              if (event.buttons) handlePointer(event, 'move');
            }}
            onPointerUp={event => handlePointer(event, 'up')}
            onPointerCancel={event => {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              if (event.pointerType === 'touch') activeTouchIdRef.current = null;
            }}
            onTouchStart={event => handleTouch(event, 'down')}
            onTouchMove={event => handleTouch(event, 'move')}
            onTouchEnd={event => handleTouch(event, 'up')}
            onTouchCancel={event => handleTouch(event, 'up')}
            onClick={handleClickFallback}
            onWheel={handleWheel}
            onContextMenu={event => event.preventDefault()}
          >
            {session ? (
              <>
                <video
                  ref={videoRef}
                  className="h-full w-full object-contain"
                  autoPlay
                  muted
                  playsInline
                />
                <textarea
                  ref={textCaptureRef}
                  className="pointer-events-none absolute left-0 top-0 h-8 w-8 resize-none opacity-0"
                  aria-hidden="true"
                  autoCapitalize="off"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  tabIndex={-1}
                  onInput={handleTextInput}
                  onKeyDown={event => handleKey(event, 'down')}
                  onKeyUp={event => handleKey(event, 'up')}
                />
              </>
            ) : (
              <span>Select a window and start streaming.</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
