# holder

`weave-holder` (ADR 0022) is the process that keeps one terminal alive for the weave Host. It
holds the terminal's PTY, its shell and the authoritative screen in libghostty-vt, and it speaks
the holder protocol (`../docs/specs/wve-85-host-protocol.md`, "Holders"). Read the root
`AGENTS.md` first. The crate is built under WVE-151, and grew from the spike in WVE-149.

## libghostty-vt

`ghostty.toml` pins the Ghostty commit and the Zig that builds it. The app's terminals (WVE-153)
build their xcframework from the same pin, since the holder and the app decode each other's
snapshots.

`build.rs` links `libghostty-vt.a` statically from the first of:

1. `$GHOSTTY_VT_PREFIX`, a prefix that already holds a build;
2. the cache: `$WEAVE_GHOSTTY_CACHE`, else `$XDG_CACHE_HOME/weave/ghostty`, else
   `~/.cache/weave/ghostty`;
3. a build into the cache, which needs Ghostty's source and Zig:
   - the source comes from `$GHOSTTY_SRC`, or from `git fetch --depth 1` of the pinned commit;
   - Zig comes from `$ZIG`, or a `zig` of the pinned version on PATH, or a download from
     ziglang.org checked against the pin's sha256.

The cache keeps:

- one build per commit and target (about 15 MB), shared by every checkout and worktree;
- the Zig it downloaded (about 450 MB) and Zig's global cache.

Once a build is done, the cache drops the source and Zig's local cache. When the pin moves, it
removes other commits' builds and other Zigs. A first build takes about two minutes on an M3.

To move the pin:

1. Update `ghostty.toml`. If Ghostty's `minimum_zig_version` moved, update Zig's version and its
   checksums from ziglang.org's `index.json`.
2. Regenerate the bindings with `cargo build -p weave-holder --features bindgen`. This needs
   libclang: Xcode's on macOS, `libclang-dev` on Debian.
3. Review the diff of `src/ffi/bindings.rs`, and run the tests.

The codec names the commit (`weave-holder --version`), so a pin change is a codec change. Holders
already running keep theirs, and clients restore from them through the formatter's VT.

`src/ffi.rs` includes the committed bindings, generated with layout assertions, so a platform
whose C layout differs fails to compile rather than misbehaving. `src/vt.rs` is the only module
that calls them.

## Commands

The workspace's plain `cargo build` and `cargo test` leave the holder out until the Host starts
holders (WVE-152), so name it:

```bash
cargo test -p weave-holder
cargo clippy -p weave-holder --all-targets
cargo build -p weave-holder && ./target/debug/weave-holder --version   # prints the codec
```
