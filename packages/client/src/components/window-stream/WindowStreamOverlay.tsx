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
import { AppWindow, List, Loader2, MonitorUp, Play, Search, Square, X } from 'lucide-react';
import type { PortalConnection } from '../../lib/chat-state-api';
import { cn } from '../../lib/cn';
import { fuzzyScore } from '../../lib/fuzzy';
import { normalizeVideoPoint } from '../../lib/window-stream-control';
import {
  getWindowStreamErrorMessage,
  listWindowStreamApplications,
  listWindowStreamWindows,
  openWindowStreamApplication,
  startWindowStreamSession,
} from '../../lib/window-stream-transport';
import type { WindowStreamApplicationInfo, WindowStreamInfo, WindowStreamSession } from '../../lib/window-stream-types';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { CommandPanel } from '../ui/command';
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from '../ui/select';
import { Spinner } from '../ui/spinner';

type WindowStreamOverlayProps = {
  portals: PortalConnection[];
  onHide: () => void;
  onSessionActiveChange?: (isActive: boolean) => void;
};

const windowSessionCapability = 'portal.window.session';
const windowListCapability = 'portal.window.list';
const applicationListCapability = 'portal.applications.list';
const applicationOpenCapability = 'portal.applications.open';
const launcherMatchTimeoutMs = 5_000;

type LauncherView = 'running' | 'applications';

type LauncherItem = WindowStreamApplicationInfo & {
  windows: WindowStreamInfo[];
};

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

const getWindowApplicationKey = (window: WindowStreamInfo) =>
  window.bundleIdentifier ? `bundle:${window.bundleIdentifier}` : window.appName ? `name:${window.appName.toLowerCase()}` : undefined;

const getApplicationKey = (application: WindowStreamApplicationInfo) =>
  application.bundleIdentifier ? `bundle:${application.bundleIdentifier}` : `app:${application.id}`;

const mergeUniquePids = (...pidLists: (number[] | undefined)[]) => {
  const pids = new Set<number>();
  for (const list of pidLists) {
    for (const pid of list ?? []) {
      if (Number.isFinite(pid)) pids.add(pid);
    }
  }
  return [...pids];
};

const createLauncherItems = (
  applications: WindowStreamApplicationInfo[],
  windows: WindowStreamInfo[],
): LauncherItem[] => {
  const itemsByKey = new Map<string, LauncherItem>();
  const nameKeys = new Map<string, string>();

  for (const application of applications) {
    const key = getApplicationKey(application);
    const item: LauncherItem = {
      ...application,
      pids: mergeUniquePids(application.pids),
      windows: [],
    };
    itemsByKey.set(key, item);
    nameKeys.set(application.name.toLowerCase(), key);
  }

  for (const window of windows) {
    const windowKey = getWindowApplicationKey(window);
    const fallbackNameKey = window.appName ? nameKeys.get(window.appName.toLowerCase()) : undefined;
    const key = windowKey && itemsByKey.has(windowKey)
      ? windowKey
      : fallbackNameKey ?? windowKey ?? `window:${window.id}`;
    const existing = itemsByKey.get(key);
    if (existing) {
      existing.windows.push(window);
      existing.isRunning = true;
      existing.pids = mergeUniquePids(existing.pids, typeof window.pid === 'number' ? [window.pid] : undefined);
      if (!existing.bundleIdentifier && window.bundleIdentifier) existing.bundleIdentifier = window.bundleIdentifier;
      continue;
    }
    itemsByKey.set(key, {
      id: key,
      name: window.appName || window.title || window.id,
      bundleIdentifier: window.bundleIdentifier,
      isRunning: true,
      pids: typeof window.pid === 'number' ? [window.pid] : undefined,
      windows: [window],
    });
  }

  return [...itemsByKey.values()];
};

