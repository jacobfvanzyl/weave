//! The weave Host as a launchd user agent: started at login, started again if it exits, with
//! no idle exit. `weave daemon install` writes it, and while it's installed `start`, `stop`
//! and `restart` go through `launchctl`, and clients never start a Host of their own.
//!
//! A Host directory of its own (`WEAVE_DAEMON_DIR`) gets a service of its own, named after it.

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use anyhow::Context;
use anyhow::bail;
use weave_host::DaemonPaths;

use crate::daemon;

/// The label of the default Host's service.
const LABEL: &str = "local.weave.host";

/// Folders macOS keeps processes launchd starts out of until they're let in.
const PROTECTED: [&str; 4] = [
    "Documents",
    "Desktop",
    "Downloads",
    "Library/Mobile Documents",
];

/// Environment the service passes on, as it was when installed, so it uses the same places.
const PASSED_ON: [&str; 5] = [
    "WEAVE_DAEMON_DIR",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_CACHE_HOME",
];

/// Whether launchd runs the Host for `paths`.
pub fn installed(paths: &DaemonPaths) -> bool {
    plist_path(paths).is_some_and(|path| path.is_file())
}

pub async fn install(paths: &DaemonPaths) -> anyhow::Result<()> {
    ensure_macos()?;
    let plist = plist_path(paths).context("no home directory for ~/Library/LaunchAgents")?;
    let executable = std::env::current_exe()
        .and_then(std::fs::canonicalize)
        .context("finding the weave executable")?;
    if let Some(folder) = protected(&executable) {
        bail!(
            "launchd can't start {} from {}: macOS keeps the processes it starts out of that \
             folder. Install from a copy elsewhere, such as ~/.local/bin/weave, by running that \
             copy's `weave daemon install`",
            executable.display(),
            folder.display()
        );
    }
    // A Host started on demand holds the socket; launchd's takes over from it.
    let was_running = daemon::stop(paths).await?;
    if installed(paths) {
        launchctl(&["bootout", &service_target(paths)?]).ok();
    }
    paths
        .prepare()
        .with_context(|| format!("creating {}", paths.dir.display()))?;
    let environment: Vec<(String, String)> = PASSED_ON
        .iter()
        .filter_map(|name| Some(((*name).to_owned(), std::env::var(name).ok()?)))
        .filter(|(_, value)| !value.is_empty())
        .collect();
    let contents = render(&label(paths), &executable, &paths.log(), &environment);
    if let Some(parent) = plist.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(&plist, contents).with_context(|| format!("writing {}", plist.display()))?;
    launchctl(&["bootstrap", &domain(paths)?, &plist.display().to_string()])?;
    drop(daemon::wait_until_listening(paths).await?);
    let restarted = if was_running {
        " (it replaced the one that was running; sessions it had open reopen when attached)"
    } else {
        ""
    };
    eprintln!(
        "Installed the weave Host as a launchd service{restarted}. It runs {} at login and \
         restarts it if it stops; `weave daemon uninstall` removes it. macOS may ask to let \
         weave into ~/Documents, ~/Desktop or ~/Downloads the first time an agent works there.",
        executable.display()
    );
    Ok(())
}

/// The protected folder `path` is in, if it's in one.
fn protected(path: &Path) -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME").filter(|home| !home.is_empty())?);
    let home = std::fs::canonicalize(&home).unwrap_or(home);
    PROTECTED
        .iter()
        .map(|folder| home.join(folder))
        .find(|folder| path.starts_with(folder))
}

pub async fn uninstall(paths: &DaemonPaths) -> anyhow::Result<()> {
    ensure_macos()?;
    if !installed(paths) {
        bail!("the weave Host isn't installed as a service");
    }
    let plist = plist_path(paths).context("no home directory for ~/Library/LaunchAgents")?;
    let running = weave_host::socket::connect(&paths.socket).await.is_ok();
    launchctl(&["bootout", &service_target(paths)?]).ok();
    std::fs::remove_file(&plist).with_context(|| format!("removing {}", plist.display()))?;
    if running {
        daemon::wait_until_stopped(paths).await?;
    }
    eprintln!("Removed the weave Host's launchd service; clients start a Host when they need one.");
    Ok(())
}

/// Start the installed service, loading it again if `stop` unloaded it.
pub fn start(paths: &DaemonPaths) -> anyhow::Result<()> {
    let plist = plist_path(paths).context("no home directory for ~/Library/LaunchAgents")?;
    if launchctl(&["print", &service_target(paths)?]).is_ok() {
        launchctl(&["kickstart", &service_target(paths)?])
    } else {
        launchctl(&["bootstrap", &domain(paths)?, &plist.display().to_string()])
    }
}

