//! `repos/init` (WVE-178): a directory on the Host's computer that is a git repository of its
//! own, with a client's first files committed in it alone, for a client that isn't on this
//! computer, as the Dispatcher making a Bot's home is. The Host knows nothing of what it's for.
//!
//! The directory is made, with its parents, unless it's there; `git init` makes it a repository
//! unless it's the top of one already. One that is, or would be, inside another repository's
//! work tree is refused before anything is made: its files would be committed there. The files
//! are written only when none of them is there, never over anything, and committed alone
//! (`commit --only`), as the user git's configuration or environment names, or left uncommitted
//! without one, saying so.

use std::io::Write as _;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use agent_client_protocol::Error;
use weave_host_protocol::worktrees::FilesMade;
use weave_host_protocol::worktrees::InitRepositoryRequest;
use weave_host_protocol::worktrees::InitRepositoryResponse;
use weave_host_protocol::worktrees::RepositoryFile;

use crate::Shared;
use crate::git;

/// Make the repository `request` asks for, with its files.
pub(crate) async fn init(
    shared: &Shared,
    request: InitRepositoryRequest,
) -> Result<InitRepositoryResponse, Error> {
    let path = whole(&request.path, &shared.home())?;
    let files = names(&request.files)?;
    if !files.is_empty() && request.message.trim().is_empty() {
        return Err(refused("files are committed with a message: give one"));
    }
    let git = &shared.git;
    // Where it is in git, from the directory or, before it's made, what it would be made in.
    let there = blocking({
        let path = path.clone();
        move || Ok(nearest(&path))
    })
    .await?;
    let initialized = match (git.work_tree_top(&there).await, there == path) {
        (Some(top), true) if top == git::canonical(&path) => false,
        (Some(top), _) => {
            return Err(refused(format!(
                "{} is inside the repository at {}, and a repository of its own is asked for",
                path.display(),
                top.display()
            )));
        }
        (None, _) => true,
    };
    let (path, created) = blocking({
        let path = path.clone();
        move || make_directory(&path)
    })
    .await?;
    if initialized {
        git.init(&path).await?;
    }
    let files = match files.is_empty() {
        true => None,
        false => Some(write_and_commit(shared, &path, request.files, &request.message).await?),
    };
    Ok(InitRepositoryResponse {
        path,
        created,
        initialized,
        files,
    })
}

/// Write `files` in `dir`, unless one of them is there, and commit them alone.
async fn write_and_commit(
    shared: &Shared,
    dir: &Path,
    files: Vec<RepositoryFile>,
    message: &str,
) -> Result<FilesMade, Error> {
    let paths: Vec<String> = files
        .iter()
        .map(|file| file.path.to_string_lossy().into_owned())
        .collect();
    let written = blocking({
        let dir = dir.to_path_buf();
        move || write(&dir, files)
    })
    .await?;
    if let Some(kept) = written {
        return Ok(FilesMade::Kept { file: kept });
    }
    let git = &shared.git;
    if !git.knows_who(dir).await {
        return Ok(FilesMade::Uncommitted {
            why: "git has no user.name and user.email to commit them as; set them with `git \
                  config --global`, then commit them"
                .to_owned(),
        });
    }
    let named: Vec<&str> = paths.iter().map(String::as_str).collect();
    Ok(match git.commit_only(dir, &named, message).await {
        Ok(()) => FilesMade::Committed,
        Err(error) => FilesMade::Uncommitted { why: error.message },
    })
}

/// `path` whole on this computer: `~/…` under `home`; anything else relative is refused.
fn whole(path: &Path, home: &Path) -> Result<PathBuf, Error> {
    if let Ok(under) = path.strip_prefix("~") {
        return Ok(match under.as_os_str().is_empty() {
            true => home.to_path_buf(),
            false => home.join(under),
        });
    }
    match path.is_absolute() {
        true => Ok(path.to_path_buf()),
        false => Err(refused(format!(
            "{} isn't a whole path, or one under ~, on this Host",
            path.display()
        ))),
    }
}

