---
status: accepted
date: 2026-09-13
---

# Put Agent, Terminal and Browser Panes in one Workspace composition

An Agent Pane presents exactly one Thread. A Workspace can contain several Agent Panes alongside Terminal and Browser Panes, all using the same split tree, top rail and focus border. Each client selects one Workspace and one Pane within it. Selecting a different Workspace replaces the entire visible arrangement; there is no separately selected global agent dock. Phone clients display their focused Pane without changing the shared split tree or requesting a software keyboard during navigation.

Thread membership remains authoritative and independent of its Execution Context, as established in ADR 0004. Creating a new Agent Pane opens a local draft with a theme peach Draft title chip. Only its first sent message creates a durable Thread and shared Pane. Empty drafts are discarded when another Pane is activated; typed drafts remain in the client session until sent or explicitly discarded. Multiple drafts may coexist. Composer settings and menus do not change Pane activation. Draft placement and text are never sent to the Host before Send. Moving a Thread moves its Pane and preserves its conversation and execution permissions. Closing its Pane archives the Thread; stopping active work requires confirmation and occurs within the Host lifecycle operation before removal. Another client changing the layout cannot bypass content closure by deleting an Agent Pane from a composition replacement.

Composition schema 3 adds Agent and Browser leaves. The Host migrates schema 2 while preserving Workspace, terminal and existing layout identities, then inserts existing active Threads into their assigned Workspaces. Reconciliation is idempotent and retains Agent Pane identities across moves. Protocol 8 requires matching clients and Hosts. It enables managed Browser Pane creation and browser-aware shared closure; earlier clients do not display browser close consequences and must not edit these compositions.

ACP connections and action routing are per Thread. A Pane retains its own transcript, permission requests, configuration and draft text while another Pane receives focus. Browser Profile grants remain a separate Host authority and are not expanded by Workspace or Agent Pane placement.

Fully trusted human Alpha pairings can use all current and future Browser Profiles on their Host. Agents and restricted credentials need explicit Profile grants. Human pairing authority must not be inherited by an ACP credential; Workspace and Agent Pane placement do not expand those grants.
