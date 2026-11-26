//! The person's dotfiles as this Host holds and places them (ADR 0037, WVE-243).
//!
//! Only the Dispatcher this Host joined may call `dotfiles/plan`, `dotfiles/put` and
//! `dotfiles/apply`. Synced files are stored content-addressed under `$WEAVE_DAEMON_DIR/dotfiles/`
//! (`blobs/<sha256>`, `files/<path>`, `manifest.json`) and linked into `$HOME` via file-level
//! symlinks so machine-local state under `~/.config` and `~/.ssh` stays local. When `mode` is
//! `auto` and `$HOME` already holds a git checkout matching the configured canonical remote (such
//! as `~/.dotfiles`), the Host stays in `local` authoring mode without touching symlinks.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::collections::HashSet;
use std::io::Write as _;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use agent_client_protocol::Error;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest as _;
use sha2::Sha256;
use tokio::sync::Mutex;
use weave_host_protocol::dotfiles::ApplyDotfilesRequest;
use weave_host_protocol::dotfiles::DotfilesActiveMode;
use weave_host_protocol::dotfiles::DotfilesConflict;
use weave_host_protocol::dotfiles::DotfilesEntry;
use weave_host_protocol::dotfiles::DotfilesEntryKind;
use weave_host_protocol::dotfiles::DotfilesHostReport;
use weave_host_protocol::dotfiles::DotfilesMode;
use weave_host_protocol::dotfiles::MAX_CHUNK_BYTES;
use weave_host_protocol::dotfiles::PlanDotfilesRequest;
use weave_host_protocol::dotfiles::PlanDotfilesResponse;
use weave_host_protocol::dotfiles::PutDotfilesBlobsRequest;

use crate::git::Git;
use crate::journal::create_private_dir;
use crate::journal::private_file;

/// What this Host persists in `manifest.json`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct StoredManifest {
    commit: Option<String>,
    /// Relative paths under `$HOME` whose symlinks weave currently owns.
    managed: BTreeSet<String>,
    /// Unmanaged paths skipped during the last apply, so a later sync re-tries them.
    #[serde(default)]
    conflicts: Vec<DotfilesConflict>,
}

/// A plan staged by `dotfiles/plan` while waiting for `dotfiles/put` + `dotfiles/apply`.
struct StagedPlan {
    commit: String,
    entries: Vec<DotfilesEntry>,
    /// Expected total size for each missing SHA-256 requested in the plan.
    expected: HashMap<String, u64>,
    /// Bytes written so far to `staging/<sha256>.part` for each in-flight blob.
    progress: HashMap<String, u64>,
}

struct State {
    manifest: StoredManifest,
    staged: Option<StagedPlan>,
}

pub(crate) struct Dotfiles {
    /// `$WEAVE_DAEMON_DIR/dotfiles`; none for an in-process Host that joins no Dispatcher.
    dir: Option<PathBuf>,
    home: PathBuf,
    state: Mutex<State>,
}

fn invalid(why: impl Into<String>) -> Error {
    Error::invalid_params().data(why.into())
}

fn internal(why: impl Into<String>) -> Error {
    Error::internal_error().data(why.into())
}

/// Validate that `sha256` is 64 lowercase ASCII hex characters (safe as a filename).
fn valid_sha256(sha256: &str) -> bool {
    sha256.len() == 64
        && sha256
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Validate a relative dotfiles path under `$HOME`: plain components only, never `.git`.
fn validate_path(path: &str) -> Result<PathBuf, Error> {
    if path.is_empty() || path.contains('\0') || path.contains('\\') {
        return Err(invalid(format!("invalid dotfiles path: {path}")));
    }
    let rel = Path::new(path);
    let mut components = rel.components();
    let Some(first) = components.next() else {
        return Err(invalid(format!("invalid dotfiles path: {path}")));
    };
    let Component::Normal(first_name) = first else {
        return Err(invalid(format!(
            "dotfiles path must stay under home: {path}"
        )));
    };
    if first_name == ".git" {
        return Err(invalid("dotfiles may not place files inside ~/.git"));
    }
    if !components.all(|component| matches!(component, Component::Normal(_))) {
        return Err(invalid(format!(
            "dotfiles path must stay under home: {path}"
        )));
    }
    Ok(rel.to_path_buf())
}

fn validate_entries(entries: &[DotfilesEntry]) -> Result<(), Error> {
    let mut seen = HashSet::with_capacity(entries.len());
    for entry in entries {
        validate_path(&entry.path)?;
        if !seen.insert(entry.path.as_str()) {
            return Err(invalid(format!("duplicate dotfiles path: {}", entry.path)));
        }
        match &entry.kind {
            DotfilesEntryKind::File { sha256, .. } => {
                if !valid_sha256(sha256) {
                    return Err(invalid(format!(
                        "invalid sha256 for {}: {sha256}",
                        entry.path
                    )));
                }
            }
            DotfilesEntryKind::Symlink { target } => {
                if target.is_empty() || target.contains('\0') {
                    return Err(invalid(format!(
                        "invalid symlink target for {}",
                        entry.path
                    )));
                }
            }
        }
    }
    Ok(())
}

fn blobs_dir(dir: &Path) -> PathBuf {
    dir.join("blobs")
}

fn staging_dir(dir: &Path) -> PathBuf {
    dir.join("staging")
}

fn files_dir(dir: &Path) -> PathBuf {
    dir.join("files")
}

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join("manifest.json")
}

