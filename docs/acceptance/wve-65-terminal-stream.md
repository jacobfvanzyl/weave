# WVE-65 terminal output checkpoint

Live terminal output now goes directly from its authenticated attachment to a
single renderer-owned sink. React retains attachment metadata and layout state;
it no longer concatenates, truncates and replays a live transcript on each output
event. The inactive mock presentation can still supply static preview data.

The sink acknowledges each snapshot or live write. Delivery stays ordered while
the renderer consumes output. Pending data, including an in-flight write, is
bounded to 2 MiB and 1,024 queued frames. Overflow or a current renderer failure
invalidates the incomplete stream and requests a fresh Host snapshot. Replacing
a renderer also requires a snapshot once it has consumed any output; a retained
tail is insufficient to reconstruct terminal emulation. Late failures from a
detached renderer cannot invalidate its replacement.

The xterm adapter uses this path today and suppresses protocol replies while
applying a snapshot. The native libghostty adapter is still outstanding; this
checkpoint establishes its delivery boundary without claiming native rendering.

Validation:

- `bun run check` passed with 186 Alpha tests, 73 Host tests, 24 protocol tests,
  2 boundary tests and all existing builds/typechecks. An additional focused
  overflow/reattachment scenario then passed with the complete 187-test Alpha
  suite.
- Stream tests cover fragmented escape/Unicode data, acknowledgement ordering,
  pending-byte limits, renderer failure, replacement and stale completion fencing.
- Controller tests show output reaching the sink without a React rerender and
  overflow reattaching the same terminal without creation or termination.
- Renderer tests cover live writes without prop updates and input suppression
  during snapshot replay. The multi-Host rendered shell uses this stream too.
- Packaged Electron pairing and relaunch passed at
  `/tmp/weave-desktop-VGc8qd`, including permission handoff between conversations,
  terminal paste/copy, Neovim typing and resizing.
- The current signed iPad build succeeded. Physical execution is pending because
  Xcode reports the connected iPad is locked; this is not a device acceptance pass.

WVE-65 remains In Progress. Native libghostty view/input adapters, remaining
workspace presentation refinements and complete native acceptance are still due.