/// The files' paths, checked: each relative and within the directory, not in `.git`, once.
fn names(files: &[RepositoryFile]) -> Result<Vec<&Path>, Error> {
    let mut named: Vec<&Path> = Vec::new();
    for file in files {
        let path = file.path.as_path();
        let within = path.components().all(|component| match component {
            Component::Normal(name) => !name.eq_ignore_ascii_case(".git"),
            _ => false,
        });
        if path.as_os_str().is_empty() || !within {
            return Err(refused(format!(
                "{} isn't a file's path within the directory: give one relative to it, without \
                 `..` or `.git`",
                path.display()
            )));
        }
        if named.contains(&path) {
            return Err(refused(format!("{} is named twice", path.display())));
        }
        named.push(path);
    }
    Ok(named)
}

/// `path`, or the nearest directory above it that's there.
fn nearest(path: &Path) -> PathBuf {
    path.ancestors()
        .find(|ancestor| ancestor.symlink_metadata().is_ok())
        .unwrap_or(path)
        .to_path_buf()
}

/// Make `path`, with its parents, unless it's there: the directory with symlinks resolved, and
/// whether it was made.
fn make_directory(path: &Path) -> Result<(PathBuf, bool), Error> {
    let created = path.symlink_metadata().is_err();
    std::fs::create_dir_all(path)
        .map_err(|error| refused(format!("{} couldn't be made: {error}", path.display())))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| refused(format!("{}: {error}", path.display())))?;
    if !canonical.is_dir() {
        return Err(refused(format!("{} isn't a directory", path.display())));
    }
    Ok((canonical, created))
}

/// Write `files` in `dir`, unless one of them is there: the first that is, if one is.
fn write(dir: &Path, files: Vec<RepositoryFile>) -> Result<Option<PathBuf>, Error> {
    if let Some(there) = files
        .iter()
        .find(|file| dir.join(&file.path).symlink_metadata().is_ok())
    {
        return Ok(Some(there.path.clone()));
    }
    for file in files {
        let path = dir.join(&file.path);
        let shown = file.path.display();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| refused(format!("{shown} couldn't be written: {error}")))?;
        }
        // Nothing is written over.
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .and_then(|mut written| written.write_all(file.text.as_bytes()))
            .map_err(|error| refused(format!("{shown} couldn't be written: {error}")))?;
    }
    Ok(None)
}

/// Run `work` off the dispatch loop's thread: a slow disk shouldn't hold it up.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| Error::internal_error().data(error.to_string()))?
}

/// The request was wrong, or can't be done here, as `why` says: in the message, which a client
/// such as the Dispatcher passes on.
fn refused(why: impl Into<String>) -> Error {
    let mut error = Error::invalid_params();
    error.message = why.into();
    error
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn file(path: &str) -> RepositoryFile {
        RepositoryFile {
            path: path.into(),
            text: String::new(),
        }
    }

    #[test]
    fn paths_are_whole_or_under_the_home() {
        let home = Path::new("/home/j");
        assert_eq!(
            whole(Path::new("~/bots/odin"), home).ok(),
            Some(PathBuf::from("/home/j/bots/odin"))
        );
        assert_eq!(
            whole(Path::new("~"), home).ok(),
            Some(PathBuf::from("/home/j"))
        );
        assert_eq!(
            whole(Path::new("/srv/odin"), home).ok(),
            Some(PathBuf::from("/srv/odin"))
        );
        assert!(whole(Path::new("bots/odin"), home).is_err());
        assert!(whole(Path::new("~odin"), home).is_err());
    }

    #[test]
    fn files_are_named_within_the_directory_once() {
        let files = [file("AGENTS.md"), file("notes/today.md")];
        let named = names(&files).expect("named");
        assert_eq!(named, [Path::new("AGENTS.md"), Path::new("notes/today.md")]);
        for wrong in [
            "",
            "../AGENTS.md",
            "/etc/passwd",
            "a/../b",
            ".git/config",
            "./x",
        ] {
            assert!(names(&[file(wrong)]).is_err(), "{wrong:?}");
        }
        assert!(names(&[file("a"), file("a")]).is_err());
    }
}
