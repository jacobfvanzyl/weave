# PER-15: tmux pane-arrangement lessons for Weave

Research scope: tmux behavior and implementation, using the official OpenBSD
tmux manual and the official tmux repository. Stable source-code links are
pinned to release
[`3.7b` (`e802909`)](https://github.com/tmux/tmux/tree/e802909de06012a4df6209d55e86487c56223163);
the note calls out one `master` behavior that is newer than that release.

## Executive conclusion

Borrow tmux's **recursive split tree**, geometric directional targeting, and
single command model shared by buttons/keybinds/palette. Do not copy tmux's
command names literally or treat its pane-number order as spatial order.

For Weave, `Move Pane Left/Right/Up/Down` should mean: find the pane that shares
the requested edge with the focused Pane and **swap the two Pane identities
between their existing layout cells**. This preserves the surrounding geometry
and makes repeated moves predictable. A separate `Move Pane to Workspace Tab…`
operation should remove the Pane from its source tree and insert it by splitting
a chosen destination Pane. At an outer edge, arrangement should stop rather
than wrap to the opposite edge.

## What tmux actually does

### Splits and the layout model

- `split-window -h` creates panes side-by-side; `-v` creates panes above/below,
  with vertical the default. `-b` places the new pane left/above rather than
  right/below. A requested size may be absolute or a percentage. `-f` splits
  across the full window rather than only the target pane
  ([tmux(1), `split-window`](https://man.openbsd.org/tmux#split-window)).
- Internally, a window layout is a tree. A cell is either a left-right
  container, a top-bottom container, or a leaf holding a pane. The window owns
  the root; leaves and panes point to each other; every cell knows its parent
  and geometry
  ([`layout.c`, model comment](https://github.com/tmux/tmux/blob/3.7b/layout.c#L25-L43)).
- The tree is n-ary, not necessarily binary. Splitting a leaf on the same axis
  as its parent inserts a sibling in that parent; splitting on the other axis
  wraps the leaf in a new container. A full-size split operates at the root
  ([`layout_split_pane`](https://github.com/tmux/tmux/blob/3.7b/layout.c#L990-L1137)).
- Closing a leaf gives its space to a tiled sibling, then removes a parent that
  has only one child by promoting that child
  ([`layout_destroy_cell`](https://github.com/tmux/tmux/blob/3.7b/layout.c#L535-L589)).

This model explains why nested horizontal/vertical splits remain structurally
stable under split, close, resize, and move operations. Geometry is derived
from the tree; it is not the source of truth.

### Directional neighbor selection

`select-pane -L/-R/-U/-D` targets a pane geometrically left, right, above, or
below the current target
([tmux(1), `select-pane`](https://man.openbsd.org/tmux#select-pane)). The source
implementation:

1. computes the focused pane's rectangle;
2. finds panes whose facing edge is directly adjacent;
3. keeps candidates whose span overlaps the focused pane on the perpendicular
   axis; and
4. if several qualify, selects the most recently active candidate.

At a window edge tmux wraps to the opposite edge. See
[`window_pane_find_up/down/left/right`](https://github.com/tmux/tmux/blob/3.7b/window.c#L1490-L1717)
and its
[`window_pane_choose_best` MRU tie-break](https://github.com/tmux/tmux/blob/3.7b/window.c#L1446-L1463).

The important separation is that this is **geometric focus navigation**. It
does not traverse the layout tree and it does not rearrange it.

### Swap versus move

tmux exposes two materially different operations:

- `swap-pane` exchanges two pane identities while keeping the two layout cells
  and their geometry. tmux's shorthand `-U/-D` means previous/next **pane
  number**, not spatially above/below
  ([tmux(1), `swap-pane`](https://man.openbsd.org/tmux#swap-pane)). In source it
  rewires each leaf's pane pointer and moves each pane to the other's geometry;
  it does not rebuild either layout tree
  ([`cmd-swap-pane.c`](https://github.com/tmux/tmux/blob/3.7b/cmd-swap-pane.c#L45-L134)).
- `join-pane`/tiled `move-pane` removes the source pane from its current layout,
  splits a destination pane, and inserts the source into the new cell. The
  destination may be in another window. Axis and before/after position are
  explicit
  ([tmux(1), `join-pane`](https://man.openbsd.org/tmux#join-pane),
  [`cmd-join-pane.c`](https://github.com/tmux/tmux/blob/3.7b/cmd-join-pane.c#L28-L140)).

In stable 3.7b, `move-pane` is an alias-shaped twin of `join-pane`. Current
unreleased `master` adds `move-pane -L/-R/-U/-D` for changing a **floating**
pane's coordinates; it still is not a spatial reorder command for tiled panes
([tmux(1), `move-pane`](https://man.openbsd.org/tmux#move-pane),
[`master` command definition](https://github.com/tmux/tmux/blob/31dccb6bc9521b0ea46307974d071ad7f09f0e9b/cmd-join-pane.c#L37-L58)).
A Weave command called `Move Pane Left` therefore should not be implemented by
copying tmux's `move-pane` surface.

### Resize semantics

`resize-pane` changes a target by directional increments or absolute width and
height; zoom is a separate toggle on the same command
([tmux(1), `resize-pane`](https://man.openbsd.org/tmux#resize-pane)). For a tiled
pane, tmux walks from the leaf to the nearest ancestor on the requested axis,
then transfers bounded space across an adjacent boundary. It respects minimum
sizes, searches other siblings if the nearest one cannot shrink, and propagates
the change through nested children
([`layout_resize_pane` and helpers](https://github.com/tmux/tmux/blob/3.7b/layout.c#L667-L820)).

This is boundary movement, not independent rectangle resizing: growing one
region consumes space from another and the tree continues to fill the entire
container.

## Recommendation for Weave

### Borrow

- Keep one normalized layout tree per Workspace Tab, with `row`, `column`, and
  Pane-leaf nodes. Flatten adjacent containers with the same axis and collapse
  singleton containers after removal.
- Store Pane identity/content separately from layout cells. That makes a
  directional swap a small, reversible identity exchange rather than a risky
  tree rewrite.
- Resolve `Focus Left/Right/Up/Down` and `Move Pane
  Left/Right/Up/Down` through the same geometric-neighbor function. A candidate
  must share the facing boundary and overlap on the perpendicular axis.
- Make every operation a canonical command, invoked identically by the focused
  Pane controls, global keybindings, and command palette:
  `Split Pane Left/Right/Above/Below`, `Focus …`, `Move Pane …`,
  `Resize Pane …`, `Move Pane to Workspace Tab…`, and `Close Pane`.
- Preserve full-container coverage, minimum Pane sizes, divider drag, and
  keyboard resize as different inputs to the same bounded resize operation.

### Adapt

- For an ambiguous directional neighbor, prefer **largest shared-edge overlap**,
  then nearest center on the perpendicular axis, then stable layout order.
  tmux's most-recently-active tie-break makes the result history-dependent,
  which is useful for focus but surprising for structural movement.
- Focus navigation may optionally wrap as a preference. Arrangement must not
  wrap: disable/no-op `Move Pane Left` when no left neighbor exists.
- A directional move should swap with the geometric neighbor and retain focus
  on the moved Pane. Cross-Tab movement should use tmux's join model: remove,
  normalize the source tree, split a user-selected destination, insert, and
  focus the moved Pane.
- Store proportional weights or pixel-derived ratios, not terminal rows and
  columns. Weave must arrange heterogeneous Editor, Thread, Terminal, and other
  Pane types across changing desktop dimensions.
- Give structural edits undo support. A split-tree snapshot is compact, and
  directional swap, split, close, and cross-Tab insert can each produce an
  inverse operation.

### Do not borrow

- Do not expose tmux's historical terminology where “horizontal split” means
  a left/right result; use unambiguous commands such as `Split Right` and
  `Split Below` in the UI.
- Do not use creation/numeric Pane order as a proxy for spatial direction.
- Do not make Pane type part of the layout algorithm. The Workspace's default
  Pane type affects what `New Pane` creates, while the active Tab's `New Pane`
  button can override it with a picker; both should feed the same split/insert
  command after the type is resolved.
- Do not couple Weave's visual layout to tmux's backend session/window layout.
  tmux is a useful algorithmic reference, but a Weave Terminal Pane is only one
  leaf type in a broader Workspace Tab layout.

## Proposed behavioral contract

| Command | Result |
| --- | --- |
| `Split Right` / `Split Below` | Split the focused Pane's leaf 50/50 and focus the new Pane; the type comes from the picker or Workspace default. |
| `Split Left` / `Split Above` | Same, inserting before the focused leaf. |
| `Focus <direction>` | Select the geometric neighbor; optional focus-wrap preference only. |
| `Move Pane <direction>` | Swap the focused Pane identity with its geometric neighbor; keep focus on the moved Pane; no-op at an outer edge. |
| `Resize Pane <direction>` | Move the relevant ancestor boundary by a bounded step; respect minimum sizes. |
| `Move Pane to Workspace Tab…` | Remove from source tree, normalize it, split a selected destination, insert and focus. |
| `New Pane` on active Tab | Open the type picker; preselect the Workspace-level default and remember no Tab-local shadow default unless later required. |

One follow-up decision remains deliberately outside this research note: the
exact keybindings. The command semantics and conflict policy should be fixed
before assigning shortcuts.
