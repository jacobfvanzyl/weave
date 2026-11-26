//! Git through the `git` command (ADR 0019): where a thread's directory is in a repository,
//! and a repository's worktrees, which the Host lists, makes beside it as worktrunk lays them
//! out (`<repo>.<branch>`) and removes; and making a repository of its own with its first
//! files committed (`repos/init`, [`crate::repos`]). Git runs with the agents' environment, so
//! the person's configuration and hooks apply, never prompts, and reads without taking optional
//! locks, so it doesn't get in the way of the person's own git. A repository is known by its
//! remote's identity, the URL git would use, its rewrites applied, with an SSH host resolved
//! as [`crate::remotes`] says (WVE-213).

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::Error;
use weave_host_protocol::errors;
use weave_host_protocol::worktrees::CreateWorktreeResponse;
use weave_host_protocol::worktrees::Divergence;
use weave_host_protocol::worktrees::GitLocation;
use weave_host_protocol::worktrees::Upstream;
use weave_host_protocol::worktrees::Worktree;

use crate::remotes::Remotes;
use crate::remotes::SshHosts;

/// How long git may take to read something.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// How long git may take to check out a worktree or remove one, hooks included.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Variables that would point git at another repository than the one it runs in, as a git
/// hook's environment does.
const REPOSITORY_VARIABLES: &[&str] = &[
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
];

#[derive(Clone, Debug)]
pub(crate) struct Git {
    environment: BTreeMap<String, String>,
    /// Remotes' identities, with the SSH lookups kept for the Host's life.
    remotes: Arc<Remotes>,
}

/// A repository, as `git worktree list` gives it.
#[derive(Clone, Debug)]
pub(crate) struct Repository {
    /// Its primary worktree, or the repository itself when it's bare.
    pub(crate) primary: PathBuf,
    /// The remote it's known by, and that remote's name.
    pub(crate) remote: Option<(String, String)>,
    /// The primary worktree first.
    pub(crate) entries: Vec<Entry>,
}

/// One worktree of a repository.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Entry {
    pub(crate) path: PathBuf,
    pub(crate) head: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) bare: bool,
    /// Its directory is gone.
    pub(crate) prunable: bool,
}

/// The branch new worktrees start from: its name, and what to start from, which is the
/// remote's branch when there's no local one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DefaultBranch {
    pub(crate) name: String,
    pub(crate) rev: String,
}

/// What a git command printed, when it succeeded.
struct Output {
    stdout: String,
}

/// Summary of a local git checkout on this Host that may be the person's authoring dotfiles repo.
#[derive(Clone, Debug)]
pub(crate) struct LocalDotfilesInfo {
    pub(crate) root: PathBuf,
    pub(crate) remote: Option<String>,
    pub(crate) commit: Option<String>,
    pub(crate) dirty: bool,
    pub(crate) ahead: Option<u32>,
}

impl Git {
    /// Git with `environment`, resolving SSH remotes' hosts with `ssh`.
    pub(crate) fn new(environment: &BTreeMap<String, String>, ssh: Arc<dyn SshHosts>) -> Self {
        Self {
            environment: environment.clone(),
            remotes: Arc::new(Remotes::new(ssh)),
        }
    }

    /// Run git in `dir`. Fails with what git said when it exits unsuccessfully.
    async fn run(&self, dir: &Path, args: &[&str], timeout: Duration) -> Result<Output, Error> {
        let mut command = tokio::process::Command::new("git");
        command
            .arg("-C")
            .arg(dir)
            .args(args)
            .envs(&self.environment)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for variable in REPOSITORY_VARIABLES {
            command.env_remove(variable);
        }
        let output = tokio::time::timeout(timeout, command.output())
            .await
            .map_err(|_| errors::git_failed(format!("git {} took too long", args.join(" "))))?
            .map_err(|error| errors::git_failed(format!("git couldn't be run: {error}")))?;
        if output.status.success() {
            Ok(Output {
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            })
        } else {
            let said = String::from_utf8_lossy(&output.stderr);
            let said = said.trim();
            Err(errors::git_failed(if said.is_empty() {
                format!("git {} failed ({})", args.join(" "), output.status)
            } else {
                said.to_owned()
            }))
        }
    }

    async fn read(&self, dir: &Path, args: &[&str]) -> Result<String, Error> {
        self.run(dir, args, READ_TIMEOUT)
            .await
            .map(|output| output.stdout)
    }

