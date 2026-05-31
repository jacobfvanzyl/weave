import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, LoaderCircle, Plus, TerminalSquare, X } from 'lucide-react';
import { Button } from '../ui/button';
import { createTerminalTransport } from '../../lib/terminal-transport';
import type { TerminalSessionKind, TerminalTransport } from '../../lib/terminal-types';
import { GhosttyTerminalView, type GhosttyTerminalHandle } from './GhosttyTerminalView';

type TerminalPanelTarget = {
  kind: TerminalSessionKind;
  terminalId: string;
  title: string;
  cwd?: string;
  planeId?: string;
  demiplaneId?: string;
  portalId?: string;
  rootId?: string;
  repoPath?: string;
  workspacePath?: string;
};

type TerminalStatus = 'connecting' | 'running' | 'error';

export type TerminalPanelTab = {
  id: string;
  terminalId: string;
  label: string;
  cwd?: string | undefined;
  title?: string | undefined;
  status?: TerminalStatus | undefined;
  error?: string | undefined;
};

type TerminalPanelProps = {
  activeTabId?: string;
  focusRequest?: number;
  isExpanded?: boolean;
  onActiveSessionCountChange?: (count: number) => void;
  onActiveTabIdChange: (tabId: string) => void;
  onCreateTab: (ordinal: number) => TerminalPanelTab;
  onExpandedChange?: (isExpanded: boolean) => void;
  onSessionActiveChange: (isActive: boolean) => void;
  onTabsChange: (tabs: TerminalPanelTab[]) => void;
  tabs: TerminalPanelTab[];
  target: TerminalPanelTarget;
  onHide: () => void;
  variant?: 'pane' | 'overlay';
};

type TerminalSize = {
  terminalId: string;
  cols: number;
  rows: number;
};

type TerminalTabMeta = {
  cwd?: string | undefined;
  error?: string | undefined;
  status?: TerminalStatus | undefined;
  title?: string | undefined;
};

type TerminalSessionViewProps = {
  focusRequest: number;
  isActive: boolean;
  onExit: (tabId: string) => void;
  onMetaChange: (tabId: string, meta: TerminalTabMeta) => void;
  onSessionActiveChange: (tabId: string, isActive: boolean) => void;
  tab: TerminalPanelTab;
  target: TerminalPanelTarget;
  transport?: TerminalTransport;
};

const terminalRevealDelayMs = 180;
const terminalRevealFallbackMs = 1_500;

const getTitlePath = (terminalTitle: string | undefined) => {
  const trimmedTitle = terminalTitle?.trim();
  if (!trimmedTitle) return undefined;

  const shellTitleMatch = /^.+@[^:]+:(.+)$/.exec(trimmedTitle);
  return shellTitleMatch?.[1]?.trim() || trimmedTitle;
};

const getTabLabel = (tab: TerminalPanelTab) => getTitlePath(tab.title) ?? tab.cwd ?? tab.label;