fn read_manifest(dir: &Path) -> StoredManifest {
    let path = manifest_path(dir);
    let Ok(bytes) = std::fs::read(&path) else {
        return StoredManifest::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(manifest) => manifest,
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "dotfiles manifest couldn't be read; starting fresh");
            StoredManifest::default()
        }
    }
}

fn write_manifest(dir: &Path, manifest: &StoredManifest) -> std::io::Result<()> {
    create_private_dir(dir)?;
    let path = manifest_path(dir);
    let temp = dir.join("manifest.json.tmp");
    let bytes = serde_json::to_vec_pretty(manifest).map_err(std::io::Error::other)?;
    let written = (|| {
        let mut out = private_file(&temp, true)?;
        out.write_all(&bytes)?;
        out.sync_all()?;
        std::fs::rename(&temp, &path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
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

fn sha256_file(path: &Path) -> std::io::Result<String> {
    use std::io::Read as _;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    Ok(out)
}

/// Whether `rel` lives under `~/.ssh/` (so OpenSSH requires `0700` dir and `0600` files).
fn is_ssh_path(rel: &Path) -> bool {
    matches!(rel.components().next(), Some(Component::Normal(first)) if first == ".ssh")
}

/// Replace or create a symlink at `dest` pointing to `target`.
#[cfg(unix)]
fn place_symlink(dest: &Path, target: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::symlink;
    // Create beside `dest` and rename so existing links are swapped atomically.
    let parent = dest.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "symlink has no parent")
    })?;
    let name = dest
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "link".to_owned());
    let temp = parent.join(format!(".{name}.weave-tmp"));
    let _ = std::fs::remove_file(&temp);
    symlink(target, &temp)?;
    if let Err(error) = std::fs::rename(&temp, dest) {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    Ok(())
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

/// Remove empty directories upward from `start` while staying strictly inside `stop_at`.
fn prune_empty_parents(mut dir: Option<&Path>, stop_at: &Path) {
    while let Some(current) = dir {
        if current == stop_at || !current.starts_with(stop_at) {
            break;
        }
        if std::fs::remove_dir(current).is_err() {
            break;
        }
        dir = current.parent();
    }
}

/// Check if `link_target` resolves into `files_root` (either directly or joined to `dest`'s parent).
fn points_into(dest: &Path, link_target: &Path, files_root: &Path) -> bool {
    let resolved = if link_target.is_absolute() {
        link_target.to_path_buf()
    } else {
        dest.parent().map_or_else(
            || link_target.to_path_buf(),
            |parent| parent.join(link_target),
        )
    };
    resolved.starts_with(files_root)
}

/// Materialize one file from `blobs/<sha256>` into `files/<rel>` with the requested mode.
fn materialize_file(blob_path: &Path, materialized_path: &Path, mode: u32) -> std::io::Result<()> {
    if let Some(parent) = materialized_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = materialized_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_owned());
    let temp = materialized_path.parent().map_or_else(
        || PathBuf::from(format!(".{name}.weave-tmp")),
        |parent| parent.join(format!(".{name}.weave-tmp")),
    );
    let written = (|| {
        std::fs::copy(blob_path, &temp)?;
        set_mode(&temp, mode)?;
        std::fs::rename(&temp, materialized_path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// Unlink every weave-managed symlink listed in `manifest.managed`, leaving unmanaged files alone.
fn unlink_managed(home: &Path, dir: &Path, manifest: &mut StoredManifest) -> u32 {
    let files_root = files_dir(dir);
    let mut removed = 0u32;
    let managed = std::mem::take(&mut manifest.managed);
    for rel_str in managed {
        let rel = Path::new(&rel_str);
        let dest = home.join(rel);
        let Ok(meta) = std::fs::symlink_metadata(&dest) else {
            continue;
        };
        if !meta.file_type().is_symlink() {
            continue;
        }
        if std::fs::remove_file(&dest).is_ok() {
            removed = removed.saturating_add(1);
            prune_empty_parents(dest.parent(), home);
        }
        let materialized = files_root.join(rel);
        let _ = std::fs::remove_file(&materialized);
        prune_empty_parents(materialized.parent(), &files_root);
    }
    manifest.commit = None;
    manifest.conflicts.clear();
    let _ = std::fs::remove_dir_all(&files_root);
    let _ = std::fs::remove_dir_all(blobs_dir(dir));
    let _ = std::fs::remove_dir_all(staging_dir(dir));
    let _ = write_manifest(dir, manifest);
    removed
}

/// Apply `entries` at `commit` into `home`, updating `manifest` and garbage-collecting unused blobs.
fn apply_entries(
    home: &Path,
    dir: &Path,
    commit: String,
    entries: &[DotfilesEntry],
    prev: &StoredManifest,
) -> Result<(StoredManifest, DotfilesHostReport), Error> {
    create_private_dir(dir).map_err(|error| internal(format!("creating dotfiles dir: {error}")))?;
    let blobs_root = blobs_dir(dir);
    let files_root = files_dir(dir);
    std::fs::create_dir_all(&files_root)
        .map_err(|error| internal(format!("creating dotfiles files dir: {error}")))?;

    // Verify all referenced blobs exist before touching `$HOME`.
    let mut referenced_blobs = HashSet::new();
    for entry in entries {
        if let DotfilesEntryKind::File { sha256, .. } = &entry.kind {
            let blob = blobs_root.join(sha256);
            if !blob.is_file() {
                return Err(invalid(format!(
                    "missing blob {sha256} for {}; run dotfiles/plan again",
                    entry.path
                )));
            }
            referenced_blobs.insert(sha256.clone());
        }
    }

    let mut new_managed = BTreeSet::new();
    let mut conflicts = Vec::new();
    let mut active_materialized = HashSet::new();

    'entries: for entry in entries {
        let rel = validate_path(&entry.path)?;
        let dest = home.join(&rel);

        // Ensure every ancestor directory under `$HOME` is a real directory, never a symlink.
        let mut cursor = home.to_path_buf();
        let ancestors: Vec<_> = rel
            .parent()
            .into_iter()
            .flat_map(Path::components)
            .collect();
        for (idx, component) in ancestors.iter().enumerate() {
            cursor.push(component);
            match std::fs::symlink_metadata(&cursor) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        let ancestor_rel = cursor
                            .strip_prefix(home)
                            .unwrap_or(&cursor)
                            .to_string_lossy()
                            .into_owned();
                        conflicts.push(DotfilesConflict {
                            path: entry.path.clone(),
                            reason: format!(
                                "an unmanaged symlinked directory exists at {ancestor_rel}"
                            ),
                        });
                        continue 'entries;
                    }
                    if !meta.file_type().is_dir() {
                        let ancestor_rel = cursor
                            .strip_prefix(home)
                            .unwrap_or(&cursor)
                            .to_string_lossy()
                            .into_owned();
                        conflicts.push(DotfilesConflict {
                            path: entry.path.clone(),
                            reason: format!(
                                "an unmanaged file exists where directory {ancestor_rel} is needed"
                            ),
                        });
                        continue 'entries;
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&cursor).map_err(|error| {
                        internal(format!("creating {}: {error}", cursor.display()))
                    })?;
                    if idx == 0 && matches!(component, Component::Normal(name) if *name == ".ssh") {
                        set_mode(&cursor, 0o700).map_err(|error| {
                            internal(format!(
                                "setting permissions on {}: {error}",
                                cursor.display()
                            ))
                        })?;
                    }
                }
                Err(error) => {
                    return Err(internal(format!("checking {}: {error}", cursor.display())));
                }
            }
        }

        // Prepare desired symlink target.
        let desired_target = match &entry.kind {
            DotfilesEntryKind::File {
                sha256, executable, ..
            } => {
                let blob_path = blobs_root.join(sha256);
                let materialized = files_root.join(&rel);
                let mode = if is_ssh_path(&rel) {
                    0o600
                } else if *executable {
                    0o755
                } else {
                    0o644
                };
                materialize_file(&blob_path, &materialized, mode).map_err(|error| {
                    internal(format!("materializing {}: {error}", materialized.display()))
                })?;
                active_materialized.insert(entry.path.clone());
                materialized
            }
            DotfilesEntryKind::Symlink { target } => PathBuf::from(target),
        };

        // Check existing path at `$HOME/<rel>`.
        match std::fs::symlink_metadata(&dest) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                place_symlink(&dest, &desired_target)
                    .map_err(|error| internal(format!("linking {}: {error}", dest.display())))?;
                new_managed.insert(entry.path.clone());
            }
            Ok(meta) if meta.file_type().is_symlink() => {
                let current = std::fs::read_link(&dest).map_err(|error| {
                    internal(format!("reading symlink {}: {error}", dest.display()))
                })?;
                if current == desired_target {
                    new_managed.insert(entry.path.clone());
                } else if prev.managed.contains(&entry.path)
                    || points_into(&dest, &current, &files_root)
                {
                    place_symlink(&dest, &desired_target).map_err(|error| {
                        internal(format!("updating symlink {}: {error}", dest.display()))
                    })?;
                    new_managed.insert(entry.path.clone());
                } else {
                    conflicts.push(DotfilesConflict {
                        path: entry.path.clone(),
                        reason: format!(
                            "an unmanaged symlink already exists there (-> {})",
                            current.display()
                        ),
                    });
                }
            }
            Ok(meta) => {
                let what = if meta.file_type().is_dir() {
                    "an unmanaged directory already exists there"
                } else {
                    "an unmanaged file already exists there"
                };
                conflicts.push(DotfilesConflict {
                    path: entry.path.clone(),
                    reason: what.to_owned(),
                });
            }
            Err(error) => {
                return Err(internal(format!("checking {}: {error}", dest.display())));
            }
        }
    }

    // Remove previously managed symlinks that are no longer in the manifest.
    let mut removed = 0u32;
    for old_path in &prev.managed {
        if new_managed.contains(old_path) {
            continue;
        }
        let rel = Path::new(old_path);
        let dest = home.join(rel);
        if let Ok(meta) = std::fs::symlink_metadata(&dest)
            && meta.file_type().is_symlink()
            && std::fs::remove_file(&dest).is_ok()
        {
            removed = removed.saturating_add(1);
            prune_empty_parents(dest.parent(), home);
        }
        if !active_materialized.contains(old_path) {
            let materialized = files_root.join(rel);
            let _ = std::fs::remove_file(&materialized);
            prune_empty_parents(materialized.parent(), &files_root);
        }
    }

    // Garbage-collect unreferenced blobs and clear staging.
    if let Ok(read_dir) = std::fs::read_dir(&blobs_root) {
        for entry in read_dir.flatten() {
            let name = entry.file_name();
            let keep = name
                .to_str()
                .is_some_and(|hex| referenced_blobs.contains(hex));
            if !keep {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    let _ = std::fs::remove_dir_all(staging_dir(dir));

    let linked = u32::try_from(new_managed.len()).unwrap_or(u32::MAX);
    let next_manifest = StoredManifest {
        commit: Some(commit.clone()),
        managed: new_managed,
        conflicts: conflicts.clone(),
    };
    write_manifest(dir, &next_manifest)
        .map_err(|error| internal(format!("saving dotfiles manifest: {error}")))?;

    let report = DotfilesHostReport {
        mode: DotfilesActiveMode::Synced,
        commit: Some(commit),
        local_path: None,
        dirty: false,
        ahead: None,
        linked,
        removed,
        conflicts,
    };
    Ok((next_manifest, report))
}

/// Candidate local git checkout directories under `home` that might hold the person's dotfiles.
fn local_checkout_candidates(home: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let default = home.join(".dotfiles");
    if default.is_dir() {
        candidates.push(default);
    }
    // Also follow common stowed entrypoints (`~/.zshrc`, `~/.config`) in case the person cloned
    // their dotfiles repo elsewhere under `$HOME` (such as `~/dotfiles`).
    for probe in [".zshrc", ".config"] {
        let path = home.join(probe);
        if let Ok(target) = std::fs::read_link(&path) {
            let resolved = if target.is_absolute() {
                target
            } else {
                home.join(target)
            };
            let start = if resolved.is_dir() {
                resolved
            } else if let Some(parent) = resolved.parent() {
                parent.to_path_buf()
            } else {
                continue;
            };
            if let Ok(canonical) = std::fs::canonicalize(&start)
                && !candidates.contains(&canonical)
            {
                candidates.push(canonical);
            }
        }
    }
    candidates
}

fn display_under_home(home: &Path, path: &Path) -> String {
    let home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf());
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    match path.strip_prefix(&home) {
        Ok(rel) if rel.as_os_str().is_empty() => "~".to_owned(),
        Ok(rel) => format!("~/{}", rel.display()),
        Err(_) => path.display().to_string(),
    }
}

impl Dotfiles {
    pub(crate) fn load(dir: Option<PathBuf>, home: PathBuf) -> Self {
        let manifest = dir.as_deref().map(read_manifest).unwrap_or_default();
        Self {
            dir,
            home,
            state: Mutex::new(State {
                manifest,
                staged: None,
            }),
        }
    }

    fn require_dir(&self) -> Result<PathBuf, Error> {
        self.dir
            .clone()
            .ok_or_else(|| internal("this Host has no state directory for dotfiles"))
    }

    /// Inspect `$HOME` for a local authoring checkout matching `remote` (or any `~/.dotfiles`
    /// checkout when `force_local` is true).
    async fn inspect_local(
        &self,
        git: &Git,
        remote: Option<&str>,
        branch: Option<&str>,
        force_local: bool,
    ) -> Option<DotfilesHostReport> {
        let home = self.home.clone();
        let candidates = tokio::task::spawn_blocking(move || local_checkout_candidates(&home))
            .await
            .ok()?;
        let expected_remote = match remote {
            Some(remote) => Some(git.resolved_remote_identity(remote).await),
            None => None,
        };
        for candidate in candidates {
            let Some(info) = git.inspect_dotfiles_checkout(&candidate, branch).await else {
                continue;
            };
            let matches = match (&expected_remote, &info.remote) {
                (Some(expected), Some(actual)) => expected.eq_ignore_ascii_case(actual),
                _ => false,
            };
            if matches || force_local {
                let local_path = display_under_home(&self.home, &info.root);
                return Some(DotfilesHostReport {
                    mode: DotfilesActiveMode::Local,
                    commit: info.commit,
                    local_path: Some(local_path),
                    dirty: info.dirty,
                    ahead: info.ahead,
                    linked: 0,
                    removed: 0,
                    conflicts: Vec::new(),
                });
            }
        }
        if force_local {
            return Some(DotfilesHostReport {
                mode: DotfilesActiveMode::Local,
                commit: None,
                local_path: None,
                dirty: false,
                ahead: None,
                linked: 0,
                removed: 0,
                conflicts: Vec::new(),
            });
        }
        None
    }

    /// `dotfiles/plan`: decide whether this Host is `local`, `off`, `clear`, up to date, or needs
    /// missing blobs uploaded before `dotfiles/apply`.
    pub(crate) async fn plan(
        &self,
        git: &Git,
        request: PlanDotfilesRequest,
    ) -> Result<PlanDotfilesResponse, Error> {
        let dir = self.require_dir()?;
        let mut state = self.state.lock().await;
        state.staged = None;

        if request.clear || request.mode == DotfilesMode::Off {
            let home = self.home.clone();
            let mut manifest = state.manifest.clone();
            let (manifest, removed) = tokio::task::spawn_blocking(move || {
                let removed = unlink_managed(&home, &dir, &mut manifest);
                (manifest, removed)
            })
            .await
            .map_err(|error| internal(format!("clearing dotfiles: {error}")))?;
            state.manifest = manifest;
            return Ok(PlanDotfilesResponse {
                missing: Vec::new(),
                report: Some(DotfilesHostReport {
                    mode: DotfilesActiveMode::Off,
                    commit: None,
                    local_path: None,
                    dirty: false,
                    ahead: None,
                    linked: 0,
                    removed,
                    conflicts: Vec::new(),
                }),
            });
        }

        // Local mode (explicit or auto-detected).
        if request.mode == DotfilesMode::Local {
            let report = self
                .inspect_local(
                    git,
                    request.remote.as_deref(),
                    request.branch.as_deref(),
                    true,
                )
                .await
                .unwrap_or(DotfilesHostReport {
                    mode: DotfilesActiveMode::Local,
                    commit: None,
                    local_path: None,
                    dirty: false,
                    ahead: None,
                    linked: 0,
                    removed: 0,
                    conflicts: Vec::new(),
                });
            return Ok(PlanDotfilesResponse {
                missing: Vec::new(),
                report: Some(report),
            });
        }
        if request.mode == DotfilesMode::Auto
            && let Some(report) = self
                .inspect_local(
                    git,
                    request.remote.as_deref(),
                    request.branch.as_deref(),
                    false,
                )
                .await
        {
            return Ok(PlanDotfilesResponse {
                missing: Vec::new(),
                report: Some(report),
            });
        }

        // Sync mode.
        let Some(commit) = request.commit else {
            return Err(invalid(
                "dotfiles/plan requires a commit unless clear is true",
            ));
        };
        validate_entries(&request.entries)?;

        // Fast path: already at this commit with no unresolved conflicts.
        if state.manifest.commit.as_deref() == Some(commit.as_str())
            && state.manifest.conflicts.is_empty()
            && state.manifest.managed.len() == request.entries.len()
        {
            let linked = u32::try_from(state.manifest.managed.len()).unwrap_or(u32::MAX);
            return Ok(PlanDotfilesResponse {
                missing: Vec::new(),
                report: Some(DotfilesHostReport {
                    mode: DotfilesActiveMode::Synced,
                    commit: Some(commit),
                    local_path: None,
                    dirty: false,
                    ahead: None,
                    linked,
                    removed: 0,
                    conflicts: Vec::new(),
                }),
            });
        }

        // Check which blobs are missing from our local cache.
        let blobs_root = blobs_dir(&dir);
        let entries = request.entries;
        let missing: Vec<(String, u64)> = {
            let entries = entries.clone();
            tokio::task::spawn_blocking(move || {
                let mut seen = HashSet::new();
                let mut missing = Vec::new();
                for entry in &entries {
                    if let DotfilesEntryKind::File { sha256, size, .. } = &entry.kind
                        && seen.insert(sha256.clone())
                        && !blobs_root.join(sha256).is_file()
                    {
                        missing.push((sha256.clone(), *size));
                    }
                }
                missing
            })
            .await
            .map_err(|error| internal(format!("checking cached dotfiles blobs: {error}")))?
        };

        if missing.is_empty() {
            let home = self.home.clone();
            let prev = state.manifest.clone();
            let (next_manifest, report) = tokio::task::spawn_blocking(move || {
                apply_entries(&home, &dir, commit, &entries, &prev)
            })
            .await
            .map_err(|error| internal(format!("applying dotfiles: {error}")))??;
            state.manifest = next_manifest;
            return Ok(PlanDotfilesResponse {
                missing: Vec::new(),
                report: Some(report),
            });
        }

        let missing_hashes: Vec<String> = missing.iter().map(|(hash, _)| hash.clone()).collect();
        let expected: HashMap<String, u64> = missing.into_iter().collect();
        state.staged = Some(StagedPlan {
            commit,
            entries,
            expected,
            progress: HashMap::new(),
        });
        Ok(PlanDotfilesResponse {
            missing: missing_hashes,
            report: None,
        })
    }

    /// `dotfiles/put`: receive chunks for missing blobs, verifying SHA-256 on completion.
    pub(crate) async fn put(&self, request: PutDotfilesBlobsRequest) -> Result<(), Error> {
        let dir = self.require_dir()?;
        let mut state = self.state.lock().await;
        let Some(staged) = state.staged.as_mut() else {
            return Err(invalid(
                "no dotfiles plan is staged; send dotfiles/plan first",
            ));
        };
        if request.chunks.is_empty() {
            return Ok(());
        }

        // Decode and validate offsets before writing to disk.
        let mut decoded = Vec::with_capacity(request.chunks.len());
        let mut planned_progress = staged.progress.clone();
        for chunk in request.chunks {
            if !valid_sha256(&chunk.sha256) {
                return Err(invalid(format!("invalid sha256: {}", chunk.sha256)));
            }
            let Some(&expected_size) = staged.expected.get(&chunk.sha256) else {
                return Err(invalid(format!(
                    "blob {} was not requested by dotfiles/plan",
                    chunk.sha256
                )));
            };
            if chunk.total_size != expected_size {
                return Err(invalid(format!(
                    "blob {} totalSize {} does not match planned size {expected_size}",
                    chunk.sha256, chunk.total_size
                )));
            }
            let bytes = BASE64.decode(&chunk.data).map_err(|error| {
                invalid(format!("invalid base64 for {}: {error}", chunk.sha256))
            })?;
            if bytes.len() > MAX_CHUNK_BYTES {
                return Err(invalid(format!(
                    "chunk for {} exceeds max size ({} > {MAX_CHUNK_BYTES})",
                    chunk.sha256,
                    bytes.len()
                )));
            }
            let current = planned_progress.get(&chunk.sha256).copied().unwrap_or(0);
            if chunk.offset != current {
                return Err(invalid(format!(
                    "out-of-order chunk for {}: expected offset {current}, got {}",
                    chunk.sha256, chunk.offset
                )));
            }
            let end = chunk
                .offset
                .checked_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX))
                .ok_or_else(|| invalid("chunk offset overflow"))?;
            if end > expected_size {
                return Err(invalid(format!(
                    "chunk for {} extends past totalSize {expected_size}",
                    chunk.sha256
                )));
            }
            planned_progress.insert(chunk.sha256.clone(), end);
            decoded.push((chunk.sha256, chunk.offset, expected_size, bytes));
        }

        let finished =
            tokio::task::spawn_blocking(move || -> Result<Vec<(String, u64, bool)>, Error> {
                let blobs_root = blobs_dir(&dir);
                let stage_root = staging_dir(&dir);
                create_private_dir(&blobs_root)
                    .map_err(|error| internal(format!("creating blobs dir: {error}")))?;
                create_private_dir(&stage_root)
                    .map_err(|error| internal(format!("creating staging dir: {error}")))?;

                let mut results = Vec::with_capacity(decoded.len());
                for (sha256, offset, total_size, bytes) in decoded {
                    let end = offset.saturating_add(u64::try_from(bytes.len()).unwrap_or(u64::MAX));
                    let complete = end == total_size;
                    if offset == 0 && complete {
                        // Single-chunk blob: verify in memory and write directly.
                        let actual = sha256_hex(&bytes);
                        if actual != sha256 {
                            return Err(invalid(format!(
                                "sha256 mismatch for blob: expected {sha256}, got {actual}"
                            )));
                        }
                        let temp = stage_root.join(format!("{sha256}.tmp"));
                        let final_path = blobs_root.join(&sha256);
                        let written = (|| {
                            let mut out = private_file(&temp, true)?;
                            out.write_all(&bytes)?;
                            out.sync_all()?;
                            std::fs::rename(&temp, &final_path)
                        })();
                        if let Err(error) = written {
                            let _ = std::fs::remove_file(&temp);
                            return Err(internal(format!("writing blob {sha256}: {error}")));
                        }
                    } else {
                        let part = stage_root.join(format!("{sha256}.part"));
                        let mut file = if offset == 0 {
                            private_file(&part, true)
                        } else {
                            std::fs::OpenOptions::new().append(true).open(&part)
                        }
                        .map_err(|error| {
                            internal(format!("opening staged blob {sha256}: {error}"))
                        })?;
                        file.write_all(&bytes).map_err(|error| {
                            internal(format!("writing staged blob {sha256}: {error}"))
                        })?;
                        file.flush().map_err(|error| {
                            internal(format!("flushing staged blob {sha256}: {error}"))
                        })?;
                        drop(file);

                        if complete {
                            let actual = sha256_file(&part).map_err(|error| {
                                internal(format!("hashing staged blob {sha256}: {error}"))
                            })?;
                            if actual != sha256 {
                                let _ = std::fs::remove_file(&part);
                                return Err(invalid(format!(
                                    "sha256 mismatch for blob: expected {sha256}, got {actual}"
                                )));
                            }
                            let final_path = blobs_root.join(&sha256);
                            std::fs::rename(&part, &final_path).map_err(|error| {
                                let _ = std::fs::remove_file(&part);
                                internal(format!("committing blob {sha256}: {error}"))
                            })?;
                        }
                    }
                    results.push((sha256, end, complete));
                }
                Ok(results)
            })
            .await
            .map_err(|error| internal(format!("storing dotfiles blobs: {error}")))??;

        for (sha256, end, complete) in finished {
            if complete {
                staged.progress.remove(&sha256);
                staged.expected.remove(&sha256);
            } else {
                staged.progress.insert(sha256, end);
            }
        }
        Ok(())
    }

    /// `dotfiles/apply`: apply the staged plan into `$HOME`.
    pub(crate) async fn apply(
        &self,
        request: ApplyDotfilesRequest,
    ) -> Result<DotfilesHostReport, Error> {
        let dir = self.require_dir()?;
        let mut state = self.state.lock().await;
        let Some(staged) = state.staged.as_ref() else {
            return Err(invalid(
                "no dotfiles plan is staged; send dotfiles/plan first",
            ));
        };
        if staged.commit != request.commit {
            return Err(invalid(format!(
                "staged dotfiles plan is for commit {}, not {}",
                staged.commit, request.commit
            )));
        }
        if !staged.expected.is_empty() {
            return Err(invalid(format!(
                "{} dotfiles blob(s) are still missing before apply",
                staged.expected.len()
            )));
        }
        let staged = state
            .staged
            .take()
            .ok_or_else(|| internal("staged dotfiles plan disappeared"))?;
        let home = self.home.clone();
        let prev = state.manifest.clone();
        let (next_manifest, report) = tokio::task::spawn_blocking(move || {
            apply_entries(&home, &dir, staged.commit, &staged.entries, &prev)
        })
        .await
        .map_err(|error| internal(format!("applying dotfiles: {error}")))??;
        state.manifest = next_manifest;
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use pretty_assertions::assert_eq;

    use super::*;
    use crate::remotes::AsWritten;

    fn test_git() -> Git {
        let mut env = BTreeMap::new();
        env.insert("GIT_CONFIG_GLOBAL".into(), "/dev/null".into());
        env.insert("GIT_CONFIG_NOSYSTEM".into(), "1".into());
        Git::new(&env, Arc::new(AsWritten))
    }

    #[tokio::test]
    async fn syncs_chunked_blobs_preserves_modes_handles_conflicts_and_removals() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("home");
        let state_dir = tmp.path().join("daemon/dotfiles");
        std::fs::create_dir_all(&home).expect("home");
        // Pre-existing unmanaged file that must NOT be clobbered.
        std::fs::write(home.join(".existing"), b"keep me").expect("existing");

        let dotfiles = Dotfiles::load(Some(state_dir.clone()), home.clone());
        let git = test_git();

        let zshrc = b"export EDITOR=nvim\n";
        let ssh_cfg = b"Host example\n  User jaco\n";
        let bin_script = b"#!/bin/sh\necho hi\n";
        let existing = b"would clobber";

        let plan = dotfiles
            .plan(
                &git,
                PlanDotfilesRequest {
                    remote: Some("github.com/test/dotfiles".into()),
                    branch: Some("main".into()),
                    mode: DotfilesMode::Auto,
                    clear: false,
                    commit: Some("commit1".into()),
                    entries: vec![
                        DotfilesEntry {
                            path: ".zshrc".into(),
                            kind: DotfilesEntryKind::File {
                                sha256: sha256_hex(zshrc),
                                size: zshrc.len() as u64,
                                executable: false,
                            },
                        },
                        DotfilesEntry {
                            path: ".ssh/config".into(),
                            kind: DotfilesEntryKind::File {
                                sha256: sha256_hex(ssh_cfg),
                                size: ssh_cfg.len() as u64,
                                executable: false,
                            },
                        },
                        DotfilesEntry {
                            path: "bin/hi".into(),
                            kind: DotfilesEntryKind::File {
                                sha256: sha256_hex(bin_script),
                                size: bin_script.len() as u64,
                                executable: true,
                            },
                        },
                        DotfilesEntry {
                            path: ".config/kanata/kanata.kbd".into(),
                            kind: DotfilesEntryKind::Symlink {
                                target: "../../kanata.kbd".into(),
                            },
                        },
                        DotfilesEntry {
                            path: ".existing".into(),
                            kind: DotfilesEntryKind::File {
                                sha256: sha256_hex(existing),
                                size: existing.len() as u64,
                                executable: false,
                            },
                        },
                    ],
                },
            )
            .await
            .expect("plan");
        assert_eq!(plan.missing.len(), 4);
        assert!(plan.report.is_none());

        // Upload `.zshrc` in two chunks to exercise multi-chunk assembly, others in one batch.
        dotfiles
            .put(PutDotfilesBlobsRequest {
                chunks: vec![
                    weave_host_protocol::dotfiles::DotfilesBlobChunk {
                        sha256: sha256_hex(zshrc),
                        offset: 0,
                        total_size: zshrc.len() as u64,
                        data: BASE64.encode(&zshrc[..8]),
                    },
                    weave_host_protocol::dotfiles::DotfilesBlobChunk {
                        sha256: sha256_hex(zshrc),
                        offset: 8,
                        total_size: zshrc.len() as u64,
                        data: BASE64.encode(&zshrc[8..]),
                    },
                    weave_host_protocol::dotfiles::DotfilesBlobChunk {
                        sha256: sha256_hex(ssh_cfg),
                        offset: 0,
                        total_size: ssh_cfg.len() as u64,
                        data: BASE64.encode(ssh_cfg),
                    },
                    weave_host_protocol::dotfiles::DotfilesBlobChunk {
                        sha256: sha256_hex(bin_script),
                        offset: 0,
                        total_size: bin_script.len() as u64,
                        data: BASE64.encode(bin_script),
                    },
                    weave_host_protocol::dotfiles::DotfilesBlobChunk {
                        sha256: sha256_hex(existing),
                        offset: 0,
                        total_size: existing.len() as u64,
                        data: BASE64.encode(existing),
                    },
                ],
            })
            .await
            .expect("put");

        let report = dotfiles
            .apply(ApplyDotfilesRequest {
                commit: "commit1".into(),
            })
            .await
            .expect("apply");
        assert_eq!(report.mode, DotfilesActiveMode::Synced);
        assert_eq!(report.commit.as_deref(), Some("commit1"));
        assert_eq!(report.linked, 4);
        assert_eq!(report.removed, 0);
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(report.conflicts[0].path, ".existing");

        // Unmanaged file stayed untouched.
        assert_eq!(
            std::fs::read(home.join(".existing")).expect("read"),
            b"keep me"
        );
        // Synced files work via symlinks; `.config` is a real directory (not folded!).
        assert_eq!(std::fs::read(home.join(".zshrc")).expect("zshrc"), zshrc);
        assert!(
            std::fs::symlink_metadata(home.join(".zshrc"))
                .expect("meta")
                .file_type()
                .is_symlink()
        );
        assert!(
            !std::fs::symlink_metadata(home.join(".config"))
                .expect("meta")
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            std::fs::read_link(home.join(".config/kanata/kanata.kbd")).expect("symlink"),
            PathBuf::from("../../kanata.kbd")
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let ssh_dir_mode = std::fs::metadata(home.join(".ssh"))
                .expect("ssh dir")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(ssh_dir_mode, 0o700);
            let ssh_cfg_mode = std::fs::metadata(home.join(".ssh/config"))
                .expect("ssh cfg")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(ssh_cfg_mode, 0o600);
            let bin_mode = std::fs::metadata(home.join("bin/hi"))
                .expect("bin")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(bin_mode, 0o755);
        }

        // Second commit removes `bin/hi` and keeps `.zshrc` unchanged -> 0 missing blobs, applied immediately!
        let plan2 = dotfiles
            .plan(
                &git,
                PlanDotfilesRequest {
                    remote: Some("github.com/test/dotfiles".into()),
                    branch: Some("main".into()),
                    mode: DotfilesMode::Auto,
                    clear: false,
                    commit: Some("commit2".into()),
                    entries: vec![DotfilesEntry {
                        path: ".zshrc".into(),
                        kind: DotfilesEntryKind::File {
                            sha256: sha256_hex(zshrc),
                            size: zshrc.len() as u64,
                            executable: false,
                        },
                    }],
                },
            )
            .await
            .expect("plan2");
        assert!(plan2.missing.is_empty());
        let report2 = plan2.report.expect("applied in plan");
        assert_eq!(report2.linked, 1);
        assert_eq!(report2.removed, 3);
        assert!(report2.conflicts.is_empty());
        assert!(std::fs::symlink_metadata(home.join("bin/hi")).is_err());

        // Clear removes the remaining managed symlink and leaves `.existing` intact.
        let cleared = dotfiles
            .plan(
                &git,
                PlanDotfilesRequest {
                    clear: true,
                    ..PlanDotfilesRequest::default()
                },
            )
            .await
            .expect("clear");
        let report3 = cleared.report.expect("cleared report");
        assert_eq!(report3.mode, DotfilesActiveMode::Off);
        assert_eq!(report3.removed, 1);
        assert!(std::fs::symlink_metadata(home.join(".zshrc")).is_err());
        assert_eq!(
            std::fs::read(home.join(".existing")).expect("read"),
            b"keep me"
        );
    }

    #[tokio::test]
    async fn refuses_to_traverse_unmanaged_symlinked_directory() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("home");
        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&home).expect("home");
        std::fs::create_dir_all(&elsewhere).expect("elsewhere");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&elsewhere, home.join(".config")).expect("symlink");

        let dotfiles = Dotfiles::load(Some(tmp.path().join("daemon/dotfiles")), home.clone());
        let git = test_git();
        let data = b"starship = true\n";
        let plan = dotfiles
            .plan(
                &git,
                PlanDotfilesRequest {
                    mode: DotfilesMode::Sync,
                    commit: Some("c1".into()),
                    entries: vec![DotfilesEntry {
                        path: ".config/starship.toml".into(),
                        kind: DotfilesEntryKind::File {
                            sha256: sha256_hex(data),
                            size: data.len() as u64,
                            executable: false,
                        },
                    }],
                    ..PlanDotfilesRequest::default()
                },
            )
            .await
            .expect("plan");
        assert_eq!(plan.missing.len(), 1);
        dotfiles
            .put(PutDotfilesBlobsRequest {
                chunks: vec![weave_host_protocol::dotfiles::DotfilesBlobChunk {
                    sha256: sha256_hex(data),
                    offset: 0,
                    total_size: data.len() as u64,
                    data: BASE64.encode(data),
                }],
            })
            .await
            .expect("put");
        let report = dotfiles
            .apply(ApplyDotfilesRequest {
                commit: "c1".into(),
            })
            .await
            .expect("apply");
        assert_eq!(report.linked, 0);
        assert_eq!(report.conflicts.len(), 1);
        assert!(report.conflicts[0].reason.contains("symlinked directory"));
        assert!(!elsewhere.join("starship.toml").exists());
    }
}
