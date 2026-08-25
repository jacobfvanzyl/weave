# Zed pane resizing and persistence shape

_Research snapshot: 2026-08-26. Primary Zed source only._

## Conclusion

Zed's editor panes are an ordered, recursively nested set of n-ary axes. Each axis owns its direction, children, and one proportional weight per child. A divider drag changes those weights, clamps panes to an axis-specific minimum, and can carry the remaining delta across more distant siblings when the immediate sibling reaches its minimum. The visible divider is 1 px, while its mouse target is 4 px; double-clicking a divider equalizes that axis. ([pane-group constants and model](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L20-L31), [drag computation](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1224-L1320), [handle lifecycle](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1322-L1347), [mouse handlers](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1530-L1605))

Alpha deliberately diverges on excess drag delta: a separator owns only its two adjacent Panes. Once either Pane reaches its current minimum, further movement in that direction stops instead of resizing a more distant sibling.

Zed's left/right docks use a separate edge-panel model. Their size can be a fixed pixel value or a proportional flex value, and the size is persisted independently from whether the dock is visible. That separation is the most useful precedent for Weave's future per-Thread restoration: hidden panes should leave the active layout, but their last usable size should remain in serializable state. ([dock size state](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/dock.rs#L377-L423), [dock visibility state](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/persistence/model.rs#L153-L230), [workspace-scoped dock-size key](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/dock.rs#L1251-L1267))

The current upstream revision inspected was [`e0f913b`](https://github.com/zed-industries/zed/tree/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4), the `main` head returned by the canonical repository on 2026-08-26.

## Center-pane representation

`PaneGroup` has one `root: Member`; a member is either a pane or a `PaneAxis`. A `PaneAxis` contains an `Axis`, ordered `members`, proportional `flexes`, and runtime-only bounding boxes. New axes start with every flex set to `1`. Restored axes accept saved flexes only when their count matches the children and their sum is approximately the number of children; otherwise Zed falls back to equal sizes. ([group and member types](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L27-L42), [`PaneAxis::new` and `load`](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L647-L683))

The tree stays shallow where possible:

- Splitting along the parent's existing axis inserts a sibling into that n-ary axis.
- Splitting along the other axis wraps the target pane in a nested axis.
- Adding or removing a sibling resets that axis to equal weights.
- Removing the penultimate member collapses the one-child axis into its remaining member.
- Reset Pane Sizes recursively sets every axis to equal weights.

These behaviors are implemented directly in [`PaneAxis::split`, `insert_pane`, `remove`, and `reset_pane_sizes`](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L685-L786).

Layout interprets each weight as a share of `child_count`: `child_pixels = container_pixels * flex / child_count`. Since valid flexes sum to `child_count`, this is a normalized proportional layout even though the stored numbers do not have to sum to `1`. Runtime bounding boxes are recomputed during layout and are not serialized. ([axis layout](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1387-L1457), [flex invariant](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1615-L1617))

This closely matches Weave's existing `WorkspaceCompositionLayout`: an ordered `row`/`column` tree with stable Layout Node identities and one positive ratio per child. Weave already rejects a ratio/child count mismatch and adjacent containers with the same axis, which is the serialized equivalent of Zed's flattened same-axis representation. ([Weave protocol layout shape](../../packages/protocol/src/v2/dtos.ts#L176-L206), [Weave layout invariants](../../packages/protocol/src/v2/dtos.ts#L287-L352))

## Divider drag lifecycle

| Phase | Zed behavior | Weave implication |
| --- | --- | --- |
| Layout | Every gap receives a 4 px blocking hitbox centered over a 1 px divider. | Keep the visual seam thin while giving it a forgiving target. The hitbox must not add visible width or shift pane geometry. |
| Pointer down | The axis stores the divider's child index as the active drag; double-click resets every sibling weight to `1`. | Store `{ layoutId, dividerIndex }`, not a DOM node. Equalize only the affected row. |
| Pointer move | The pointer's absolute coordinate is converted to a requested change from the dragged child's start edge. | Base every move on current geometry or a drag-start snapshot; do not accumulate rounded `movementX` deltas. |
| Clamp | Each pair is constrained by the axis minimum. If a pair cannot absorb the requested movement, the loop continues through successive siblings in the movement direction. | Deliberate Alpha divergence: reject an update that changes a third Pane. The active separator stops when either adjacent Pane reaches its constraint. |
| Pointer up | The active divider index is cleared. The cursor remains a resize cursor for the whole drag, even after leaving the narrow hitbox. | Use pointer capture and handle `pointerup` plus `pointercancel`; keep `col-resize` on the document or drag surface until finalization. |

The authoritative source for the request-to-weight loop is [`compute_resize`](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1224-L1320); the cursor, down, move, double-click, and up behavior is in the axis paint handlers ([lines 1530–1605](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1530-L1605)).

One detail should be adapted rather than transcribed. Zed's programmatic resize converts pixels to a flex change with `child_count * pixel_delta / container_pixels`, which follows its layout equation, while the current direct mouse-drag path uses `pixel_delta / container_pixels`. ([programmatic conversion](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L854-L894), [mouse conversion](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1242-L1264)) Preserve the proportional invariant and test the result in pixels for two, three, and four siblings instead of copying either formula blindly.

## Minimums and clamping

Center panes use a fixed minimum of 80 px on a horizontal axis and 100 px on a vertical axis. The drag path clamps both sides of each affected pair; if the current child is already below the minimum because the container itself became too small, that resize is ignored rather than making it smaller. ([minimum constants](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L20-L24), [pair clamping](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1235-L1313))

Side docks are more content-aware: a panel may provide a minimum size, the dock wrapper applies it, fixed-width docks may shrink when total space is insufficient, and stored widths are clamped again when workspace bounds change. ([panel sizing contract](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/dock.rs#L36-L69), [dock rendering and minimum](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/workspace.rs#L8186-L8278), [bounds-change clamp](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/workspace.rs#L9206-L9238))

For Weave, use pane-kind minimums in rendering and drag math, but keep them out of the persisted snapshot. Minimums are product constraints that can evolve; saved data should remain proportional and be re-clamped against the current viewport and current rules when restored.

## Persistence behavior

Zed serializes the center as the same recursive shape it renders: each group stores `axis`, ordered `children`, and optional `flexes`; each leaf stores a pane. Deserialization recursively rebuilds the tree, drops empty children, collapses groups that restore with only one member, and validates the flex vector through `PaneAxis::load`. ([serialized shape and restore](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/persistence/model.rs#L234-L337), [tree serialization](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/workspace.rs#L7204-L7229))

The database representation preserves group identity through parent/position relationships, stores the axis on each group, and stores its flex vector as JSON. ([schema](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/persistence.rs#L554-L582), [flex migration](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/persistence.rs#L643-L646), [read and write](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/persistence.rs#L2281-L2407))

Every divider move asks the Workspace to serialize, but Workspace serialization coalesces requests behind a 200 ms timer. ([drag save request](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/pane_group.rs#L1315-L1320), [serialization throttle](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/workspace.rs#L173), [coalescing implementation](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/workspace.rs#L7187-L7202)) For browser `localStorage`, Weave can avoid synchronous write churn more simply: update controlled in-memory layout during drag, then expose one commit event on pointer-up for the later persistence layer. A debounced safety write during a long drag can be added with the persistence feature, not the resize component.

Zed's docks demonstrate a second useful rule. Visibility and selected panel live in the saved Workspace dock structure, while size is stored separately by `workspace_id:panel_key`. Hiding a dock therefore does not erase its remembered geometry. ([dock visibility model](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/persistence/model.rs#L153-L230), [size persistence](https://github.com/zed-industries/zed/blob/e0f913b07d6a4c4ee4ee27119ec4ea3aadcd35e4/crates/workspace/src/workspace.rs#L2398-L2431))

## Recommended Weave seam

The resize implementation should be controlled by a serializable layout value now, even though no `localStorage` adapter is added yet. The current desktop arrangement can be one top-level `row` containing the visible Thread list, Thread Pane, Editor Pane, and Project Pane in display order. Mobile can continue using its existing replacement/sheet behavior and should not render resize handles.

Use a shape compatible with the existing Workspace Composition vocabulary, while keeping this Alpha-only, per-Thread client preference separate from the server-authoritative Workspace Composition:

```ts
type AlphaPaneKind = 'thread-list' | 'thread' | 'editor' | 'project';

type AlphaLayoutNode =
  | { kind: 'pane'; layoutId: string; paneId: string }
  | {
      kind: 'row' | 'column';
      layoutId: string;
      children: AlphaLayoutNode[];
      ratios: number[];
    };

type AlphaThreadLayoutState = {
  schemaVersion: 1;
  threadId: string;
  root: AlphaLayoutNode;
  panes: Record<string, {
    kind: AlphaPaneKind;
    visible: boolean;
    rememberedRatio?: number;
  }>;
};
```

The implementation does not need to expose that exact public type, but it should preserve these boundaries:

1. Stable `layoutId`/`paneId` values identify state; array indexes are only render positions.
2. Ratios, not measured pixels, are the source of truth. Normalize and validate them at the state boundary.
3. Drag state is transient: active divider, pointer id, starting coordinate, container pixels, and starting ratios do not belong in the snapshot.
4. Hidden panes are absent from the rendered row and have no adjacent divider, but retain a remembered ratio for reopening. This matters for the Project Pane and for an Editor Pane whose last tab closes.
5. Switching Threads should eventually select a state object by `threadId`; a later adapter can parse/write the versioned record in `localStorage` without changing the resize component.
6. Keep this local presentation snapshot distinct from `WorkspaceCompositionLayout`. The structures deliberately rhyme, so promotion to the shared composition model can be an explicit migration rather than a rewrite.
7. The separator should have web-native accessibility semantics (`role="separator"`, `aria-orientation="vertical"`) and keyboard resizing. This is a Weave requirement, not behavior evidenced in the inspected Zed mouse implementation.

## Focused acceptance cases

- Drag each of the three possible seams in a four-pane row in both directions.
- Verify the pane on each side changes immediately and total width remains constant.
- Push an immediate neighbor to minimum and verify further delta is ignored without changing any farther sibling.
- Resize the viewport below the sum of preferred widths; no negative/NaN ratios, lost panes, or horizontal page scroll may result.
- Hide and restore the Project Pane; it must have no divider while absent and should reopen at its remembered proportion.
- Close the last Editor tab and reopen a file; the Editor Pane should behave the same way.
- Double-click a seam and equalize only that row's siblings.
- Complete and cancel a pointer drag outside the handle; cursor and drag state must always clear.
- Switch between two Threads in memory and prove their controlled layout objects remain independent, without writing `localStorage` yet.
- Round-trip a layout object through JSON in a unit test and reject/reset invalid ratio count, non-positive ratios, unknown schema versions, and duplicate identities.

The design should reproduce Zed's interaction principles, not copy its GPL implementation text.