    /// Whether git succeeds, as a check such as `show-ref --verify --quiet` does.
    async fn holds(&self, dir: &Path, args: &[&str]) -> bool {
        self.run(dir, args, READ_TIMEOUT).await.is_ok()
    }

    /// Where in a repository `dir` is; none outside one, or when git can't say.
    pub(crate) async fn locate(&self, dir: &Path) -> Option<GitLocation> {
        let (toplevel, repository) = tokio::join!(
            self.read(dir, &["rev-parse", "--show-toplevel"]),
            self.repository(dir),
        );
        let worktree = canonical(Path::new(toplevel.ok()?.trim()));
        let repository = repository.ok()?;
        let branch = repository
            .entries
            .iter()
            .find(|entry| entry.path == worktree)
            .and_then(|entry| entry.branch.clone());
        Some(GitLocation {
            repo: repository.primary,
            worktree,
            branch,
            remote: repository.remote.map(|(_, identity)| identity),
        })
    }

    /// The repository `dir` is in.
    pub(crate) async fn repository(&self, dir: &Path) -> Result<Repository, Error> {
        let (listed, remotes) = tokio::join!(
            self.read(dir, &["worktree", "list", "--porcelain", "-z"]),
            self.read(dir, &["config", "--get-regexp", r"^remote\..*\.url$"]),
        );
        let entries = parse_worktrees(&listed.map_err(|_| errors::not_a_repository(dir))?);
        let primary = entries
            .first()
            .map(|entry| entry.path.clone())
            .ok_or_else(|| errors::not_a_repository(dir))?;
        // A repository without remotes has no `remote.*.url` to find.
        let remote = match remotes.ok().as_deref().and_then(chosen_remote) {
            Some((name, written)) => self
                .remote_identity(dir, &name, &written)
                .await
                .map(|identity| (name, identity)),
            None => None,
        };
        Ok(Repository {
            primary,
            remote,
            entries,
        })
    }

    /// The identity of the remote `name`, whose URL is `written` in the configuration: the URL
    /// git would use, its `url.<base>.insteadOf` rewrites applied, which `git remote get-url`
    /// gives from the configuration alone, without reaching the remote; else as written.
    async fn remote_identity(&self, dir: &Path, name: &str, written: &str) -> Option<String> {
        let url = self.read(dir, &["remote", "get-url", "--", name]).await;
        let url = match &url {
            Ok(url) if !url.trim().is_empty() => url.trim(),
            _ => written,
        };
        self.remotes.identity(url).await
    }

    /// Whether `found`, the identity of a checkout here, is the repository `named`, an identity
    /// another Host or a Project gives: the same, or the same once its host is resolved here,
    /// as an identity from a Host that didn't resolve SSH hosts may need.
    pub(crate) async fn same_repository(&self, found: &str, named: &str) -> bool {
        found.eq_ignore_ascii_case(named)
            || found.eq_ignore_ascii_case(&self.remotes.resolved(named).await)
    }

