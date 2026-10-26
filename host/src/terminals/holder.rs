//! Holders as an [`Owner`]: `weave-holder` processes, one per terminal, each on a socket of its
//! own in the holders' directory, and found again by their records after the Host restarts
//! (ADR 0022, spec "Holders").
//!
//! The Host starts a holder outside its own process tree, so a restart or update of the Host
//! leaves every shell running. On Linux that's a systemd unit of its own (`systemd-run --user`),
//! since the Host's unit stops everything left in its cgroup; where there's no user manager to
//! ask, and on macOS, it's `weave-holder spawn`, which detaches into a session of its own.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;

use agent_client_protocol::Error;
use futures::future::BoxFuture;
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use weave_host_protocol::errors;

use super::owner::CHANNEL_DEPTH;
use super::owner::Incoming;
use super::owner::Outgoing;
use super::owner::Owner;
use super::owner::Start;
use super::owner::Wire;

/// The holder protocol's frame kinds (the holder's `protocol.rs`).
const JSON: u8 = 0x00;
const RESTORE: u8 = 0x01;
const OUTPUT: u8 = 0x03;
const INPUT: u8 = 0x10;
/// The largest frame the Host accepts from a holder.
const MAX_FRAME: usize = 16 * 1024 * 1024;
/// How long a holder has to answer on its socket once started.
const START_TIMEOUT: Duration = Duration::from_secs(15);

/// How the Host starts holders.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Launch {
    /// A systemd unit of its own, through `systemd-run --user`.
    SystemdRun,
    /// `weave-holder spawn`, in a session of its own.
    Spawn,
}

impl Launch {
    /// `systemd-run` where the user's systemd answers, as for a Host it runs; otherwise `spawn`.
    pub fn detect() -> Self {
        if cfg!(target_os = "linux")
            && std::env::var_os("XDG_RUNTIME_DIR")
                .is_some_and(|runtime| Path::new(&runtime).join("systemd/private").exists())
        {
            Self::SystemdRun
        } else {
            Self::Spawn
        }
    }
}

/// The holders in one directory, started from one binary.
pub struct Holders {
    dir: PathBuf,
    binary: PathBuf,
    launch: Launch,
    /// A shell to start instead of the person's login shell, as tests start `/bin/sh`.
    shell: Option<PathBuf>,
}

/// What the Host reads of a holder's record (`<id>.json`).
#[derive(Deserialize)]
struct Record {
    id: String,
}

impl Holders {
    pub fn new(dir: PathBuf, binary: PathBuf, launch: Launch) -> Self {
        Self {
            dir,
            binary,
            launch,
            shell: None,
        }
    }

    /// Holders whose shell is `shell` rather than the person's login shell.
    pub fn with_shell(mut self, shell: PathBuf) -> Self {
        self.shell = Some(shell);
        self
    }

    /// Holders in `dir`, from the `weave-holder` installed beside this program, as
    /// `scripts/update-hosts` installs it beside `weave`; none without one.
    pub fn beside_this_program(dir: PathBuf) -> Option<Self> {
        let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
        let binary = exe.parent()?.join("weave-holder");
        binary
            .is_file()
            .then(|| Self::new(dir, binary, Launch::detect()))
    }

    fn socket(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.sock"))
    }

    /// Removes what a holder that's gone left behind.
    fn forget(&self, id: &str) {
        for name in [
            format!("{id}.json"),
            format!("{id}.sock"),
            format!("{id}.log"),
            format!("{id}.env.json"),
        ] {
            let _ = std::fs::remove_file(self.dir.join(name));
        }
    }

    fn prepare(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        std::fs::set_permissions(&self.dir, std::fs::Permissions::from_mode(0o700))
    }

