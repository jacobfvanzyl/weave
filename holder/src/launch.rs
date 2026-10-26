//! What a holder runs, and in which environment: the person's shell, started as Ghostty starts
//! one (`src/termio/Exec.zig` and `src/termio/shell_integration.zig` upstream, at the commit
//! `ghostty.toml` pins).
//!
//! - On macOS an interactive shell runs under `login(1)` (`-q` with `~/.hushlogin`), so it's a
//!   login shell as in Terminal and Ghostty; elsewhere under `/bin/sh -c`. `login(1)` exits 0
//!   whatever the shell exits with, so a command, whose exit code matters, skips it.
//! - The environment is the one given (the agents', WVE-141) with `TERM=xterm-ghostty` and
//!   `TERMINFO` naming Ghostty's terminfo, `COLORTERM`, and `TERM_PROGRAM=weave`, not `ghostty`,
//!   which would promise what weave's clients don't draw, such as Kitty graphics.
//! - Ghostty's shell integration is injected for zsh (`ZDOTDIR`), bash (`--posix` and `ENV`, but
//!   not Apple's `/bin/bash` 3.2, which ignores `ENV`), and fish, elvish and nushell
//!   (`XDG_DATA_DIRS`), so the shell reports its directory (OSC 7) and its commands (OSC 133).
//! - A command runs non-interactively under a login shell, without integration.

use std::collections::BTreeMap;
use std::path::Path;

use crate::resources::Resources;

/// A program and its arguments, its environment, and the shell integration it has.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launch {
    pub argv: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub integration: Option<Integration>,
}

/// The shells Ghostty integrates with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Integration {
    Bash,
    Elvish,
    Fish,
    Nushell,
    Zsh,
}

/// What to launch.
pub struct Options<'a> {
    /// The person's login shell.
    pub shell: &'a str,
    /// A command to run under the shell instead of an interactive shell.
    pub command: Option<&'a [String]>,
    /// Ghostty's resources, without which the terminal is `xterm-256color` and has no integration.
    pub resources: Option<&'a Resources>,
    /// The environment to start from.
    pub env: BTreeMap<String, String>,
    /// macOS: the user `login(1)` runs the shell as, and whether `~/.hushlogin` exists.
    pub login: Option<Login<'a>>,
}

pub struct Login<'a> {
    pub user: &'a str,
    pub hush: bool,
}

/// Ghostty's default shell features, less `path`, which puts Ghostty's own binary on PATH.
const SHELL_FEATURES: &str = "cursor:blink,title";

pub fn launch(options: Options) -> Launch {
    let Options {
        shell,
        command,
        resources,
        mut env,
        login,
    } = options;
    env.remove("VTE_VERSION");
    env.insert("COLORTERM".into(), "truecolor".into());
    env.insert("TERM_PROGRAM".into(), "weave".into());
    env.insert(
        "TERM_PROGRAM_VERSION".into(),
        env!("CARGO_PKG_VERSION").into(),
    );
    match resources {
        Some(resources) => {
            env.insert("TERM".into(), "xterm-ghostty".into());
            env.insert("TERMINFO".into(), path(&resources.terminfo()));
            env.insert("GHOSTTY_RESOURCES_DIR".into(), path(&resources.ghostty()));
        }
        None => {
            env.insert("TERM".into(), "xterm-256color".into());
            env.remove("TERMINFO");
        }
    }

    let (script, integration) = match (command, resources) {
        (Some(command), _) => (
            format!("exec {} -l -c {}", quote(shell), quote(&join(command))),
            None,
        ),
        (None, Some(resources)) => integrate(shell, resources, &mut env),
        (None, None) => (quote(shell), None),
    };
    if integration.is_some() {
        env.insert("GHOSTTY_SHELL_FEATURES".into(), SHELL_FEATURES.into());
    }

    let argv = match login.filter(|_| command.is_none()) {
        // As Ghostty does: login(1) for a login session, then bash only to `exec -l` the shell,
        // which makes it a login shell whatever it is.
        Some(Login { user, hush }) => {
            let mut argv = vec!["/usr/bin/login".to_string()];
            if hush {
                argv.push("-q".into());
            }
            argv.extend(
                ["-flp", user, "/bin/bash", "--noprofile", "--norc", "-c"].map(String::from),
            );
            argv.push(format!("exec -l {script}"));
            argv
        }
        None => vec!["/bin/sh".into(), "-c".into(), script],
    };
    Launch {
        argv,
        env,
        integration,
    }
}

