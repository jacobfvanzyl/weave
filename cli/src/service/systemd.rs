//! The weave Host as a systemd user service, on Linux: started with the person's user manager
//! and started again if it exits, through `systemctl --user`. The user manager runs while they
//! are logged in, or from boot to shutdown with lingering on, which `install` turns on, so a
//! Host set up over SSH keeps running after they disconnect and after the computer restarts.

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use anyhow::Context;
use anyhow::bail;
use weave_host::DaemonPaths;

use super::executable;
use super::instance;
use super::passed_on;
use super::user_id;
use crate::daemon;

/// The default Host's unit, without its `.service`.
const UNIT: &str = "weave-host";

/// How long systemd lets the Host take to stop before it kills it and its agents: the Host
/// suspends every open session as it stops, each given up to 10 seconds.
const STOP_TIMEOUT: Duration = Duration::from_secs(30);

/// Whether systemd runs the Host for `paths`.
pub(super) fn installed(paths: &DaemonPaths) -> bool {
    unit_path(paths).is_some_and(|path| path.is_file())
}

pub(super) async fn install(paths: &DaemonPaths) -> anyhow::Result<()> {
    let path = unit_path(paths).context("no home directory for ~/.config/systemd/user")?;
    let executable = executable()?;
    // Fails here, before anything changes, without a user manager to reach.
    systemctl(&["daemon-reload"])?;
    // A Host started on demand holds the socket; systemd's takes over from it.
    let was_running = daemon::stop(paths).await?;
    paths
        .prepare()
        .with_context(|| format!("creating {}", paths.dir.display()))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let contents = render(&executable, &paths.log(), &passed_on());
    std::fs::write(&path, contents).with_context(|| format!("writing {}", path.display()))?;
    let unit = unit(paths);
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", &unit])?;
    systemctl(&["restart", &unit])?;
    drop(daemon::wait_until_listening(paths).await?);
    let restarted = if was_running {
        " (it replaced the one that was running; threads it had open reopen when attached)"
    } else {
        ""
    };
    let lingering = match user_id(paths) {
        Ok(uid) => linger(uid),
        Err(error) => Lingering::Off(format!("{error:#}")),
    };
    let lingering = match lingering {
        Lingering::On => {
            "Lingering is on for you, so systemd runs it from boot, logged in or not.".to_owned()
        }
        Lingering::TurnedOn => "It turned lingering on for you (`loginctl enable-linger`), so \
                                systemd runs it from boot, logged in or not."
            .to_owned(),
        Lingering::Off(why) => format!(
            "Lingering is off for you and couldn't be turned on ({why}), so the Host stops when \
             you log out and waits for your next login after a restart; `sudo loginctl \
             enable-linger $USER` turns it on."
        ),
    };
    eprintln!(
        "Installed the weave Host as the systemd user service {unit}{restarted}. It runs {} \
         and restarts it if it stops; `weave daemon uninstall` removes it. {lingering}",
        executable.display()
    );
    Ok(())
}

pub(super) async fn uninstall(paths: &DaemonPaths) -> anyhow::Result<()> {
    let path = unit_path(paths).context("no home directory for ~/.config/systemd/user")?;
    let running = weave_host::socket::connect(&paths.socket).await.is_ok();
    systemctl(&["disable", "--now", &unit(paths)])?;
    std::fs::remove_file(&path).with_context(|| format!("removing {}", path.display()))?;
    systemctl(&["daemon-reload"]).ok();
    if running {
        daemon::wait_until_stopped(paths).await?;
    }
    eprintln!(
        "Removed the weave Host's systemd service; clients start a Host when they need one. \
         Lingering stays as it was; `loginctl disable-linger` turns it off."
    );
    Ok(())
}

pub(super) fn start(paths: &DaemonPaths) -> anyhow::Result<()> {
    systemctl(&["start", &unit(paths)])
}

pub(super) fn stop(paths: &DaemonPaths) -> anyhow::Result<()> {
    systemctl(&["stop", &unit(paths)])
}

pub(super) fn restart(paths: &DaemonPaths) -> anyhow::Result<()> {
    systemctl(&["restart", &unit(paths)])
}

pub(super) fn notes(paths: &DaemonPaths) -> Vec<String> {
    let Ok(uid) = user_id(paths) else {
        return Vec::new();
    };
    lingering_note_for(uid)
        .into_iter()
        .chain(stop_limit_note(uid))
        .collect()
}

