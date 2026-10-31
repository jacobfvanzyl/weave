---
status: accepted
date: 2026-10-31
---

# A peer Host may only do what the Host tools need, and Hosts pair both ways over SSH

ADR 0017 let a peer Host do what a paired device may, less administering the Host. A paired device is the person in front of the app: it browses the computer's files, runs terminals, makes and removes worktrees, opens threads and answers what they ask. A peer is another Host acting for its agents, and the Host tools are all it uses (WVE-109). So a Host now refuses a peer every method but those the Host tools and following a turn there need: its hello, `host/status`, listing agents and threads, reading a thread, `session/run` without attaching, attaching only as an observer, detaching, adding to a thread's queue, steering and cancelling a turn. The rest answer `forbidden` before any handler sees them. A peer's key is copyable where the Host has no Secure Enclave, as on Linux, and what a copied key could do is now what an agent could already ask through the Host tools, under the thread's own policy, not a shell on the computer.

T3 Code reached the same place for its linked environments (`docs/research/t3code-peer-environments.md`): a link gets its MCP tools only, never terminals, files or the client RPC.

Pairing a peer was two commands on two computers: `weave pair` on one, `weave peers add <url> <code>` on the other, and the same again for the other direction. ADR 0017 already manages another Host through its CLI over SSH, so `weave hosts add studio` now does both: it runs `weave pair --json` on studio over SSH, pairs with what that prints, and has studio pair back the same way unless `--one-way`. Each pairing still goes one way, and the URL and code still work where SSH doesn't. The command is `weave hosts`, as the Host tool is `list_hosts` and its argument `host`.

## Considered options

- **Device rights, less administration**, as ADR 0017 had it. A peer never needs terminals, files or worktrees, and every right it has is one a copied key has.
- **An access level chosen at pairing**, as T3 lets the person pick read-only up to full access for a link. The calling thread's policy already bounds what a thread started on a peer approves, and nothing yet asks for less; a level can come later as a narrowing of this set.
- **Finding peers through Tailscale**, by tag or MagicDNS. With pairing over SSH the person names the computer as SSH knows it, which is all discovery would save them typing. Rex, which lists its hosts by label and lets the tailnet decide who connects, needs no pairing at all; ADR 0017 keeps pairing so that being in the tailnet is never enough.
- **One direction by default.** The person's Hosts are all theirs, and wanting one's agents to reach another but not back is the exception.

## Consequences

- `peers.rs` still pairs as a device; the gate is on the serving side (`client::FOR_PEERS`), so a peer from before this change keeps its pairing and loses only what it never used.
- A new Host tool needs its method added to the peers' set before it works across Hosts.
- `weave pair --json` prints the URL and code and doesn't wait for a device, for `weave hosts add` to read over SSH.