const TerminalSessionView = ({
  focusRequest,
  isActive,
  onExit,
  onMetaChange,
  onSessionActiveChange,
  tab,
  target,
  transport,
}: TerminalSessionViewProps) => {
  const terminalRef = useRef<GhosttyTerminalHandle | null>(null);
  const onExitRef = useRef(onExit);
  const onSessionActiveChangeRef = useRef(onSessionActiveChange);
  const startedTerminalRef = useRef<string | undefined>(undefined);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latestSizeRef = useRef<TerminalSize | undefined>(undefined);
  const latestMetaRef = useRef<string | undefined>(undefined);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [cwd, setCwd] = useState<string>();
  const [title, setTitle] = useState<string>();
  const [error, setError] = useState<string>();
  const [isTerminalReady, setIsTerminalReady] = useState(false);
  const [hasMeasuredSize, setHasMeasuredSize] = useState(false);

  const clearRevealTimer = useCallback(() => {
    if (revealTimerRef.current === undefined) return;
    clearTimeout(revealTimerRef.current);
    revealTimerRef.current = undefined;
  }, []);

  const scheduleTerminalReveal = useCallback((delayMs = terminalRevealDelayMs) => {
    clearRevealTimer();
    revealTimerRef.current = setTimeout(() => {
      revealTimerRef.current = undefined;
      requestAnimationFrame(() => setIsTerminalReady(true));
    }, delayMs);
  }, [clearRevealTimer]);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    onSessionActiveChangeRef.current = onSessionActiveChange;
  }, [onSessionActiveChange]);

  useEffect(() => () => clearRevealTimer(), [clearRevealTimer]);

  useEffect(() => {
    if (!isActive || focusRequest === 0) return undefined;
    const animationFrame = window.requestAnimationFrame(() => terminalRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusRequest, isActive]);

  useEffect(() => {
    const meta: TerminalTabMeta = { cwd, error, status, title };
    const metaKey = JSON.stringify(meta);
    if (latestMetaRef.current === metaKey) return;
    latestMetaRef.current = metaKey;
    onMetaChange(tab.id, meta);
  }, [cwd, error, onMetaChange, status, tab.id, title]);

  const handleInput = useCallback((data: string) => {
    void transport?.input(tab.terminalId, data).catch(() => undefined);
  }, [tab.terminalId, transport]);

  const handleResize = useCallback((cols: number, rows: number) => {
    latestSizeRef.current = { terminalId: tab.terminalId, cols, rows };
    setHasMeasuredSize(true);
    if (startedTerminalRef.current === tab.terminalId) {
      void transport?.resize(tab.terminalId, cols, rows).catch(() => undefined);
    }
  }, [tab.terminalId, transport]);

  const syncTerminalSize = useCallback(() => {
    terminalRef.current?.fit();
    const terminalSize = terminalRef.current?.getSize();
    const nextSize = terminalSize
      ? { terminalId: tab.terminalId, cols: terminalSize.cols, rows: terminalSize.rows }
      : latestSizeRef.current;
    if (!nextSize || nextSize.terminalId !== tab.terminalId) return;

    latestSizeRef.current = nextSize;
    setHasMeasuredSize(true);
    if (startedTerminalRef.current === tab.terminalId) {
      void transport?.resize(tab.terminalId, nextSize.cols, nextSize.rows).catch(() => undefined);
    }
  }, [tab.terminalId, transport]);

  const handleTitleChange = useCallback((nextTitle: string) => {
    setTitle(nextTitle);
  }, []);

  const handleTerminalError = useCallback((message: string) => {
    setStatus('error');
    setError(message);
  }, []);

  useEffect(() => {
    if (!transport) {
      setStatus('error');
      setError('Terminal transport is unavailable in this client.');
      return undefined;
    }

    const measuredSize = hasMeasuredSize && latestSizeRef.current?.terminalId === tab.terminalId
      ? latestSizeRef.current
      : undefined;

    setStatus('connecting');
    setError(undefined);
    setCwd(undefined);
    setTitle(undefined);
    setIsTerminalReady(false);
    clearRevealTimer();

    if (!measuredSize) return undefined;

    const resizeSyncTimers: number[] = [];
    let resizeSyncFrame: number | undefined;
    const scheduleResizeSync = (delayMs: number) => {
      resizeSyncTimers.push(window.setTimeout(syncTerminalSize, delayMs));
    };

    const unsubscribe = transport.subscribe(event => {
      if (event.terminalId !== tab.terminalId) return;

      if (event.type === 'started') {
        setStatus('running');
        setCwd(event.cwd);
        setError(undefined);
        onSessionActiveChangeRef.current(tab.id, true);
        syncTerminalSize();
        scheduleTerminalReveal(terminalRevealFallbackMs);
        return;
      }

      if (event.type === 'output' || event.type === 'replay') {
        terminalRef.current?.write(event.data);
        scheduleTerminalReveal();
        return;
      }

      if (event.type === 'title') {
        setTitle(event.title);
        return;
      }

      if (event.type === 'exit') {
        onSessionActiveChangeRef.current(tab.id, false);
        onExitRef.current(tab.id);
        return;
      }

      if (event.type === 'error') {
        setStatus('error');
        setError(event.error);
        onSessionActiveChangeRef.current(tab.id, false);
        setIsTerminalReady(true);
      }
    });

    startedTerminalRef.current = tab.terminalId;
    void transport.start({
      kind: target.kind,
      terminalId: tab.terminalId,
      planeId: target.planeId,
      demiplaneId: target.demiplaneId,
      portalId: target.portalId,
      rootId: target.rootId,
      repoPath: target.repoPath,
      workspacePath: target.workspacePath,
      cwd: target.cwd,
      cols: measuredSize.cols,
      rows: measuredSize.rows,
    }).then(() => {
      resizeSyncFrame = window.requestAnimationFrame(syncTerminalSize);
      scheduleResizeSync(50);
      scheduleResizeSync(250);
    }).catch(startError => {
      setStatus('error');
      setError(startError instanceof Error ? startError.message : String(startError));
      onSessionActiveChangeRef.current(tab.id, false);
      setIsTerminalReady(true);
    });

    return () => {
      if (startedTerminalRef.current === tab.terminalId) {
        startedTerminalRef.current = undefined;
      }
      if (resizeSyncFrame !== undefined) window.cancelAnimationFrame(resizeSyncFrame);
      resizeSyncTimers.forEach(timer => window.clearTimeout(timer));
      clearRevealTimer();
      unsubscribe();
      void transport.detach(tab.terminalId).catch(() => undefined);
    };
  }, [
    clearRevealTimer,
    hasMeasuredSize,
    scheduleTerminalReveal,
    syncTerminalSize,
    tab.id,
    tab.terminalId,
    target.cwd,
    target.demiplaneId,
    target.kind,
    target.planeId,
    target.portalId,
    target.repoPath,
    target.rootId,
    target.workspacePath,
    transport,
  ]);

  return (
    <div className={isActive ? 'relative h-full min-h-0 overflow-hidden' : 'hidden'} data-terminal-tab-id={tab.id}>
      <div className={isTerminalReady ? 'h-full min-h-0 opacity-100' : 'pointer-events-none h-full min-h-0 opacity-0'}>
        <GhosttyTerminalView
          key={tab.terminalId}
          ref={terminalRef}
          autoFocus={isActive}
          onInput={handleInput}
          onResize={handleResize}
          onError={handleTerminalError}
          onTitleChange={handleTitleChange}
        />
      </div>
      {!isTerminalReady && status !== 'error' ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-primary">
          <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
        </div>
      ) : null}
      {status === 'error' ? (
        <div className="pointer-events-none absolute inset-x-3 top-3 rounded-md border border-destructive/30 bg-background/90 px-3 py-2 text-xs text-destructive shadow-sm">
          {error}
        </div>
      ) : null}
    </div>
  );
};