pub(super) fn lingering_note(paths: &DaemonPaths) -> Option<String> {
    lingering_note_for(user_id(paths).ok()?)
}

fn lingering_note_for(uid: u32) -> Option<String> {
    (lingering(uid) == Some(false)).then(|| {
        "Lingering is off for you, so the Host stops when you log out, and after this computer \
         restarts it waits for your next login. `loginctl enable-linger` turns it on (with sudo, \
         if that's refused)."
            .to_owned()
    })
}

/// When systemd stops the user manager at shutdown sooner than the Host may take to stop.
fn stop_limit_note(uid: u32) -> Option<String> {
    let shown = query(
        "systemctl",
        &[
            "show",
            &format!("user@{uid}.service"),
            "--property=TimeoutStopUSec",
            "--value",
        ],
    )?;
    if timespan(&shown)? >= STOP_TIMEOUT {
        return None;
    }
    let seconds = STOP_TIMEOUT.as_secs();
    Some(format!(
        "systemd gives your user manager {shown} to stop when this computer shuts down, less \
         than the {seconds}s the Host may take to suspend its threads, so it can be cut off. To \
         give it as long, as root put `[Service]` and `TimeoutStopSec={seconds}` in \
         /etc/systemd/system/user@{uid}.service.d/zz-weave.conf, then run `systemctl \
         daemon-reload`."
    ))
}

enum Lingering {
    On,
    TurnedOn,
    /// Why it's off.
    Off(String),
}

/// Lingering, turned on if it's off: without it the user manager, and the Host, stops when
/// the person's last session ends, and starts only when they log in.
fn linger(uid: u32) -> Lingering {
    if lingering(uid) == Some(true) {
        return Lingering::On;
    }
    let uid = uid.to_string();
    match run("loginctl", &["enable-linger", &uid]) {
        Ok(_) if lingering_text(&uid).as_deref() == Some("yes") => Lingering::TurnedOn,
        Ok(_) => Lingering::Off("loginctl left it off".to_owned()),
        Err(error) => Lingering::Off(error),
    }
}

/// Whether lingering is on for `uid`, if logind says.
fn lingering(uid: u32) -> Option<bool> {
    match lingering_text(&uid.to_string())?.as_str() {
        "yes" => Some(true),
        "no" => Some(false),
        _ => None,
    }
}

fn lingering_text(uid: &str) -> Option<String> {
    query(
        "loginctl",
        &["show-user", uid, "--property=Linger", "--value"],
    )
}

/// The unit for `paths`: the default Host's, or one named after another Host directory.
fn unit(paths: &DaemonPaths) -> String {
    match instance(paths) {
        Some(name) => format!("{UNIT}-{name}.service"),
        None => format!("{UNIT}.service"),
    }
}

/// Where the user manager looks for the person's own units. Not under `$XDG_CONFIG_HOME`,
/// which a development Host sets for a config of its own and the user manager doesn't see.
fn unit_path(paths: &DaemonPaths) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty())?;
    Some(
        PathBuf::from(home)
            .join(".config/systemd/user")
            .join(unit(paths)),
    )
}

/// `systemctl --user <args>`, with a hint when it can't reach the user manager.
fn systemctl(args: &[&str]) -> anyhow::Result<()> {
    let mut all = vec!["--user"];
    all.extend_from_slice(args);
    match run("systemctl", &all) {
        Ok(_) => Ok(()),
        Err(why) if why.contains("bus") || why.contains("XDG_RUNTIME_DIR") => bail!(
            "{why}. systemctl --user reaches your user manager through XDG_RUNTIME_DIR, which \
             logging in sets, over SSH too, but su and sudo don't"
        ),
        Err(why) => bail!("{why}"),
    }
}

/// Runs `program <args>`, giving its output, or why it failed.
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let shown = format!("{program} {}", args.join(" "));
    let output = Command::new(program).args(args).output().map_err(|error| {
        format!("couldn't run `{shown}` ({error}); the weave Host's service needs systemd")
    })?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned());
    }
    let why = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Err(format!("`{shown}` failed: {why}"))
}

/// What `program <args>` prints, if it succeeds and prints something.
fn query(program: &str, args: &[&str]) -> Option<String> {
    run(program, args).ok().filter(|output| !output.is_empty())
}

