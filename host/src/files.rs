//! `files/list`: what a directory on the Host's computer holds, for clients that aren't on it.
//! Names and kinds only, of anything the Host's user can read: a client that can start an
//! agent in any directory reaches that much already.

use std::io::ErrorKind;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use agent_client_protocol::Error;
use weave_host_protocol::files::FileEntry;
use weave_host_protocol::files::FileKind;
use weave_host_protocol::files::ListFilesRequest;
use weave_host_protocol::files::ListFilesResponse;
use weave_host_protocol::files::MAX_ENTRIES;

/// List the directory `request` names, or `home` when it names none.
pub(crate) fn list(request: &ListFilesRequest, home: &Path) -> Result<ListFilesResponse, Error> {
    let path = match &request.path {
        Some(path) if path.is_absolute() => normalize(path),
        Some(path) => {
            return Err(refused(format!(
                "{} isn't an absolute path",
                path.display()
            )));
        }
        None => normalize(home),
    };
    let read = std::fs::read_dir(&path).map_err(|error| {
        refused(match error.kind() {
            ErrorKind::NotFound => format!("{} doesn't exist", path.display()),
            ErrorKind::NotADirectory => format!("{} isn't a directory", path.display()),
            ErrorKind::PermissionDenied => format!("{} can't be read", path.display()),
            _ => format!("{} couldn't be listed: {error}", path.display()),
        })
    })?;
    let mut entries: Vec<FileEntry> = read
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !request.hidden && name.starts_with('.') {
                return None;
            }
            let kind = kind(&entry);
            Some(FileEntry { name, kind })
        })
        .collect();
    // Directories first, then by name.
    entries.sort_by(|left, right| {
        let rank = |entry: &FileEntry| u8::from(entry.kind != FileKind::Directory);
        rank(left)
            .cmp(&rank(right))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    Ok(ListFilesResponse {
        parent: path.parent().map(Path::to_path_buf),
        path,
        home: home.to_path_buf(),
        entries,
        truncated,
    })
}

/// What an entry is, following a symlink only when it is one: the entry's own type needs no
/// look at the disk on most file systems.
fn kind(entry: &std::fs::DirEntry) -> FileKind {
    let of = |file_type: std::fs::FileType| {
        if file_type.is_dir() {
            FileKind::Directory
        } else if file_type.is_file() {
            FileKind::File
        } else {
            FileKind::Other
        }
    };
    match entry.file_type() {
        Ok(file_type) if file_type.is_symlink() => std::fs::metadata(entry.path())
            .map(|metadata| of(metadata.file_type()))
            .unwrap_or(FileKind::Other),
        Ok(file_type) => of(file_type),
        Err(_) => FileKind::Other,
    }
}

/// `path` without `.` or `..`, worked out from its text: symlinks stay as named.
fn normalize(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normal.pop();
            }
            other => normal.push(other),
        }
    }
    normal
}

fn refused(why: String) -> Error {
    Error::invalid_params().data(why)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn paths_lose_dots_but_keep_symlinks() {
        assert_eq!(normalize(Path::new("/a/./b/../c/")), PathBuf::from("/a/c"));
        assert_eq!(normalize(Path::new("/../..")), PathBuf::from("/"));
        assert_eq!(normalize(Path::new("/tmp")), PathBuf::from("/tmp"));
    }
}
