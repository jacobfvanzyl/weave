import { usePaneFocusAdapter, paneVisible, paneRendered, paneOverlayOpen } from '@/app/pane-focus';
import { TERMINAL_CODEC } from '@weave/product-protocol';
import { useEffect, useRef, useState } from 'react';
import type { TerminalOutputSource } from '@/terminal/output-stream';
import { decodeTerminalBytes, encodeTerminalBytes, nativeTerminalAcceptance, nativeTerminalBridge } from '@/terminal/native-terminal';

export function NativeTerminalView({ output, readOnly, onInput, onResize, focusRequest, dimAmount = 0 }: {
  focusRequest?: string;
  dimAmount?: number;
  output: TerminalOutputSource; readOnly: boolean;
  onInput?(data: string | Uint8Array): void; onResize?(cols: number, rows: number): void;
}) {
  const { owner, id: paneId } = usePaneFocusAdapter();
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ readOnly, onInput, onResize, dimAmount });
  latest.current = { readOnly, onInput, onResize, dimAmount };
  const [error, setError] = useState<string>();
  const updateGeometry = useRef<(() => void) | undefined>(undefined);
  const requestedFocus = useRef<string | undefined>(focusRequest);
  useEffect(() => { requestedFocus.current = focusRequest; updateGeometry.current?.(); }, [focusRequest]);
  useEffect(() => updateGeometry.current?.(), [readOnly, dimAmount]);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    let failed = false;
    let surfaceId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    let removeListener: (() => Promise<void>) | undefined;
    let frame: number | undefined;
    let resizeEnabled = false;
    let geometryRevision = 0;
    let previousBounds = '';
    let lastResize = '';

    let nativeFocused = false;
    let overlayWasOpen = false;
    const webFocus = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (target !== element && !target.closest?.('[role="dialog"], [role="menu"], [role="listbox"]')) nativeFocused = false;
    };
    if (!owner) document.addEventListener('focusin', webFocus);
    let unregisterFocus: (() => void) | undefined;
    let layoutReady = false;
    const fail = (cause: unknown) => {
      if (disposed) return;
      failed = true;
      unregisterFocus?.();
      setError(cause instanceof Error ? cause.message : String(cause));
      measure();
    };
    const measure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (disposed || !surfaceId) return;
        const rect = element.getBoundingClientRect();
        const overlay = paneOverlayOpen();
        const restoreFocus = overlayWasOpen && !overlay && nativeFocused;
        overlayWasOpen = overlay;
        const focusToken = requestedFocus.current;
        const shouldFocus = !owner && (Boolean(focusToken) || restoreFocus);
        const frameElement = element.closest<HTMLElement>('[data-slot="terminal-focus-border"]');
        const frameStyle = frameElement && getComputedStyle(frameElement);
        const color = frameStyle?.getPropertyValue(frameElement?.closest('[data-agent-focused="true"]') ? '--sidebar-selected' : '--terminal-focus').trim();
        const focusBorder = frameStyle && /^#[0-9a-f]{6}$/i.test(color ?? '') ? {
          width: frameElement?.closest('[data-focused="true"]') ? parseFloat(frameStyle.borderTopWidth) || 0 : 0,
          radius: parseFloat(frameStyle.borderBottomRightRadius) || 0,
          rgb: parseInt(color!.slice(1), 16),
        } : undefined;
        const bounds = { surfaceId, focusBorder, dimAmount: latest.current.dimAmount, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: !failed && !document.hidden && paneRendered(element) && rect.width > 0 && rect.height > 0, readOnly: latest.current.readOnly, inputBlocked: overlay || !paneVisible(element) };
        resizeEnabled = bounds.visible;
        const key = JSON.stringify(bounds);
        if (key === previousBounds && !shouldFocus) return;
        previousBounds = key;
        const revision = ++geometryRevision;
        layoutReady = false;
        void nativeTerminalBridge.layout(bounds).then(({ cols, rows }) => {
          if (disposed || revision !== geometryRevision || !resizeEnabled || !bounds.visible) return;
          layoutReady = true;
          owner?.ready();
          if (!latest.current.readOnly && lastResize !== `${cols}:${rows}`) { lastResize = `${cols}:${rows}`; latest.current.onResize?.(cols, rows); }
          if (!bounds.inputBlocked && shouldFocus && (restoreFocus || (focusToken && requestedFocus.current === focusToken))) {
            requestedFocus.current = undefined;
            void nativeTerminalBridge.focus({ surfaceId: bounds.surfaceId }).catch(() => {
              // Occlusion can change between layout and native focus. Retain
              // the intent for the next visible layout; emulation remains valid.
              if (!disposed && !requestedFocus.current) requestedFocus.current = focusToken;
            });
          }
        }).catch(fail);
      });
    };
    updateGeometry.current = measure;
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const mutations = new MutationObserver(measure);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'inert', 'aria-hidden', 'data-open', 'data-closed', 'data-focused', 'data-agent-focused', 'data-window-bottom-right', 'class'] });
    window.addEventListener('resize', measure);
    window.addEventListener('alpha-window-corner-change', measure);
    document.addEventListener('visibilitychange', measure);
    void (async () => {
      const listener = await nativeTerminalBridge.addListener('event', (event) => {
        if (disposed || event.surfaceId !== surfaceId) return;
        if (!failed && !paneOverlayOpen() && paneVisible(element) && event.kind === 'input' && event.data && !latest.current.readOnly) latest.current.onInput?.(decodeTerminalBytes(event.data));
        // Only an acknowledged visible layout can resize the Host. UIKit also
        // emits provisional sizes while creating/hiding its native view.
        if (event.kind === 'error') fail(event.message ?? 'Native terminal input failed.');
        if (event.kind === 'blur') { nativeFocused = false; if (paneId) owner?.didBlur(paneId); }
        if (event.kind === 'focus') {
          if (owner && paneId) {
            if (event.intent === 'pointer') owner.request(paneId);
            // AppKit/UIKit may restore a native responder when an overlay
            // disappears. It must not replace the remembered typing target.
            if (owner.snapshot() && owner.snapshot() !== paneId) { owner.restoreTarget(); return; }
          }
          nativeFocused = true; element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        }
      });
      removeListener = () => listener.remove();
      if (disposed) { await listener.remove(); return; }
      const created = await nativeTerminalBridge.create();
      surfaceId = created.surfaceId;
      if (disposed) { await nativeTerminalBridge.close({ surfaceId }); return; }
      if (created.codec !== TERMINAL_CODEC) throw new Error('Native terminal codec mismatch; rebuild matching app components.');
      // Position the native viewport before replay. Its capacity is measured
      // separately; only the Host snapshot sets the terminal's emulation grid.
      const initial = element.getBoundingClientRect();
      await nativeTerminalBridge.layout({ surfaceId, x: initial.x, y: initial.y, width: initial.width, height: initial.height, visible: false, readOnly: latest.current.readOnly });
      if (disposed) return;
      setError(undefined);
      element.dataset.nativeRenderer = created.renderer;
      const id = surfaceId;
      if (owner && paneId) unregisterFocus = owner.register(paneId, {
        element, available: () => !disposed && !failed && layoutReady && paneVisible(element),
        focus: async () => {
          if (!layoutReady || !paneVisible(element) || paneOverlayOpen()) return false;
          await nativeTerminalBridge.focus({ surfaceId: id }); return true;
        },
      });
      unsubscribe = output.subscribe({
        reset: (data, grid) => nativeTerminalBridge.write({ surfaceId: id, data: window.weaveDesktop?.nativeTerminal ? data : encodeTerminalBytes(data), reset: true, ...(grid ? { cols: grid.cols, rows: grid.rows } : {}) }),
        history: (data) => nativeTerminalBridge.write({ surfaceId: id, data: window.weaveDesktop?.nativeTerminal ? data : encodeTerminalBytes(data), reset: false, history: true }),
        write: (data) => nativeTerminalBridge.write({ surfaceId: id, data: window.weaveDesktop?.nativeTerminal ? data : encodeTerminalBytes(data), reset: false }),
      });
      if (import.meta.env.VITE_ALPHA_ACCEPTANCE === '1') nativeTerminalAcceptance.set(element, {
        focus: async () => { if (owner && paneId) owner.request(paneId); await nativeTerminalBridge.focus({ surfaceId: id }); },
        read: async () => (await nativeTerminalBridge.inspect({ surfaceId: id })).text,
      });
      measure();
    })().catch(fail);
    return () => {
      disposed = true;
      unregisterFocus?.();
      updateGeometry.current = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('alpha-window-corner-change', measure);
      document.removeEventListener('visibilitychange', measure);
      document.removeEventListener('focusin', webFocus);
      unsubscribe?.();
      nativeTerminalAcceptance.delete(element);
      void removeListener?.();
      if (surfaceId) void nativeTerminalBridge.close({ surfaceId }).catch(() => undefined);
    };
  }, [output, owner, paneId]);
  return <div ref={host} data-slot='native-terminal' data-native-layered={error ? undefined : 'true'} className='min-h-0 min-w-0 flex-1 overflow-hidden' aria-label='Native terminal surface'>
    {error && <p role='alert' className='p-3 text-sm text-destructive'>{error}</p>}
  </div>;
}
