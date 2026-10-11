# Context Map

## Contexts

- [Weave product](./CONTEXT.md): Alpha, Portal and the shared Host protocol in `product/`; Workspaces, Panes and Threads on a Host computer.
- [weave](./tui/CONTEXT.md): the `weave` TUI in `tui/` and the Host it connects to; agents, sessions and turns.

## Relationships

- **Weave product ↔ weave**: independent. Neither uses the other's code, protocol or vocabulary (ADR 0008).
- **Host** means different things: in Weave product it is a computer, with a Host Daemon process; in weave it is the per-user process that runs agents.