    /// The branch new worktrees of `repository` start from: the remote's default branch, else
    /// `main` or `master`.
    pub(crate) async fn default_branch(&self, repository: &Repository) -> Option<DefaultBranch> {
        let dir = &repository.primary;
        let local = async |name: &str| {
            self.holds(
                dir,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{name}"),
                ],
            )
            .await
        };
        if let Some((remote, _)) = &repository.remote {
            let head = format!("refs/remotes/{remote}/HEAD");
            if let Ok(target) = self
                .read(dir, &["symbolic-ref", "--quiet", "--short", &head])
                .await
                && let Some(name) = target.trim().strip_prefix(&format!("{remote}/"))
            {
                let rev = if local(name).await {
                    name.to_owned()
                } else {
                    target.trim().to_owned()
                };
                return Some(DefaultBranch {
                    name: name.to_owned(),
                    rev,
                });
            }
        }
        for name in ["main", "master"] {
            if local(name).await {
                return Some(DefaultBranch {
                    name: name.to_owned(),
                    rev: name.to_owned(),
                });
            }
        }
        None
    }

    /// `repository`'s worktrees whose directories are there, with their status: changes,
    /// how far each is from `default` and from its upstream. No threads yet.
    pub(crate) async fn worktrees(
        &self,
        repository: &Repository,
        default: Option<&DefaultBranch>,
    ) -> Vec<Worktree> {
        let present: Vec<(usize, &Entry)> = repository
            .entries
            .iter()
            .enumerate()
            .filter(|(_, entry)| !entry.prunable && !entry.bare)
            .collect();
        let statuses = futures::future::join_all(present.iter().map(|(_, entry)| async {
            let (status, divergence) = tokio::join!(
                self.read(&entry.path, &["status", "--porcelain=v2", "--branch", "-z"]),
                async {
                    let default = default?;
                    entry.head.as_ref()?;
                    let range = format!("{}...HEAD", default.rev);
                    let counted = self
                        .read(
                            &entry.path,
                            &["rev-list", "--left-right", "--count", &range],
                        )
                        .await
                        .ok()?;
                    parse_left_right(&counted)
                },
            );
            (status.ok().map(|status| parse_status(&status)), divergence)
        }))
        .await;
        let mut worktrees: Vec<Worktree> = present
            .into_iter()
            .zip(statuses)
            .map(|((index, entry), (status, divergence))| {
                let (changes, upstream) = status.unwrap_or_default();
                Worktree {
                    path: entry.path.clone(),
                    branch: entry.branch.clone(),
                    head: entry.head.clone(),
                    primary: index == 0,
                    changes,
                    divergence,
                    upstream,
                    threads: Vec::new(),
                }
            })
            .collect();
        worktrees.sort_by(|left, right| {
            right
                .primary
                .cmp(&left.primary)
                .then_with(|| left.path.cmp(&right.path))
        });
        worktrees
    }

    /// Make a worktree of `repository` for `branch` beside it, as worktrunk would: a new
    /// branch from `base` (else the default branch, else the primary worktree's HEAD), or one
    /// that exists, on a remote alone included.
    pub(crate) async fn create(
        &self,
        repository: &Repository,
        branch: &str,
        base: Option<&str>,
    ) -> Result<CreateWorktreeResponse, Error> {
        let dir = &repository.primary;
        self.check_branch_name(dir, branch).await?;
        if let Some(base) = base
            && (base.is_empty() || base.starts_with('-'))
        {
            return Err(
                Error::invalid_params().data(format!("{base:?} isn't a base to start from"))
            );
        }
        if let Some(entry) = repository
            .entries
            .iter()
            .find(|entry| entry.branch.as_deref() == Some(branch))
        {
            return Err(Error::invalid_params().data(format!(
                "{branch} is checked out in {} already",
                entry.path.display()
            )));
        }
        let path = worktree_path(&repository.primary, branch)?;
        if std::fs::symlink_metadata(&path).is_ok() {
            return Err(Error::invalid_params().data(format!("{} already exists", path.display())));
        }
        let path_text = path.display().to_string();
        let local = self
            .holds(
                dir,
                &[
                    "show-ref",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{branch}"),
                ],
            )
            .await;
        if local && base.is_some() {
            return Err(Error::invalid_params().data(format!(
                "{branch} exists already; a base is for a new branch"
            )));
        }
        let remote_has_it = !local && base.is_none() && self.on_a_remote(dir, branch).await;
        let default = if local || remote_has_it || base.is_some() {
            None
        } else {
            self.default_branch(repository).await
        };
        let mut args = vec!["worktree", "add"];
        if !local && !remote_has_it {
            args.extend(["-b", branch]);
        }
        args.extend(["--", &path_text]);
        if local || remote_has_it {
            // Git makes a branch only a remote has, tracking it.
            args.push(branch);
        } else if let Some(base) = base.or(default.as_ref().map(|default| default.rev.as_str())) {
            args.push(base);
        }
        self.run(dir, &args, WRITE_TIMEOUT).await?;
        Ok(CreateWorktreeResponse {
            path: canonical(&path),
            branch: branch.to_owned(),
            created_branch: !local,
        })
    }

    /// Refuse a name that isn't a branch name, or that git would read as something else.
    async fn check_branch_name(&self, dir: &Path, branch: &str) -> Result<(), Error> {
        let refused = || Error::invalid_params().data(format!("{branch:?} isn't a branch name"));
        if branch.is_empty() || branch.starts_with('-') {
            return Err(refused());
        }
        match self
            .read(dir, &["check-ref-format", "--branch", branch])
            .await
        {
            // `--branch` expands `@{-1}` and the like; only a name that stays itself is one.
            Ok(name) if name.trim() == branch => Ok(()),
            _ => Err(refused()),
        }
    }

    /// Whether a remote has `branch`.
    async fn on_a_remote(&self, dir: &Path, branch: &str) -> bool {
        self.read(
            dir,
            &[
                "for-each-ref",
                "--format=%(refname:strip=3)",
                "refs/remotes",
            ],
        )
        .await
        .is_ok_and(|names| names.lines().any(|name| name == branch))
    }

    /// Whether `worktree` has changes that removing it would lose, as `git worktree remove`
    /// counts them.
    pub(crate) async fn has_changes(&self, worktree: &Path) -> Result<bool, Error> {
        self.read(
            worktree,
            &["status", "--porcelain", "--ignore-submodules=none", "-z"],
        )
        .await
        .map(|status| !status.is_empty())
    }

    /// Remove `worktree`, with its changes when `force`.
    pub(crate) async fn remove(
        &self,
        repository: &Repository,
        worktree: &Path,
        force: bool,
    ) -> Result<(), Error> {
        let path = worktree.display().to_string();
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.extend(["--", &path]);
        self.run(&repository.primary, &args, WRITE_TIMEOUT)
            .await
            .map(drop)
    }

    /// The top of the work tree `dir` is in, symlinks resolved; none outside one, as in a
    /// repository's own `.git` directory.
    pub(crate) async fn work_tree_top(&self, dir: &Path) -> Option<PathBuf> {
        let inside = self
            .read(dir, &["rev-parse", "--is-inside-work-tree"])
            .await
            .ok()?;
        if inside.trim() != "true" {
            return None;
        }
        let top = self
            .read(dir, &["rev-parse", "--show-toplevel"])
            .await
            .ok()?;
        Some(canonical(Path::new(top.trim())))
    }

    /// Make `dir` a repository (`git init`).
    pub(crate) async fn init(&self, dir: &Path) -> Result<(), Error> {
        self.run(dir, &["init", "--quiet"], READ_TIMEOUT)
            .await
            .map(drop)
    }

    /// Resolve an identity string (like `github.com-kp/owner/repo`) through SSH aliases here,
    /// keeping `file://` local-path identities intact for tests.
    pub(crate) async fn resolved_remote_identity(&self, identity: &str) -> String {
        if identity.starts_with("file://") {
            return identity.to_owned();
        }
        self.remotes.resolved(identity).await
    }

    /// Inspect a candidate local dotfiles git checkout at `dir`, returning its root, canonical
    /// remote identity, HEAD commit, dirty state, and commits ahead of `origin/<branch>` (or
    /// upstream). Returns `None` if `dir` is not inside a git work tree.
    pub(crate) async fn inspect_dotfiles_checkout(
        &self,
        dir: &Path,
        branch: Option<&str>,
    ) -> Option<LocalDotfilesInfo> {
        let root = self.work_tree_top(dir).await?;
        let remote = match self.read(&root, &["remote", "get-url", "origin"]).await {
            Ok(url) => {
                let url = url.trim();
                match self.remotes.identity(url).await {
                    Some(identity) => Some(identity),
                    None => {
                        // Local filesystem remote (common in tests): canonicalize into `file://…`.
                        let stripped = url.strip_prefix("file://").unwrap_or(url);
                        let path = Path::new(stripped);
                        let resolved = if path.is_absolute() {
                            canonical(path)
                        } else {
                            canonical(&root.join(path))
                        };
                        Some(format!("file://{}", resolved.display()))
                    }
                }
            }
            Err(_) => None,
        };
        let commit = self
            .read(&root, &["rev-parse", "HEAD"])
            .await
            .ok()
            .map(|sha| sha.trim().to_owned())
            .filter(|sha| !sha.is_empty());
        let dirty = self.has_changes(&root).await.unwrap_or(false);
        let ahead = {
            let mut count = None;
            if let Some(branch) = branch {
                let spec = format!("origin/{branch}..HEAD");
                if let Ok(out) = self.read(&root, &["rev-list", "--count", &spec]).await {
                    count = out.trim().parse::<u32>().ok();
                }
            }
            if count.is_none()
                && let Ok(out) = self
                    .read(&root, &["rev-list", "--count", "@{u}..HEAD"])
                    .await
            {
                count = out.trim().parse::<u32>().ok();
            }
            count
        };
        Some(LocalDotfilesInfo {
            root,
            remote,
            commit,
            dirty,
            ahead,
        })
    }

    /// Whether git knows who to commit as in `dir`, from its configuration or the environment,
    /// rather than guessing from the computer.
    pub(crate) async fn knows_who(&self, dir: &Path) -> bool {
        let (author, committer) = tokio::join!(
            self.holds(
                dir,
                &["-c", "user.useConfigOnly=true", "var", "GIT_AUTHOR_IDENT"]
            ),
            self.holds(
                dir,
                &[
                    "-c",
                    "user.useConfigOnly=true",
                    "var",
                    "GIT_COMMITTER_IDENT"
                ]
            ),
        );
        author && committer
    }

    /// Commit `files` in `dir`, relative to it, with `message`, and nothing else that's staged.
    pub(crate) async fn commit_only(
        &self,
        dir: &Path,
        files: &[&str],
        message: &str,
    ) -> Result<(), Error> {
        let mut add = vec!["add", "--"];
        add.extend(files);
        self.run(dir, &add, READ_TIMEOUT).await?;
        let mut commit = vec!["commit", "--quiet", "--message", message, "--only", "--"];
        commit.extend(files);
        // Hooks run, as the person's own commits run them.
        self.run(dir, &commit, WRITE_TIMEOUT).await.map(drop)
    }

    /// Delete `branch` if git counts it merged, or regardless when `force`. Whether it went.
    pub(crate) async fn delete_branch(
        &self,
        repository: &Repository,
        branch: &str,
        force: bool,
    ) -> bool {
        let flag = if force { "-D" } else { "-d" };
        match self
            .run(
                &repository.primary,
                &["branch", flag, "--", branch],
                READ_TIMEOUT,
            )
            .await
        {
            Ok(_) => true,
            Err(error) => {
                tracing::info!(%error, branch, "kept a removed worktree's branch");
                false
            }
        }
    }
}

