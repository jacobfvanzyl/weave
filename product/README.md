# Weave Product

This directory is the self-contained Weave product stack:

- `alpha/` is the Capacitor and React client.
- `portal/` is the directly connected host daemon.
- `protocol/` is their only shared wire-contract module.

The product must build and run without importing the repository's earlier applications or shared packages. Run `bun run check:boundary` from this directory to enforce that rule mechanically.

## Development

```bash
bun install --frozen-lockfile
bun run check
```

Portal remains a Deno executable and is checked from its own directory. Alpha and the protocol use the product-local Bun workspace.

### Alpha UI mocks

Alpha's product shell consumes a UI controller rather than Portal directly. During
development, append one of these scenarios to the Alpha URL to render the same
components without a running host:

```text
?mock=disconnected
?mock=connecting
?mock=empty
?mock=sidebar
?mock=busy
?mock=error
```

Mock mode is disabled in production builds. Actions such as search, Thread
selection, Thread creation, connection, and disconnection remain interactive in
the mocked shell.

## Module seams

- Alpha depends on `@weave/product-protocol` and browser or Capacitor primitives only.
- Portal depends on `@weave/product-protocol` and Deno primitives only.
- The protocol contains wire types, constants, and response validation. It contains no Portal or Alpha behavior.
- `scripts/check-boundary.ts` rejects imports that escape this directory and dependencies on the earlier Weave packages.

The current product supports authenticated Portal discovery, Workspace and Agent listing, durable Thread identity and ACP recovery, plus Workspace-scoped filesystem browsing, UTF-8 reads, full content hashes, conditional writes, directory and file mutations, bounded search, and connection-scoped change observation. Alpha exposes the filesystem through a read-only Workspace browser. Persistent user terminals remain a follow-on slice and will be introduced behind a new product interface rather than pulled in as a legacy dependency.

See `portal/README.md` for local configuration and direct acceptance.
