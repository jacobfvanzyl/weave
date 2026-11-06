//! Starting one of weave's own servers, the Host or the Dispatcher, in the background: this
//! weave, detached from the terminal that started it, logging to a file.

use std::fs::OpenOptions;
use std::path::Path;
use std::process::Stdio;

use anyhow::Context;

/// A log bigger than this is set aside (as `….log.old`) when a server starts.
const LOG_LIMIT: u64 = 10 * 1024 * 1024;

/// Run this weave with `args`, its stdout and stderr appended to `log_path`, in a session of its
/// own; `what` is how errors name it.
pub(crate) fn spawn(args: &[&str], log_path: &Path, what: &str) -> anyhow::Result<()> {
    if std::fs::metadata(log_path).is_ok_and(|metadata| metadata.len() > LOG_LIMIT) {
        let _ = std::fs::rename(log_path, log_path.with_extension("log.old"));
    }
    let mut log_options = OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_options.mode(0o600);
    }
    let log = log_options
        .open(log_path)
        .with_context(|| format!("opening {}", log_path.display()))?;
    let executable = std::env::current_exe().context("finding the weave executable")?;
    let mut command = std::process::Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // A session of its own, without this terminal: the terminal's signals (Ctrl+C, a closing
    // window) miss it, and nothing it runs can take the terminal over, as an interactive shell's
    // job control did, leaving the shell that started it in the background (WVE-154).
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: between fork and exec, setsid only makes the child a session leader; it
        // allocates nothing and takes no lock.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("starting {what}"))?;
    // Reap it if it exits while this process still runs.
    std::thread::spawn(move || child.wait());
    Ok(())
}
