//! A Bot's home on this computer (ADR 0028, WVE-118): the directory its threads run in and its
//! memory is kept in, which `weave bots add` makes before the Dispatcher adds a Bot on this
//! computer's Host. It makes the directory, a git repository unless it's in one already, and,
//! when it has neither an `AGENTS.md` nor a `CLAUDE.md`, the Bot's first memory files, committed
//! on their own. What was there it leaves as it was, and commits nothing of it.

use std::io::Write as _;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;

use anyhow::Context as _;
use anyhow::bail;

/// The memory files a home starts with: what the Bot always has in mind, and Claude's name for
/// it.
const AGENTS: &str = "AGENTS.md";
const CLAUDE: &str = "CLAUDE.md";

/// A Bot called `name`'s home on its Host when none is given: `~/bots/<name>`, lowercased, with
/// hyphens for spaces.
pub(super) fn default_home(name: &str) -> anyhow::Result<PathBuf> {
    Ok(Path::new("~/bots").join(directory_name(name)?))
}

/// `name` as a directory's: lowercased, with a hyphen for each run of spaces, and for a slash,
/// which would put it in a directory of its own.
fn directory_name(name: &str) -> anyhow::Result<String> {
    let named: String = name
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect();
    if named.chars().all(|c| c == '.') {
        bail!("{name:?} makes no directory name for a home: give one with --home");
    }
    Ok(named)
}

/// `home`, as given for a Bot on this computer, as a whole path here: `~/…` under the home
/// directory, and a relative one from this directory.
pub(super) fn here(home: &Path) -> anyhow::Result<PathBuf> {
    if let Ok(under) = home.strip_prefix("~") {
        let dir = std::env::var_os("HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .context("there's no home directory ($HOME) for ~ to name: give --home whole")?;
        return Ok(match under.as_os_str().is_empty() {
            true => dir,
            false => dir.join(under),
        });
    }
    std::path::absolute(home).with_context(|| format!("the directory {}", home.display()))
}

/// What making a home did.
#[derive(Debug)]
pub(super) struct Made {
    /// The home, whole, with symlinks resolved.
    pub(super) path: PathBuf,
    /// It wasn't there before.
    pub(super) created: bool,
    /// It wasn't in a git repository, and is one now.
    pub(super) initialized: bool,
    pub(super) files: Files,
}

/// What became of the Bot's first memory files.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Files {
    /// This one of them was there already, so neither was written.
    Kept(&'static str),
    /// Written, and committed on their own.
    Committed,
    /// Written, but not committed, for this reason.
    Uncommitted(String),
}

impl Made {
    /// What it did, for a Bot called `name`, in a sentence or two.
    pub(super) fn said(&self, name: &str) -> String {
        let place = self.path.display();
        let repository = match (self.created, self.initialized) {
            (true, true) => format!("Made {name}'s home, {place}, a git repository."),
            (true, false) => {
                format!("Made {name}'s home, {place}, in the git repository that directory is in.")
            }
            (false, true) => format!("Made {place}, {name}'s home, a git repository."),
            (false, false) => format!("{name}'s home, {place}, is in a git repository already."),
        };
        let files = match &self.files {
            Files::Kept(file) => {
                format!(" Its {file} was there already, so what's there is left as it was.")
            }
            Files::Committed => {
                format!(" Its first memory files, {AGENTS} and {CLAUDE}, are committed there.")
            }
            Files::Uncommitted(why) => format!(
                " Its first memory files, {AGENTS} and {CLAUDE}, are there but not committed: \
                 {why}."
            ),
        };
        format!("{repository}{files}")
    }
}

/// Make `home`, on this computer, the home of the Bot called `name`.
pub(super) fn make(home: &Path, name: &str) -> anyhow::Result<Made> {
    let created = !home.exists();
    std::fs::create_dir_all(home).with_context(|| format!("making {}", home.display()))?;
    let path = home
        .canonicalize()
        .with_context(|| format!("the directory {}", home.display()))?;
    if !path.is_dir() {
        bail!("{} isn't a directory", path.display());
    }
    let inside = git(&path, &["rev-parse", "--is-inside-work-tree"])?;
    let initialized =
        !(inside.status.success() && String::from_utf8_lossy(&inside.stdout).trim() == "true");
    if initialized {
        run(&path, &["init", "--quiet"])?;
    } else {
        // A home is a repository of its own: one inside another's would have its memory files
        // committed there.
        let top = git(&path, &["rev-parse", "--show-toplevel"])?;
        let top = PathBuf::from(String::from_utf8_lossy(&top.stdout).trim());
        let top = top.canonicalize().unwrap_or(top);
        if top != path {
            bail!(
                "{} is inside the repository at {}, and a Bot's home is a repository of its \
                 own: give another --home",
                path.display(),
                top.display()
            );
        }
    }
    let there = [AGENTS, CLAUDE]
        .into_iter()
        .find(|file| path.join(file).symlink_metadata().is_ok());
    let files = match there {
        Some(file) => Files::Kept(file),
        None => {
            write(&path.join(AGENTS), &agents_md(name))?;
            write(&path.join(CLAUDE), "@AGENTS.md\n")?;
            commit(&path, name)
        }
    };
    Ok(Made {
        path,
        created,
        initialized,
        files,
    })
}

/// Write `text` to `path`, which mustn't be there: nothing is overwritten.
fn write(path: &Path, text: &str) -> anyhow::Result<()> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .with_context(|| format!("writing {}", path.display()))
}

