---
status: accepted
date: 2026-10-16
---

# Remote clients reach the Host only through the tailnet and prove a device key on every connection

Clients on the person's other devices, the iPad and iPhone first, need to reach the weave Host (WVE-90). The Host listens on loopback only, and Tailscale Serve, never Funnel, is the only way in: a device must be in the tailnet of the Host's computer, and Serve terminates TLS with the tailnet's certificate. Weave never changes Tailscale's configuration. Because Serve's connections and local processes both arrive from loopback, where a connection comes from counts for nothing. Every WebSocket connection proves a paired device by signing a Host challenge with a P-256 key that never leaves the device, in the Secure Enclave on Apple devices, and the Host stores only public keys. A paired device can then do what a local client can, except administer the Host.

## Considered options

- **Binding the Host to its tailnet address.** It is just as tailnet-only, but brings no trusted TLS, so iOS needs App Transport Security exceptions for plain `ws://`. A non-loopback listener also brings macOS firewall prompts for a binary that's rebuilt often, and the address may not exist yet when the Host starts.
- **TLS in the Host**, with its own pinned certificate or `tailscale cert` files as Portal used. That puts certificate renewal and private keys in the Host, and pinning needs the client's WebSocket to be native rather than a WebView's.
- **Bearer device tokens**, the `token` method WVE-85 reserved. Simpler, but whoever copies a token is that device until it's revoked. A Secure Enclave key can't be copied, and the Host keeps no secrets.
- **Directory allowlists or per-device grants**, as Portal had. An agent's shell isn't confined to its thread's directory, so they would limit what a device opens, not what it can do. Revoking the device is the control.

## Consequences

- Remote access needs Tailscale on both devices and a Serve entry the person makes once.
- Other accounts on the Host's computer can reach the loopback port, so `host/hello` is the boundary there, not the file mode that guards the Unix socket.
- Signing agents in and out stays on the Host's computer.
- Networks without Tailscale wait for TLS in the Host.
