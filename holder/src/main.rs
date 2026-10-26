//! `weave-holder`, which the Host starts to keep one terminal alive (ADR 0022).
//!
//! - `weave-holder serve …` holds the terminal in the foreground until its program exits, as a
//!   systemd unit of its own runs it on Linux (`systemd-run --user`).
//! - `weave-holder spawn …` starts one in a session of its own, outside the caller's process tree,
//!   as on macOS, and returns once its socket answers, printing its record.
//! - `weave-holder --version` prints the codec of its snapshots.
//!
//! Both print the holder's record (`<id>.json`) as one line of JSON once it's ready, or
//! `{"error": …}` if it couldn't start.

use std::collections::BTreeMap;
use std::io::BufRead;
use std::io::Write;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::Args;
use clap::Parser;
use clap::Subcommand;
use weave_holder::event::Size;
use weave_holder::holder;
use weave_holder::holder::Options;
use weave_holder::launch;

#[derive(Parser)]
#[command(name = "weave-holder", disable_version_flag = true)]
struct Cli {
    /// Print the version and the codec of the holder's snapshots.
    #[arg(long, short = 'V')]
    version: bool,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Hold a terminal in the foreground until its program exits.
    Serve(Hold),
    /// Start a holder in a session of its own and return once it's ready.
    Spawn(Hold),
}

#[derive(Args)]
struct Hold {
    /// The holders' directory, where the record, socket and Ghostty's resources go.
    #[arg(long)]
    dir: PathBuf,
    /// The terminal's id: letters, digits, `-` and `_`.
    #[arg(long)]
    id: String,
    /// The directory the program starts in.
    #[arg(long)]
    cwd: PathBuf,
    #[arg(long)]
    label: Option<String>,
    /// The worktree, or directory outside a repository, the terminal belongs to.
    #[arg(long)]
    scope: Option<String>,
    /// The thread the terminal was opened from.
    #[arg(long)]
    opened_from: Option<String>,
    #[arg(long, default_value_t = 80)]
    cols: u16,
    #[arg(long, default_value_t = 24)]
    rows: u16,
    /// The shell, by default the user's login shell.
    #[arg(long)]
    shell: Option<String>,
    /// A JSON object of the environment to start the program in, read and then removed. Without
    /// it, the holder's own.
    #[arg(long)]
    env_file: Option<PathBuf>,
    /// A command to run under the shell instead of an interactive shell.
    #[arg(last = true)]
    command: Vec<String>,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    if cli.version {
        return match weave_holder::vt::codec() {
            Ok(codec) => {
                println!("weave-holder {} ({codec})", env!("CARGO_PKG_VERSION"));
                ExitCode::SUCCESS
            }
            Err(error) => fail(&error.to_string()),
        };
    }
    match cli.command {
        Some(Command::Serve(hold)) => match options(hold) {
            Ok(options) => serve(options),
            Err(error) => fail(&error),
        },
        Some(Command::Spawn(hold)) => match options(hold) {
            Ok(options) => spawn(options),
            Err(error) => fail(&error),
        },
        None => fail("say serve, spawn or --version"),
    }
}

fn options(hold: Hold) -> Result<Options, String> {
    let env = match &hold.env_file {
        Some(path) => {
            let text = std::fs::read_to_string(path)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            let _ = std::fs::remove_file(path);
            serde_json::from_str::<BTreeMap<String, String>>(&text)
                .map_err(|error| format!("{}: {error}", path.display()))?
        }
        None => std::env::vars().collect(),
    };
    Ok(Options {
        dir: hold.dir,
        id: hold.id,
        cwd: hold.cwd,
        label: hold.label,
        scope: hold.scope,
        opened_from: hold.opened_from,
        size: Size {
            cols: hold.cols.max(2),
            rows: hold.rows.max(2),
        },
        shell: hold.shell.unwrap_or_else(launch::login_shell),
        command: (!hold.command.is_empty()).then_some(hold.command),
        env,
    })
}

fn serve(options: Options) -> ExitCode {
    let mut stdout = std::io::stdout();
    match holder::serve(options, &mut stdout) {
        Ok(_) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

/// Starts the holder in a session of its own, its parent gone so it isn't the caller's child,
/// and waits for it to say it's ready.
fn spawn(options: Options) -> ExitCode {
    let (reader, mut writer) = match std::io::pipe() {
        Ok(pipe) => pipe,
        Err(error) => return fail(&error.to_string()),
    };
    let log = options.dir.join(format!("{}.log", options.id));
    // SAFETY: this process has one thread until the holder starts in the grandchild.
    match unsafe { libc::fork() } {
        -1 => fail(&std::io::Error::last_os_error().to_string()),
        0 => {
            drop(reader);
            unsafe { libc::setsid() };
            match unsafe { libc::fork() } {
                0 => {
                    detach_stdio(&log);
                    let code = match holder::serve(options, &mut writer) {
                        Ok(_) => 0,
                        Err(_) => 1,
                    };
                    let _ = std::fs::remove_file(&log);
                    std::process::exit(code)
                }
                -1 => unsafe { libc::_exit(1) },
                _ => unsafe { libc::_exit(0) },
            }
        }
        child => {
            drop(writer);
            let mut status = 0;
            unsafe { libc::waitpid(child, &mut status, 0) };
            let mut line = String::new();
            let _ = std::io::BufReader::new(reader).read_line(&mut line);
            let ready: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
            if let Some(error) = ready["error"].as_str() {
                return fail(error);
            }
            if ready["socket"].is_null() {
                return fail("the holder ended before it was ready");
            }
            let mut stdout = std::io::stdout();
            let _ = stdout.write_all(line.as_bytes());
            ExitCode::SUCCESS
        }
    }
}

/// The holder keeps none of the caller's descriptors open: its stdin and stdout are /dev/null and
/// its stderr goes to `log`, which it removes when it ends cleanly.
fn detach_stdio(log: &std::path::Path) {
    if let Some(dir) = log.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let null = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/null");
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log);
    unsafe {
        if let Ok(null) = &null {
            libc::dup2(null.as_raw_fd(), 0);
            libc::dup2(null.as_raw_fd(), 1);
        }
        if let Ok(log) = &log {
            libc::dup2(log.as_raw_fd(), 2);
        }
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("weave-holder: {message}");
    ExitCode::FAILURE
}
