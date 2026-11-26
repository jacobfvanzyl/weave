//! Pulling the person's dotfiles repository on the Dispatcher and syncing it incrementally to
//! every connected Host (ADR 0037, WVE-243).
//!
//! The Dispatcher keeps a bare mirror in `$WEAVE_DISPATCHER_DIR/dotfiles/repo.git`. On each poll
//! tick (`run`), on `dotfiles/set`, and on `dotfiles/sync`, it checks `git ls-remote` and fetches
//! only when the remote branch SHA has moved. Private repositories authenticate with a `token`
//! credential from `weave credentials` passed via a temporary private `GIT_ASKPASS` script (never
//! written to `.git/config` or logged). While credentials are locked, remote fetches are skipped
//! and Hosts still receive the last cached snapshot on disk.

use std::collections::HashMap;
use std::io::BufRead as _;
use std::io::BufReader;
use std::io::Read as _;
use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;

use agent_client_protocol::Error;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use sha2::Digest as _;
use sha2::Sha256;
use weave_host_client::HostHandle;
use weave_host_protocol::dispatcher::CredentialKind;
use weave_host_protocol::dispatcher::DEFAULT_DOTFILES_POLL_SECS;
use weave_host_protocol::dispatcher::DotfilesHostStatus;
use weave_host_protocol::dispatcher::DotfilesStatus;
use weave_host_protocol::dispatcher::SetDotfilesRequest;
use weave_host_protocol::dotfiles::ApplyDotfilesRequest;
use weave_host_protocol::dotfiles::DotfilesBlobChunk;
use weave_host_protocol::dotfiles::DotfilesEntry;
use weave_host_protocol::dotfiles::DotfilesEntryKind;
use weave_host_protocol::dotfiles::DotfilesMode;
use weave_host_protocol::dotfiles::FEATURE as DOTFILES_FEATURE;
use weave_host_protocol::dotfiles::MAX_CHUNK_BYTES;
use weave_host_protocol::dotfiles::PlanDotfilesRequest;
use weave_host_protocol::dotfiles::PutDotfilesBlobsRequest;
use zeroize::Zeroizing;

use crate::Shared;
use crate::internal;
use crate::invalid;
use crate::lock;

/// Username paired with a PAT in `GIT_ASKPASS` (works on GitHub, GitLab, Gitea/Forgejo).
const GIT_USERNAME: &str = "x-access-token";

/// Fallback sleep when polling is disabled or unconfigured (woken immediately by `dotfiles_changed`).
const IDLE_WAIT_MS: u64 = 60 * 60 * 1000;

/// Cached manifest for the latest fetched commit, kept in memory so reconnects avoid re-hashing
/// the entire git tree.
#[derive(Clone)]
struct TreeSnapshot {
    commit: String,
    entries: Vec<DotfilesEntry>,
    /// `sha256_hex -> git object id` for reading missing blobs out of `repo.git`.
    git_oids: HashMap<String, String>,
}

