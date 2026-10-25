---
status: accepted
date: 2026-10-24
---

# Weave says thread where ACP says session

Weave called a conversation with an agent a session, ACP's word, and its glossary told people to avoid "thread". The tools people compare weave with call it a thread: Delta, Zed, Amp and Codex all do ([research](../research/agent-identity-and-where-agents-run.md)), and weave's own README had begun to. Weave's language is therefore thread (WVE-121): the glossary, the ADRs, and what a person reads in the CLI, the TUI and the app. A thread is identified by the id of its agent's ACP session, and "session" stays ACP's word for the agent's side of it, as in `session/new` and `session/load`.

The code and the wire keep "session" for now: type and function names, the Host protocol's `session/*` and `sessions/*` methods and `sessionId` fields, the error names, the Host tools (`rename_session` and the rest) and the journals on disk. Renaming them is a new major version of the Host protocol, so every client and paired device moves at once, plus a move of every journal, and is decided on its own if the mismatch starts costing more than that. Commands and settings people type say thread and still accept their session names.

## Consequences

- A reader of the code meets "session" for what the glossary calls a thread. The two are the same thing; ACP's own sessions are the ones in ACP's methods and payloads.
- ADRs 0008 to 0020 were reworded to the new term rather than superseded, since only the word changed.