/// Stop the installed service until it's started again, or the next login.
pub fn stop(paths: &DaemonPaths) -> anyhow::Result<()> {
    if launchctl(&["print", &service_target(paths)?]).is_err() {
        return Ok(());
    }
    launchctl(&["bootout", &service_target(paths)?])
}

fn ensure_macos() -> anyhow::Result<()> {
    if cfg!(target_os = "macos") {
        Ok(())
    } else {
        bail!("running the weave Host as a service needs launchd, which is macOS's")
    }
}

/// The service's label: the default Host's, or one named after another Host directory.
fn label(paths: &DaemonPaths) -> String {
    let default = DaemonPaths::default_dir();
    if default.as_deref() == Some(paths.dir.as_path()) {
        return LABEL.to_owned();
    }
    let name: String = paths
        .dir
        .display()
        .to_string()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    format!("{LABEL}.{}", name.trim_matches('-'))
}

fn plist_path(paths: &DaemonPaths) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty())?;
    Some(
        PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", label(paths))),
    )
}

/// launchd's domain for this user's agents.
fn domain(paths: &DaemonPaths) -> anyhow::Result<String> {
    Ok(format!("gui/{}", user_id(paths)?))
}

fn service_target(paths: &DaemonPaths) -> anyhow::Result<String> {
    Ok(format!("{}/{}", domain(paths)?, label(paths)))
}

/// This user's id: the owner of the Host's directory, which this user created.
fn user_id(paths: &DaemonPaths) -> anyhow::Result<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        paths
            .prepare()
            .with_context(|| format!("creating {}", paths.dir.display()))?;
        Ok(std::fs::metadata(&paths.dir)
            .with_context(|| format!("reading {}", paths.dir.display()))?
            .uid())
    }
    #[cfg(not(unix))]
    {
        let _ = paths;
        bail!("no user id on this platform")
    }
}

fn launchctl(args: &[&str]) -> anyhow::Result<()> {
    let output = Command::new("launchctl")
        .args(args)
        .output()
        .context("running launchctl")?;
    if !output.status.success() {
        bail!(
            "launchctl {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// The property list for a service running `executable`'s Host with `environment`.
fn render(label: &str, executable: &Path, log: &Path, environment: &[(String, String)]) -> String {
    let string = |value: &str| format!("<string>{}</string>", escape(value));
    let variables: String = environment
        .iter()
        .map(|(name, value)| format!("\t\t<key>{}</key>\n\t\t{}\n", escape(name), string(value)))
        .collect();
    let environment = if variables.is_empty() {
        String::new()
    } else {
        format!("\t<key>EnvironmentVariables</key>\n\t<dict>\n{variables}\t</dict>\n")
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \
         \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n<dict>\n\
         \t<key>Label</key>\n\t{label}\n\
         \t<key>ProgramArguments</key>\n\t<array>\n\t\t{program}\n\t\t{daemon}\n\t\t{run}\n\t\t{launchd}\n\t</array>\n\
         {environment}\
         \t<key>RunAtLoad</key>\n\t<true/>\n\
         \t<key>KeepAlive</key>\n\t<true/>\n\
         \t<key>StandardOutPath</key>\n\t{log}\n\
         \t<key>StandardErrorPath</key>\n\t{log}\n\
         </dict>\n</plist>\n",
        label = string(label),
        program = string(&executable.display().to_string()),
        daemon = string("daemon"),
        run = string("run"),
        launchd = string("--launchd"),
        log = string(&log.display().to_string()),
    )
}

fn escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_host_directory_of_its_own_gets_a_service_of_its_own() {
        let paths = DaemonPaths::in_dir("/tmp/weave dev/host".into());
        assert_eq!(label(&paths), "local.weave.host.tmp-weave-dev-host");
    }

    #[test]
    fn the_service_runs_this_weave_with_the_places_it_was_installed_with() {
        let plist = render(
            "local.weave.host",
            Path::new("/opt/weave & co/weave"),
            Path::new("/state/daemon.log"),
            &[("WEAVE_DAEMON_DIR".to_owned(), "/state".to_owned())],
        );
        assert!(plist.contains("<string>/opt/weave &amp; co/weave</string>"));
        assert!(plist.contains(
            "<string>daemon</string>\n\t\t<string>run</string>\n\t\t<string>--launchd</string>"
        ));
        assert!(plist.contains("<key>WEAVE_DAEMON_DIR</key>\n\t\t<string>/state</string>"));
        assert!(plist.contains("<key>KeepAlive</key>\n\t<true/>"));
        assert!(
            plist.contains("<key>StandardErrorPath</key>\n\t<string>/state/daemon.log</string>")
        );
        // Without anything to pass on, there's no environment dictionary.
        let bare = render("x", Path::new("/w"), Path::new("/l"), &[]);
        assert!(!bare.contains("EnvironmentVariables"));
    }
}
