# MessageScroller

The transcript's scroller: shadcn/ui's `MessageScroller` primitive, kept here as the app's own
code (WVE-235). It is `packages/react/src/message-scroller` from
[shadcn-ui/ui](https://github.com/shadcn-ui/ui) at commit `4aaea19d` (2 November 2026, after the
0.3.1 release, which the app used as `@shadcn/react` until then), MIT licensed, Copyright (c)
2023 shadcn. Its `useRender` and `mergeProps` are Base UI's, which upstream's `use-render` copies.
`components/ui/message-scroller.tsx` styles it.

## What weave changed

Each change is marked `weave:` where it is made.

- **Resizes are handled in the frame they happen.** Upstream waits an animation frame after its
  ResizeObserver hears of one (#11085), because its tail spacer sat inside the content it
  watches, so sizing the spacer re-fired the observer. That frame painted content that had shrunk
  under a held turn at a scroll position the browser had clamped, then snapped back: the
  transcript flashed down by what folded (204px for a short turn ending) and back. The spacer is
  now the content's sibling in the viewport (`MessageScrollerContent`), so nothing the handler
  does resizes what it watches, and the observers call `handleResize` directly. The geometry
  sizes the spacer from the content's own box (`getTailSpacerHeight`, `getContentBoxBottom`)
  and reads the content's padding from the content (`getElementScrollTop`).
- **Following glides.** While following the live end, a reply that grows is followed a quarter
  of the remaining way each frame (`followToEnd`, `FOLLOW_EASING`) instead of a jump per chunk;
  each frame aims at the end as it is then, a reader's gesture stops it, and it is instant under
  `prefers-reduced-motion`. Opening at the end, the end button and jumps stay as they were.
- **A turn can be brought back to the reading line** (`anchorMessage`), as a new prompt is when
  it arrives, while it is on screen. The chat pane does so as a turn ends and folds
  (`TurnEndHold` in `src/chat/chat-pane.tsx`).

Upstream's tests run here under happy-dom (`message-scroller.test.tsx`, `geometry.test.ts`),
their layout model moved to the spacer's new place and run with reduced motion, since they
assert where the scroller settles; the tests of what weave changed are at the end of
`message-scroller.test.tsx`.

To take a later upstream change, compare it with the commit above and carry it over by hand.
