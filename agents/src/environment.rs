//! The environment agents start in. A Host started by launchd has almost none of its own, so
//! the Host captures the user's login shell environment, as a terminal they open gets it, and
//! lays it over its own.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Context;
use anyhow::bail;

/// How long the login shell may take to start.
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

/// Printed before the environment, so whatever the shell's startup files print comes first
/// and is skipped.
const MARKER: &[u8] = b"__WEAVE_ENVIRONMENT__\0";

/// Variables that describe the capturing shell rather than the user's settings.
const SHELL_STATE: [&str; 4] = ["_", "SHLVL", "PWD", "OLDPWD"];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Environment {
    pub vars: BTreeMap<String, String>,
    pub source: Source,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Source {
    /// The login shell's, over the process's own.
    LoginShell,
    /// The process's own only.
    #[default]
    Process,
}

impl Environment {
    /// This process's own environment.
    pub fn process() -> Self {
        Self {
            vars: process_vars(),
            source: Source::Process,
        }
    }

    /// This process's environment with the login shell's over it, or this process's alone
    /// when the shell can't be captured within `timeout`, logging why.
    pub async fn capture(timeout: Duration) -> Self {
        let mut environment = Self::process();
        let shell = user_shell();
        match login_shell(&shell, timeout).await {
            Ok(vars) => {
                environment.vars.extend(vars);
                environment.source = Source::LoginShell;
            }
            Err(error) => tracing::warn!(
                shell = %shell.display(),
                "couldn't capture the login shell's environment; agents get the Host's: {error:#}"
            ),
        }
        environment
    }
}

fn process_vars() -> BTreeMap<String, String> {
    std::env::vars_os()
        .filter_map(|(name, value)| Some((name.into_string().ok()?, value.into_string().ok()?)))
        .collect()
}

/// `$SHELL`, else `/bin/sh`.
fn user_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|shell| !shell.is_empty())
        .map_or_else(|| PathBuf::from("/bin/sh"), PathBuf::from)
}

/// The environment of `shell` started as an interactive login shell, so both its profile and
/// its rc files run.
///
/// The shell runs in a session of its own, without a terminal. An interactive shell's job
/// control otherwise takes over the terminal of whatever started the Host, and hands it to the
/// Host's process group when it exits, leaving that terminal's shell in the background, as
/// `weave daemon restart` did to the terminal it ran in (WVE-154).
pub async fn login_shell(
    shell: &Path,
    timeout: Duration,
) -> anyhow::Result<BTreeMap<String, String>> {
    let script = "printf '%s\\0' __WEAVE_ENVIRONMENT__; env -0";
    let mut command = tokio::process::Command::new(shell);
    command
        .args(["-l", "-i", "-c", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    // SAFETY: between fork and exec, setsid only makes the child a session leader; it allocates
    // nothing and takes no lock.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let output = command.output();
    let output = tokio::time::timeout(timeout, output)
        .await
        .with_context(|| format!("it took longer than {}s", timeout.as_secs()))?
        .context("starting it")?;
    if !output.status.success() {
        bail!("it exited with {}", output.status);
    }
    parse(&output.stdout)
}

/// What follows the marker: `NAME=value` entries, each ended by a NUL.
fn parse(output: &[u8]) -> anyhow::Result<BTreeMap<String, String>> {
    let start = output
        .windows(MARKER.len())
        .position(|window| window == MARKER)
        .context("its output had no environment in it")?;
    let vars = output[start + MARKER.len()..]
        .split(|byte| *byte == 0)
        .filter_map(|entry| std::str::from_utf8(entry).ok())
        .filter_map(|entry| entry.split_once('='))
        .filter(|(name, _)| !name.is_empty() && !SHELL_STATE.contains(name))
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
    Ok(vars)
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use pretty_assertions::assert_eq;

    use super::*;

    /// Held by each test while it writes its stand-in shells and runs them. On Linux a process
    /// forked while another test has its shell open for writing keeps it open until it execs,
    /// and running that shell meanwhile fails with "Text file busy".
    static SHELLS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A stand-in shell: `body` runs first, then the `-c` script it was given.
    fn shell(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("shell");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\nshift 3\neval \"$1\"\n"))
            .expect("script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("mode");
        path
    }

    /// An interactive shell's job control takes over a terminal it can open (WVE-154), so the
    /// shell gets none: it leads a session of its own.
    #[tokio::test]
    async fn the_shell_runs_without_a_terminal() {
        let _shells = SHELLS.lock().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let shell = shell(
            dir.path(),
            "leader=no; [ \"$(ps -o pgid= -p $$ | tr -d ' ')\" = \"$$\" ] && leader=yes\n\
             terminal=no; (exec 3</dev/tty) 2>/dev/null && terminal=yes\n\
             export WEAVE_TEST_LEADER=$leader WEAVE_TEST_TERMINAL=$terminal",
        );
        let vars = login_shell(&shell, CAPTURE_TIMEOUT)
            .await
            .expect("captured");
        assert_eq!(
            vars.get("WEAVE_TEST_LEADER").map(String::as_str),
            Some("yes")
        );
        assert_eq!(
            vars.get("WEAVE_TEST_TERMINAL").map(String::as_str),
            Some("no")
        );
    }

    #[tokio::test]
    async fn the_shells_variables_come_after_whatever_its_startup_prints() {
        let _shells = SHELLS.lock().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let shell = shell(
            dir.path(),
            "echo 'Welcome back'\nexport GREETING='hello\nworld' WEAVE_TEST_PATH=/opt/tools/bin",
        );
        let vars = login_shell(&shell, CAPTURE_TIMEOUT)
            .await
            .expect("captured");
        assert_eq!(
            vars.get("GREETING").map(String::as_str),
            Some("hello\nworld")
        );
        assert_eq!(
            vars.get("WEAVE_TEST_PATH").map(String::as_str),
            Some("/opt/tools/bin")
        );
        assert!(!vars.contains_key("SHLVL") && !vars.contains_key("PWD"));
    }

    #[tokio::test]
    async fn a_shell_that_hangs_or_fails_is_given_up_on() {
        let _shells = SHELLS.lock().await;
        let dir = tempfile::tempdir().expect("tempdir");
        let hangs = shell(dir.path(), "sleep 5");
        let error = login_shell(&hangs, Duration::from_millis(100))
            .await
            .expect_err("times out");
        assert!(error.to_string().contains("longer than"));

        let fails = shell(dir.path(), "exit 3");
        assert!(login_shell(&fails, CAPTURE_TIMEOUT).await.is_err());
    }
}
