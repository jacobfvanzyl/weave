---
status: accepted
date: 2026-10-21
---

# Clients decide how to enrich a session above a text floor, and the TUI composes with its multiplexer

Weave's clients are meant to reach devices of very different capability: a computer, an iPad, a phone, and later glasses or a speaker. Sessions stay the core primitive and weave stays chat-first (ADR 0015). Every client must be able to carry on a session in text, written or spoken: follow what the agent says, prompt it, and answer pending requests, or leave one it can't answer, such as a URL elicitation, for another client. Everything richer is each client's choice, including whether and how to show views (ADR 0012): inline, in a split, in another window, or cast to a nearby screen. The Host doesn't describe devices, rank fidelities or tailor what it sends to a device. A client says in `host/hello` what it renders, as it already does for client tools, and skips the rest. Since no client has to show a view, what the agent is given must stand on its own as text, and the tools the Host answers or fronts make sure of it.

A client may show a view wherever the view's bridge and the client's Host connection go with it: its own windows and splits, screen mirroring or AirPlay. A view handed to a device that would run it outside a client, such as a television's own browser, runs there as a static page without the bridge, or that device becomes a client itself. Putting a view on a shared screen is the person's choice in that client.

The TUI shows one session per instance and builds no panes, splits or sidebar of sessions. Inside a multiplexer such as Rex or cmux, the multiplexer is that management: its sidebar and workspaces arrange TUIs attached to sessions, and a layout puts a pane back on its session with `weave --resume <id>`. The TUI treats the multiplexer as its environment. It speaks to it through generic terminal sequences (OSC 7 for its directory, OSC 7501 for whether the session is working or waiting on the person) and, where the multiplexer can open a browser pane, through its scriptable CLI, so views open in a split beside the TUI. It declares in `host/hello` only the views its environment lets it show. Anything specific to one multiplexer sits behind detecting that multiplexer, so the TUI works the same without it, and the Host protocol gains nothing for multiplexers. Rex therefore sits beside the Host, as one environment the TUI runs in, not beneath it.

## Considered options

- **Places.** Things the Host owns (Visuals, pinned views, terminals, web pages) that outlive sessions and appear on devices through placement records, each with a text form for low-fidelity devices. The Host would have to model devices and fidelities, and the design grew back towards Portal's Workspace Composition (ADRs 0004, 0006 and 0007 at `e30f6e93`). A dashboard on a fixed device is already a long-lived headless session that a trigger prompts, shown by whichever client chooses to.
- **Fidelity tiers in the Host.** Speakable, glanceable, text, declarative and interactive renditions of each event, with the Host choosing per client. Someone has to write the lower tiers, either the agent on every prompt or a model in the Host, which ADR 0011 keeps out. It would also fix in the protocol what each kind of device wants.
- **Rex beneath the Host**, with agent processes and the Host's terminals in Rex blocks. ACP is JSON-RPC over stdio, which a PTY driven through `rex send` and `rex capture` fits poorly. Rex's block types and server protocol are Superlogical's to change. Its unit, a terminal byte stream, can't be reduced for a voice or glanceable client.
- **A TUI with its own panes and session switcher.** Every multiplexer already has them, and the TUI would compete with the environment it runs in.

## Consequences

- Nothing a session's agent makes outlives the session. Deleting a session removes its Visuals along with its journal.
- What the text floor requires event by event is left open, beyond the rule that every journal event, every pending request and every later addition to the Host protocol has a text form a client can act on.
- ADR 0012's TUI, which shows a view's text and says a view exists, still holds outside a multiplexer. Inside one that opens browser panes, the TUI becomes a client that can show views.
- A view in a multiplexer's browser pane needs a page of weave's there that runs the bridge, and a way back to the Host. Either it relays through the TUI, so the pane stays part of the TUI's client, or it connects as a client of its own. That page is never served from the Host's WebSocket origin. Which route is decided when it's built.
- The TUI emits neither OSC 7 nor OSC 7501 yet. OSC 7501 is what lets a multiplexer's sidebar show the sessions waiting on the person, as the app's "Needs you" list does.
- Reaching a client that isn't connected, such as a push for a pending request to a suspended iPhone app, belongs to the Host or a service beside it, and is decided when it's built.
- A device that can't be a client gets no concept of its own until weave has to render a view on one. Until then it is reached through an upstream server's tools (ADR 0013). The concept won't be called a Resource, a word MCP already uses.