/// `path` with symlinks resolved, or as given when it can't be.
pub(crate) fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Where a new worktree of the repository whose primary worktree is `primary` goes for
/// `branch`: beside it, as worktrunk's default `{{ repo_path }}/../{{ repo }}.{{ branch |
/// sanitize }}`.
pub(crate) fn worktree_path(primary: &Path, branch: &str) -> Result<PathBuf, Error> {
    let (Some(parent), Some(name)) = (primary.parent(), primary.file_name()) else {
        return Err(Error::invalid_params().data(format!(
            "{} has no directory beside it for worktrees",
            primary.display()
        )));
    };
    let mut leaf = name.to_os_string();
    leaf.push(".");
    leaf.push(sanitize(branch));
    Ok(parent.join(leaf))
}

/// A branch name safe for a directory's, as worktrunk's `sanitize` makes it.
fn sanitize(branch: &str) -> String {
    branch.replace(['/', '\\'], "-")
}

/// `git worktree list --porcelain -z`: records ending in NUL, worktrees separated by an empty
/// one.
fn parse_worktrees(listed: &str) -> Vec<Entry> {
    let mut entries = Vec::new();
    let mut current: Option<Entry> = None;
    for field in listed.split('\0') {
        if field.is_empty() {
            entries.extend(current.take());
            continue;
        }
        let (key, value) = field.split_once(' ').unwrap_or((field, ""));
        if key == "worktree" {
            entries.extend(current.take());
            current = Some(Entry {
                path: canonical(Path::new(value)),
                ..Entry::default()
            });
            continue;
        }
        let Some(entry) = current.as_mut() else {
            continue;
        };
        match key {
            "HEAD" => entry.head = Some(value.to_owned()),
            "branch" => {
                entry.branch = Some(
                    value
                        .strip_prefix("refs/heads/")
                        .unwrap_or(value)
                        .to_owned(),
                );
            }
            "bare" => entry.bare = true,
            "prunable" => entry.prunable = true,
            _ => {}
        }
    }
    entries.extend(current);
    entries
}

