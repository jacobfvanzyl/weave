//! The daemon's Unix socket, guarded by a lock file so only one daemon serves a directory.

use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;

use agent_client_protocol::ByteStreams;
use tokio::net::UnixListener;
use tokio::net::UnixStream;
use tokio::net::unix::OwnedReadHalf;
use tokio::net::unix::OwnedWriteHalf;
use tokio_util::compat::Compat;
use tokio_util::compat::TokioAsyncReadCompatExt;
use tokio_util::compat::TokioAsyncWriteCompatExt;

use crate::paths::DaemonPaths;

/// ACP over one socket connection, for either end.
pub type Transport = ByteStreams<Compat<OwnedWriteHalf>, Compat<OwnedReadHalf>>;

/// The socket, listened on while the lock is held.
pub struct Listening {
    pub listener: UnixListener,
    _lock: File,
}

/// Take the directory's lock and listen on its socket. Fails if another daemon holds the
/// lock; a socket left by one that died is replaced.
pub fn listen(paths: &DaemonPaths) -> io::Result<Listening> {
    paths.prepare()?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.lock())?;
    lock.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => io::Error::new(
            io::ErrorKind::AddrInUse,
            format!("another weave daemon serves {}", paths.dir.display()),
        ),
        std::fs::TryLockError::Error(error) => error,
    })?;
    match std::fs::remove_file(&paths.socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(&paths.socket)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&paths.socket, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(Listening {
        listener,
        _lock: lock,
    })
}

/// Connect to a daemon's socket.
pub async fn connect(socket: &Path) -> io::Result<Transport> {
    Ok(transport(UnixStream::connect(socket).await?))
}

pub(crate) fn transport(stream: UnixStream) -> Transport {
    let (read, write) = stream.into_split();
    ByteStreams::new(write.compat_write(), read.compat())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_daemon_per_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = DaemonPaths::in_dir(dir.path().join("daemon"));
        let first = listen(&paths).expect("first daemon listens");
        let second = listen(&paths).err().map(|error| error.kind());
        assert_eq!(second, Some(io::ErrorKind::AddrInUse));
        assert!(connect(&paths.socket).await.is_ok());
        drop(first);
        // Once the first has gone, its socket is replaced.
        assert!(listen(&paths).is_ok());
    }
}
