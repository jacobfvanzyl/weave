---
status: accepted
date: 2026-11-07
---

# The Dispatcher is the hub: Hosts dial out to it, and the person's devices reach every Host through it

Under ADRs 0010, 0016 and 0027, every Host listens for remote connections behind a Tailscale Serve entry of its own, each of the person's devices pairs with each Host, and the Dispatcher dials each Host and pairs with it as a service. Since ADR 0029, Hosts don't know each other and reach one another only through the Dispatcher. So the person's computers already form a hub around it, except for the ways in, and those cost the most to live with:

- **An address per Host.** Each Host needs one that others can reach. On homelab-1 that meant the person running `sudo tailscale serve` by hand, because another program's Serve entry forwards to a Unix socket. When that computer was renamed, its entry stayed under the old name and the iPad's pairing went dead with it.
- **Pairings that grow with devices times Hosts**, plus one per Host for the Dispatcher. `weave dispatcher connect` grew an offer to make the second pairing, because one direction wasn't enough.
- **Serve even behind NAT.** A Host in a container or behind NAT needs a Serve entry too.

The person wants to run the Dispatcher wherever they choose, and Hosts wherever they choose, with the Dispatcher the one place everything else goes through.

So the Dispatcher becomes the hub.

- **Hosts dial out to the Dispatcher.** A Host joins the Dispatcher once, with a one-time code as a device pairs. From then on it keeps one connection open to it, and dials again when it drops.
  - Only the connection's direction changes. Over it the Dispatcher is still a client of the Host with the `service` role (ADR 0027): it sends the same requests and follows threads with the same `sessions/watch`. Agents' calls to other Hosts still go to it as service tools (ADR 0029).
  - The Host proves a key of its own to the Dispatcher, and checks the Dispatcher's key against the one it learned when it joined.
  - A Host without a Dispatcher, or whose Dispatcher is away, works on as before for its own computer's clients, and keeps trying to reconnect.
- **The person's devices pair only with the Dispatcher** (WVE-176), and reach every Host through it.
  - When a device wants a Host, the Dispatcher asks that Host, over its connection, to open another connection for the device, and joins the two.
  - The Host serves what comes over that connection as an ordinary remote client of the Host protocol. Hello, attach, replay, pending requests and the journal stay the Host's, unchanged, and the Dispatcher passes the bytes through without reading the protocol.
  - The Host takes the Dispatcher's word for which device is connecting, and treats it as a paired device, but only on connections the Host opened to the Dispatcher itself.
- **Local clients keep the Host's socket.** The CLI, the TUI and Rex on a Host's own computer connect to it as they do now, with or without a Dispatcher.
- **Only the Dispatcher needs an address.** It stays in the tailnet (ADR 0010, ADR 0017), behind its own Serve entry (WVE-176), so the edge stays as ADR 0027 has it. A Host anywhere that can reach the Dispatcher, whether a laptop, the homelab or a container, needs Tailscale to get there. It needs no Serve entry, no listening port and no pairing per device.
- **Hosts stop taking remote connections of their own.** Once the app reaches Hosts through the Dispatcher, the Hosts' own remote access retires: their WebSocket, Serve entry and paired devices (ADR 0016), and `weave pair` and `weave devices` on a Host. A Host is still managed through its own CLI, over SSH (ADR 0017).
- **A thread stays on its Host for its whole life.** Its agent's own history, its directory and its journal are on that computer, and moving them would mean copying each agent's private files. Clients reach any thread through the Dispatcher, by its Host and id.
- **A Bot is a named succession of threads** (ADR 0028): a Dispatcher record that points at its current thread.
  - A Bot moves to another Host by starting a new thread there, after its home is cloned there. The old thread names the new one as its successor.
  - The Dispatcher chooses the Host each time it starts a Bot's thread, and when the Bot's Host is gone.
  - A Bot's threads open through the Bot, not from the Hosts' thread lists, as ADR 0028 has it.

## Considered options

- **Keep the ways in as they are**, every Host listening and every device paired with each. ADR 0028 and ADR 0029 chose this to keep conversations off the Dispatcher. It costs an address per Host, and pairings that grow with devices times Hosts.
- **Hosts listening as a fallback**, for when the Dispatcher is away. It keeps every Serve entry and every pairing this removes, for a case the person can make rare by running the Dispatcher on their most reliable computer.
- **A Dispatcher that reads what it relays**: it routes Host-protocol messages, so several devices share one connection to a Host. ADR 0028 rejected relaying because this kind rebuilds attaching and replay in the Dispatcher. Passing a connection through keeps them in the Host.
- **Encrypting between device and Host now**, so the Dispatcher can't read what it passes on. That matters once a Dispatcher runs outside the tailnet, which nothing needs yet. Passing bytes through leaves room for it.
- **Putting a Host in the Dispatcher**, or a coordinating Host (ADR 0017). Agents need the computer their work is on, and the Dispatcher runs no agents.

## Consequences

- **While the Dispatcher is away, the person's devices reach no Host**, though each Host's own computer still does. ADR 0017 rejected a coordinating Host as one more thing that must stay up. This accepts that cost for the Dispatcher, which should run on a computer that stays up.
- **The Dispatcher holds the keys to every Host.** It can do there whatever a paired device can, and sees everything it passes on. In the person's tailnet that is one of their own computers.
- **A Host keeps a secret again**: its key for the Dispatcher, in the Secure Enclave where it can. ADR 0029 had removed the key it kept for peers.
- **One more hop between a device and a thread.** It adds little inside the tailnet and more to a Dispatcher far away, and a terminal feels it before a conversation does.
- **What carries over.** The Dispatcher's API for devices (WVE-176) stays. `weave hosts add` makes a Host join the Dispatcher instead of pairing the Dispatcher with it, so Hosts already paired that way join again. The app pairs once, with the Dispatcher, and opens each Host through it.
- **Amended ADRs:**
  - ADR 0010 and ADR 0017: only the Dispatcher listens in the tailnet.
  - ADR 0016: Hosts make no Serve entry, and the Dispatcher keeps its own.
  - ADR 0027: Hosts connect to the Dispatcher, and it carries devices' connections to them.
  - ADR 0028: a Bot's thread is reached through the Dispatcher, and a Bot moves by starting a new thread.
  - ADR 0029: clients reach every Host through the Dispatcher.
