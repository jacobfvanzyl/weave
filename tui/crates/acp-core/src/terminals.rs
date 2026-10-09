//! The `terminal/*` methods: commands the agent runs in the client's environment.
//!
//! Each command runs in its own process group with stdout and stderr merged into one
//! byte-limited buffer. Output and exit are also reported as [`AgentEvent`]s so a UI can show
//! them live, and keep showing them after the agent releases the terminal.

use std::collections::HashMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::ExitStatus;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::CreateTerminalRequest;
use agent_client_protocol::schema::v1::CreateTerminalResponse;
use agent_client_protocol::schema::v1::KillTerminalRequest;
use agent_client_protocol::schema::v1::KillTerminalResponse;
use agent_client_protocol::schema::v1::ReleaseTerminalRequest;
use agent_client_protocol::schema::v1::ReleaseTerminalResponse;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::TerminalExitStatus;
use agent_client_protocol::schema::v1::TerminalId;
use agent_client_protocol::schema::v1::TerminalOutputRequest;
use agent_client_protocol::schema::v1::TerminalOutputResponse;
use agent_client_protocol::schema::v1::WaitForTerminalExitRequest;
use agent_client_protocol::schema::v1::WaitForTerminalExitResponse;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::watch;

use crate::AgentEvent;

/// How long to keep collecting output after the process exits, for pipes held open by
/// background children.
const OUTPUT_DRAIN_GRACE: Duration = Duration::from_millis(250);

/// Terminal ids are unique across the process, not just one connection, since the weave
/// daemon forwards several agents' terminals to the same client.
static NEXT_TERMINAL: AtomicU64 = AtomicU64::new(1);

pub(crate) struct Terminals {
    events: UnboundedSender<AgentEvent>,
    /// Working directory of each session, the default for its commands.
    session_dirs: Arc<Mutex<HashMap<SessionId, PathBuf>>>,
    live: Mutex<HashMap<TerminalId, Arc<TerminalProcess>>>,
}

struct TerminalProcess {
    session_id: SessionId,
    pid: Option<u32>,
    /// Set as soon as the process is reaped, after which its group id may be reused.
    reaped: Arc<AtomicBool>,
    output: Arc<Mutex<OutputBuffer>>,
    exit: watch::Receiver<Option<TerminalExitStatus>>,
}

impl Terminals {
    pub(crate) fn new(
        events: UnboundedSender<AgentEvent>,
        session_dirs: Arc<Mutex<HashMap<SessionId, PathBuf>>>,
    ) -> Self {
        Self {
            events,
            session_dirs,
            live: Mutex::new(HashMap::new()),
        }
    }

