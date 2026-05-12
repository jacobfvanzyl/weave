# Mage Portal

Tiny Deno daemon for validating Portal lifecycle.

## Commands

```bash
# server must already be running
WEAVE_AUTH_TOKEN=test-token deno task --config portal/deno.json login --server http://localhost:4111 --ws-server ws://localhost:4112 --name "My Laptop"

deno task --config portal/deno.json mount --plane plane_x --path /path/to/repo

deno task --config portal/deno.json daemon

deno task --config portal/deno.json status
```

Config is stored at:

```text
~/.mage-hand/portal.json
```

## Lifecycle

1. `login` calls `POST /portals/token` using normal app auth.
2. `daemon` connects to `ws://.../portals/connect?portalId=...&token=...`.
3. Server sends `portal.accepted`.
4. Portal sends `portal.hello` with mounts and capabilities.
5. Server sends `portal.hello.ack`.
6. Portal sends `portal.pong` heartbeat every 15s.
7. Server `GET /portals` shows online Portal while socket stays open.

## Implemented tools

- `read`: reads text files under a mounted Plane path with path-jail validation.

Not implemented yet:

- `write`
- `edit`
- `bash`
