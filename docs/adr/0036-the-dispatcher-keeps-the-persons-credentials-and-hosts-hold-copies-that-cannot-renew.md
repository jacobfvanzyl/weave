---
status: accepted
date: 2026-11-22
---

# The Dispatcher keeps the person's credentials, and Hosts hold copies that cannot renew

Weave has never read or stored a credential: each Host's agents use sign-ins the person made by hand on that computer, and git uses whatever that computer has. That stops working once the Dispatcher makes a computer from nothing and a Host on it joins with nothing typed (WVE-238): nobody is there to sign in. It was already tedious across the person's own computers. The person wants their agent sign-ins and git credentials kept in one place, and every Host to get what it needs without being asked (WVE-239).

This reverses the rule, for the Dispatcher and the Host. The person settled each part on 2026-11-22, the parts marked so in discussion and the rest by accepting this ADR.

- **The Dispatcher keeps them** (settled). It is always on, every Host already proves its key to it on each connection, and it already holds the keys to every Host. The person uses no secrets manager, so none is built on; the store sits behind a small interface so one could be a second backend.
- **The store is encrypted, and its key is not on the Dispatcher's disk** (settled). The person supplies a passphrase when the Dispatcher starts, or the Mac supplies the key. Until then the Dispatcher runs as it does today and gives out no credentials. A stolen disk or backup gives up nothing.
- **Agents run on the person's subscriptions** (settled), never on API keys. The Dispatcher signs in by running the vendor's own program, with the person approving once in a browser, and keeps what that program wrote. Weave never performs a vendor's sign-in or token exchange itself.
- **The Dispatcher is the only holder that renews a sign-in.** A vendor's sign-in is a short-lived access token and a renewal token that changes each time it is used, so two holders renewing would cut each other off. The Dispatcher keeps the renewal token and renews by running the vendor's program.
- **A Host holds a copy that cannot renew.** It gets the sign-in with the renewal token taken out, which is all an agent needs for a turn. A copy that leaks is good for the life of its access token and no longer.
- **Hosts cache what they are given** (settled), encrypted with the Host's own key, so agents start while the Dispatcher is away. How long depends on the credential: a sign-in's copy lasts until its access token dies, and a git token for a week (settled).
- **Agent credentials go to every Host that joined** (settled, for now). **A git credential belongs to a Project** (settled) and goes to the Hosts the Project has a location on, for that Project's remote only. That keeps the person's personal and work logins apart with no rule about which Host is which.
- **Git asks through a credential helper.** The Host sets one for its agents' git, which asks the Host, so no token is written to a git configuration.
- **The person's own computers switch** (settled). The Mac and homelab use the same credentials as a machine made from nothing, and sign-ins made by hand stop being a second way.
- **Removing a credential** tells every connected Host to drop its copy at once. A Host that is away keeps its copy until the cache runs out, so a real compromise is still revoked at the vendor.
- **Nothing records one.** A credential is never written to a journal, a protocol trace, a log or the Dispatcher's deliveries, and the Host protocol carries it only in a message of its own that traces leave out.

## What was tested

On 2026-11-22, on homelab, in throwaway containers with Claude Code 2.1.330 and Codex CLI 0.171.0, each given a copy of homelab's own sign-in. The real sign-in files were never written.

| Case | Result |
| --- | --- |
| Claude Code, renewal token removed | A turn ran; the file was unchanged |
| Codex, renewal token removed | Refused: it no longer read the file as a ChatGPT sign-in |
| Codex, renewal token replaced by a placeholder | A turn ran; the file was unchanged |
| Claude Code, access token the server rejects, nothing to renew with | Failed in 4 seconds: "401 OAuth access token is invalid" |
| Codex, access token the server rejects, placeholder to renew with | Failed in 6 seconds: "Your access token could not be refreshed" |
| Claude Code, access token marked expired in the file but still valid | A turn ran: only the server's answer counts |

Lives seen: Claude's access token is issued for about 8 hours, and Codex's for about 10 days. That is how long a Host can run each agent with the Dispatcher away.

## Considered options

- **Sign in on each Host**, as now, through a terminal there. It keeps the old rule and needs the person once per machine, which a machine made from nothing can't have.
- **A long-lived token for Claude** (`claude setup-token`, good for a year, for one purpose). It is the vendor's documented way for places with no browser and would let a Host run for a week without the Dispatcher. The person prefers the short-lived sign-in, which leaks less and works the same way for both agents. Eight hours without the Dispatcher is acceptable for now (settled), and this stays the fallback if it proves too short. It wasn't tested, and several reports say such tokens have been refused.
- **Copies of the whole sign-in on every Host.** The first Host to renew would cut the others off, and OpenAI's own guidance is one machine per copy.
- **The Dispatcher in the path of every model request**, adding the credential as it passes. No token would leave it and removal would be instant, but every turn would go through homelab, a Dispatcher outage would stop every agent, and thread content would pass through a program built not to see it (ADR 0027).
- **Weave doing the sign-in or the renewal itself.** Anthropic's terms don't let a third party offer Claude.ai sign-in in its own application, and it would break whenever a vendor changed its flow.
- **The provider's secret store** (Fly's). Nothing to build for machines there, and no help for the Mac or homelab.

## Consequences

- **Amends ADR 0011**, whose Hosts ran agents "on the person's own login" made on each computer, and the workspace's rule that weave never reads or stores credentials. It still never asks a vendor for one on its own behalf, and still runs only the vendors' unmodified programs.
- **Amends ADR 0027.** The Dispatcher still runs no agents and stores no conversations. It now keeps the person's credentials, which makes it the most valuable thing the person runs, and a restart of it needs the person.
- **Hosts depend on the Dispatcher more.** Without it, Claude stops after about eight hours and Codex after about ten days. Hosts otherwise work on without it, as before.
- **Two kinds of credential, one path.** One that doesn't change (a git token, later perhaps an API key for something else) and a sign-in the Dispatcher renews. Hosts treat both as something given, cached and dropped.
- **The launch of a machine moves into the Dispatcher** (WVE-238 ran it in the CLI), since the provider's token and the Tailscale client are credentials too and belong in the same store.
- **Fits ADR 0035.** One person's credentials, on one person's Hosts.

## Still to find out

- **How the Dispatcher makes each vendor's program renew when asked.** Neither has a command for it. Claude Code renews through ordinary use near expiry, which homelab's own file shows. Codex did not renew on an ordinary turn with eight days gone and two left, so what makes it renew isn't known.
- **What a turn in progress does when its access token dies**, and what the Host tells the person.
- **Whether several Hosts on one access token at once draws a limit** from either vendor. Neither states one.
- **Whether the vendors' terms mind.** The person's own subscription, on the person's own machines, in the vendors' unmodified programs, is the reading taken here; neither vendor's terms were read in full.
