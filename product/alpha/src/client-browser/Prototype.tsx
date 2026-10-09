// Isolated feasibility entry, available only in acceptance builds.
import { useEffect, useRef, useState } from 'react';
import { nativeClientBrowser, type ClientBrowserEvent, type ClientBrowserSnapshot } from './native-client-browser';
type Surface = { id: string; label: string };
export function ClientBrowserPrototype() {
  const slots = useRef(new Map<string, HTMLDivElement>());
  const owned = useRef<Surface[]>([]);
  const [surfaces, setSurfaces] = useState<Surface[]>([]);
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState(false);
  const [overlay, setOverlay] = useState(false);
  const [vertical, setVertical] = useState(false);
  const [snapshots, setSnapshots] = useState<Record<string, ClientBrowserSnapshot>>({});
  const flags = useRef({ hidden, overlay }); flags.current = { hidden, overlay };
  const layout = useRef(() => {});
  const close = useRef((_id: string) => {});
  useEffect(() => { layout.current(); }, [hidden, overlay, vertical, surfaces]);
  useEffect(() => {
    let stopped = false;
    const events: ClientBrowserEvent[] = [];
    let listener: Awaited<ReturnType<typeof nativeClientBrowser.addListener>> | undefined;
    const fail = (e: unknown) => { if (!stopped) setError(String(e)); };
    const measure = () => {
      for (const { id, label } of owned.current) {
        const rect = slots.current.get(id)?.getBoundingClientRect(); if (!rect) continue;
        void nativeClientBrowser.layout({ surfaceId: id, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          visible: !document.hidden && !(label === 'Right' && flags.current.hidden) && !flags.current.overlay,
          blocked: flags.current.overlay }).catch(fail);
      }
    };
    const resize = new ResizeObserver(measure);
    layout.current = () => { resize.disconnect(); slots.current.forEach(el => resize.observe(el)); measure(); };
    close.current = id => {
      owned.current = owned.current.filter(surface => surface.id !== id);
      setSurfaces([...owned.current]);
      void nativeClientBrowser.close({ surfaceId: id }).catch(fail);
    };
    const add = async (result: Promise<{ surfaceId: string }>, label: string) => {
      const { surfaceId } = await result;
      if (stopped) { await nativeClientBrowser.close({ surfaceId }); return; }
      owned.current.push({ id: surfaceId, label }); setSurfaces([...owned.current]);
    };
    window.addEventListener('resize', measure); document.addEventListener('visibilitychange', measure);
    const base = new URLSearchParams(location.search).get('fixture') || 'http://localhost:43187';
    void (async () => {
      listener = await nativeClientBrowser.addListener('event', event => {
        if (stopped) return;
        events.push(event); if (events.length > 300) events.shift();
        if (event.kind === 'popup-created' && typeof event.popupToken === 'string') {
          void add(nativeClientBrowser.adopt({ popupToken: event.popupToken }), 'Popup').catch(fail);
        }
        if (event.kind === 'page-close') close.current(event.surfaceId);
      });
      if (stopped) { await listener.remove(); return; }
      for (const label of ['Left', 'Right']) {
        if (stopped) return;
        await add(nativeClientBrowser.create({ address: `${base}/?pane=${label.toLowerCase()}` }), label);
      }
    })().catch(fail);
    const timer = setInterval(() => {
      const current = [...owned.current];
      void Promise.all(current.map(async ({ id }) => [id, await nativeClientBrowser.snapshot({ surfaceId: id })] as const)).then(values => {
        if (stopped) return;
        setSnapshots(Object.fromEntries(values));
        Object.assign(window, { clientBrowserPrototypeEvidence: { surfaces: current, snapshots: values.map(([, value]) => value),
          events: [...events], documentHidden: document.hidden, hidden: flags.current.hidden, overlay: flags.current.overlay } });
      }).catch(fail);
    }, 500);
    return () => {
      stopped = true; clearInterval(timer); resize.disconnect(); window.removeEventListener('resize', measure); document.removeEventListener('visibilitychange', measure);
      void listener?.remove(); owned.current.forEach(({ id }) => { void nativeClientBrowser.close({ surfaceId: id }); }); owned.current = [];
    };
  }, []);
  const buttonStyle = { padding: '7px 12px', background: '#313244', borderRadius: 6, cursor: 'pointer' };
  return <main style={{ height: '100dvh', display: 'flex', flexDirection: 'column', paddingTop: 30, color: '#cdd6f4', background: '#1e1e2e' }}>
    <header style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 16px', flexWrap: 'wrap' }}>
      <strong>WVE-80 · SwiftUI / WKWebView feasibility</strong>
      <button style={buttonStyle} onClick={() => setHidden(v => !v)}>{hidden ? 'Show right page' : 'Hide right page'}</button>
      <button style={buttonStyle} onClick={() => setVertical(v => !v)}>Change split</button>
      <button style={buttonStyle} onClick={() => setOverlay(true)}>Open shell overlay</button>
    </header>
    {error && <p role="alert">{error}</p>}
    <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 8, padding: '0 8px', flexDirection: vertical ? 'column' : 'row' }}>
      {surfaces.map(({ id, label }) => <div key={id} style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 6, fontSize: 12, display: 'flex', justifyContent: 'space-between' }}>
          <span>{label} · {snapshots[id]?.title || 'Starting'} · {snapshots[id]?.pageIdentity.slice(0, 8)}</span>
          <button aria-label={`Close ${label} page`} onClick={() => close.current(id)}>×</button>
        </div>
        <div ref={el => { if (el) slots.current.set(id, el); else slots.current.delete(id); }} data-client-browser-slot={id} style={{ flex: 1, minHeight: 0, background: '#11111b' }} />
      </div>)}
    </div>
    <footer style={{ padding: 8, fontSize: 12 }}>Temporary profiles · SwiftUI / WKWebView · downloads use disposable destinations · no Host connection</footer>
    {overlay && <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: '#000a', display: 'grid', placeItems: 'center' }}>
      <div style={{ background: '#313244', padding: 30, borderRadius: 12 }}><p>React shell overlay — native pages are retained while hidden.</p><button style={buttonStyle} onClick={() => setOverlay(false)}>Close shell overlay</button></div>
    </div>}
  </main>;
}
