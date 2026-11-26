---
status: accepted
date: 2026-11-26
---

# The Dispatcher pulls the person's dotfiles from git and syncs Hosts

The person keeps their terminal dotfiles in one private git repository on GitHub (`~/.dotfiles`), laid out for `stow .`. Managing that checkout by hand on every computer was already tedious, and fails altogether on cloud Hosts launched from nothing (WVE-238, WVE-239): a fresh machine joins the Dispatcher with an empty home directory and needs the person's shell, editor, prompt, and agent configuration without manual cloning or GNU Stow installed.

The person settled each part on 2026-11-26 (WVE-243):

- **GitHub stays the source of truth; the Dispatcher pulls and disseminates.** The Dispatcher keeps a bare mirror of the configured repository and branch, checks `git ls-remote` automatically on a schedule (default every 60 seconds) and on demand (`weave dotfiles sync`), and pushes updates to connected Hosts — and to every Host as it connects.
- **Private repositories reuse the Dispatcher's credential store (ADR 0036).** The dotfiles configuration names a token credential in `weave credentials` (such as `git-personal`), passed to `git` only via a private `GIT_ASKPASS` helper while the store is unlocked, and never written to `.git/config`. While the store is locked, the Dispatcher skips remote fetches and continues serving the last cached snapshot from disk so Hosts still sync on connect.
- **Everything committed to the repository is synced**, skipping only GNU Stow's root-level repository metadata defaults (`.git`, `.gitignore`, `.gitmodules`, `.gitattributes`, `README*`, `LICENSE*`, `COPYING*`, `.stow-local-ignore`, `.stow-global-ignore`) and `.DS_Store` anywhere. Untracked and `.gitignore`d files on authoring machines never leave them.
- **Content-addressed incremental transfer.** Because a real dotfiles repository can be tens of megabytes and Host WebSockets enforce an 8 MiB backlog limit, sync uses three `Peer::Joined`-only Host protocol requests: `dotfiles/plan` (manifest of paths, SHA-256 digests, executable bits, and git symlinks), `dotfiles/put` (only blobs missing from the Host's local cache, packed into <= 512 KiB chunks), and `dotfiles/apply`. Already-current Hosts transfer zero bytes; a single-file edit sends one small chunk.
- **Hosts place file-level symlinks without requiring GNU Stow.** Each synced Host keeps a content-addressed blob cache and materialized file tree under its state directory and creates real parent directories and file-level symlinks into `$HOME` — never folding `~/.config` or `~/.ssh` into a single directory symlink, so per-machine local files (`~/.config/zsh/local.zsh`, `~/.ssh/id_*`, `~/.config/weave/agents.lock`) stay local. Files under `~/.ssh/` get `0600` inside a `0700` directory. A Host tracks every symlink it owns, removes stale ones cleanly, refuses paths leaving `$HOME`, and reports unmanaged existing files or symlinked ancestor directories as conflicts rather than clobbering them.
- **Seamless local authoring on the person's main computer.** Each Host defaults to `auto` mode: when a Host already holds a local git checkout (such as `~/.dotfiles`) whose canonical remote (WVE-213) matches the configured dotfiles repository, it stays in `local` mode without touching symlinks and reports its local commit, dirty state, and commits ahead back to the Dispatcher. Any Host can be overridden explicitly (`auto`, `sync`, `local`, `off`).
- **File sync only for now.** Installing shell packages or terminal tools on cloud Hosts stays outside this feature.

## Considered options

- **Each Host clones and pulls from GitHub directly.** Requires git credentials and network access to GitHub on every Host, plus either GNU Stow or custom pull/conflict logic everywhere, and loses single-place coordination when a commit lands.
- **Dispatcher as primary store (replacing GitHub).** Loses the person's existing git history, branching, and editing workflow in `~/.dotfiles`.
- **Single-message full snapshot (`dotfiles/sync`), like `credentials/sync`.** Fails or hits WebSocket backlog limits on repositories with large committed assets, and wastes bandwidth on every reconnect and single-file edit.
- **Invoking GNU Stow on each Host.** Requires Perl and `stow` installed on minimal cloud Host images, and Stow's directory folding would fold `~/.config` and `~/.ssh` into the managed tree.

## Consequences

- **Extends the Dispatcher → Host sync pattern (ADR 0036)** from secrets to non-secret personal configuration, without gating Host sync on unlocking the credential store once a snapshot is cached.
- **Zero-touch cloud Hosts.** A new Fly machine launched by `weave hosts launch` receives both its credentials and the person's dotfiles automatically as soon as it joins.
- **Fits ADR 0035.** One person's dotfiles repository, synced across one person's Hosts.
