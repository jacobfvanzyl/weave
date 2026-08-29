# Alpha Browser acceptance fixture

This maintained HTTP surface is the deterministic external website for Apple Browser acceptance.
It is independent of Portal, agent control, and public internet availability.

From `product/`, run:

```bash
bun run acceptance:browser:fixture:test
bun run acceptance:browser:fixture
```

The server listens on `0.0.0.0:5175`. Override the bind address or port with
`BROWSER_ACCEPTANCE_FIXTURE_HOST` and `BROWSER_ACCEPTANCE_FIXTURE_PORT`. macOS acceptance binds an
ephemeral loopback port. The physical-iPad runner binds an ephemeral local-network port and needs
the Mac's reachable IP through `--fixture-host`; Alpha's existing local-network transport policy
allows that fixture without adding a test-only App Transport Security exception.

The fixture exposes navigation/history, redirect, slow and failing responses, popup and frame
policy, upload and attachment responses, permission controls, ephemeral cookies, and stable targets
for the bounded native snapshot/type/key/click/wait/scroll feasibility probe.
