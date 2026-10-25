---
status: accepted
date: 2026-10-21
---

# Everything reaches a Host through the tailnet, Hosts pair as peers, and each is managed through its own CLI

ADR 0010 let remote clients in through the tailnet only. That rule now covers every connection to a Host: clients, the person's other Hosts, and services such as a bridge to a chat service or a program in the cloud, which joins the tailnet as a node of its own. The Host still listens on loopback behind its Serve entry (ADR 0016), and every connection still proves a key the Host paired with. Tailscale decides who can reach a Host; pairing decides who is connecting. Being in the tailnet, or carrying a tag there, is never enough on its own.

A client may be connected to several Hosts, and Hosts are peers: none coordinates the others. A Host pairs with another of the person's Hosts as a peer Host, the way a device pairs, and connects to it as a remote client over the Host protocol. It offers that connection to its agents through Host tools that name the peer (WVE-106). Hosts never speak MCP to each other. The Host a thread runs on stays its only authority: it runs the agent, keeps the journal, applies the permission policy, and holds the pending requests its own clients answer. A thread started for a peer's agent approves nothing that agent's own thread wouldn't. Reach is one hop: a Host's agents see its peers, not their peers.

Each Host is managed through its own CLI. From another computer, the person runs that CLI over SSH on the tailnet: Tailscale SSH where the Host's computer runs the open-source `tailscaled`, the only macOS variant that can be a Tailscale SSH server, and otherwise the system's SSH server at its tailnet name. The Host protocol gains no way to administer a Host remotely and no way to run a command, for remote clients and peer Hosts alike.

## Considered options

- **Tailscale Funnel or a relay for callers outside the tailnet.** Either puts a way in on the internet, which the tailnet rule exists to avoid. Senders that can only reach a public URL, such as GitHub's webhooks, wait for a decision of their own (WVE-98).
- **Trusting tailnet identity alone**, the node, its tags or Serve's identity headers, in place of pairing. It is coarser than a key per device or Host, and Serve's connections all arrive from loopback, so the Host would have to ask Tailscale about every one.
- **Hosts speaking MCP to each other**, each offering its Host MCP server to peers. The Host MCP server is for a Host's own agents; the Host protocol already carries threads, journals and pending requests between computers, with replay after a drop.
- **A coordinating Host** that knows every Host and routes between them. One more thing that must stay up, for a person with a few computers whose clients already keep a connection to each Host.
- **Reaching through peers**, a Host's agents seeing its peers' peers. Who could act on a Host would then depend on pairings made on other Hosts.
- **Remote administration through the Host protocol**, or a request that runs the CLI for a caller. SSH already proves who the person is and gives them the computer; a second, narrower way in would be one more thing to secure.

## Consequences

- A Host keeps a secret for the first time: the private key it proves itself to peers with. It is a Secure Enclave key where the Host can use one, so it can't be copied off the computer. ADR 0010's "the Host keeps no secrets" now means it keeps no one else's.
- A peer Host can do what a paired device can, less administering the Host, and is revoked the same way. Pairing a peer turns remote access on as pairing a device does (ADR 0016).
- A service pairs and connects as a remote client like any other. A bridge to a chat service runs on a node in the tailnet and dials the service itself, as Slack's Socket Mode allows. Whether a service gets less than a paired device is decided with the first one.
- Remote management needs an SSH server on the Host's computer. With the Mac App Store or standalone Tailscale app that is macOS Remote Login, which the person turns on; weave doesn't.
- Every CLI command that reports something has to work over SSH without a terminal, and give its answer as JSON when asked.