    pub(crate) fn create(
        &self,
        request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, Error> {
        let cwd = match request.cwd {
            Some(cwd) if !cwd.is_absolute() => {
                return Err(Error::invalid_params()
                    .data(format!("cwd must be absolute: {}", cwd.display())));
            }
            Some(cwd) => Some(cwd),
            None => lock(&self.session_dirs).get(&request.session_id).cloned(),
        };
        let mut command = build_command(&request.command, &request.args);
        command
            .envs(
                request
                    .env
                    .iter()
                    .map(|variable| (&variable.name, &variable.value)),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false);
        if let Some(cwd) = &cwd {
            command.current_dir(cwd);
        }
        #[cfg(unix)]
        command.process_group(0);
        let mut child = command.spawn().map_err(|error| {
            Error::internal_error().data(format!("failed to start {}: {error}", request.command))
        })?;

        let terminal_id = TerminalId::new(format!(
            "term-{}",
            NEXT_TERMINAL.fetch_add(1, Ordering::Relaxed)
        ));
        let limit = request
            .output_byte_limit
            .and_then(|limit| usize::try_from(limit).ok());
        let output = Arc::new(Mutex::new(OutputBuffer::new(limit)));
        let (exit_tx, exit_rx) = watch::channel(None);
        let readers = [
            child
                .stdout
                .take()
                .map(|stdout| self.spawn_reader(&terminal_id, stdout, &output)),
            child
                .stderr
                .take()
                .map(|stderr| self.spawn_reader(&terminal_id, stderr, &output)),
        ];

        let pid = child.id();
        let reaped = Arc::new(AtomicBool::new(false));
        let events = self.events.clone();
        let id = terminal_id.clone();
        let reaped_by_waiter = Arc::clone(&reaped);
        tokio::spawn(async move {
            let status = child.wait().await;
            reaped_by_waiter.store(true, Ordering::SeqCst);
            // Let the readers deliver what the process wrote before it exited.
            for reader in readers.into_iter().flatten() {
                let _ = tokio::time::timeout(OUTPUT_DRAIN_GRACE, reader).await;
            }
            let status = match status {
                Ok(status) => exit_status(status),
                Err(error) => {
                    tracing::warn!(%error, terminal = %id, "waiting for terminal command failed");
                    TerminalExitStatus::new()
                }
            };
            let _ = exit_tx.send(Some(status.clone()));
            let _ = events.send(AgentEvent::TerminalExited {
                terminal_id: id,
                status,
            });
        });

        let process = TerminalProcess {
            session_id: request.session_id,
            pid,
            reaped,
            output,
            exit: exit_rx,
        };
        lock(&self.live).insert(terminal_id.clone(), Arc::new(process));
        Ok(CreateTerminalResponse::new(terminal_id))
    }

    fn spawn_reader(
        &self,
        terminal_id: &TerminalId,
        mut pipe: impl AsyncRead + Unpin + Send + 'static,
        output: &Arc<Mutex<OutputBuffer>>,
    ) -> tokio::task::JoinHandle<()> {
        let events = self.events.clone();
        let output = Arc::clone(output);
        let terminal_id = terminal_id.clone();
        tokio::spawn(async move {
            let mut buffer = vec![0; 8192];
            let mut carry = Vec::new();
            loop {
                let read = match pipe.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                lock(&output).append(&buffer[..read]);
                let text = decode_utf8_stream(&mut carry, &buffer[..read]);
                if !text.is_empty() {
                    let _ = events.send(AgentEvent::TerminalOutput {
                        terminal_id: terminal_id.clone(),
                        text,
                    });
                }
            }
        })
    }

    pub(crate) fn output(
        &self,
        request: &TerminalOutputRequest,
    ) -> Result<TerminalOutputResponse, Error> {
        let process = self.get(&request.session_id, &request.terminal_id)?;
        let (text, truncated) = lock(&process.output).snapshot();
        let exit = process.exit.borrow().clone();
        Ok(TerminalOutputResponse::new(text, truncated).exit_status(exit))
    }

    /// A future resolving when the command exits; awaiting it must not block the dispatch loop.
    pub(crate) fn wait_for_exit(
        &self,
        request: &WaitForTerminalExitRequest,
    ) -> Result<
        impl Future<Output = Result<WaitForTerminalExitResponse, Error>> + Send + 'static,
        Error,
    > {
        let mut exit = self
            .get(&request.session_id, &request.terminal_id)?
            .exit
            .clone();
        Ok(async move {
            let status = exit
                .wait_for(Option::is_some)
                .await
                .map_err(|_| {
                    Error::internal_error().data("terminal was released before it exited")
                })?
                .clone()
                .unwrap_or_default();
            Ok(WaitForTerminalExitResponse::new(status))
        })
    }

    pub(crate) fn kill(
        &self,
        request: &KillTerminalRequest,
    ) -> Result<KillTerminalResponse, Error> {
        let process = self.get(&request.session_id, &request.terminal_id)?;
        process.kill();
        Ok(KillTerminalResponse::new())
    }

    pub(crate) fn release(
        &self,
        request: &ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse, Error> {
        self.get(&request.session_id, &request.terminal_id)?;
        if let Some(process) = lock(&self.live).remove(&request.terminal_id) {
            process.kill();
        }
        Ok(ReleaseTerminalResponse::new())
    }

    fn get(
        &self,
        session_id: &SessionId,
        terminal_id: &TerminalId,
    ) -> Result<Arc<TerminalProcess>, Error> {
        lock(&self.live)
            .get(terminal_id)
            .filter(|process| &process.session_id == session_id)
            .cloned()
            .ok_or_else(|| Error::invalid_params().data(format!("unknown terminal {terminal_id}")))
    }
}

impl Drop for Terminals {
    /// The connection is gone, so nobody can release these: stop them.
    fn drop(&mut self) {
        for process in lock(&self.live).values() {
            process.kill();
        }
    }
}

impl TerminalProcess {
    fn kill(&self) {
        if self.reaped.load(Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid.and_then(|pid| i32::try_from(pid).ok()) {
            // SAFETY: killpg only sends a signal; the group id came from a child spawned
            // as its own group leader that has not been reaped.
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
        }
    }
}

/// Without arguments, `command` is a shell command line; with them, a program to exec.
fn build_command(command: &str, args: &[String]) -> tokio::process::Command {
    if args.is_empty() {
        #[cfg(unix)]
        let mut shell = tokio::process::Command::new("/bin/sh");
        #[cfg(unix)]
        shell.arg("-c").arg(command);
        #[cfg(windows)]
        let mut shell = tokio::process::Command::new("cmd");
        #[cfg(windows)]
        shell.arg("/C").arg(command);
        shell
    } else {
        let mut program = tokio::process::Command::new(Path::new(command));
        program.args(args);
        program
    }
}

fn exit_status(status: ExitStatus) -> TerminalExitStatus {
    let exit_code = status.code().and_then(|code| u32::try_from(code).ok());
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(signal_name)
    };
    #[cfg(not(unix))]
    let signal = None;
    TerminalExitStatus::new()
        .exit_code(exit_code)
        .signal(signal)
}

#[cfg(unix)]
fn signal_name(signal: i32) -> String {
    match signal {
        libc::SIGHUP => "SIGHUP".to_owned(),
        libc::SIGINT => "SIGINT".to_owned(),
        libc::SIGQUIT => "SIGQUIT".to_owned(),
        libc::SIGABRT => "SIGABRT".to_owned(),
        libc::SIGKILL => "SIGKILL".to_owned(),
        libc::SIGSEGV => "SIGSEGV".to_owned(),
        libc::SIGPIPE => "SIGPIPE".to_owned(),
        libc::SIGTERM => "SIGTERM".to_owned(),
        other => other.to_string(),
    }
}

/// Output retained up to an optional byte limit, dropping the oldest bytes first.
struct OutputBuffer {
    bytes: Vec<u8>,
    limit: Option<usize>,
    truncated: bool,
}

impl OutputBuffer {
    fn new(limit: Option<usize>) -> Self {
        Self {
            bytes: Vec::new(),
            limit,
            truncated: false,
        }
    }

    fn append(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
        let Some(limit) = self.limit else {
            return;
        };
        if self.bytes.len() <= limit {
            return;
        }
        let mut cut = self.bytes.len() - limit;
        // Truncate at a character boundary: never keep a continuation byte as the first byte.
        while self.bytes.get(cut).is_some_and(|byte| byte & 0xC0 == 0x80) {
            cut += 1;
        }
        self.bytes.drain(..cut);
        self.truncated = true;
    }

    fn snapshot(&self) -> (String, bool) {
        (
            String::from_utf8_lossy(&self.bytes).into_owned(),
            self.truncated,
        )
    }
}

/// Decode a chunk of a byte stream, holding back an incomplete trailing character.
fn decode_utf8_stream(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    carry.extend_from_slice(chunk);
    let mut text = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(valid) => {
                text.push_str(valid);
                carry.clear();
                return text;
            }
            Err(error) => {
                let (valid, rest) = carry.split_at(error.valid_up_to());
                text.push_str(std::str::from_utf8(valid).unwrap_or_default());
                match error.error_len() {
                    // The rest is the start of a character still to come.
                    None => {
                        *carry = rest.to_vec();
                        return text;
                    }
                    Some(invalid) => {
                        text.push(char::REPLACEMENT_CHARACTER);
                        *carry = rest[invalid..].to_vec();
                    }
                }
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_keeps_the_newest_bytes_at_a_character_boundary() {
        let mut buffer = OutputBuffer::new(Some(4));
        buffer.append("ab".as_bytes());
        assert_eq!(buffer.snapshot(), ("ab".to_owned(), false));
        // "é" is two bytes; keeping 4 bytes of "abcé" would start mid-character.
        buffer.append("cé".as_bytes());
        assert_eq!(buffer.snapshot(), ("bcé".to_owned(), true));
        buffer.append("日".as_bytes());
        assert_eq!(buffer.snapshot(), ("日".to_owned(), true));
    }

    #[test]
    fn stream_decoding_holds_back_split_characters() {
        let bytes = "a日b".as_bytes();
        let mut carry = Vec::new();
        assert_eq!(decode_utf8_stream(&mut carry, &bytes[..2]), "a");
        assert_eq!(decode_utf8_stream(&mut carry, &bytes[2..]), "日b");
        assert!(carry.is_empty());
        assert_eq!(decode_utf8_stream(&mut carry, b"x\xffy"), "x\u{FFFD}y");
    }
}