/// The remote a repository is known by, from `git config --get-regexp '^remote\..*\.url$'`:
/// `origin`, else the first. Its name, and its URL as written.
fn chosen_remote(urls: &str) -> Option<(String, String)> {
    let remotes: Vec<(&str, &str)> = urls
        .lines()
        .filter_map(|line| {
            let (key, url) = line.split_once(' ')?;
            let name = key.strip_prefix("remote.")?.strip_suffix(".url")?;
            Some((name, url))
        })
        .collect();
    let (name, url) = remotes
        .iter()
        .find(|(name, _)| *name == "origin")
        .or_else(|| remotes.first())?;
    Some(((*name).to_owned(), (*url).to_owned()))
}

/// `git status --porcelain=v2 --branch -z`: whether anything changed, and the upstream.
fn parse_status(status: &str) -> (bool, Option<Upstream>) {
    let mut changes = false;
    let mut upstream = None;
    let mut divergence = Divergence::default();
    for record in status.split('\0').filter(|record| !record.is_empty()) {
        if let Some(header) = record.strip_prefix("# ") {
            if let Some(name) = header.strip_prefix("branch.upstream ") {
                upstream = Some(name.to_owned());
            } else if let Some(counts) = header.strip_prefix("branch.ab ") {
                let mut counts = counts.split(' ');
                let count = |count: Option<&str>, sign: char| {
                    count
                        .and_then(|count| count.strip_prefix(sign))
                        .and_then(|count| count.parse().ok())
                        .unwrap_or(0)
                };
                divergence.ahead = count(counts.next(), '+');
                divergence.behind = count(counts.next(), '-');
            }
        } else if matches!(record.as_bytes().first(), Some(b'1' | b'2' | b'u' | b'?')) {
            changes = true;
        }
    }
    (changes, upstream.map(|name| Upstream { name, divergence }))
}

