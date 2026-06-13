import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, MonitorUp, Play, Square, X } from 'lucide-react';
import type { PortalConnection } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { getWindowStreamErrorMessage, listWindowStreamWindows, startWindowStreamSession } from '../../lib/window-stream-transport';
import type { WindowStreamSession } from '../../lib/window-stream-types';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';

type WindowStreamOverlayProps = {
  portals: PortalConnection[];
  onHide: () => void;
};

const windowSessionCapability = 'portal.window.session';
const windowListCapability = 'portal.window.list';

const controlModifiers = (event: ReactKeyboardEvent | ReactPointerEvent) => [
  event.shiftKey ? 'shift' : undefined,
  event.altKey ? 'alt' : undefined,
  event.metaKey ? 'meta' : undefined,
  event.ctrlKey ? 'ctrl' : undefined,
].filter((item): item is string => Boolean(item));

const normalizePoint = (element: HTMLElement, event: ReactPointerEvent | ReactWheelEvent) => {
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / Math.max(1, bounds.width))),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / Math.max(1, bounds.height))),
  };
};

export const WindowStreamOverlay = ({ portals, onHide }: WindowStreamOverlayProps) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const capablePortals = useMemo(() => portals.filter(portal =>
    portal.status === 'online' && portal.capabilities.includes(windowSessionCapability)
  ), [portals]);
  const [selectedPortalId, setSelectedPortalId] = useState(() => capablePortals[0]?.portalId ?? '');
  const selectedPortal = capablePortals.find(portal => portal.portalId === selectedPortalId) ?? capablePortals[0];
  const [selectedWindowId, setSelectedWindowId] = useState('');
  const [session, setSession] = useState<WindowStreamSession | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
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
    setSelectedWindowId(windowId => windows.some(window => window.id === windowId) ? windowId : windows[0]?.id ?? '');
  }, [windows]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = session?.mediaStream ?? null;
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    return session.onStateChange(setConnectionState);
  }, [session]);

  useEffect(() => {
    if (!session) return undefined;
    return session.onError(nextError => setError(getWindowStreamErrorMessage(nextError)));
  }, [session]);

  useEffect(() => () => {
    session?.close();
  }, [session]);

  const start = async () => {
    if (!selectedPortal) return;
    setIsStarting(true);
    setError(null);
    session?.close();
    setSession(null);
    try {
      const nextSession = await startWindowStreamSession({
        portalId: selectedPortal.portalId,
        windowId: selectedWindowId || undefined,
      });
      setSession(nextSession);
      window.requestAnimationFrame(() => surfaceRef.current?.focus());
    } catch (startError) {
      setError(getWindowStreamErrorMessage(startError));
    } finally {
      setIsStarting(false);
    }
  };

  const stop = () => {
    session?.close();
    setSession(null);
    setConnectionState('closed');
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

  const handlePointer = (event: ReactPointerEvent<HTMLDivElement>, action: 'move' | 'down' | 'up') => {
    if (!session) return;
    const point = normalizePoint(event.currentTarget, event);
    if (action === 'down') {
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      session.sendControl({ type: 'focus' });
    }
    session.sendControl({
      type: 'pointer',
      action,
      x: point.x,
      y: point.y,
      modifiers: controlModifiers(event),
    });
  };

  const handleKey = (event: ReactKeyboardEvent<HTMLDivElement>, action: 'down' | 'up') => {
    if (!session) return;
    event.preventDefault();
    session.sendControl({
      type: 'key',
      action,
      key: event.key,
      code: event.code,
      modifiers: controlModifiers(event),
    });
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!session) return;
    event.preventDefault();
    const point = normalizePoint(event.currentTarget, event);
    session.sendControl({
      type: 'scroll',
      dx: event.deltaX,
      dy: event.deltaY,
      x: point.x,
      y: point.y,
    });
  };

  const displayError = error ?? (windowsError ? getWindowStreamErrorMessage(windowsError) : null);

  return (
    <section className="flex h-full min-h-0 flex-col bg-background text-foreground" data-weave-window-stream-overlay>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
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
              <SelectValue placeholder="Portal" />
            </SelectTrigger>
            <SelectPopup>
              {capablePortals.map(portal => (
                <SelectItem key={portal.portalId} value={portal.portalId}>{portal.name || portal.portalId}</SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select value={selectedWindowId} onValueChange={value => setSelectedWindowId(value ?? '')} disabled={Boolean(session) || isFetchingWindows || windows.length === 0}>
            <SelectTrigger className="h-8 w-56">
              <SelectValue placeholder={isFetchingWindows ? 'Loading windows' : 'Window'} />
            </SelectTrigger>
            <SelectPopup>
              {windows.map(window => (
                <SelectItem key={window.id} value={window.id}>
                  {[window.appName, window.title || window.id].filter(Boolean).join(' - ')}
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
              session ? 'cursor-crosshair' : 'flex items-center justify-center text-sm text-muted-foreground',
            )}
            tabIndex={0}
            onKeyDown={event => handleKey(event, 'down')}
            onKeyUp={event => handleKey(event, 'up')}
            onPointerDown={event => handlePointer(event, 'down')}
            onPointerMove={event => {
              if (event.buttons) handlePointer(event, 'move');
            }}
            onPointerUp={event => handlePointer(event, 'up')}
            onWheel={handleWheel}
          >
            {session ? (
              <video
                ref={videoRef}
                className="h-full w-full object-contain"
                autoPlay
                muted
                playsInline
              />
            ) : (
              <span>Select a window and start streaming.</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
