# Zed dock rail and Terminal placement

_Research snapshot: 2026-08-28. Primary Zed documentation and source only._

## Conclusion

Alpha should model Bottom and Right as independent docks, not as a boolean "terminal pane" bolted onto the existing row. One Terminal panel owns all terminal tabs and has a persisted `bottom | right` position. Its ordinary rail-button click toggles or activates that panel; secondary click opens a checked placement menu. The menu should expose only **Dock Bottom** and **Dock Right** for WVE-43.

The bottom rail should render the Bottom group before the Right group. Terminal has a lower explicit ordering value than Project, so it remains immediately before Project whether the two icons are in different groups or both are in Right. When both groups contain an icon, render one short vertical separator between the groups. An icon is mauve only when its panel is both the active panel of its dock and that dock is open.

This follows the interaction and state boundaries in Zed at [`8ee36b6`](https://github.com/zed-industries/zed/tree/8ee36b682cf1971e51032cbd932dd16def575364), the canonical `main` head inspected on 2026-08-28. The commit was authored at `2026-08-28T12:15:55Z`.

## What Zed actually models

Zed distinguishes the center's editor `Pane`s from edge `Panel`s. A `Dock` is an independently openable container for one or more panels, and as many as three docks can be open together: Left, Right, and Bottom. The first-party glossary illustrates a different panel in each dock. ([official glossary](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/docs/src/development/glossary.md#L82-L87))

At source level:

- `DockPosition` is the closed set `Left | Bottom | Right`. Left and Right consume horizontal space; Bottom consumes vertical space. ([position and axis](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L323-L374))
- Every panel owns a stable key, current position, valid-position predicate, position setter, icon, toggle action, and ordering priority. The dock owns an ordered panel list, `is_open`, and one `active_panel_index`. ([panel contract](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L36-L101), [dock state](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L281-L295))
- Saved workspace state is independent per dock: each of Left, Right, and Bottom stores `visible`, `active_panel`, and `zoom`. This permits Bottom and Right to remain open at the same time. ([saved shape](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/persistence/model.rs#L153-L208), [capture and restore](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/workspace.rs#L2308-L2368))
- Zed's workspace renderer composes Left and Right around a center column, then places Bottom according to a configurable full/left-aligned/right-aligned/contained layout. The contained form keeps Right full-height while Bottom sits under the center, which is the closest match to the supplied Alpha reference. ([dock composition variants](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/workspace.rs#L9467-L9702))

Only one panel is active and visible inside a given dock. Multiple panel icons may belong to that dock, but clicking another icon switches its active panel rather than opening a second adjacent panel. Multiple docks, by contrast, may remain visible simultaneously. Zed's regression test opens Left and Right together, moves the visible Left panel into Bottom, and later restores Bottom and Right together. ([multi-dock test](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/workspace.rs#L14405-L14533))

## Moving a panel from its rail icon

Zed's current rail interaction has two paths:

1. Primary click toggles the panel. If the icon represents the open dock's active panel, the action closes that dock. Otherwise it dispatches the panel's toggle action and focuses it. The selected state is exactly `dock.is_open && dock.active_panel_index == this_panel`. ([active and click behavior](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L1390-L1436), [button rendering](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L1533-L1552))
2. Secondary click opens a context menu on that same icon. It lists checked **Dock Left**, **Dock Right**, and **Dock Bottom** entries, filtered through the panel's valid-position predicate. Selecting a different entry calls the panel's position setter. ([placement menu](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L1441-L1470))

The current first-party Parallel Agents guide explicitly tells users to rearrange an individual panel by right-clicking its icon. ([official guide](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/docs/src/ai/parallel-agents.md#L8-L12)) An older migration page says panels can be moved "by dragging or through settings," but the current `PanelButtons` implementation has no drag handler: its rail trigger has click and right-click-menu behavior only. ([migration wording](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/docs/src/migrate/webstorm.md#L242-L252), [current rail implementation](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L1390-L1564)) WVE-43 should therefore implement the evidenced rail menu, not icon drag-and-drop.

Zed's Terminal accepts all three positions and writes the selection to Terminal settings. Its default width and height are distinct because a side-to-bottom move crosses axes. ([Terminal panel placement](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/terminal_view/src/terminal_panel.rs#L1677-L1715)) WVE-43 deliberately narrows this to Bottom and Right.

When a position changes, Zed removes the panel from its source dock and inserts it into the destination. If the panel was visible, the destination opens and activates it. If the panel was hidden, its icon moves without opening or replacing the destination's active panel. Same-axis size state follows the panel; cross-axis size state resets to the destination default; workspace state is then serialized. ([move transition](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L642-L704))

## Rail ordering, active color, and group divider

Zed creates three separate panel-button groups. Left is registered on the status bar's left side; Right and then Bottom are registered on its right side. Right-side status items are rendered in reverse registration order, so the visible group order is Bottom followed by Right. ([group registration](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/workspace.rs#L1832-L1848), [right-side rendering](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/status_bar.rs#L208-L229))

Within a dock, panels are sorted by ascending unique `activation_priority`; the Right group reverses that list so icons still read inward from the right edge in the intended order. ([deterministic insertion](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L785-L825), [Right reversal](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L1566-L1583)) Project uses priority `1` and Terminal uses priority `2`; after the Right reversal, Terminal appears immediately before Project. ([Project priority](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/project_panel/src/project_panel.rs#L7831-L7868), [Terminal priority](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/terminal_view/src/terminal_panel.rs#L1781-L1813))

The active predicate is passed to `IconButton::toggle_state`. A selected icon defaults to semantic `Color::Selected`, which resolves to the theme's accent text color. ([selected icon](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/ui/src/components/button/icon_button.rs#L232-L254), [selected color](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/ui/src/styles/color.rs#L88-L109)) In Alpha, the direct equivalent is `text-primary`, backed by `--zed-accent: #cba6f7`; no new literal color is needed. ([Alpha theme](../../product/alpha/src/styles.css#L73-L116))

Zed prepends a border-colored vertical divider to every nonempty Bottom or Right group and appends one to Left. The shared divider primitive is one pixel wide and `h_4` (16 px), which produces the short, nearly rail-height separator in Zed's status bar. ([group dividers](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/workspace/src/dock.rs#L1570-L1583), [divider geometry](https://github.com/zed-industries/zed/blob/8ee36b682cf1971e51032cbd932dd16def575364/crates/ui/src/components/divider.rs#L137-L150)) Zed does **not** condition that divider on another dock group being populated. The requested Alpha rule is narrower and should render exactly one divider only when both Bottom and Right have icons.

## Concrete WVE-43 design for Alpha

The current Alpha layout stores only Threads/Project visibility and one horizontal row of Threads, Thread, Editor, and Project panes. The Project toggle is a standalone ghost button without selected state. ([current snapshot](../../product/alpha/src/app/alpha-pane-layout.ts#L4-L18), [visibility model](../../product/alpha/src/app/alpha-pane-layout.ts#L43-L83), [Project toggle](../../product/alpha/src/components/project-pane-toggle.tsx#L6-L34)) Supporting a movable Terminal cleanly requires a small dock layer above that pane-row model.

Use this conceptual state boundary; exact names may follow the implementation:

```ts
type AlphaDockPosition = 'bottom' | 'right';
type AlphaDockPanelId = 'terminal' | 'project';

type AlphaDockSnapshot = {
  schemaVersion: 1;
  panelPosition: {
    terminal: AlphaDockPosition;
    project: 'right';
  };
  docks: {
    bottom: { open: boolean; activePanelId: 'terminal' | null };
    right: { open: boolean; activePanelId: AlphaDockPanelId | null };
  };
  rememberedSize: {
    bottomHeight?: number;
    rightWidth?: number;
  };
};
```

The Terminal panel identity and its tabs/process attachments must survive every UI-only move. `dockPosition` determines presentation only; it must not create, close, detach, reattach, or resize a Portal terminal by itself.

Render the desktop shell as:

```text
workspace
├─ center stack
│  ├─ existing Threads / Thread / Editor row
│  └─ Bottom dock (Terminal when positioned here and open)
└─ Right dock (active Terminal or Project panel)
bottom rail: [Bottom icons] | [Right icons]
```

This matches Zed's contained bottom-dock geometry while preserving Alpha's current right-side Project placement. It also makes the required simultaneous case unambiguous: Terminal can be open in Bottom while Project is open in Right. If Terminal is moved to Right, Terminal and Project share that dock and only its active one is visible.

The rail contract should be:

1. Bottom group precedes Right group.
2. Terminal has order `1`; Project has order `2`. Therefore Terminal is immediately before Project when both are in Right, and it is the last Bottom icon immediately before the inter-group separator when split across docks.
3. `aria-pressed` and `text-primary` are derived independently per button from `dock.open && dock.activePanelId === panelId`. Merely belonging to a dock is not active. Both icons may be mauve at once only when Terminal is active in Bottom and Project is active in Right.
4. Ordinary Terminal click closes Bottom/Right if Terminal is already that open dock's active panel; otherwise it opens the Terminal's current dock and makes Terminal active.
5. Secondary click on the Terminal icon opens a checked menu with **Dock Bottom** and **Dock Right**. Provide the same menu through keyboard context-menu activation and a reliable long-press or explicit touch affordance on iPad; hover/right-click alone is insufficient for Alpha's mobile shell.
6. Moving an open Terminal closes its now-empty source dock, opens the destination, and activates Terminal there. Moving a hidden Terminal moves only the icon and does not replace an open Project panel. Remember Bottom height and Right width separately so each orientation returns to its last usable size.
7. Insert one `Separator` with `orientation="vertical"`, `w-px`, and approximately 16–24 px height between groups only when `bottomButtons.length > 0 && rightButtons.length > 0`. Do not render one separator per group; the requirement is one boundary between populated groups.
8. Hiding a dock is a view operation. Closing a terminal tab remains the explicit operation that can end that terminal's lifecycle.

On mobile, do not compress the center, Bottom, and Right docks into a desktop grid. Preserve the same position and active/open state but present the selected dock surface as the existing sheet/replacement pattern. Dock placement remains meaningful because it controls where the Terminal returns on desktop and how its rail icon is grouped.

## Focused acceptance cases

- With Terminal in Bottom and Project in Right, verify both panes can be open simultaneously, both active icons are mauve, Terminal precedes Project, and exactly one 1 px vertical separator appears between their icon groups.
- Left-click the active Terminal icon and verify Bottom hides without closing terminal tabs or Portal attachments; click again and verify it restores at the remembered height.
- Right-click the Terminal icon, choose **Dock Right**, and verify the open Terminal transfers into Right, Bottom closes when empty, Terminal becomes the active Right panel, and the Project icon remains present but is no longer mauve.
- Move a hidden Terminal from Bottom to Right while Project is open. Verify only the icon moves: Right remains open on Project and Project remains mauve until Terminal is clicked.
- With Terminal and Project both in Right, verify Terminal is immediately before Project, no inter-dock divider is present, and clicking either icon switches the one visible Right panel.
- Move Terminal back to Bottom and verify its prior Bottom height returns while Right restores its prior width.
- Exercise the placement menu with mouse, keyboard, and iPad touch; checked state, focus return, and accessible names must remain correct.
- Switch Threads and Hosts while both docks are open. Dock presentation may follow the chosen Alpha preference scope, but terminal tab identity and Host ownership must not change.

The design should reproduce Zed's state and interaction principles without copying GPL implementation text.
