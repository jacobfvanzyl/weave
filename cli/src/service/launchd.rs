//! The weave Host, and the Dispatcher, as launchd user agents, on macOS: started at login and
//! started again if they exit, through `launchctl`.

use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use anyhow::Context;
use anyhow::bail;
use weave_dispatcher::DispatcherPaths;
use weave_host::DaemonPaths;

use super::dispatcher_instance;
use super::executable;
use super::instance;
use super::owner_of;
use super::passed_on;
use super::user_id;
use crate::daemon;

/// The label of the default Host's service.
const LABEL: &str = "local.weave.host";

/// The label of the default Dispatcher's service.
const DISPATCHER_LABEL: &str = "local.weave.dispatcher";

/// Folders macOS keeps processes launchd starts out of until they're let in.
const PROTECTED: [&str; 4] = [
    "Documents",
    "Desktop",
    "Downloads",
    "Library/Mobile Documents",
];

/// Whether launchd runs the Host for `paths`.
pub(super) fn installed(paths: &DaemonPaths) -> bool {
    plist_path(paths).is_some_and(|path| path.is_file())
}

pub(super) async fn install(paths: &DaemonPaths) -> anyhow::Result<()> {
    let plist = plist_path(paths).context("no home directory for ~/Library/LaunchAgents")?;
    let executable = startable(executable()?, "weave daemon install")?;
    // A Host started on demand holds the socket; launchd's takes over from it.
    let was_running = daemon::stop(paths, false).await?;
    if installed(paths) {
        launchctl(&["bootout", &service_target(paths)?]).ok();
    }
    paths
        .prepare()
        .with_context(|| format!("creating {}", paths.dir.display()))?;
    let contents = render(
        &label(paths),
        &executable,
        &["daemon", "run", "--launchd"],
        &paths.log(),
        &passed_on(),
    );
    if let Some(parent) = plist.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(&plist, contents).with_context(|| format!("writing {}", plist.display()))?;
    launchctl(&["bootstrap", &domain(paths)?, &plist.display().to_string()])?;
    drop(daemon::wait_until_listening(paths).await?);
    let restarted = if was_running {
        " (it replaced the one that was running; threads it had open reopen when attached)"
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

/// `executable`, unless it's in a folder launchd can't start it from; `install` is the command
/// to run from a copy elsewhere.
fn startable(executable: PathBuf, install: &str) -> anyhow::Result<PathBuf> {
    if let Some(folder) = protected(&executable) {
        bail!(
            "launchd can't start {} from {}: macOS keeps the processes it starts out of that \
             folder. Install from a copy elsewhere, such as ~/.local/bin/weave, by running that \
             copy's `{install}`",
            executable.display(),
            folder.display()
        );
    }
    Ok(executable)
}

/// Whether launchd runs the Dispatcher for `paths`.
pub(super) fn dispatcher_installed(paths: &DispatcherPaths) -> bool {
    agent_plist(&dispatcher_label(paths)).is_some_and(|path| path.is_file())
}

/// Write the Dispatcher's service and start it.
pub(super) fn install_dispatcher(paths: &DispatcherPaths) -> anyhow::Result<PathBuf> {
    let label = dispatcher_label(paths);
    let plist = agent_plist(&label).context("no home directory for ~/Library/LaunchAgents")?;
    let executable = startable(executable()?, "weave dispatcher install")?;
    let uid = owner_of(&paths.dir)?;
    let target = format!("gui/{uid}/{label}");
    if plist.is_file() {
        launchctl(&["bootout", &target]).ok();
    }
    let contents = render(
        &label,
        &executable,
        &["dispatcher", "run"],
        &paths.log(),
        &passed_on(),
    );
    if let Some(parent) = plist.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    std::fs::write(&plist, contents).with_context(|| format!("writing {}", plist.display()))?;
    launchctl(&[
        "bootstrap",
        &format!("gui/{uid}"),
        &plist.display().to_string(),
    ])?;
    Ok(executable)
}

pub(super) fn uninstall_dispatcher(paths: &DispatcherPaths) -> anyhow::Result<()> {
    let label = dispatcher_label(paths);
    let plist = agent_plist(&label).context("no home directory for ~/Library/LaunchAgents")?;
    let uid = owner_of(&paths.dir)?;
    launchctl(&["bootout", &format!("gui/{uid}/{label}")]).ok();
    std::fs::remove_file(&plist).with_context(|| format!("removing {}", plist.display()))
}

/// The Dispatcher service's label: the default Dispatcher's, or one named after another
/// directory.
fn dispatcher_label(paths: &DispatcherPaths) -> String {
    match dispatcher_instance(paths) {
        Some(name) => format!("{DISPATCHER_LABEL}.{name}"),
        None => DISPATCHER_LABEL.to_owned(),
    }
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

pub(super) async fn uninstall(paths: &DaemonPaths) -> anyhow::Result<()> {
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
pub(super) fn start(paths: &DaemonPaths) -> anyhow::Result<()> {
    let plist = plist_path(paths).context("no home directory for ~/Library/LaunchAgents")?;
    if launchctl(&["print", &service_target(paths)?]).is_ok() {
        launchctl(&["kickstart", &service_target(paths)?])
    } else {
        launchctl(&["bootstrap", &domain(paths)?, &plist.display().to_string()])
    }
}

/// Stop the installed service until it's started again, or the next login.
pub(super) fn stop(paths: &DaemonPaths) -> anyhow::Result<()> {
    if launchctl(&["print", &service_target(paths)?]).is_err() {
        return Ok(());
    }
    launchctl(&["bootout", &service_target(paths)?])
}

/// The service's label: the default Host's, or one named after another Host directory.
fn label(paths: &DaemonPaths) -> String {
    match instance(paths) {
        Some(name) => format!("{LABEL}.{name}"),
        None => LABEL.to_owned(),
    }
}

fn plist_path(paths: &DaemonPaths) -> Option<PathBuf> {
    agent_plist(&label(paths))
}

/// Where the user agent `label`'s property list goes.
fn agent_plist(label: &str) -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty())?;
    Some(
        PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{label}.plist")),
    )
}

/// launchd's domain for this user's agents.
fn domain(paths: &DaemonPaths) -> anyhow::Result<String> {
    Ok(format!("gui/{}", user_id(paths)?))
}

fn service_target(paths: &DaemonPaths) -> anyhow::Result<String> {
    Ok(format!("{}/{}", domain(paths)?, label(paths)))
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

/// The property list for a service running `executable` with `arguments` and `environment`.
fn render(
    label: &str,
    executable: &Path,
    arguments: &[&str],
    log: &Path,
    environment: &[(String, String)],
) -> String {
    let string = |value: &str| format!("<string>{}</string>", escape(value));
    let variables: String = environment
        .iter()
        .map(|(name, value)| format!("\t\t<key>{}</key>\n\t\t{}\n", escape(name), string(value)))
        .collect();
    let arguments: String = std::iter::once(executable.display().to_string())
        .chain(arguments.iter().map(|argument| (*argument).to_owned()))
        .map(|argument| format!("\t\t{}\n", string(&argument)))
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
         \t<key>ProgramArguments</key>\n\t<array>\n{arguments}\t</array>\n\
         {environment}\
         \t<key>RunAtLoad</key>\n\t<true/>\n\
         \t<key>KeepAlive</key>\n\t<true/>\n\
         \t<key>StandardOutPath</key>\n\t{log}\n\
         \t<key>StandardErrorPath</key>\n\t{log}\n\
         </dict>\n</plist>\n",
        label = string(label),
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
    fn a_dispatcher_directory_of_its_own_gets_a_service_of_its_own() {
        let paths = DispatcherPaths::in_dir("/tmp/weave dev/dispatcher".into());
        assert_eq!(
            dispatcher_label(&paths),
            "local.weave.dispatcher.tmp-weave-dev-dispatcher"
        );
    }

    #[test]
    fn the_service_runs_this_weave_with_the_places_it_was_installed_with() {
        let plist = render(
            "local.weave.host",
            Path::new("/opt/weave & co/weave"),
            &["daemon", "run", "--launchd"],
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
        let bare = render("x", Path::new("/w"), &[], Path::new("/l"), &[]);
        assert!(!bare.contains("EnvironmentVariables"));
    }
}
