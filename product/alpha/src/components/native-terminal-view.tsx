import { useEffect, useRef, useState } from 'react';
import type { TerminalOutputSource } from '@/terminal/output-stream';
import { decodeTerminalBytes, encodeTerminalBytes, nativeTerminalAcceptance, nativeTerminalBridge } from '@/terminal/native-terminal';

export function NativeTerminalView({ output, readOnly, onInput, onResize }: {
  output: TerminalOutputSource; readOnly: boolean;
  onInput?(data: string): void; onResize?(cols: number, rows: number): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ readOnly, onInput, onResize });
  latest.current = { readOnly, onInput, onResize };
  const [error, setError] = useState<string>();
  const updateGeometry = useRef<(() => void) | undefined>(undefined);
  useEffect(() => updateGeometry.current?.(), [readOnly]);
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
    const fail = (cause: unknown) => {
      if (disposed) return;
      failed = true;
      setError(cause instanceof Error ? cause.message : String(cause));
      measure();
    };
    const measure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (disposed || !surfaceId) return;
        const rect = element.getBoundingClientRect();
        const overlay = [...document.querySelectorAll('[role="dialog"], [role="menu"], [role="listbox"]')].some((item) => item.getBoundingClientRect().height > 0);
        const bounds = { surfaceId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: !failed && !document.hidden && !overlay && element.isConnected && rect.width > 0 && rect.height > 0, readOnly: latest.current.readOnly };
        resizeEnabled = bounds.visible;
        const key = JSON.stringify(bounds);
        if (key === previousBounds) return;
        previousBounds = key;
        const revision = ++geometryRevision;
        void nativeTerminalBridge.layout(bounds).then(({ cols, rows }) => {
          if (!disposed && revision === geometryRevision && resizeEnabled && bounds.visible && !latest.current.readOnly) latest.current.onResize?.(cols, rows);
        }).catch(fail);
      });
    };
    updateGeometry.current = measure;
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    const mutations = new MutationObserver(measure);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'hidden', 'data-open'] });
    window.addEventListener('resize', measure);
    document.addEventListener('visibilitychange', measure);
    void (async () => {
      const listener = await nativeTerminalBridge.addListener('event', (event) => {
        if (disposed || event.surfaceId !== surfaceId) return;
        if (!failed && event.kind === 'input' && event.data && !latest.current.readOnly) latest.current.onInput?.(decodeTerminalBytes(event.data));
        // Only an acknowledged visible layout can resize the Host. UIKit also
        // emits provisional sizes while creating/hiding its native view.
        if (event.kind === 'error') fail(event.message ?? 'Native terminal input failed.');
        if (event.kind === 'focus') element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      });
      removeListener = () => listener.remove();
      if (disposed) { await listener.remove(); return; }
      const created = await nativeTerminalBridge.create();
      surfaceId = created.surfaceId;
      if (disposed) { await nativeTerminalBridge.close({ surfaceId }); return; }
      // A saved screen must not be parsed using the new view's default 80×24
      // grid. Fit the native surface before subscribing to its initial replay.
      const initial = element.getBoundingClientRect();
      await nativeTerminalBridge.layout({ surfaceId, x: initial.x, y: initial.y, width: initial.width, height: initial.height, visible: false, readOnly: latest.current.readOnly });
      if (disposed) return;
      setError(undefined);
      element.dataset.nativeRenderer = created.renderer;
      const id = surfaceId;
      unsubscribe = output.subscribe({
        reset: (data) => nativeTerminalBridge.write({ surfaceId: id, data: encodeTerminalBytes(data), reset: true }),
        write: (data) => nativeTerminalBridge.write({ surfaceId: id, data: encodeTerminalBytes(data), reset: false }),
      });
      if (import.meta.env.VITE_ALPHA_ACCEPTANCE === '1') nativeTerminalAcceptance.set(element, {
        focus: () => nativeTerminalBridge.focus({ surfaceId: id }),
        read: async () => (await nativeTerminalBridge.inspect({ surfaceId: id })).text,
      });
      measure();
    })().catch(fail);
    return () => {
      disposed = true;
      updateGeometry.current = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener('resize', measure);
      document.removeEventListener('visibilitychange', measure);
      unsubscribe?.();
      nativeTerminalAcceptance.delete(element);
      void removeListener?.();
      if (surfaceId) void nativeTerminalBridge.close({ surfaceId }).catch(() => undefined);
    };
  }, [output]);
  return <div ref={host} data-slot='native-terminal' className='min-h-0 min-w-0 flex-1 overflow-hidden bg-[#1e1e2e]' aria-label='Native terminal surface'>
    {error && <p role='alert' className='p-3 text-sm text-destructive'>{error}</p>}
  </div>;
}