/// A time span as `systemctl show` gives it, such as `5s`, `1min 30s` or `infinity`.
fn timespan(text: &str) -> Option<Duration> {
    if text == "infinity" {
        return Some(Duration::MAX);
    }
    let mut total = Duration::ZERO;
    for word in text.split_whitespace() {
        let split = word
            .find(|ch: char| !ch.is_ascii_digit() && ch != '.')
            .unwrap_or(word.len());
        let (number, unit) = word.split_at(split);
        let seconds = match unit {
            "us" | "µs" => 1e-6,
            "ms" => 1e-3,
            "" | "s" => 1.0,
            "min" => 60.0,
            "h" => 3600.0,
            "d" => 86_400.0,
            "w" => 604_800.0,
            "M" => 2_629_800.0,
            "y" => 31_557_600.0,
            _ => return None,
        };
        total += Duration::try_from_secs_f64(number.parse::<f64>().ok()? * seconds).ok()?;
    }
    (!text.trim().is_empty()).then_some(total)
}

/// The unit for a service running `executable`'s Host with `environment`, logging to `log`.
/// `KillMode=mixed` signals the Host alone, which stops its agents itself; systemd kills what
/// is left once it has gone.
fn render(executable: &Path, log: &Path, environment: &[(String, String)]) -> String {
    let variables: String = environment
        .iter()
        .map(|(name, value)| format!("Environment={}\n", quoted(&format!("{name}={value}"))))
        .collect();
    let log = specifiers(&log.display().to_string());
    format!(
        "[Unit]\n\
         Description=weave Host\n\
         \n\
         [Service]\n\
         ExecStart={program} daemon run --systemd\n\
         {variables}\
         Restart=always\n\
         RestartSec=2\n\
         KillMode=mixed\n\
         TimeoutStopSec={stop}\n\
         StandardOutput=append:{log}\n\
         StandardError=append:{log}\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        program = quoted(&executable.display().to_string()).replace('$', "$$"),
        stop = STOP_TIMEOUT.as_secs(),
    )
}

/// `value` as one quoted word of a unit file.
fn quoted(value: &str) -> String {
    let escaped = specifiers(value).replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

/// `value` with its `%`s kept from systemd's specifiers.
fn specifiers(value: &str) -> String {
    value.replace('%', "%%")
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_host_directory_of_its_own_gets_a_unit_of_its_own() {
        let paths = DaemonPaths::in_dir("/tmp/weave dev/host".into());
        assert_eq!(unit(&paths), "weave-host-tmp-weave-dev-host.service");
    }

    #[test]
    fn the_unit_runs_this_weave_with_the_places_it_was_installed_with() {
        let unit = render(
            Path::new("/opt/weave \"100%\" $HOME/weave"),
            Path::new("/state/daemon.log"),
            &[("WEAVE_DAEMON_DIR".to_owned(), "/state dir".to_owned())],
        );
        assert_eq!(
            unit,
            "[Unit]\n\
             Description=weave Host\n\
             \n\
             [Service]\n\
             ExecStart=\"/opt/weave \\\"100%%\\\" $$HOME/weave\" daemon run --systemd\n\
             Environment=\"WEAVE_DAEMON_DIR=/state dir\"\n\
             Restart=always\n\
             RestartSec=2\n\
             KillMode=mixed\n\
             TimeoutStopSec=30\n\
             StandardOutput=append:/state/daemon.log\n\
             StandardError=append:/state/daemon.log\n\
             \n\
             [Install]\n\
             WantedBy=default.target\n"
        );
    }

    #[test]
    fn systemds_time_spans_are_read() {
        assert_eq!(timespan("5s"), Some(Duration::from_secs(5)));
        assert_eq!(timespan("2min"), Some(Duration::from_secs(120)));
        assert_eq!(timespan("1min 30s"), Some(Duration::from_secs(90)));
        assert_eq!(timespan("1.500s"), Some(Duration::from_millis(1500)));
        assert_eq!(timespan("500ms"), Some(Duration::from_millis(500)));
        assert_eq!(timespan("infinity"), Some(Duration::MAX));
        assert_eq!(timespan("90"), Some(Duration::from_secs(90)));
        assert_eq!(timespan(""), None);
        assert_eq!(timespan("soon"), None);
    }
}