const rankLauncherItem = (item: LauncherItem, query: string, recentIds: string[]) => {
  const trimmedQuery = query.trim();
  const queryScore = trimmedQuery
    ? Math.max(
      fuzzyScore(trimmedQuery, item.name),
      fuzzyScore(trimmedQuery, item.path ?? ''),
      fuzzyScore(trimmedQuery, item.bundleIdentifier ?? ''),
      ...item.windows.map(window => fuzzyScore(trimmedQuery, formatWindowLabel(window))),
    )
    : 1;
  if (trimmedQuery && queryScore <= 0) return 0;
  const recentIndex = recentIds.indexOf(item.id);
  return queryScore +
    (item.isActive ? 10_000 : 0) +
    (item.isRunning ? 5_000 : 0) +
    (recentIndex >= 0 ? 2_000 - recentIndex * 10 : 0);
};

const findBestWindowForItem = (
  item: Pick<LauncherItem, 'bundleIdentifier' | 'name' | 'pids' | 'windows'>,
  windows: WindowStreamInfo[],
) => {
  const knownWindowIds = new Set(item.windows.map(window => window.id));
  const directWindow = windows.find(window => knownWindowIds.has(window.id));
  if (directWindow) return directWindow;
  if (item.bundleIdentifier) {
    const bundleWindow = windows.find(window => window.bundleIdentifier === item.bundleIdentifier);
    if (bundleWindow) return bundleWindow;
  }
  const pids = new Set(item.pids ?? []);
  if (pids.size > 0) {
    const pidWindow = windows.find(window => typeof window.pid === 'number' && pids.has(window.pid));
    if (pidWindow) return pidWindow;
  }
  return windows.find(window => window.appName?.toLowerCase() === item.name.toLowerCase());
};

const launcherRecentStorageKey = (portalId: string) => `weave.window-stream.launcher.recent.${portalId}`;

