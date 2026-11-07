//! The Dispatcher's Unix socket, guarded by a lock file so only one Dispatcher runs from a
//! directory. Its file mode keeps other users out, and the Dispatcher checks each peer's user id
//! as well, as the Host does with its own.

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
use tokio_util::compat::TokioAsyncReadCompatExt as _;
use tokio_util::compat::TokioAsyncWriteCompatExt as _;

use crate::paths::DispatcherPaths;

/// The Dispatcher's API over one socket connection, for either end.
pub type Transport = ByteStreams<Compat<OwnedWriteHalf>, Compat<OwnedReadHalf>>;

/// The socket, listened on while the lock is held.
pub struct Listening {
    pub listener: UnixListener,
    _lock: File,
}

/// Take the directory's lock and listen on its socket. Fails if another Dispatcher holds the
/// lock; a socket left by one that died is replaced.
pub fn listen(paths: &DispatcherPaths) -> io::Result<Listening> {
    paths.prepare()?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.lock())?;
    lock.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => io::Error::new(
            io::ErrorKind::AddrInUse,
            format!("another Dispatcher runs from {}", paths.dir.display()),
        ),
        std::fs::TryLockError::Error(error) => error,
    })?;
    let listener = bind_private(&paths.socket())?;
    Ok(Listening {
        listener,
        _lock: lock,
    })
}

/// Listen on the socket Hosts on this computer connect to (ADR 0030), once the directory's lock
/// is held, replacing one a Dispatcher that died left.
pub fn listen_hosts(paths: &DispatcherPaths) -> io::Result<UnixListener> {
    bind_private(&paths.hosts_socket())
}

/// Bind `socket`, replacing what's there, for its owner only.
fn bind_private(socket: &Path) -> io::Result<UnixListener> {
    match std::fs::remove_file(socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(socket)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(listener)
}

/// Connect to a Dispatcher's socket.
pub async fn connect(socket: &Path) -> io::Result<Transport> {
    Ok(transport(UnixStream::connect(socket).await?))
}

pub(crate) fn transport(stream: UnixStream) -> Transport {
    let (read, write) = stream.into_split();
    ByteStreams::new(write.compat_write(), read.compat())
}

/// The user id that owns `listener`'s socket file: the Dispatcher's own.
pub(crate) fn owner(listener: &UnixListener) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
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

/// Whether `stream`'s peer is the socket's owner, or anyone when there's no owner to compare
/// with: the socket's file mode is then the only check. None when the peer can't be told, as
/// when it has gone already, as the CLI's checks whether the Dispatcher is running do.
pub(crate) fn from_owner(stream: &UnixStream, owner: Option<u32>) -> Option<bool> {
    let Some(owner) = owner else {
        return Some(true);
    };
    let credentials = stream.peer_cred().ok()?;
    Some(credentials.uid() == owner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_dispatcher_per_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = DispatcherPaths::in_dir(dir.path().join("dispatcher"));
        let first = listen(&paths).expect("the first listens");
        let second = listen(&paths).err().map(|error| error.kind());
        assert_eq!(second, Some(io::ErrorKind::AddrInUse));
        assert!(connect(&paths.socket()).await.is_ok());
        drop(first);
        assert!(listen(&paths).is_ok());
    }
}
