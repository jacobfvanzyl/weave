---
status: accepted
date: 2026-10-22
---

# The Host manages worktrees with git, in worktrunk's layout

The apps need to start a thread in a new git worktree of a repository on the Host's computer, which a phone can't make for itself (WVE-115). The Host is therefore git-aware: it knows which repository, worktree and branch a thread's directory is in, and it lists, creates and removes worktrees itself through the `git` command, so the person's git configuration and hooks apply. Worktrees are objects of their own beside threads, not parts of them. A client can make a worktree and start a thread in it, or remove a worktree along with its threads, or do either alone. A thread still runs in the one directory a client names.

New worktrees go where worktrunk puts them by default: beside the repository as `<repo>.<branch>`, always on a branch. worktrunk reads worktrees from git, so it lists and removes the ones weave makes as its own, and the person's `wt` in a terminal and weave in the app manage the same worktrees. Worktrees belong to the person. The Host never removes one on its own, and pruning a thread's journal leaves its worktree alone. Removing a worktree is refused while a thread in it runs a turn or waits on a request; otherwise its open threads are closed first. A worktrunk `pre-remove` hook that asks the Host applies the same rule to `wt remove`, `wt merge` and `wt step prune` in a terminal.

## Considered options

- **Host-owned directories**, as WVE-115 was first written and research section 10.3 weighed: scratch directories and worktrees under the Host's state directory, removed with the thread's journal after a snapshot to `refs/weave/snapshots/<session id>`. They would be hidden from the person's own tools and duplicate the worktree workflow the person already has, and making automatic removal safe needs snapshots, a sweep for directories no journal names, and a way to restore a directory when a thread is reopened from its agent's history.
- **Wrapping worktrunk's CLI**, so the person's path template, project hooks and branch cleanup apply. It would be a dependency the Linux and container Hosts (WVE-116, WVE-119) don't have, behind a 0.x JSON interface whose library API is documented as unstable, and project hooks need approval, which a Host with no terminal would have to carry to a client for consent. The part weave needs is a few git commands.
- **worktrunk with a fallback to git** when it's missing: two code paths that put worktrees in different places and run different hooks.

## Consequences

- Worktrees the apps make run none of worktrunk's hooks, such as a project's `pre-start` or `copy-ignored`, so they start without ignored files like `.env` or installed dependencies. A setup step of weave's own is a separate decision.
- Removals through weave don't fire worktrunk's `post-remove` hooks.
- A branch is deleted with its worktree only when git counts it merged. Squash-merged branches stay until `wt step prune` or the person removes them.
- A worktree path template customised in worktrunk isn't followed. worktrunk marks worktrees away from its path (`branch_mismatch`), and `wt step relocate` can move them.
- Scratch directories are dropped. An always-on agent's directory is decided with WVE-118.
- Threads in a worktree removed without the hook keep their journals, and can be deleted as threads whose directory is gone (WVE-120).
