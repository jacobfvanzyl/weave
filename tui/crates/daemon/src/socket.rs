//! The Host's Unix socket, guarded by a lock file so only one Host serves a directory. Its
//! file mode keeps other users out, and the Host checks each peer's user id as well.

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

/// The Host protocol over one socket connection, for either end.
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

/// The user id that owns `listener`'s socket file: the Host's own.
pub(crate) fn owner(listener: &UnixListener) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let address = listener.local_addr().ok()?;
        let path = address.as_pathname()?;
        std::fs::metadata(path).ok().map(|metadata| metadata.uid())
    }
    #[cfg(not(unix))]
    {
        let _ = listener;
        None
    }
}

/// Whether `stream`'s peer runs as `owner`. Without an owner to compare with, the socket's
/// file mode is the only check.
pub(crate) fn same_user(stream: &UnixStream, owner: Option<u32>) -> bool {
    let Some(owner) = owner else {
        return true;
    };
    stream
        .peer_cred()
        .is_ok_and(|credentials| credentials.uid() == owner)
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
