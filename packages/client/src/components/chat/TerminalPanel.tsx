import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, LoaderCircle, Power, TerminalSquare, X } from 'lucide-react';
import { Button } from '../ui/button';
import { createDesktopTerminalTransport } from '../../lib/terminal-transport';
import type { TerminalTransport } from '../../lib/terminal-types';
import { GhosttyTerminalView, type GhosttyTerminalHandle } from './GhosttyTerminalView';

type TerminalPanelTarget = {
  planeId: string;
  demiplaneId: string;
  planeName: string;
  demiplaneName: string;
};

type TerminalPanelProps = {
  focusRequest?: number;
  isExpanded: boolean;
  onExpandedChange: (isExpanded: boolean) => void;
  onSessionActiveChange: (isActive: boolean) => void;
  target: TerminalPanelTarget;
  onHide: () => void;
};

type TerminalStatus = 'connecting' | 'running' | 'error';

type TerminalSize = {
  demiplaneId: string;
  cols: number;
  rows: number;
};

const terminalRevealDelayMs = 180;
const terminalRevealFallbackMs = 1_500;

const getTitlePath = (terminalTitle: string | undefined) => {
  const trimmedTitle = terminalTitle?.trim();
  if (!trimmedTitle) return undefined;

  const shellTitleMatch = /^.+@[^:]+:(.+)$/.exec(trimmedTitle);
  return shellTitleMatch?.[1]?.trim() || trimmedTitle;
};

export const TerminalPanel = ({
  focusRequest = 0,
  isExpanded,
  onExpandedChange,
  onSessionActiveChange,
  target,
  onHide,
}: TerminalPanelProps) => {
  const terminalRef = useRef<GhosttyTerminalHandle | null>(null);
  const onHideRef = useRef(onHide);
  const startedDemiplaneRef = useRef<string | undefined>(undefined);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [status, setStatus] = useState<TerminalStatus>('connecting');
  const [cwd, setCwd] = useState<string>();
  const [title, setTitle] = useState<string>();
  const [error, setError] = useState<string>();
  const [isClosing, setIsClosing] = useState(false);
  const [isTerminalReady, setIsTerminalReady] = useState(false);
  const [initialSize, setInitialSize] = useState<TerminalSize>();
  const transport = useMemo<TerminalTransport | undefined>(() => createDesktopTerminalTransport(), []);

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
    onHideRef.current = onHide;
  }, [onHide]);

  useEffect(() => () => clearRevealTimer(), [clearRevealTimer]);

  useEffect(() => {
    if (focusRequest === 0) return undefined;
    const animationFrame = window.requestAnimationFrame(() => terminalRef.current?.focus());
    return () => window.cancelAnimationFrame(animationFrame);
  }, [focusRequest]);

  const handleInput = useCallback((data: string) => {
    void transport?.input(target.demiplaneId, data).catch(() => undefined);
  }, [target.demiplaneId, transport]);

  const handleResize = useCallback((cols: number, rows: number) => {
    setInitialSize(current => current?.demiplaneId === target.demiplaneId
      ? current
      : { demiplaneId: target.demiplaneId, cols, rows });
    if (startedDemiplaneRef.current === target.demiplaneId) {
      void transport?.resize(target.demiplaneId, cols, rows).catch(() => undefined);
    }
  }, [target.demiplaneId, transport]);

  const handleTitleChange = useCallback((nextTitle: string) => {
    setTitle(nextTitle);
  }, []);

  const handleTerminalError = useCallback((message: string) => {
    setStatus('error');
    setError(message);
  }, []);

  const handleCloseSession = useCallback(async () => {
    if (!transport) return;
    setIsClosing(true);
    try {
      await transport.close(target.demiplaneId);
      onSessionActiveChange(false);
      onHide();
    } catch (closeError) {
      setStatus('error');
      setError(closeError instanceof Error ? closeError.message : String(closeError));
      setIsClosing(false);
    }
  }, [onHide, onSessionActiveChange, target.demiplaneId, transport]);

  useEffect(() => {
    if (!transport) {
      setStatus('error');
      setError('Terminal transport is unavailable in this client.');
      return undefined;
    }

    const measuredSize = initialSize?.demiplaneId === target.demiplaneId ? initialSize : undefined;

    setStatus('connecting');
    setError(undefined);
    setCwd(undefined);
    setTitle(undefined);
    setIsClosing(false);
    setIsTerminalReady(false);
    clearRevealTimer();

    if (!measuredSize) return undefined;

    const unsubscribe = transport.subscribe(event => {
      if (event.demiplaneId !== target.demiplaneId) return;

      if (event.type === 'started') {
        setStatus('running');
        setCwd(event.cwd);
        setError(undefined);
        onSessionActiveChange(true);
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
        onSessionActiveChange(false);
        onHideRef.current();
        return;
      }

      if (event.type === 'error') {
        setStatus('error');
        setError(event.error);
        onSessionActiveChange(false);
        setIsTerminalReady(true);
      }
    });

    startedDemiplaneRef.current = target.demiplaneId;
    void transport.start({
      planeId: target.planeId,
      demiplaneId: target.demiplaneId,
      cols: measuredSize.cols,
      rows: measuredSize.rows,
    }).catch(startError => {
      setStatus('error');
      setError(startError instanceof Error ? startError.message : String(startError));
      onSessionActiveChange(false);
    });

    return () => {
      if (startedDemiplaneRef.current === target.demiplaneId) {
        startedDemiplaneRef.current = undefined;
      }
      clearRevealTimer();
      unsubscribe();
      void transport.detach(target.demiplaneId).catch(() => undefined);
    };
  }, [clearRevealTimer, initialSize, onSessionActiveChange, scheduleTerminalReveal, target.demiplaneId, target.planeId, transport]);

  const titleLabel = getTitlePath(title) ?? cwd ?? `${target.planeName} / ${target.demiplaneName}`;
  const statusLabel = status === 'connecting'
    ? 'connecting'
    : status === 'error'
      ? error ?? 'error'
      : undefined;

  return (
    <section
      className={[
        'relative z-10 flex min-h-44 shrink-0 flex-col bg-background transition-[height] duration-150 ease-out',
        isExpanded ? 'h-full' : 'h-[min(34dvh,22rem)] border-t border-border',
      ].join(' ')}
      data-weave-terminal-panel
      data-weave-surface="terminal"
      data-expanded={isExpanded ? 'true' : 'false'}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <TerminalSquare size={15} className="shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">
            {titleLabel}
          </span>
          {statusLabel ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {statusLabel}
            </span>
          ) : null}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Stop terminal"
          disabled={isClosing || status === 'connecting'}
          onClick={handleCloseSession}
        >
          <Power size={14} />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={isExpanded ? 'Collapse terminal' : 'Expand terminal'}
          title={isExpanded ? 'Collapse terminal' : 'Expand terminal'}
          onClick={() => onExpandedChange(!isExpanded)}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </Button>
        <Button size="icon-xs" variant="ghost" aria-label="Hide terminal" onClick={onHide}>
          <X size={14} />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--vscode-panel-background,var(--background))]">
        <div className={isTerminalReady ? 'h-full min-h-0 opacity-100' : 'pointer-events-none h-full min-h-0 opacity-0'}>
          <GhosttyTerminalView
            key={target.demiplaneId}
            ref={terminalRef}
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
    </section>
  );
};