/// Runtime state held by the Dispatcher for dotfiles sync.
#[derive(Default)]
pub(crate) struct Dotfiles {
    /// Serializes git mirror fetches so two callers never race on `repo.git`.
    fetching: tokio::sync::Mutex<()>,
    /// Cached tree for the latest fetched commit.
    snapshot: Mutex<Option<TreeSnapshot>>,
    /// Per-Host lock serializing `plan -> put -> apply` sequences so two syncs to the same Host
    /// never interleave staged plans.
    host_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Dotfiles {
    fn host_lock(&self, host_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = lock(&self.host_locks);
        Arc::clone(
            locks
                .entry(host_id.to_owned())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    fn cached_snapshot(&self, commit: &str) -> Option<TreeSnapshot> {
        lock(&self.snapshot)
            .as_ref()
            .filter(|snap| snap.commit == commit)
            .cloned()
    }

    fn set_snapshot(&self, snapshot: Option<TreeSnapshot>) {
        *lock(&self.snapshot) = snapshot;
    }
}

/// Canonical remote identity for `repo`, matching `host/src/remotes.rs` (`github.com/owner/repo`)
/// or `file://<canonical_path>` for local filesystem repositories (tests).
pub(crate) fn canonical_remote(repo: &str) -> Option<String> {
    let trimmed = repo.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .or_else(|| trimmed.strip_prefix("ssh://"))
    {
        let (authority, path) = rest.split_once('/')?;
        let host_port = authority
            .rsplit_once('@')
            .map_or(authority, |(_, right)| right);
        let host = host_port
            .split_once(':')
            .map_or(host_port, |(host, _)| host)
            .to_ascii_lowercase();
        let path = clean_remote_path(path);
        return (!host.is_empty() && !path.is_empty()).then(|| format!("{host}/{path}"));
    }
    if let Some(rest) = trimmed.strip_prefix("file://") {
        let path = Path::new(rest);
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        return Some(format!("file://{}", resolved.display()));
    }
    // Local filesystem path (absolute or relative, e.g. in tests).
    if trimmed.starts_with('/') || trimmed.starts_with("./") || trimmed.starts_with("../") {
        let path = Path::new(trimmed);
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        return Some(format!("file://{}", resolved.display()));
    }
    // SCP-style SSH remote (`git@github.com:owner/repo.git`).
    if let Some((left, path)) = trimmed.split_once(':')
        && !left.contains('/')
    {
        let host = left
            .rsplit_once('@')
            .map_or(left, |(_, right)| right)
            .to_ascii_lowercase();
        let path = clean_remote_path(path);
        return (!host.is_empty() && !path.is_empty()).then(|| format!("{host}/{path}"));
    }
    None
}

fn clean_remote_path(path: &str) -> String {
    let trimmed = path.trim_matches('/');
    trimmed
        .strip_suffix(".git")
        .unwrap_or(trimmed)
        .trim_end_matches('/')
        .to_owned()
}

/// GNU Stow's root-level repository metadata defaults (plus `.DS_Store` anywhere): kept out of
/// `$HOME` so `~/README.md` or `~/.gitignore` aren't symlinked.
fn is_ignored_path(path: &str) -> bool {
    let file_name = path.rsplit('/').next().unwrap_or(path);
    if file_name == ".DS_Store" {
        return true;
    }
    if path.contains('/') {
        return false;
    }
    let upper = path.to_ascii_uppercase();
    matches!(
        path,
        ".git"
            | ".gitignore"
            | ".gitmodules"
            | ".gitattributes"
            | ".stow-local-ignore"
            | ".stow-global-ignore"
    ) || upper.starts_with("README")
        || upper.starts_with("LICENSE")
        || upper.starts_with("COPYING")
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// Temporary private `GIT_ASKPASS` script that prints `x-access-token` / `$WEAVE_GIT_TOKEN`
/// without ever writing the token to disk or `.git/config`. Removed on drop.
struct AskPass {
    dir: PathBuf,
    script: PathBuf,
}

impl AskPass {
    fn create(base: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(base)
            .map_err(|error| format!("creating {}: {error}", base.display()))?;
        let mut nonce = [0u8; 8];
        let _ = getrandom::fill(&mut nonce);
        let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
        let dir = base.join(format!("askpass-{suffix}"));
        std::fs::create_dir_all(&dir)
            .map_err(|error| format!("creating {}: {error}", dir.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("chmod {}: {error}", dir.display()))?;
        }
        let script = dir.join("askpass.sh");
        let body = format!(
            "#!/bin/sh\ncase \"$1\" in\n  *Username*|*username*) printf '%s\\n' '{GIT_USERNAME}' ;;\n  *) printf '%s\\n' \"$WEAVE_GIT_TOKEN\" ;;\nesac\n"
        );
        std::fs::write(&script, body)
            .map_err(|error| format!("writing {}: {error}", script.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))
                .map_err(|error| format!("chmod {}: {error}", script.display()))?;
        }
        Ok(Self { dir, script })
    }
}

impl Drop for AskPass {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Run a `git` command with optional token auth via `GIT_ASKPASS`, never prompting on a terminal.
fn run_git(
    dir: Option<&Path>,
    args: &[&str],
    token: Option<&str>,
    askpass_base: &Path,
) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new("git");
    if let Some(dir) = dir {
        cmd.arg("-C").arg(dir);
    }
    cmd.args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let _askpass = match token {
        Some(token) => {
            let helper = AskPass::create(askpass_base)?;
            cmd.env("GIT_ASKPASS", &helper.script)
                .env("WEAVE_GIT_TOKEN", token);
            Some(helper)
        }
        None => None,
    };

    let output = cmd
        .output()
        .map_err(|error| format!("running git {}: {error}", args.join(" ")))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let why = if stderr.is_empty() {
            format!("git {} exited with {}", args.join(" "), output.status)
        } else {
            stderr
        };
        Err(why)
    }
}

fn mirror_dir(base: &Path) -> PathBuf {
    base.join("repo.git")
}

/// Ask the remote for the current commit SHA of `refs/heads/<branch>`.
fn ls_remote_commit(
    repo: &str,
    branch: &str,
    token: Option<&str>,
    askpass_base: &Path,
) -> Result<String, String> {
    let refspec = format!("refs/heads/{branch}");
    let stdout = run_git(
        None,
        &["ls-remote", "--heads", repo, &refspec],
        token,
        askpass_base,
    )?;
    let text = String::from_utf8_lossy(&stdout);
    for line in text.lines() {
        let Some((sha, name)) = line.split_once('\t') else {
            continue;
        };
        if name.trim() == refspec && !sha.trim().is_empty() {
            return Ok(sha.trim().to_owned());
        }
    }
    Err(format!("branch {branch} was not found in {repo}"))
}

/// Ensure `repo.git` holds `expected_commit` by fetching `branch` when missing.
fn ensure_mirror_commit(
    base: &Path,
    repo: &str,
    branch: &str,
    expected_commit: &str,
    token: Option<&str>,
) -> Result<(), String> {
    let mirror = mirror_dir(base);
    if mirror.is_dir() {
        let tree_spec = format!("{expected_commit}^{{tree}}");
        if run_git(Some(&mirror), &["cat-file", "-e", &tree_spec], None, base).is_ok() {
            return Ok(());
        }
    } else {
        std::fs::create_dir_all(&mirror)
            .map_err(|error| format!("creating {}: {error}", mirror.display()))?;
        run_git(Some(&mirror), &["init", "--bare", "--quiet"], None, base)?;
    }

    let refspec = format!("+refs/heads/{branch}:refs/heads/{branch}");
    let is_network = repo.starts_with("http://")
        || repo.starts_with("https://")
        || repo.starts_with("ssh://")
        || (!repo.starts_with('/') && !repo.starts_with("file://") && repo.contains(':'));
    let fetched = if is_network {
        run_git(
            Some(&mirror),
            &[
                "fetch",
                "--no-tags",
                "--depth",
                "1",
                "--force",
                repo,
                &refspec,
            ],
            token,
            base,
        )
        .or_else(|_| {
            run_git(
                Some(&mirror),
                &["fetch", "--no-tags", "--force", repo, &refspec],
                token,
                base,
            )
        })
    } else {
        run_git(
            Some(&mirror),
            &["fetch", "--no-tags", "--force", repo, &refspec],
            token,
            base,
        )
    };
    fetched.map(drop)
}

/// Raw entry parsed from `git ls-tree -r -z -l`.
struct GitTreeItem {
    mode: String,
    oid: String,
    path: String,
}

/// Read all entries and compute SHA-256 digests for `commit` out of `repo.git` using a single
/// `git cat-file --batch` invocation.
fn read_tree_snapshot(base: &Path, commit: &str) -> Result<TreeSnapshot, String> {
    let mirror = mirror_dir(base);
    let tree_out = run_git(Some(&mirror), &["ls-tree", "-r", "-z", commit], None, base)?;
    let mut items = Vec::new();
    for record in tree_out.split(|&b| b == 0) {
        if record.is_empty() {
            continue;
        }
        let Some(tab) = record.iter().position(|&b| b == b'\t') else {
            continue;
        };
        let header = std::str::from_utf8(&record[..tab])
            .map_err(|error| format!("non-UTF-8 git ls-tree header: {error}"))?;
        let path = std::str::from_utf8(&record[tab + 1..])
            .map_err(|error| format!("non-UTF-8 dotfiles path in git tree: {error}"))?
            .to_owned();
        let mut parts = header.split_whitespace();
        let (Some(mode), Some(kind), Some(oid)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        if kind != "blob" {
            // Skip submodules (`commit`) or unexpected types.
            continue;
        }
        if is_ignored_path(&path) {
            continue;
        }
        if !matches!(mode, "100644" | "100755" | "120000") {
            continue;
        }
        items.push(GitTreeItem {
            mode: mode.to_owned(),
            oid: oid.to_owned(),
            path,
        });
    }

    if items.is_empty() {
        return Ok(TreeSnapshot {
            commit: commit.to_owned(),
            entries: Vec::new(),
            git_oids: HashMap::new(),
        });
    }

    let mut entries = Vec::with_capacity(items.len());
    let mut git_oids = HashMap::new();
    let blobs = read_git_blobs(
        &mirror,
        items.iter().map(|item| item.oid.as_str()).collect(),
    )?;

    for (item, bytes) in items.into_iter().zip(blobs) {
        match item.mode.as_str() {
            "120000" => {
                let target = String::from_utf8(bytes).map_err(|error| {
                    format!("non-UTF-8 symlink target at {}: {error}", item.path)
                })?;
                entries.push(DotfilesEntry {
                    path: item.path,
                    kind: DotfilesEntryKind::Symlink { target },
                });
            }
            "100644" | "100755" => {
                let sha256 = sha256_hex(&bytes);
                let size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
                git_oids.entry(sha256.clone()).or_insert(item.oid);
                entries.push(DotfilesEntry {
                    path: item.path,
                    kind: DotfilesEntryKind::File {
                        sha256,
                        size,
                        executable: item.mode == "100755",
                    },
                });
            }
            _ => {}
        }
    }

    Ok(TreeSnapshot {
        commit: commit.to_owned(),
        entries,
        git_oids,
    })
}

/// Read raw bytes of `oids` in order from `mirror` via a single `git cat-file --batch` process.
fn read_git_blobs(mirror: &Path, oids: Vec<&str>) -> Result<Vec<Vec<u8>>, String> {
    if oids.is_empty() {
        return Ok(Vec::new());
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(mirror)
        .args(["cat-file", "--batch"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("spawning git cat-file: {error}"))?;

    let input: String = oids
        .iter()
        .fold(String::with_capacity(oids.len() * 41), |mut acc, oid| {
            acc.push_str(oid);
            acc.push('\n');
            acc
        });
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "git cat-file had no stdin".to_owned())?;
    let writer = std::thread::spawn(move || stdin.write_all(input.as_bytes()));

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "git cat-file had no stdout".to_owned())?;
    let mut reader = BufReader::new(stdout);
    let mut out = Vec::with_capacity(oids.len());
    let mut header = String::new();
    for oid in &oids {
        header.clear();
        let read = reader
            .read_line(&mut header)
            .map_err(|error| format!("reading git cat-file header for {oid}: {error}"))?;
        if read == 0 {
            return Err(format!("unexpected EOF from git cat-file for {oid}"));
        }
        let line = header.trim_end_matches(['\r', '\n']);
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 3 {
            return Err(format!("git object {oid} missing in mirror ({line})"));
        }
        let size: usize = parts[2]
            .parse()
            .map_err(|error| format!("bad git object size for {oid}: {error}"))?;
        let mut buf = vec![0u8; size];
        reader
            .read_exact(&mut buf)
            .map_err(|error| format!("reading git object {oid}: {error}"))?;
        // Trailing newline after object payload.
        let mut nl = [0u8; 1];
        reader
            .read_exact(&mut nl)
            .map_err(|error| format!("reading git object delimiter for {oid}: {error}"))?;
        out.push(buf);
    }

    let write_res = writer
        .join()
        .map_err(|_| "writing to git cat-file panicked".to_owned())?;
    if let Err(error) = write_res {
        return Err(format!("writing oids to git cat-file: {error}"));
    }
    let status = child
        .wait()
        .map_err(|error| format!("waiting for git cat-file: {error}"))?;
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut err) = child.stderr.take() {
            let _ = err.read_to_string(&mut stderr);
        }
        return Err(format!("git cat-file failed: {}", stderr.trim()));
    }
    Ok(out)
}

/// Pack `(sha256, bytes)` blobs into `PutDotfilesBlobsRequest` batches where each batch carries at
/// most `MAX_CHUNK_BYTES` of raw payload bytes, splitting any oversized blob into sequential chunks.
fn pack_blob_batches(blobs: Vec<(String, Vec<u8>)>) -> Vec<PutDotfilesBlobsRequest> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut current_bytes = 0usize;

