---
status: accepted
date: 2026-09-11
---

# Give the Terminal Service an independent process lifetime

The Host Daemon remains the access, Workspace, Thread and ACP authority, while a separate local Terminal Service owns PTYs and authoritative public libghostty-vt state. Bun's existing PTY primitive and a small Node-API binding avoid maintaining a PTY implementation or adopting another application language; the protected local service contract permits replacing the execution component independently if public Superlogical components become suitable.

Only the authority answers application queries. Native clients restore upstream binary snapshots, incrementally load history and encode shared human input; their viewport, selection and rendering remain local. We deliberately break the old terminal protocol and remove the tmux runtime, with explicit maintenance for old sessions and incompatible owner updates. Client and Host Daemon restart survival does not imply PTY-owner crash or Host reboot recovery.
