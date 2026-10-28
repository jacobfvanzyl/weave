---
status: accepted
date: 2026-10-28
---

# Agents act on any thread on their Host, and the Host's reports tell nobody back

ADR 0020 let an agent read any thread but prompt, steer and cancel only the threads it started, and theirs (WVE-106). That stopped a case worth having: a thread in a repository's main checkout asking the thread in one of its worktrees to address a pull request's review, so that it could draft a release including the pull request, when neither thread started the other. So any thread's agent now acts on any thread on its Host, through the same Host tools, and the `weave` CLI prompts, steers and reads threads beside listing, cancelling and closing them, so that scripts and agents compose threads as Rex's CLI composes its sessions and blocks (WVE-158). The thread whose agent began a turn hears how it ends, or that it waits on a person, whoever started the thread it ran in. That message is a report: its turn's origin names the thread it reports on and says it's a report, and a report's turn tells nobody how it ended, so two threads can't trade reports forever. Before this, only the reach rule kept them from it.

The rule ADR 0020 drew was weaker than it looked. An agent that can run shell commands without asking already reaches any thread with `weave run --resume`, and a thread's permission policy is only part of what it may do, since agents' own modes and settings approve tools without asking weave. We open it up and watch for trouble before designing a rule that measures what a thread may do.

## Considered options

- **Act on any thread whose policy is within the caller's.** This targets the risk ADR 0020 named, a thread approving more than its caller, rather than ancestry. It has to count the agent's own permission mode too, which only a per-agent convention can read, and it still misses what an agent's settings and "always allow" answers approve. It is the first thing to try if open reach causes trouble.
- **A person grants one thread reach to another**, as a permission request in the calling thread. A headless caller would wait for someone, and it is machinery to build before anything has gone wrong.
- **Keep ADR 0020's rule.** It blocks the case above.

## Consequences

- The `session` turn origin gains `report`, an addition, so protocol version 2 stays.
- `[delegation]` stays: `depth` limits only starting new threads, and `running` counts only a thread's own delegated threads.
- A thread can get turns from an agent its person didn't point at it. The turn's origin names the thread, which clients show; the thread's own policy still answers its permission requests, and no agent answers another thread's pending requests.
- Turns a client sends, the CLI's included, are a client's: no thread hears how they end, even when an agent ran the CLI.