    for (sha256, bytes) in blobs {
        let total_size = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if bytes.is_empty() {
            current.push(DotfilesBlobChunk {
                sha256,
                offset: 0,
                total_size: 0,
                data: String::new(),
            });
            continue;
        }
        let mut offset = 0usize;
        while offset < bytes.len() {
            let remaining = bytes.len() - offset;
            // Flush current batch if this piece doesn't fit and current batch isn't empty.
            if !current.is_empty()
                && current_bytes + remaining.min(MAX_CHUNK_BYTES) > MAX_CHUNK_BYTES
            {
                batches.push(PutDotfilesBlobsRequest {
                    chunks: std::mem::take(&mut current),
                });
                current_bytes = 0;
            }
            let room = MAX_CHUNK_BYTES.saturating_sub(current_bytes).max(1);
            let take = remaining.min(room).min(MAX_CHUNK_BYTES);
            let slice = &bytes[offset..offset + take];
            current.push(DotfilesBlobChunk {
                sha256: sha256.clone(),
                offset: u64::try_from(offset).unwrap_or(u64::MAX),
                total_size,
                data: BASE64.encode(slice),
            });
            current_bytes += take;
            offset += take;
            if current_bytes >= MAX_CHUNK_BYTES {
                batches.push(PutDotfilesBlobsRequest {
                    chunks: std::mem::take(&mut current),
                });
                current_bytes = 0;
            }
        }
    }
    if !current.is_empty() {
        batches.push(PutDotfilesBlobsRequest { chunks: current });
    }
    batches
}

