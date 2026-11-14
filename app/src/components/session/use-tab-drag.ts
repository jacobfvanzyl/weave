// Dragging a tab's pill along a Session's tab rail to another place among the tabs (WVE-232).
// The pill follows the pointer and the others make room as it passes their middles; the layout
// changes once, when it's let go, so its Host is told the new order and not every step of the
// way. A mouse drags after a few pixels, so a click still shows the tab and a double click still
// renames it. A finger drags after holding still a moment, since a swipe scrolls the rail.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';

/** How far a mouse moves, in CSS pixels, before it's a drag and not a click. */
const SLOP = 5;
/** How long a finger holds still before it drags, and how far it may stray meanwhile. */
const HOLD_MS = 250;
const HOLD_SLOP = 8;

type Held = {
  id: string;
  pointerId: number;
  element: HTMLElement;
  startX: number;
  /** From the pill's left edge to where it was taken hold of. */
  grab: number;
  touch: boolean;
  timer?: ReturnType<typeof setTimeout>;
  active: boolean;
};

type Drag = { id: string; index: number; x: number };

const tabElements = (rail: HTMLElement | null) => [...(rail?.querySelectorAll<HTMLElement>('[data-tab]') ?? [])];

/**
 * `ids` are the tabs in the layout's order. `order` is the order to draw them in, which differs
 * while one is dragged, `dragging` the one dragged, `rail` the element that holds the pills, and
 * `tabProps` what a pill takes. `onMove` gets the tab and its place among the others when it's
 * dropped somewhere else.
 */
export function useTabDrag(ids: readonly string[], onMove: (id: string, index: number) => void, enabled = true) {
  const rail = useRef<HTMLDivElement>(null);
  const held = useRef<Held>(undefined);
  const [drag, setDrag] = useState<Drag>();
  const current = drag && ids.includes(drag.id) ? drag : undefined;
  const order = current
    ? (() => {
        const rest = ids.filter((id) => id !== current.id);
        rest.splice(current.index, 0, current.id);
        return rest;
      })()
    : [...ids];

  // The pill under the pointer: wherever the others have left it, moved to where it's held.
  useLayoutEffect(() => {
    const pills = tabElements(rail.current);
    for (const pill of pills) if (pill.dataset.tab !== current?.id) pill.style.transform = '';
    const pill = current ? pills.find(({ dataset }) => dataset.tab === current.id) : undefined;
    const bounds = rail.current?.getBoundingClientRect();
    if (!pill || !bounds || !held.current) return;
    pill.style.transform = '';
    const at = pill.getBoundingClientRect();
    const wanted = Math.min(Math.max(current!.x - held.current.grab, bounds.left), Math.max(bounds.left, bounds.right - at.width));
    pill.style.transform = `translateX(${wanted - at.left}px)`;
  });

  // A finger that's dragging a tab doesn't scroll the rail too.
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const still = (event: TouchEvent) => {
      if (held.current?.active) event.preventDefault();
    };
    element.addEventListener('touchmove', still, { passive: false });
    return () => element.removeEventListener('touchmove', still);
  }, []);
  useEffect(() => () => clearTimeout(held.current?.timer), []);

  const begin = (holding: Held) => {
    holding.active = true;
    try {
      holding.element.setPointerCapture?.(holding.pointerId);
    } catch {
      // The pointer has gone already.
    }
    setDrag({ id: holding.id, index: ids.indexOf(holding.id), x: holding.startX });
  };
  const release = () => {
    clearTimeout(held.current?.timer);
    held.current = undefined;
    setDrag(undefined);
  };

  const tabProps = (id: string) => ({
    'data-tab': id,
    'data-dragging': current?.id === id || undefined,
    onPointerDown(event: PointerEvent<HTMLElement>) {
      if (!enabled || ids.length < 2 || event.button !== 0 || held.current) return;
      // Its close button and its name being typed over are their own.
      if ((event.target as Element).closest('button, input')) return;
      const holding: Held = {
        id,
        pointerId: event.pointerId,
        element: event.currentTarget,
        startX: event.clientX,
        grab: event.clientX - event.currentTarget.getBoundingClientRect().left,
        touch: event.pointerType === 'touch',
        active: false,
      };
      if (holding.touch) holding.timer = setTimeout(() => begin(holding), HOLD_MS);
      held.current = holding;
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const holding = held.current;
      if (!holding || holding.pointerId !== event.pointerId) return;
      const moved = Math.abs(event.clientX - holding.startX);
      if (!holding.active) {
        if (holding.touch) {
          // A swipe, which scrolls the rail.
          if (moved > HOLD_SLOP) release();
          return;
        }
        if (moved < SLOP) return;
        begin(holding);
      }
      // Its place: after every other pill whose middle its own middle has passed.
      const pills = tabElements(rail.current);
      const width = pills.find(({ dataset }) => dataset.tab === id)?.getBoundingClientRect().width ?? 0;
      const middle = event.clientX - holding.grab + width / 2;
      const index = pills.filter((pill) => {
        if (pill.dataset.tab === id) return false;
        const at = pill.getBoundingClientRect();
        return at.left + at.width / 2 < middle;
      }).length;
      setDrag({ id, index, x: event.clientX });
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const holding = held.current;
      if (!holding || holding.pointerId !== event.pointerId) return;
      const dropped = holding.active ? current : undefined;
      release();
      if (dropped && dropped.index !== ids.indexOf(dropped.id)) onMove(dropped.id, dropped.index);
    },
    onPointerCancel(event: PointerEvent<HTMLElement>) {
      if (held.current?.pointerId === event.pointerId) release();
    },
  });

  return { rail, order, dragging: current?.id, tabProps };
}