/// Commit the memory files, and nothing else that's staged, as the person git knows from its
/// configuration; without one, it says so instead.
fn commit(path: &Path, name: &str) -> Files {
    let known = ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]
        .iter()
        .all(|ident| {
            git(path, &["-c", "user.useConfigOnly=true", "var", ident])
                .is_ok_and(|output| output.status.success())
        });
    if !known {
        return Files::Uncommitted(
            "git has no user.name and user.email to commit them as; set them with `git config \
             --global`, then commit them"
                .to_owned(),
        );
    }
    let message = format!("Start {name}'s home");
    let committed = run(path, &["add", "--", AGENTS, CLAUDE]).and_then(|()| {
        run(
            path,
            &[
                "commit",
                "--quiet",
                "--message",
                &message,
                "--only",
                "--",
                AGENTS,
                CLAUDE,
            ],
        )
    });
    match committed {
        Ok(()) => Files::Committed,
        Err(error) => Files::Uncommitted(format!("{error:#}")),
    }
}

/// `git args…` in `dir`, whatever repository the environment names.
fn git(dir: &Path, args: &[&str]) -> anyhow::Result<Output> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .output()
        .context("running git, which a Bot's home is kept with")
}

/// `git args…` in `dir`, failing with what git said.
fn run(dir: &Path, args: &[&str]) -> anyhow::Result<()> {
    let output = git(dir, args)?;
    if !output.status.success() {
        bail!(
            "git {} in {}: {}",
            args.first().copied().unwrap_or_default(),
            dir.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

/// The `AGENTS.md` a Bot called `name` starts with: what its home is for and how to keep it.
fn agents_md(name: &str) -> String {
    format!(
        "# {name}

This directory is the home of the Bot named {name}, which is you: an assistant the person comes back to over weeks. Your conversations with them happen in threads, which come and go; the files here stay. What one thread doesn't write down here, the next won't know.

So keep what's worth remembering in this directory:

- `AGENTS.md`, this file, for what should always be in mind. Keep it short.
- Notes in files beside it for everything else, each named for what it's about.
- `threads/`, for a dated note about each earlier thread.

Write things down as you learn them, without waiting to be asked, and commit after each change.

When you're asked to save before a new thread, do that: save what's worth keeping to these files, write the thread's note where the prompt says, and commit.

The weave tools let you work in the person's Projects by name: `list_projects` lists them, and `start_thread` with `project` starts a thread in one. Work on code belongs in a thread in its Project, not in this directory. To be woken later, use `wake_me`; `list_wakeups` lists what you've asked for, and `cancel_wakeup` cancels one.

## What I know
"
    )
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_home_is_named_after_its_bot() {
        assert_eq!(
            default_home("Odin").ok(),
            Some(PathBuf::from("~/bots/odin"))
        );
        assert_eq!(
            default_home(" Night  Owl ").ok(),
            Some(PathBuf::from("~/bots/night-owl"))
        );
        assert_eq!(default_home("a/b").ok(), Some(PathBuf::from("~/bots/a-b")));
        for nameless in ["", "  ", "..", "."] {
            assert!(default_home(nameless).is_err(), "{nameless:?}");
        }
    }

    #[test]
    fn what_making_a_home_did_is_said_plainly() {
        let made = Made {
            path: PathBuf::from("/home/j/bots/odin"),
            created: true,
            initialized: true,
            files: Files::Committed,
        };
        assert_eq!(
            made.said("odin"),
            "Made odin's home, /home/j/bots/odin, a git repository. Its first memory files, \
             AGENTS.md and CLAUDE.md, are committed there."
        );
        let kept = Made {
            created: false,
            initialized: false,
            files: Files::Kept(AGENTS),
            ..made
        };
        assert_eq!(
            kept.said("odin"),
            "odin's home, /home/j/bots/odin, is in a git repository already. Its AGENTS.md was \
             there already, so what's there is left as it was."
        );
    }
}