fn validate_repo(repo: &str) -> Result<String, Error> {
    let trimmed = repo.trim();
    if trimmed.is_empty() {
        return Err(invalid("a dotfiles repository URL is required"));
    }
    if trimmed.chars().any(char::is_control) || trimmed.starts_with('-') {
        return Err(invalid(
            "dotfiles repository URL must be a plain URL or path",
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_branch(branch: &str) -> Result<String, Error> {
    let trimmed = branch.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('-')
        || trimmed.chars().any(|c| c.is_control() || c.is_whitespace())
        || trimmed.contains("..")
    {
        return Err(invalid("dotfiles branch must be a plain branch name"));
    }
    Ok(trimmed.to_owned())
}

impl Shared {
    /// Current dotfiles settings and every Host's sync status.
    pub(crate) fn dotfiles_status(&self) -> Result<DotfilesStatus, Error> {
        let settings = self.store.dotfiles_settings().map_err(internal)?;
        let stored_hosts = self.store.dotfiles_hosts().map_err(internal)?;
        let hosts = self.store.hosts().map_err(internal)?;
        let mut statuses = Vec::with_capacity(hosts.len());
        for host in hosts {
            let connected = self.connected(&host.host_id);
            let saved = stored_hosts.get(&host.host_id).cloned().unwrap_or_default();
            statuses.push(DotfilesHostStatus {
                host_id: host.host_id,
                host_name: host.name,
                connected,
                configured_mode: saved.mode,
                active_mode: saved.active_mode,
                commit: saved.commit,
                local_path: saved.local_path,
                dirty: saved.dirty,
                ahead: saved.ahead,
                linked: saved.linked,
                removed: saved.removed,
                conflicts: saved.conflicts,
                synced_at: saved.synced_at,
                error: saved.error,
            });
        }
        Ok(DotfilesStatus {
            settings,
            hosts: statuses,
        })
    }

    /// Configure (or update) the dotfiles repository on the Dispatcher, fetch immediately, and
    /// sync all connected Hosts.
    pub(crate) async fn set_dotfiles(
        self: &Arc<Self>,
        request: SetDotfilesRequest,
    ) -> Result<DotfilesStatus, Error> {
        let repo = validate_repo(&request.repo)?;
        let current = self.store.dotfiles_settings().map_err(internal)?;
        let branch = match request.branch {
            Some(branch) => validate_branch(&branch)?,
            None => current.branch.clone(),
        };
        let git_credential = match request.git_credential {
            Some(Some(name)) => {
                let name = name.trim().to_owned();
                if name.is_empty() {
                    None
                } else {
                    let cred = self
                        .store
                        .credential(&name)
                        .map_err(internal)?
                        .ok_or_else(|| invalid(format!("no credential called {name}")))?;
                    if cred.kind != CredentialKind::Token {
                        return Err(invalid(format!(
                            "credential {name} is a sign-in, not a token"
                        )));
                    }
                    Some(cred.name)
                }
            }
            Some(None) => None,
            None => current.git_credential.clone(),
        };
        let poll_interval_secs = request
            .poll_interval_secs
            .unwrap_or(if current.repo.is_some() {
                current.poll_interval_secs
            } else {
                DEFAULT_DOTFILES_POLL_SECS
            });
        let remote = canonical_remote(&repo);

        self.store
            .save_dotfiles_settings(
                &repo,
                remote.as_deref(),
                &branch,
                git_credential.as_deref(),
                poll_interval_secs,
            )
            .map_err(internal)?;
        self.dotfiles.set_snapshot(None);
        self.dotfiles_changed.notify_one();

        let _ = self.fetch_dotfiles(true).await;
        self.sync_dotfiles_all().await;
        self.dotfiles_status()
    }

    /// Clear the dotfiles configuration and tell every connected Host to unlink weave-managed
    /// symlinks.
    pub(crate) async fn clear_dotfiles(self: &Arc<Self>) -> Result<DotfilesStatus, Error> {
        self.store.clear_dotfiles_settings().map_err(internal)?;
        self.dotfiles.set_snapshot(None);
        let mirror = self.config.paths.dotfiles();
        let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(mirror)).await;
        self.dotfiles_changed.notify_one();
        self.sync_dotfiles_all().await;
        self.dotfiles_status()
    }

    /// Fetch immediately from git and sync all connected Hosts.
    pub(crate) async fn sync_dotfiles_now(self: &Arc<Self>) -> Result<DotfilesStatus, Error> {
        let settings = self.store.dotfiles_settings().map_err(internal)?;
        if settings.repo.is_none() {
            return Err(invalid(
                "no dotfiles repository is configured; run `weave dotfiles set <repo>` first",
            ));
        }
        let _ = self.fetch_dotfiles(true).await;
        self.sync_dotfiles_all().await;
        self.dotfiles_status()
    }

    /// Set one Host's dotfiles mode override and sync that Host immediately if connected.
    pub(crate) async fn set_dotfiles_host(
        self: &Arc<Self>,
        host_by: &str,
        mode: DotfilesMode,
    ) -> Result<DotfilesStatus, Error> {
        let host = self.resolve_host(host_by)?;
        self.store
            .set_dotfiles_host_mode(&host.host_id, mode)
            .map_err(internal)?;
        if let Some(handle) = self.handle(&host.host_id) {
            self.sync_dotfiles_to(&host.host_id, &handle).await;
        }
        self.dotfiles_status()
    }

    /// Check the remote branch and fetch into `repo.git` if the commit SHA changed (or `force`).
    /// Returns `Ok(true)` if a new commit was fetched.
    pub(crate) async fn fetch_dotfiles(&self, force: bool) -> Result<bool, String> {
        let _guard = self.dotfiles.fetching.lock().await;
        let settings = self.store.dotfiles_settings()?;
        let Some(repo) = settings.repo.clone() else {
            return Ok(false);
        };
        let branch = settings.branch.clone();

        // Resolve optional private-repo git token from the encrypted credential store.
        let token: Option<Zeroizing<String>> = match settings.git_credential.as_deref() {
            Some(cred_name) => match self.credentials.value(&self.store, cred_name) {
                Ok(Some((CredentialKind::Token, value))) => Some(value),
                Ok(Some((CredentialKind::SignIn, _))) => {
                    let msg = format!("credential {cred_name} is a sign-in, not a token");
                    let _ = self.store.record_dotfiles_fetch_error(&msg);
                    return Err(msg);
                }
                Ok(None) => {
                    let msg = format!("credential {cred_name} was not found");
                    let _ = self.store.record_dotfiles_fetch_error(&msg);
                    return Err(msg);
                }
                Err(error) => {
                    let msg = if weave_host_protocol::errors::is(
                        &error,
                        weave_host_protocol::errors::CREDENTIALS_LOCKED,
                    ) {
                        "credentials are locked; unlock them to fetch dotfiles updates".to_owned()
                    } else {
                        error.message
                    };
                    let _ = self.store.record_dotfiles_fetch_error(&msg);
                    return Err(msg);
                }
            },
            None => None,
        };

        let base = self.config.paths.dotfiles();
        let prev_commit = settings.commit.clone();
        let fetch_result = tokio::task::spawn_blocking(move || {
            let tok = token.as_deref().map(String::as_str);
            let remote_commit = ls_remote_commit(&repo, &branch, tok, &base)?;
            let changed = prev_commit.as_deref() != Some(remote_commit.as_str());
            if !changed && !force && mirror_dir(&base).is_dir() {
                let tree_spec = format!("{remote_commit}^{{tree}}");
                if run_git(
                    Some(&mirror_dir(&base)),
                    &["cat-file", "-e", &tree_spec],
                    None,
                    &base,
                )
                .is_ok()
                {
                    return Ok((remote_commit, false, None));
                }
            }
            ensure_mirror_commit(&base, &repo, &branch, &remote_commit, tok)?;
            let snapshot = read_tree_snapshot(&base, &remote_commit)?;
            Ok::<_, String>((remote_commit, changed, Some(snapshot)))
        })
        .await
        .map_err(|error| format!("dotfiles fetch task failed: {error}"))?;

        match fetch_result {
            Ok((commit, changed, snapshot)) => {
                if let Some(snapshot) = snapshot {
                    self.dotfiles.set_snapshot(Some(snapshot));
                }
                let now = self.config.clock.now();
                let _ = self.store.record_dotfiles_fetch(&commit, now);
                Ok(changed)
            }
            Err(why) => {
                let _ = self.store.record_dotfiles_fetch_error(&why);
                tracing::warn!(%why, "fetching dotfiles repository failed");
                Err(why)
            }
        }
    }

    /// Load the cached tree snapshot for `commit` (from memory or `repo.git`).
    async fn load_snapshot(&self, commit: &str) -> Result<TreeSnapshot, String> {
        if let Some(snapshot) = self.dotfiles.cached_snapshot(commit) {
            return Ok(snapshot);
        }
        let base = self.config.paths.dotfiles();
        let commit_owned = commit.to_owned();
        let snapshot =
            tokio::task::spawn_blocking(move || read_tree_snapshot(&base, &commit_owned))
                .await
                .map_err(|error| format!("reading dotfiles mirror failed: {error}"))??;
        self.dotfiles.set_snapshot(Some(snapshot.clone()));
        Ok(snapshot)
    }

    /// Sync dotfiles to every connected Host (waiting for all of them to finish).
    pub(crate) async fn sync_dotfiles_all(self: &Arc<Self>) {
        let handles: Vec<(String, HostHandle)> = lock(&self.links)
            .iter()
            .filter_map(|(host_id, link)| Some((host_id.clone(), link.seen().handle?)))
            .collect();
        let mut tasks = Vec::with_capacity(handles.len());
        for (host_id, handle) in handles {
            let shared = Arc::clone(self);
            tasks.push(tokio::spawn(async move {
                shared.sync_dotfiles_to(&host_id, &handle).await;
            }));
        }
        for task in tasks {
            let _ = task.await;
        }
    }

    /// Sync dotfiles to one Host (called on connect, after fetch, on clear, and on host mode
    /// change).
    pub(crate) async fn sync_dotfiles_to(&self, host_id: &str, handle: &HostHandle) {
        let takes = handle
            .hello()
            .features
            .iter()
            .any(|feature| feature == DOTFILES_FEATURE);
        if !takes {
            return;
        }
        let host_lock = self.dotfiles.host_lock(host_id);
        let _guard = host_lock.lock().await;

        let settings = match self.store.dotfiles_settings() {
            Ok(settings) => settings,
            Err(why) => {
                tracing::warn!(host = %host_id, %why, "couldn't read dotfiles settings");
                return;
            }
        };
        let mode = self
            .store
            .dotfiles_host_mode(host_id)
            .unwrap_or(DotfilesMode::Auto);

        // If dotfiles aren't configured (or cleared), tell synced Hosts to unlink if they ever
        // held managed symlinks.
        if settings.repo.is_none() {
            let had_synced = self
                .store
                .dotfiles_hosts()
                .ok()
                .and_then(|map| map.get(host_id).cloned())
                .is_some_and(|row| row.linked > 0 || row.active_mode.is_some());
            if !had_synced {
                return;
            }
            match handle
                .send(PlanDotfilesRequest {
                    clear: true,
                    mode,
                    ..PlanDotfilesRequest::default()
                })
                .await
            {
                Ok(plan) => {
                    if let Some(report) = plan.report {
                        let _ = self.store.record_dotfiles_host_report(
                            host_id,
                            &report,
                            self.config.clock.now(),
                        );
                    }
                }
                Err(error) => {
                    let _ = self
                        .store
                        .record_dotfiles_host_error(host_id, &error.message);
                }
            }
            return;
        }

        // If we haven't fetched any commit yet (e.g., locked on first setup), we can still ask
        // `local` / `off` Hosts or wait for a fetch.
        let Some(commit) = settings.commit.clone() else {
            if matches!(mode, DotfilesMode::Local | DotfilesMode::Off) {
                match handle
                    .send(PlanDotfilesRequest {
                        remote: settings.remote.clone(),
                        branch: Some(settings.branch.clone()),
                        mode,
                        clear: mode == DotfilesMode::Off,
                        commit: None,
                        entries: Vec::new(),
                    })
                    .await
                {
                    Ok(plan) => {
                        if let Some(report) = plan.report {
                            let _ = self.store.record_dotfiles_host_report(
                                host_id,
                                &report,
                                self.config.clock.now(),
                            );
                        }
                    }
                    Err(error) => {
                        let _ = self
                            .store
                            .record_dotfiles_host_error(host_id, &error.message);
                    }
                }
            }
            return;
        };

        let snapshot = match self.load_snapshot(&commit).await {
            Ok(snapshot) => snapshot,
            Err(why) => {
                tracing::warn!(host = %host_id, %why, "couldn't load cached dotfiles snapshot");
                let _ = self.store.record_dotfiles_host_error(host_id, &why);
                return;
            }
        };

        let plan = match handle
            .send(PlanDotfilesRequest {
                remote: settings.remote.clone(),
                branch: Some(settings.branch.clone()),
                mode,
                clear: false,
                commit: Some(snapshot.commit.clone()),
                entries: snapshot.entries.clone(),
            })
            .await
        {
            Ok(plan) => plan,
            Err(error) => {
                tracing::warn!(host = %host_id, error = %error.message, "dotfiles/plan failed");
                let _ = self
                    .store
                    .record_dotfiles_host_error(host_id, &error.message);
                return;
            }
        };

        if let Some(report) = plan.report {
            let _ =
                self.store
                    .record_dotfiles_host_report(host_id, &report, self.config.clock.now());
            return;
        }

        // Read missing blobs from the bare mirror and upload in bounded chunks.
        let mut missing_pairs = Vec::with_capacity(plan.missing.len());
        for sha256 in &plan.missing {
            let Some(oid) = snapshot.git_oids.get(sha256) else {
                let why = format!("Host requested unknown blob {sha256}");
                let _ = self.store.record_dotfiles_host_error(host_id, &why);
                return;
            };
            missing_pairs.push((sha256.clone(), oid.clone()));
        }

        let mirror = mirror_dir(&self.config.paths.dotfiles());
        let blobs = match tokio::task::spawn_blocking(move || {
            let oid_refs: Vec<&str> = missing_pairs.iter().map(|(_, oid)| oid.as_str()).collect();
            let raw = read_git_blobs(&mirror, oid_refs)?;
            Ok::<_, String>(
                missing_pairs
                    .into_iter()
                    .map(|(sha, _)| sha)
                    .zip(raw)
                    .collect::<Vec<_>>(),
            )
        })
        .await
        {
            Ok(Ok(blobs)) => blobs,
            Ok(Err(why)) => {
                let _ = self.store.record_dotfiles_host_error(host_id, &why);
                return;
            }
            Err(error) => {
                let _ = self
                    .store
                    .record_dotfiles_host_error(host_id, &error.to_string());
                return;
            }
        };

        for batch in pack_blob_batches(blobs) {
            if let Err(error) = handle.send(batch).await {
                tracing::warn!(host = %host_id, error = %error.message, "dotfiles/put failed");
                let _ = self
                    .store
                    .record_dotfiles_host_error(host_id, &error.message);
                return;
            }
        }

        match handle
            .send(ApplyDotfilesRequest {
                commit: snapshot.commit.clone(),
            })
            .await
        {
            Ok(report) => {
                let _ = self.store.record_dotfiles_host_report(
                    host_id,
                    &report,
                    self.config.clock.now(),
                );
            }
            Err(error) => {
                tracing::warn!(host = %host_id, error = %error.message, "dotfiles/apply failed");
                let _ = self
                    .store
                    .record_dotfiles_host_error(host_id, &error.message);
            }
        }
    }
}

/// Background polling loop on `Clock`: checks `git ls-remote` every `poll_interval_secs` and
/// fans out new commits to all connected Hosts.
pub(crate) async fn run(shared: Arc<Shared>) {
    let mut next_poll: Option<u64> = None;
    loop {
        let settings = match shared.store.dotfiles_settings() {
            Ok(settings) => settings,
            Err(why) => {
                tracing::warn!(%why, "reading dotfiles settings failed");
                let wake = shared.config.clock.now().saturating_add(60_000);
                tokio::select! {
                    () = shared.config.clock.wait_until(wake) => continue,
                    () = shared.dotfiles_changed.notified() => {
                        next_poll = None;
                        continue;
                    }
                    () = shared.stop.cancelled() => return,
                }
            }
        };

        if settings.repo.is_none() || settings.poll_interval_secs == 0 {
            next_poll = None;
            tokio::select! {
                () = shared.dotfiles_changed.notified() => continue,
                () = shared.stop.cancelled() => return,
            }
        }

        let now = shared.config.clock.now();
        let interval_ms = settings
            .poll_interval_secs
            .saturating_mul(1000)
            .min(IDLE_WAIT_MS);
        let due_at = *next_poll.get_or_insert_with(|| now.saturating_add(interval_ms));
        if now >= due_at {
            next_poll = Some(now.saturating_add(interval_ms));
            if let Ok(true) = shared.fetch_dotfiles(false).await {
                tracing::info!("fetched new dotfiles commit; syncing connected Hosts");
                shared.sync_dotfiles_all().await;
            }
            continue;
        }

        tokio::select! {
            () = shared.config.clock.wait_until(due_at) => {}
            () = shared.dotfiles_changed.notified() => {
                next_poll = None;
                // Woken after unlock or settings change: if there's an unrecovered fetch error
                // (e.g., credentials just unlocked), try fetching right away.
                if let Ok(latest) = shared.store.dotfiles_settings()
                    && latest.repo.is_some()
                    && (latest.commit.is_none() || latest.fetch_error.is_some())
                    && matches!(shared.fetch_dotfiles(false).await, Ok(true))
                {
                    shared.sync_dotfiles_all().await;
                }
            }
            () = shared.stop.cancelled() => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn canonical_remote_normalizes_https_ssh_and_scp() {
        assert_eq!(
            canonical_remote("https://github.com/jacobfvanzyl/.dotfiles.git").as_deref(),
            Some("github.com/jacobfvanzyl/.dotfiles")
        );
        assert_eq!(
            canonical_remote("git@github.com:jacobfvanzyl/.dotfiles.git").as_deref(),
            Some("github.com/jacobfvanzyl/.dotfiles")
        );
        assert_eq!(
            canonical_remote("ssh://git@GitHub.com:22/jacobfvanzyl/.dotfiles/").as_deref(),
            Some("github.com/jacobfvanzyl/.dotfiles")
        );
    }

    #[test]
    fn stow_root_ignores_skip_meta_files_only_at_root() {
        assert!(is_ignored_path("README.md"));
        assert!(is_ignored_path("LICENSE"));
        assert!(is_ignored_path(".gitignore"));
        assert!(is_ignored_path(".DS_Store"));
        assert!(is_ignored_path(".config/.DS_Store"));
        assert!(is_ignored_path(".stow-local-ignore"));
        // Nested README / .gitignore inside `.config/nvim/` stay synced!
        assert!(!is_ignored_path(".config/nvim/README.md"));
        assert!(!is_ignored_path(".config/nvim/.gitignore"));
        assert!(!is_ignored_path(".zshrc"));
    }

    #[test]
    fn pack_blob_batches_packs_small_and_splits_large() {
        let large = vec![b'x'; MAX_CHUNK_BYTES + 123];
        let small1 = b"hello".to_vec();
        let small2 = b"world".to_vec();
        let batches = pack_blob_batches(vec![
            ("a".repeat(64), small1),
            ("b".repeat(64), small2),
            ("c".repeat(64), large),
        ]);
        // Two small blobs pack together; large blob splits across two chunks.
        assert_eq!(batches.len(), 3);
        assert_eq!(batches[0].chunks.len(), 2);
        assert_eq!(batches[1].chunks.len(), 1);
        assert_eq!(batches[1].chunks[0].offset, 0);
        assert_eq!(batches[2].chunks.len(), 1);
        assert_eq!(batches[2].chunks[0].offset, MAX_CHUNK_BYTES as u64);
    }
}