export const TerminalPanel = ({
  activeTabId,
  focusRequest = 0,
  isExpanded = false,
  onActiveSessionCountChange,
  onActiveTabIdChange,
  onCreateTab,
  onExpandedChange,
  onSessionActiveChange,
  onTabsChange,
  tabs,
  target,
  onHide,
  variant = 'pane',
}: TerminalPanelProps) => {
  const transport = useMemo<TerminalTransport | undefined>(() => createTerminalTransport(), []);
  const [activeSessionTabIds, setActiveSessionTabIds] = useState<Set<string>>(() => new Set());
  const activeTab = tabs.find(tab => tab.id === activeTabId) ?? tabs[0];

  const notifyActiveSessionCount = useCallback((count: number) => {
    onSessionActiveChange(count > 0);
    onActiveSessionCountChange?.(count);
  }, [onActiveSessionCountChange, onSessionActiveChange]);

  useEffect(() => {
    if (tabs.length > 0) return;
    const firstTab = onCreateTab(1);
    onTabsChange([firstTab]);
    onActiveTabIdChange(firstTab.id);
  }, [onActiveTabIdChange, onCreateTab, onTabsChange, tabs.length]);

  useEffect(() => {
    if (!activeTab && tabs.length > 0) {
      onActiveTabIdChange(tabs[0].id);
    }
  }, [activeTab, onActiveTabIdChange, tabs]);

  useEffect(() => {
    const tabIds = new Set(tabs.map(tab => tab.id));
    setActiveSessionTabIds(current => {
      let didChange = false;
      const next = new Set<string>();
      current.forEach(tabId => {
        if (tabIds.has(tabId)) {
          next.add(tabId);
        } else {
          didChange = true;
        }
      });
      if (!didChange && next.size === current.size) return current;
      notifyActiveSessionCount(next.size);
      return next;
    });
  }, [notifyActiveSessionCount, tabs]);

  const updateTabActiveState = useCallback((tabId: string, isActive: boolean) => {
    setActiveSessionTabIds(current => {
      const isCurrentlyActive = current.has(tabId);
      if (isCurrentlyActive === isActive) return current;

      const next = new Set(current);
      if (isActive) {
        next.add(tabId);
      } else {
        next.delete(tabId);
      }
      notifyActiveSessionCount(next.size);
      return next;
    });
  }, [notifyActiveSessionCount]);

  const handleTabMetaChange = useCallback((tabId: string, meta: TerminalTabMeta) => {
    let didChange = false;
    const nextTabs = tabs.map(tab => {
      if (tab.id !== tabId) return tab;
      if (
        tab.cwd === meta.cwd
        && tab.error === meta.error
        && tab.status === meta.status
        && tab.title === meta.title
      ) {
        return tab;
      }
      didChange = true;
      return { ...tab, ...meta };
    });

    if (didChange) onTabsChange(nextTabs);
  }, [onTabsChange, tabs]);

  const createNextTab = useCallback(() => onCreateTab(tabs.length + 1), [onCreateTab, tabs.length]);

  const handleAddTab = useCallback(() => {
    const nextTab = createNextTab();
    onTabsChange([...tabs, nextTab]);
    onActiveTabIdChange(nextTab.id);
  }, [createNextTab, onActiveTabIdChange, onTabsChange, tabs]);

  const closeTab = useCallback(async (tabToClose: TerminalPanelTab) => {
    try {
      await transport?.close(tabToClose.terminalId);
    } catch {
      // A tab can still be removed if its backing session is already gone.
    }

    updateTabActiveState(tabToClose.id, false);

    const tabIndex = tabs.findIndex(tab => tab.id === tabToClose.id);
    const remainingTabs = tabs.filter(tab => tab.id !== tabToClose.id);

    if (remainingTabs.length === 0) {
      onTabsChange([]);
      onHide();
      return;
    }

    onTabsChange(remainingTabs);
    if (activeTabId === tabToClose.id) {
      const nextActiveTab = remainingTabs[Math.min(Math.max(tabIndex, 0), remainingTabs.length - 1)];
      onActiveTabIdChange(nextActiveTab.id);
    }
  }, [
    activeTabId,
    onActiveTabIdChange,
    onTabsChange,
    onHide,
    tabs,
    transport,
    updateTabActiveState,
  ]);

  const handleTabExit = useCallback((tabId: string) => {
    const exitedTab = tabs.find(tab => tab.id === tabId);
    if (!exitedTab) return;
    void closeTab(exitedTab);
  }, [closeTab, tabs]);

  return (
    <section
      className={variant === 'overlay'
        ? 'relative z-10 flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border-2 border-[#89b4fa] bg-background shadow-2xl'
        : [
            'relative z-10 flex min-h-44 shrink-0 flex-col bg-background transition-[height] duration-150 ease-out',
            isExpanded ? 'h-full' : 'h-[min(34dvh,22rem)] border-t border-border',
          ].join(' ')}
      data-weave-terminal-panel
      data-weave-surface="terminal"
      data-terminal-kind={target.kind}
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      <div className="flex h-9 shrink-0 items-stretch gap-2 border-b border-border px-3">
        <TerminalSquare size={15} className="self-center shrink-0 text-primary" />
        <div
          className="flex min-w-0 flex-1 items-end overflow-x-auto"
          role="tablist"
          aria-label={target.title}
        >
          {tabs.map(tab => {
            const isSelected = tab.id === activeTab?.id;
            const tabLabel = getTabLabel(tab);
            const statusLabel = tab.status === 'connecting'
              ? 'connecting'
              : tab.status === 'error'
                ? tab.error ?? 'error'
                : undefined;

            return (
              <div
                key={tab.id}
                className={[
                  'relative -ml-px flex h-7 min-w-36 max-w-64 shrink-0 items-center overflow-hidden rounded-t-md rounded-b-none border border-b-0 text-xs first:ml-0',
                  isSelected
                    ? 'z-10 border-primary/40 bg-primary/10 text-foreground'
                    : 'z-0 border-border bg-transparent text-muted-foreground hover:z-10 hover:bg-primary/5 hover:text-foreground',
                ].join(' ')}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 overflow-hidden px-2 text-left"
                  role="tab"
                  aria-selected={isSelected}
                  title={statusLabel ? `${tabLabel} - ${statusLabel}` : tabLabel}
                  onClick={() => onActiveTabIdChange(tab.id)}
                >
                  <span className="block overflow-hidden text-ellipsis whitespace-nowrap [direction:rtl] [text-align:left]">
                    <span className="[direction:ltr] [unicode-bidi:isolate]">
                      {tabLabel}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="grid h-7 w-7 shrink-0 place-items-center text-muted-foreground hover:text-foreground"
                  aria-label={`Close ${tabLabel}`}
                  onClick={event => {
                    event.stopPropagation();
                    void closeTab(tab);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <Button
            className="mb-0.5 ml-2 shrink-0"
            size="icon-xs"
            variant="ghost"
            aria-label="New terminal tab"
            title="New terminal tab"
            onClick={handleAddTab}
          >
            <Plus size={14} />
          </Button>
        </div>
        {variant === 'pane' && onExpandedChange ? (
          <Button
            className="self-center"
            size="icon-xs"
            variant="ghost"
            aria-label={isExpanded ? 'Collapse terminal' : 'Expand terminal'}
            title={isExpanded ? 'Collapse terminal' : 'Expand terminal'}
            onClick={() => onExpandedChange(!isExpanded)}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </Button>
        ) : null}
        <Button className="self-center" size="icon-xs" variant="ghost" aria-label="Hide terminal" onClick={onHide}>
          <X size={14} />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--vscode-panel-background,var(--background))]">
        {activeTab ? (
          <TerminalSessionView
            key={activeTab.id}
            focusRequest={focusRequest}
            isActive
            onExit={handleTabExit}
            onMetaChange={handleTabMetaChange}
            onSessionActiveChange={updateTabActiveState}
            tab={activeTab}
            target={target}
            transport={transport}
          />
        ) : null}
      </div>
    </section>
  );
};