    /// The program's environment, in a file only this user reads, which the holder removes.
    fn env_file(&self, id: &str, env: &BTreeMap<String, String>) -> std::io::Result<PathBuf> {
        let path = self.dir.join(format!("{id}.env.json"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)?;
        file.write_all(&serde_json::to_vec(env).map_err(std::io::Error::other)?)?;
        Ok(path)
    }

    fn args(&self, start: &Start, env_file: &Path) -> Vec<String> {
        let dir = &self.dir;
        let mut args = vec![
            "--dir".to_owned(),
            dir.display().to_string(),
            "--id".to_owned(),
            start.id.clone(),
            "--cwd".to_owned(),
            start.directory.display().to_string(),
            "--scope".to_owned(),
            start.scope.display().to_string(),
            "--cols".to_owned(),
            start.size.cols.to_string(),
            "--rows".to_owned(),
            start.size.rows.to_string(),
            "--env-file".to_owned(),
            env_file.display().to_string(),
        ];
        if let Some(shell) = &self.shell {
            args.extend(["--shell".to_owned(), shell.display().to_string()]);
        }
        if let Some(label) = &start.label {
            args.extend(["--label".to_owned(), label.clone()]);
        }
        if let Some(session) = &start.opened_from {
            args.extend(["--opened-from".to_owned(), session.to_string()]);
        }
        if let Some(command) = &start.command {
            args.push("--".to_owned());
            args.extend(command.iter().cloned());
        }
        args
    }

    async fn launch(&self, start: &Start) -> Result<(), Error> {
        self.prepare().map_err(unavailable)?;
        let env_file = self.env_file(&start.id, &start.env).map_err(unavailable)?;
        let args = self.args(start, &env_file);
        let launched = match self.launch {
            Launch::Spawn => {
                let output = tokio::time::timeout(
                    START_TIMEOUT,
                    tokio::process::Command::new(&self.binary)
                        .arg("spawn")
                        .args(&args)
                        .stdin(std::process::Stdio::null())
                        .output(),
                )
                .await
                .map_err(|_| errors::terminal_unavailable("the holder took too long to start"))?
                .map_err(unavailable)?;
                if output.status.success() {
                    Ok(())
                } else {
                    let answer: Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
                    let why = answer["error"].as_str().map_or_else(
                        || String::from_utf8_lossy(&output.stderr).trim().to_owned(),
                        str::to_owned,
                    );
                    Err(errors::terminal_unavailable(format!(
                        "the holder didn't start: {why}"
                    )))
                }
            }
            Launch::SystemdRun => {
                let output = tokio::process::Command::new("systemd-run")
                    .args(["--user", "--collect", "--quiet", "--unit"])
                    .arg(format!("weave-holder-{}", start.id))
                    .arg(format!("--description=weave terminal {}", start.id))
                    .arg(&self.binary)
                    .arg("serve")
                    .args(&args)
                    .stdin(std::process::Stdio::null())
                    .output()
                    .await
                    .map_err(unavailable)?;
                if output.status.success() {
                    self.wait_for(&start.id).await
                } else {
                    Err(errors::terminal_unavailable(format!(
                        "systemd-run didn't start the holder: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    )))
                }
            }
        };
        if launched.is_err() {
            let _ = std::fs::remove_file(&env_file);
        }
        launched
    }

    /// Waits for a holder's socket to answer.
    async fn wait_for(&self, id: &str) -> Result<(), Error> {
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if UnixStream::connect(self.socket(id)).await.is_ok() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(errors::terminal_unavailable(
                    "the holder didn't answer on its socket",
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Owner for Holders {
    fn find(&self) -> BoxFuture<'_, Vec<String>> {
        Box::pin(async move {
            let Ok(entries) = std::fs::read_dir(&self.dir) else {
                return Vec::new();
            };
            let mut found = Vec::new();
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if !name.ends_with(".json") || name.ends_with(".env.json") {
                    continue;
                }
                let Some(record) = std::fs::read(entry.path())
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Record>(&bytes).ok())
                else {
                    continue;
                };
                if UnixStream::connect(self.socket(&record.id)).await.is_ok() {
                    found.push(record.id);
                } else {
                    tracing::info!(id = record.id, "forgot a holder that's gone");
                    self.forget(&record.id);
                }
            }
            found.sort();
            found
        })
    }

    fn start(&self, start: Start) -> BoxFuture<'_, Result<String, Error>> {
        Box::pin(async move {
            self.launch(&start).await?;
            Ok(start.id)
        })
    }

    fn connect<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Wire, Error>> {
        Box::pin(async move {
            let stream = UnixStream::connect(self.socket(id))
                .await
                .map_err(|_| errors::unknown_terminal(id))?;
            Ok(wire(stream))
        })
    }
}

fn unavailable(error: impl std::fmt::Display) -> Error {
    errors::terminal_unavailable(error.to_string())
}

/// A connection over a holder's socket: a writer of what the Host sends, and a reader of what
/// the holder does, which waits while the Host's end is full.
fn wire(stream: UnixStream) -> Wire {
    let (mut read, mut write) = stream.into_split();
    let (outgoing, mut outgoing_rx) = mpsc::channel::<Outgoing>(CHANNEL_DEPTH);
    let (incoming_tx, incoming) = mpsc::channel(CHANNEL_DEPTH);
    tokio::spawn(async move {
        while let Some(message) = outgoing_rx.recv().await {
            let frame = match message {
                Outgoing::Request { id, method, args } => frame(
                    JSON,
                    &serde_json::to_vec(
                        &serde_json::json!({"id": id, "method": method, "args": args}),
                    )
                    .unwrap_or_default(),
                ),
                Outgoing::Input(bytes) => frame(INPUT, &bytes),
            };
            if write.write_all(&frame).await.is_err() {
                break;
            }
        }
        let _ = write.shutdown().await;
    });
    tokio::spawn(async move {
        while let Ok(Some((kind, payload))) = read_frame(&mut read).await {
            let message = match kind {
                JSON => match incoming_json(&payload) {
                    Some(message) => message,
                    None => continue,
                },
                RESTORE => Incoming::Restore(payload),
                OUTPUT => Incoming::Output(payload),
                _ => continue,
            };
            if incoming_tx.send(message).await.is_err() {
                break;
            }
        }
    });
    Wire { outgoing, incoming }
}

fn incoming_json(payload: &[u8]) -> Option<Incoming> {
    let message: Value = serde_json::from_slice(payload).ok()?;
    if let Some(kind) = message["type"].as_str() {
        return Some(Incoming::Event {
            kind: kind.to_owned(),
            payload: message["payload"].clone(),
        });
    }
    let id = message["id"].as_u64()?;
    let result = match message.get("result") {
        Some(result) => Ok(result.clone()),
        None => Err(message["error"]["message"]
            .as_str()
            .unwrap_or("the holder failed")
            .to_owned()),
    };
    Some(Incoming::Answer { id, result })
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    let len = u32::try_from(payload.len() + 1).unwrap_or(u32::MAX);
    frame.extend_from_slice(&len.to_be_bytes());
    frame.push(kind);
    frame.extend_from_slice(payload);
    frame
}

async fn read_frame(
    read: &mut tokio::net::unix::OwnedReadHalf,
) -> std::io::Result<Option<(u8, Vec<u8>)>> {
    let mut len = [0; 4];
    match read.read_exact(&mut len).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("a frame of {len} bytes"),
        ));
    }
    let mut payload = vec![0; len];
    read.read_exact(&mut payload).await?;
    let kind = payload.remove(0);
    Ok(Some((kind, payload)))
}
