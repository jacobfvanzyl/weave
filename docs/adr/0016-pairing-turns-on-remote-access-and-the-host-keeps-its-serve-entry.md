---
status: accepted
date: 2026-10-21
---

# Pairing turns remote access on, and the Host keeps its own Serve entry

ADR 0010 made remote access something the person sets up: a `[remote]` section in the config, a Tailscale Serve entry made once by hand, and Weave never changing Tailscale's configuration. The app (ADR 0015) also needed its web view's origin listed in `[remote] origins`. That is configuration for something one command should do. So `weave pair` turns remote access on: when it asks for a pairing offer, the Host starts listening on loopback and makes its Serve entry, forwarding an HTTPS port of its own (7341) to that listener, and it keeps both while any device is paired, across restarts. Revoking the last device, or an offer expiring with none paired, turns both off again and removes the entry. The Host touches only the entry that forwards to its own port, refuses while Funnel would put it on the internet, and passes on Tailscale's link when Serve isn't enabled for the tailnet. It accepts the app's origin, `capacitor://localhost`, without configuration. `[remote]` stays only to change the port or URL, or to allow other origins. The rest of ADR 0010 holds: the tailnet is the only way in, the listener is loopback only, and every connection proves a device key.

## Considered options

- **Listening whenever the Host runs.** No step at all, but every Host would bind a port and make a Serve entry whether or not the person uses another device.
- **Keeping Serve hand-made, with `weave pair` printing the command.** What WVE-90 built; it leaves the step to the person and fails the first time they pair.
- **Tailscale's local API instead of its command.** It differs between the Mac app and `tailscaled`, while the `tailscale` command, which `weave pair` already read status with, works with both.
- **A native WebSocket in the app, which sends no `Origin`.** It would put every message through Capacitor's bridge. An origin no web page can send is no weaker a check.

## Consequences

- The Host changes the computer's Tailscale configuration: one Serve entry, on one HTTPS port, made and removed with remote access.
- A Host with paired devices doesn't exit when idle, so devices can reach it; `weave daemon install` keeps it running after a restart, as before.
- A Host that starts before Tailscale is ready listens anyway and tries the Serve entry again until it works.
- Pairing needs no config. A Host already using the port for something else, or whose tailnet has Serve or HTTPS off, says so when `weave pair` asks.