/// The shell's command line with Ghostty's integration for it, and the integration, if any.
fn integrate(
    shell: &str,
    resources: &Resources,
    env: &mut BTreeMap<String, String>,
) -> (String, Option<Integration>) {
    let integration_dir = resources.ghostty().join("shell-integration");
    let name = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    match name {
        "zsh" => {
            if let Some(old) = env.get("ZDOTDIR").cloned() {
                env.insert("GHOSTTY_ZSH_ZDOTDIR".into(), old);
            }
            env.insert("ZDOTDIR".into(), path(&integration_dir.join("zsh")));
            (quote(shell), Some(Integration::Zsh))
        }
        // Apple's bash 3.2 ignores ENV in POSIX mode; /bin is Apple's on macOS.
        "bash" if !(cfg!(target_os = "macos") && shell == "/bin/bash") => {
            if let Some(old) = env.get("ENV").cloned() {
                env.insert("GHOSTTY_BASH_ENV".into(), old);
            }
            env.insert(
                "ENV".into(),
                path(&integration_dir.join("bash/ghostty.bash")),
            );
            env.insert("GHOSTTY_BASH_INJECT".into(), "1".into());
            // POSIX mode's history file is ~/.sh_history; the script switches back.
            if !env.contains_key("HISTFILE")
                && let Some(home) = env.get("HOME").cloned()
            {
                env.insert("HISTFILE".into(), format!("{home}/.bash_history"));
                env.insert("GHOSTTY_BASH_UNEXPORT_HISTFILE".into(), "1".into());
            }
            (format!("{} --posix", quote(shell)), Some(Integration::Bash))
        }
        "fish" | "elvish" | "nu" => {
            let dir = path(&integration_dir);
            let dirs = env
                .get("XDG_DATA_DIRS")
                .filter(|dirs| !dirs.is_empty())
                .cloned()
                .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
            env.insert("XDG_DATA_DIRS".into(), format!("{dir}:{dirs}"));
            env.insert("GHOSTTY_SHELL_INTEGRATION_XDG_DIR".into(), dir);
            match name {
                "fish" => (quote(shell), Some(Integration::Fish)),
                "elvish" => (quote(shell), Some(Integration::Elvish)),
                _ => (
                    format!("{} --execute 'use ghostty *'", quote(shell)),
                    Some(Integration::Nushell),
                ),
            }
        }
        _ => (quote(shell), None),
    }
}

/// The user's login shell from the password database, else `$SHELL`, else `/bin/sh`.
pub fn login_shell() -> String {
    passwd(|entry| entry.pw_shell)
        .filter(|shell| !shell.is_empty())
        .or_else(|| std::env::var("SHELL").ok())
        .unwrap_or_else(|| "/bin/sh".into())
}

/// The user's name from the password database, else `$USER`.
pub fn user_name() -> String {
    passwd(|entry| entry.pw_name)
        .or_else(|| std::env::var("USER").ok())
        .unwrap_or_default()
}

fn passwd(field: fn(&libc::passwd) -> *mut libc::c_char) -> Option<String> {
    // SAFETY: getpwuid's entry is read at once, before another call can replace it.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() {
            return None;
        }
        let value = field(&*entry);
        (!value.is_null()).then(|| {
            std::ffi::CStr::from_ptr(value)
                .to_string_lossy()
                .into_owned()
        })
    }
}

fn path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// A word for `sh`, single-quoted unless it needs no quotes.
fn quote(word: &str) -> String {
    let plain = !word.is_empty()
        && word
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/._-+=:,@%".contains(&byte));
    if plain {
        word.to_string()
    } else {
        format!("'{}'", word.replace('\'', r"'\''"))
    }
}