/// `git rev-list --left-right --count <default>...HEAD`: what only the default branch has, then
/// what only HEAD has.
fn parse_left_right(counted: &str) -> Option<Divergence> {
    let mut counts = counted.split_whitespace().map(str::parse::<u32>);
    let behind = counts.next()?.ok()?;
    let ahead = counts.next()?.ok()?;
    Some(Divergence { ahead, behind })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;
    use crate::remotes::AsWritten;
    use crate::remotes::Hostname;

    /// SSH's configuration as a table of aliases.
    struct Aliases(&'static [(&'static str, &'static str)]);

    impl SshHosts for Aliases {
        fn hostname<'a>(
            &'a self,
            target: &'a crate::remotes::SshTarget,
        ) -> crate::remotes::BoxFuture<'a, Hostname> {
            let found = self
                .0
                .iter()
                .find(|(alias, _)| *alias == target.host())
                .map_or_else(|| target.host().to_owned(), |(_, host)| (*host).to_owned());
            Box::pin(async move { Hostname::Is(found) })
        }
    }

    /// Git away from the configuration of whoever runs the tests, `github.com-kp` an SSH alias
    /// for `github.com`.
    fn git() -> Git {
        let environment = [
            ("GIT_CONFIG_GLOBAL", "/dev/null"),
            ("GIT_CONFIG_NOSYSTEM", "1"),
        ]
        .into_iter()
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
        Git::new(
            &environment,
            Arc::new(Aliases(&[("github.com-kp", "github.com")])),
        )
    }

    /// A repository at `dir` with an origin at `url` and `config`'s settings.
    async fn repository(git: &Git, dir: &Path, url: &str, config: &[(&str, &str)]) {
        std::fs::create_dir_all(dir).expect("its directory");
        git.init(dir).await.expect("git init");
        git.run(dir, &["remote", "add", "origin", url], READ_TIMEOUT)
            .await
            .expect("git remote add");
        for (key, value) in config {
            git.run(dir, &["config", key, value], READ_TIMEOUT)
                .await
                .expect("git config");
        }
    }

    async fn remote_of(git: &Git, dir: &Path) -> Option<String> {
        git.locate(dir).await.and_then(|location| location.remote)
    }

    #[tokio::test]
    async fn clones_through_an_alias_a_rewrite_or_neither_are_one_repository() {
        let dir = tempfile::tempdir().expect("tempdir");
        let git = git();
        let plain = dir.path().join("plain");
        let alias = dir.path().join("alias");
        let rewritten = dir.path().join("rewritten");
        let https = dir.path().join("https");
        repository(&git, &plain, "git@github.com:owner/name.git", &[]).await;
        repository(&git, &alias, "git@github.com-kp:owner/name.git", &[]).await;
        repository(
            &git,
            &rewritten,
            "kp:owner/name",
            &[("url.git@github.com-kp:.insteadOf", "kp:")],
        )
        .await;
        repository(&git, &https, "https://github.com/owner/name", &[]).await;
        for clone in [&plain, &alias, &rewritten, &https] {
            assert_eq!(
                remote_of(&git, clone).await.as_deref(),
                Some("github.com/owner/name"),
                "{}",
                clone.display()
            );
        }
        // Without the alias, a clone through it is known as it's written, as before.
        let as_written = Git::new(&git.environment, Arc::new(AsWritten));
        assert_eq!(
            remote_of(&as_written, &alias).await.as_deref(),
            Some("github.com-kp/owner/name")
        );
        assert_eq!(
            remote_of(&as_written, &rewritten).await.as_deref(),
            Some("github.com-kp/owner/name")
        );
        // A checkout here is the repository an identity from a Host that didn't resolve names.
        assert!(
            git.same_repository("github.com/owner/name", "github.com-kp/owner/name")
                .await
        );
        assert!(
            git.same_repository("github.com/owner/name", "GitHub.com/owner/name")
                .await
        );
        assert!(
            !git.same_repository("github.com/owner/name", "github.com/owner/fork")
                .await
        );
    }

    #[test]
    fn origin_is_the_remote_a_repository_is_known_by_else_the_first() {
        let urls = "remote.upstream.url git@github.com:max-sixty/worktrunk.git\n\
                    remote.origin.url git@github.com:jacobfvanzyl/worktrunk.git\n";
        assert_eq!(
            chosen_remote(urls),
            Some((
                "origin".to_owned(),
                "git@github.com:jacobfvanzyl/worktrunk.git".to_owned()
            ))
        );
        assert_eq!(
            chosen_remote("remote.fork.url https://example.com/me/x.git\n"),
            Some(("fork".to_owned(), "https://example.com/me/x.git".to_owned()))
        );
        assert_eq!(chosen_remote(""), None);
    }

    #[test]
    fn worktrees_go_beside_the_repository_as_worktrunk_puts_them() {
        assert_eq!(
            worktree_path(Path::new("/code/weave"), "feature/auth").ok(),
            Some(PathBuf::from("/code/weave.feature-auth"))
        );
        assert_eq!(
            worktree_path(Path::new("/code/weave"), "fix").ok(),
            Some(PathBuf::from("/code/weave.fix"))
        );
        assert!(worktree_path(Path::new("/"), "fix").is_err());
    }

    #[test]
    fn worktree_lists_give_each_worktree_with_its_branch() {
        let listed = "worktree /nowhere/weave\0HEAD 4ec84ecd\0branch refs/heads/main\0\0\
                      worktree /nowhere/weave.feature-auth\0HEAD b772e68a\0branch refs/heads/feature/auth\0locked\0\0\
                      worktree /nowhere/weave.review\0HEAD 41ee083c\0detached\0prunable gitdir file points to non-existent location\0\0";
        assert_eq!(
            parse_worktrees(listed),
            vec![
                Entry {
                    path: "/nowhere/weave".into(),
                    head: Some("4ec84ecd".to_owned()),
                    branch: Some("main".to_owned()),
                    ..Entry::default()
                },
                Entry {
                    path: "/nowhere/weave.feature-auth".into(),
                    head: Some("b772e68a".to_owned()),
                    branch: Some("feature/auth".to_owned()),
                    ..Entry::default()
                },
                Entry {
                    path: "/nowhere/weave.review".into(),
                    head: Some("41ee083c".to_owned()),
                    prunable: true,
                    ..Entry::default()
                },
            ]
        );
    }

    #[test]
    fn statuses_give_changes_and_the_upstream() {
        let clean = "# branch.oid 4ec84ecd\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +1 -2\0";
        assert_eq!(
            parse_status(clean),
            (
                false,
                Some(Upstream {
                    name: "origin/main".to_owned(),
                    divergence: Divergence {
                        ahead: 1,
                        behind: 2
                    },
                })
            )
        );
        let changed = "# branch.oid 4ec84ecd\0# branch.head feature\0? notes.md\0";
        assert_eq!(parse_status(changed), (true, None));
        assert_eq!(
            parse_left_right("2\t3\n"),
            Some(Divergence {
                ahead: 3,
                behind: 2
            })
        );
    }
}