const delay = (durationMs: number) => new Promise(resolve => window.setTimeout(resolve, durationMs));

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
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [launcherView, setLauncherView] = useState<LauncherView>('applications');
  const [launcherQuery, setLauncherQuery] = useState('');
  const [isLaunchingApplication, setIsLaunchingApplication] = useState(false);
  const [recentApplicationIds, setRecentApplicationIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const canListWindows = Boolean(selectedPortal?.capabilities.includes(windowListCapability));
  const canListApplications = Boolean(selectedPortal?.capabilities.includes(applicationListCapability));
  const canOpenApplications = Boolean(selectedPortal?.capabilities.includes(applicationOpenCapability));
  const {
    data: windows = [],
    isFetching: isFetchingWindows,
    error: windowsError,
    refetch: refetchWindows,
  } = useQuery({
    queryKey: ['window-stream-windows', selectedPortal?.portalId],
    queryFn: () => listWindowStreamWindows(selectedPortal!.portalId),
    enabled: Boolean(selectedPortal?.portalId && canListWindows),
  });
  const {
    data: applications = [],
    isFetching: isFetchingApplications,
    error: applicationsError,
    refetch: refetchApplications,
  } = useQuery({
    queryKey: ['window-stream-applications', selectedPortal?.portalId],
    queryFn: () => listWindowStreamApplications(selectedPortal!.portalId),
    enabled: Boolean(selectedPortal?.portalId && canListApplications),
  });

  const launcherItems = useMemo(() => createLauncherItems(applications, windows), [applications, windows]);
  const filteredLauncherItems = useMemo(() => {
    const source = launcherView === 'running'
      ? launcherItems.filter(item => item.isRunning || item.windows.length > 0)
      : launcherItems.filter(item => item.path || !item.id.startsWith('window:'));
    return source
      .map(item => ({ item, score: rankLauncherItem(item, launcherQuery, recentApplicationIds) }))
      .filter(match => match.score > 0)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
      .slice(0, 12)
      .map(match => match.item);
  }, [launcherItems, launcherQuery, launcherView, recentApplicationIds]);

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
    if (!selectedPortal?.portalId) {
      setRecentApplicationIds([]);
      return;
    }
    try {
      const value = window.localStorage.getItem(launcherRecentStorageKey(selectedPortal.portalId));
      const parsed = value ? JSON.parse(value) as unknown : undefined;
      setRecentApplicationIds(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []);
    } catch {
      setRecentApplicationIds([]);
    }
  }, [selectedPortal?.portalId]);

  useEffect(() => {
    setSelectedWindowId(windowId => {
      if (windowId && (windows.some(window => window.id === windowId) || sessionRef.current)) return windowId;
      return windows[0]?.id ?? '';
    });
  }, [windows]);

  const rememberLauncherItem = (item: LauncherItem) => {
    const portalId = selectedPortal?.portalId;
    if (!portalId) return;
    setRecentApplicationIds(current => {
      const next = [item.id, ...current.filter(id => id !== item.id)].slice(0, 25);
      try {
        window.localStorage.setItem(launcherRecentStorageKey(portalId), JSON.stringify(next));
      } catch {
        // Recent ordering is a convenience only.
      }
      return next;
    });
  };

  const openLauncher = (view: LauncherView = sessionRef.current ? 'running' : 'applications') => {
    setLauncherView(view);
    setLauncherQuery('');
    setIsLauncherOpen(true);
  };

  useEffect(() => {
    const handleLauncherShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      event.stopPropagation();
      openLauncher();
    };
    window.addEventListener('keydown', handleLauncherShortcut, true);
    return () => window.removeEventListener('keydown', handleLauncherShortcut, true);
  }, []);

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

  const selectLauncherWindow = (item: LauncherItem, window: WindowStreamInfo) => {
    rememberLauncherItem(item);
    setIsLauncherOpen(false);
    setSelectedWindowId(window.id);
    if (window.id === streamWindowId && sessionRef.current) return;
    void startStream(window.id);
  };

  const waitForLauncherWindow = async (item: LauncherItem) => {
    const deadline = Date.now() + launcherMatchTimeoutMs;
    let latestWindows = windows;
    while (Date.now() <= deadline) {
      const match = findBestWindowForItem(item, latestWindows);
      if (match) return match;
      await delay(400);
      latestWindows = (await refetchWindows()).data ?? [];
    }
    return undefined;
  };

  const selectLauncherItem = async (item: LauncherItem) => {
    rememberLauncherItem(item);
    setError(null);
    setIsLaunchingApplication(true);
    try {
      const currentWindow = findBestWindowForItem(item, windows);
      if (currentWindow && item.isRunning) {
        if (canOpenApplications && !item.id.startsWith('window:')) {
          await openWindowStreamApplication({ portalId: selectedPortal!.portalId, applicationId: item.id });
          void refetchApplications();
        }
        setIsLauncherOpen(false);
        setSelectedWindowId(currentWindow.id);
        await startStream(currentWindow.id);
        return;
      }

      if (!canOpenApplications || item.id.startsWith('window:')) {
        if (currentWindow) {
          setIsLauncherOpen(false);
          setSelectedWindowId(currentWindow.id);
          await startStream(currentWindow.id);
          return;
        }
        throw new Error(`${item.name} is not launchable from this Portal.`);
      }

      const openedApplication = await openWindowStreamApplication({
        portalId: selectedPortal!.portalId,
        applicationId: item.id,
      });
      const opened = openedApplication ?? {};
      const targetItem: LauncherItem = {
        ...item,
        ...opened,
        id: item.id,
        name: openedApplication?.name ?? item.name,
        bundleIdentifier: openedApplication?.bundleIdentifier ?? item.bundleIdentifier,
        pids: mergeUniquePids(item.pids, openedApplication?.pids),
        isRunning: openedApplication?.isRunning ?? true,
        isActive: openedApplication?.isActive ?? item.isActive,
        windows: item.windows,
      };
      void refetchApplications();
      const targetWindow = await waitForLauncherWindow(targetItem);
      if (!targetWindow) throw new Error(`Opened ${targetItem.name}, but no streamable window appeared.`);
      setIsLauncherOpen(false);
      setSelectedWindowId(targetWindow.id);
      await startStream(targetWindow.id);
    } catch (selectError) {
      setError(getWindowStreamErrorMessage(selectError));
    } finally {
      setIsLaunchingApplication(false);
    }
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

  const displayError = error ??
    (windowsError ? getWindowStreamErrorMessage(windowsError) : null) ??
    (applicationsError ? getWindowStreamErrorMessage(applicationsError) : null);
  const selectedPortalLabel = selectedPortal ? selectedPortal.name || selectedPortal.portalId : undefined;
  const isLoadingInitialState = (isFetchingWindows || isFetchingApplications) && !session && launcherItems.length === 0;
  const launcherPanel = isLauncherOpen ? (
    <div className="absolute left-1/2 top-4 z-20 w-[min(44rem,calc(100%-2rem))] -translate-x-1/2" data-weave-window-stream-launcher>
      <CommandPanel className="overflow-hidden rounded-lg">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <div className="flex shrink-0 rounded-md bg-muted p-0.5">
            <Button
              type="button"
              size="sm"
              variant={launcherView === 'running' ? 'secondary' : 'ghost'}
              className="h-7 px-2"
              onClick={() => setLauncherView('running')}
            >
              <List size={14} />
              Running
            </Button>
            <Button
              type="button"
              size="sm"
              variant={launcherView === 'applications' ? 'secondary' : 'ghost'}
              className="h-7 px-2"
              onClick={() => setLauncherView('applications')}
              disabled={!canListApplications}
            >
              <AppWindow size={14} />
              Applications
            </Button>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-background px-2">
            <Search size={14} className="shrink-0 text-muted-foreground" />
            <input
              autoFocus
              className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              placeholder={launcherView === 'running' ? 'Running apps' : 'Applications'}
              value={launcherQuery}
              onChange={event => setLauncherQuery(event.currentTarget.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setIsLauncherOpen(false);
                  window.requestAnimationFrame(() => surfaceRef.current?.focus());
                  return;
                }
                if (event.key === 'Enter' && filteredLauncherItems[0]) {
                  event.preventDefault();
                  void selectLauncherItem(filteredLauncherItems[0]);
                }
              }}
            />
          </div>
          <Button size="icon-sm" variant="ghost" aria-label="Close launcher" onClick={() => setIsLauncherOpen(false)}>
            <X size={15} />
          </Button>
        </div>
        <div className="max-h-[min(32rem,calc(100vh-9rem))] overflow-y-auto p-2">
          {(isFetchingApplications || isFetchingWindows || isLaunchingApplication) && filteredLauncherItems.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Spinner />
              Loading
            </div>
          ) : filteredLauncherItems.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No matches</div>
          ) : filteredLauncherItems.map(item => (
            <div key={item.id} className="rounded-md">
              <Button
                type="button"
                variant="ghost"
                className="h-auto w-full justify-start gap-3 rounded-md px-3 py-2 text-left"
                disabled={isLaunchingApplication}
                onClick={() => void selectLauncherItem(item)}
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted">
                  {item.iconDataUrl ? (
                    <img src={item.iconDataUrl} alt="" className="h-6 w-6 object-contain" />
                  ) : (
                    <AppWindow size={17} className="text-muted-foreground" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{item.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.isActive ? 'Active' : item.isRunning ? 'Running' : item.path ?? item.bundleIdentifier ?? item.id}
                  </span>
                </span>
                {item.windows.length > 0 ? (
                  <span className="shrink-0 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
                    {item.windows.length}
                  </span>
                ) : null}
              </Button>
              {launcherView === 'running' && item.windows.length > 0 ? (
                <div className="mb-1 ml-11 grid gap-1">
                  {item.windows.slice(0, 5).map(window => (
                    <button
                      key={window.id}
                      type="button"
                      className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      disabled={isLaunchingApplication}
                      onClick={() => selectLauncherWindow(item, window)}
                    >
                      <MonitorUp size={13} className="shrink-0" />
                      <span className="min-w-0 truncate">{window.title || window.id}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </CommandPanel>
    </div>
  ) : null;

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
          <Button
            size="sm"
            variant="outline"
            onClick={() => openLauncher()}
            disabled={!selectedPortal || (!canListWindows && !canListApplications)}
          >
            <AppWindow size={15} />
            Launcher
          </Button>
          {session ? (
            <Button size="sm" variant="secondary" onClick={stop}>
              <Square size={15} />
              Stop
            </Button>
          ) : (
            <Button size="sm" onClick={start} disabled={!selectedPortal || isStarting}>
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
        {launcherPanel}
        {capablePortals.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No online Portal advertises window streaming.
          </div>
        ) : isLoadingInitialState ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading
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
              <span>No stream active.</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