fn join(command: &[String]) -> String {
    command
        .iter()
        .map(|word| quote(word))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn resources() -> (tempfile::TempDir, Resources) {
        let dir = tempfile::tempdir().unwrap();
        let resources = crate::resources::materialize(dir.path()).unwrap().unwrap();
        (dir, resources)
    }

    fn env() -> BTreeMap<String, String> {
        BTreeMap::from([
            ("HOME".into(), "/home/me".into()),
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("VTE_VERSION".into(), "7600".into()),
        ])
    }

    fn options<'a>(shell: &'a str, resources: Option<&'a Resources>) -> Options<'a> {
        Options {
            shell,
            command: None,
            resources,
            env: env(),
            login: None,
        }
    }

    #[test]
    fn zsh_gets_ghosttys_zdotdir_and_terminfo() {
        let (_dir, resources) = resources();
        let mut options = options("/bin/zsh", Some(&resources));
        options
            .env
            .insert("ZDOTDIR".into(), "/home/me/.config/zsh".into());
        let launch = launch(options);
        assert_eq!(launch.argv, ["/bin/sh", "-c", "/bin/zsh"]);
        assert_eq!(launch.integration, Some(Integration::Zsh));
        let env = &launch.env;
        assert_eq!(env["TERM"], "xterm-ghostty");
        assert_eq!(env["TERMINFO"], path(&resources.terminfo()));
        assert_eq!(env["COLORTERM"], "truecolor");
        assert_eq!(env["TERM_PROGRAM"], "weave");
        assert_eq!(env["GHOSTTY_RESOURCES_DIR"], path(&resources.ghostty()));
        assert_eq!(env["GHOSTTY_SHELL_FEATURES"], "cursor:blink,title");
        assert_eq!(
            env["ZDOTDIR"],
            path(&resources.ghostty().join("shell-integration/zsh"))
        );
        assert_eq!(env["GHOSTTY_ZSH_ZDOTDIR"], "/home/me/.config/zsh");
        assert_eq!(env["PATH"], "/usr/bin:/bin");
        assert!(!env.contains_key("VTE_VERSION"));
    }

    #[test]
    fn bash_runs_in_posix_mode_with_ghosttys_env_script() {
        let (_dir, resources) = resources();
        let launch = launch(options("/opt/homebrew/bin/bash", Some(&resources)));
        assert_eq!(launch.argv[2], "/opt/homebrew/bin/bash --posix");
        assert_eq!(launch.integration, Some(Integration::Bash));
        assert_eq!(
            launch.env["ENV"],
            path(
                &resources
                    .ghostty()
                    .join("shell-integration/bash/ghostty.bash")
            )
        );
        assert_eq!(launch.env["GHOSTTY_BASH_INJECT"], "1");
        assert_eq!(launch.env["HISTFILE"], "/home/me/.bash_history");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn apples_bash_gets_no_integration() {
        let (_dir, resources) = resources();
        let launch = launch(options("/bin/bash", Some(&resources)));
        assert_eq!(launch.argv[2], "/bin/bash");
        assert_eq!(launch.integration, None);
        assert!(!launch.env.contains_key("ENV"));
    }

    #[test]
    fn fish_elvish_and_nushell_find_it_on_xdg_data_dirs() {
        let (_dir, resources) = resources();
        let dir = path(&resources.ghostty().join("shell-integration"));
        for (shell, integration, script) in [
            ("/usr/bin/fish", Integration::Fish, "/usr/bin/fish"),
            ("/usr/bin/elvish", Integration::Elvish, "/usr/bin/elvish"),
            (
                "/usr/bin/nu",
                Integration::Nushell,
                "/usr/bin/nu --execute 'use ghostty *'",
            ),
        ] {
            let launch = launch(options(shell, Some(&resources)));
            assert_eq!(launch.argv[2], script);
            assert_eq!(launch.integration, Some(integration));
            assert_eq!(
                launch.env["XDG_DATA_DIRS"],
                format!("{dir}:/usr/local/share:/usr/share")
            );
            assert_eq!(launch.env["GHOSTTY_SHELL_INTEGRATION_XDG_DIR"], dir);
        }
    }

    #[test]
    fn other_shells_and_missing_resources_get_no_integration() {
        let (_dir, resources) = resources();
        let launch = launch(options("/bin/dash", Some(&resources)));
        assert_eq!(launch.integration, None);
        assert_eq!(launch.env["TERM"], "xterm-ghostty");
        assert!(!launch.env.contains_key("GHOSTTY_SHELL_FEATURES"));

        let launch = super::launch(options("/bin/zsh", None));
        assert_eq!(launch.integration, None);
        assert_eq!(launch.env["TERM"], "xterm-256color");
        assert!(!launch.env.contains_key("ZDOTDIR"));
    }

    #[test]
    fn macos_runs_a_login_shell_under_login() {
        let (_dir, resources) = resources();
        let mut options = options("/bin/zsh", Some(&resources));
        options.login = Some(Login {
            user: "me",
            hush: true,
        });
        assert_eq!(
            launch(options).argv,
            [
                "/usr/bin/login",
                "-q",
                "-flp",
                "me",
                "/bin/bash",
                "--noprofile",
                "--norc",
                "-c",
                "exec -l /bin/zsh",
            ]
        );
    }

    #[test]
    fn a_command_runs_under_a_login_shell_without_integration() {
        let (_dir, resources) = resources();
        let command = ["npm".to_string(), "run".into(), "dev server".into()];
        let mut options = options("/bin/zsh", Some(&resources));
        options.command = Some(&command);
        // Without login(1) even on macOS, which would hide the command's exit code.
        options.login = Some(Login {
            user: "me",
            hush: false,
        });
        let launch = launch(options);
        assert_eq!(
            launch.argv,
            [
                "/bin/sh",
                "-c",
                "exec /bin/zsh -l -c 'npm run '\\''dev server'\\'''"
            ]
        );
        assert_eq!(launch.integration, None);
        assert!(!launch.env.contains_key("ZDOTDIR"));
    }
}
