import { useRef, useState, type CSSProperties } from 'react';
import type { TerminalLayoutNode } from '@weave/product-protocol';

type Rect = { x: number; y: number; width: number; height: number };
type Pane = { node: Extract<TerminalLayoutNode, { kind: 'terminal' }>; rect: Rect };
type Divider = { node: Extract<TerminalLayoutNode, { kind: 'split' }>; rect: Rect };
const full: Rect = { x: 0, y: 0, width: 100, height: 100 };
const dividerWidth = 1;
const internalEdge = (end: number) => end < 100 - 0.000001;
const style = (rect: Rect): CSSProperties => ({ position: 'absolute', left: `${rect.x}%`, top: `${rect.y}%`, width: `calc(${rect.width}% - ${internalEdge(rect.x + rect.width) ? dividerWidth : 0}px)`, height: `calc(${rect.height}% - ${internalEdge(rect.y + rect.height) ? dividerWidth : 0}px)` });

// Each internal boundary owns one trailing gutter, shared by both panes.
// Native terminal frames stop before it so the web divider retains its own input region.
// Flatten only presentation geometry. Pane components remain keyed siblings
// even when their logical position in the Host's split tree changes.
export function paneGeometry(root: TerminalLayoutNode, ratios: Record<string, number> = {}) {
  const panes: Pane[] = []; const dividers: Divider[] = [];
  const visit = (node: TerminalLayoutNode, rect: Rect) => {
    if (node.kind === 'terminal') { panes.push({ node, rect }); return; }
    const ratio = ratios[node.nodeId] ?? node.ratio;
    dividers.push({ node: { ...node, ratio }, rect });
    if (node.axis === 'horizontal') {
      visit(node.children[0], { ...rect, width: rect.width * ratio });
      visit(node.children[1], { ...rect, x: rect.x + rect.width * ratio, width: rect.width * (1 - ratio) });
    } else {
      visit(node.children[0], { ...rect, height: rect.height * ratio });
      visit(node.children[1], { ...rect, y: rect.y + rect.height * ratio, height: rect.height * (1 - ratio) });
    }
  };
  visit(root, full); return { panes, dividers };
}
export function WorkspacePaneLayout({ layout, maximized, active, setRatio, renderPane }: {
  layout: TerminalLayoutNode; maximized?: string; active: boolean;
  setRatio(nodeId: string, ratio: number): Promise<unknown>;
  renderPane(node: Pane['node'], visible: boolean): React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; ratio: number } | undefined>(undefined);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const [error, setError] = useState<string>();
  const { panes, dividers } = paneGeometry(layout, ratios);
  const expanded = panes.some(({ node }) => node.paneId === maximized) ? maximized : undefined;
  const commit = async (id: string, ratio: number) => {
    try { setError(undefined); await setRatio(id, ratio); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRatios((current) => { const next = { ...current }; delete next[id]; return next; }); }
  };
  return <div ref={host} hidden={!active} className='relative min-h-0 min-w-0 flex-1' style={{ display: active ? undefined : 'none' }} aria-hidden={!active}>
    {panes.map(({ node, rect }) => {
      const visible = active && (!expanded || expanded === node.paneId);
      return <div key={node.paneId} hidden={!visible} aria-hidden={!visible} style={{ ...style(expanded === node.paneId ? full : rect), display: visible ? 'flex' : 'none' }} data-pane-id={node.paneId}>
        {renderPane(node, visible)}
      </div>;
    })}
    {!expanded && dividers.map(({ node, rect }) => {
      const horizontal = node.axis === 'horizontal';
      return <div key={node.nodeId} role='separator' tabIndex={0} aria-label='Resize terminal panes' aria-orientation={horizontal ? 'vertical' : 'horizontal'} aria-valuemin={10} aria-valuemax={90} aria-valuenow={Math.round(node.ratio * 100)}
        className='absolute z-10 touch-none bg-muted-foreground/50 hover:bg-primary focus-visible:bg-primary'
        style={horizontal ? { left: `calc(${rect.x + rect.width * node.ratio}% - ${dividerWidth}px)`, top: `${rect.y}%`, height: `${rect.height}%`, width: dividerWidth, cursor: 'col-resize' } : { top: `calc(${rect.y + rect.height * node.ratio}% - ${dividerWidth}px)`, left: `${rect.x}%`, width: `${rect.width}%`, height: dividerWidth, cursor: 'row-resize' }}
        onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { id: node.nodeId, ratio: node.ratio }; }}
        onPointerMove={(event) => {
          if (drag.current?.id !== node.nodeId || !host.current) return;
          const bounds = host.current.getBoundingClientRect();
          const position = horizontal ? (event.clientX - bounds.x) / bounds.width * 100 : (event.clientY - bounds.y) / bounds.height * 100;
          const ratio = Math.max(0.1, Math.min(0.9, (position - (horizontal ? rect.x : rect.y)) / (horizontal ? rect.width : rect.height)));
          drag.current.ratio = ratio; setRatios((current) => ({ ...current, [node.nodeId]: ratio }));
        }}
        onPointerUp={() => { if (drag.current?.id === node.nodeId) { const value = drag.current; drag.current = undefined; void commit(value.id, value.ratio); } }}
        onPointerCancel={() => { drag.current = undefined; setRatios({}); }}
        onKeyDown={(event) => {
          const delta = event.key === (horizontal ? 'ArrowRight' : 'ArrowDown') ? 0.05 : event.key === (horizontal ? 'ArrowLeft' : 'ArrowUp') ? -0.05 : 0;
          if (delta) { event.preventDefault(); void commit(node.nodeId, Math.max(0.1, Math.min(0.9, node.ratio + delta))); }
        }} />;
    })}
    {error && <p role='alert' className='absolute inset-x-0 top-0 z-20 bg-background p-2 text-destructive'>{error}</p>}
  </div>;
}
