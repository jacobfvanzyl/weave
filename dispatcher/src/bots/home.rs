//! A Bot's home (ADR 0028, WVE-118, WVE-178): the directory on its Host its threads run in and
//! its memory is kept in, a git repository of its own. `bots/add` has the Bot's Host make it
//! with `repos/init`, with what's here: where it goes when none is given, and the memory files it
//! starts with, committed on their own.

use std::path::Path;
use std::path::PathBuf;

use weave_host_protocol::worktrees::InitRepositoryRequest;
use weave_host_protocol::worktrees::RepositoryFile;

/// The memory files a home starts with: what the Bot always has in mind, and Claude's name for
/// it.
const AGENTS: &str = "AGENTS.md";
const CLAUDE: &str = "CLAUDE.md";

/// A Bot called `name`'s home on its Host when none is given: `~/bots/<name>`, lowercased, with
/// hyphens for spaces; or why there's none.
pub(crate) fn default_home(name: &str) -> Result<PathBuf, String> {
    Ok(Path::new("~/bots").join(directory_name(name)?))
}

/// `name` as a directory's: lowercased, with a hyphen for each run of spaces, and for a slash,
/// which would put it in a directory of its own.
fn directory_name(name: &str) -> Result<String, String> {
    let named: String = name
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .map(|c| if c == '/' || c == '\\' { '-' } else { c })
        .collect();
    if named.chars().all(|c| c == '.') {
        return Err(format!(
            "{name:?} makes no directory name for a home: give one with home"
        ));
    }
    Ok(named)
}

/// What the Bot called `name`'s Host is asked to make at `home`: a repository of its own with
/// the Bot's first memory files, saying what it's for when `job` does.
pub(crate) fn request(home: &Path, name: &str, job: Option<&str>) -> InitRepositoryRequest {
    InitRepositoryRequest {
        path: home.to_path_buf(),
        files: vec![
            RepositoryFile {
                path: AGENTS.into(),
                text: agents_md(name, job),
            },
            RepositoryFile {
                path: CLAUDE.into(),
                text: format!("@{AGENTS}\n"),
            },
        ],
        message: format!("Start {name}'s home"),
    }
}

/// The `AGENTS.md` a Bot called `name` starts with: what its home is for and how to keep it,
/// and its job, in the person's words, when it has one.
fn agents_md(name: &str, job: Option<&str>) -> String {
    let job = match job.map(str::trim).filter(|job| !job.is_empty()) {
        Some(job) => format!("\n## Your job\n\n{job}\n"),
        None => String::new(),
    };
    format!(
        "# {name}

This directory is the home of the Bot named {name}, which is you: an assistant the person comes back to over weeks. Your conversations with them happen in threads, which come and go; the files here stay. What one thread doesn't write down here, the next won't know.
{job}
So keep what's worth remembering in this directory:

- `AGENTS.md`, this file, for what should always be in mind. Keep it short.
- Notes in files beside it for everything else, each named for what it's about.
- `threads/`, for a dated note about each earlier thread.

Write things down as you learn them, without waiting to be asked, and commit after each change.

When you're asked to save before a new thread, do that: save what's worth keeping to these files, write the thread's note where the prompt says, and commit.

The weave tools let you work in the person's Projects by name: `list_projects` lists them, and `start_thread` with `project` starts a thread in one. Work on code belongs in a thread in its Project, not in this directory. To be woken later, use `wake_me`; `list_wakeups` lists what you've asked for, and `cancel_wakeup` cancels one.

Your schedules prompt you at the times they give, and the person may ask you to manage them: `add_schedule` adds one, `list_schedules` lists them, the person's too, and `pause_schedule`, `resume_schedule` and `remove_schedule` change one. When the person asks for another Bot, `create_bot` makes it, with a home and a job of its own, and `list_bots` lists their Bots. A Bot you make does nothing until the person prompts it, so tell them it's there. `set_avatar` changes your own avatar, an emoji on a colour, when the person asks.

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
    fn a_home_starts_with_its_memory_files_and_its_job() {
        let request = request(Path::new("~/bots/odin"), "odin", None);
        assert_eq!(request.message, "Start odin's home");
        let names: Vec<&Path> = request
            .files
            .iter()
            .map(|file| file.path.as_path())
            .collect();
        assert_eq!(names, [Path::new("AGENTS.md"), Path::new("CLAUDE.md")]);
        assert_eq!(request.files[1].text, "@AGENTS.md\n");
        let plain = &request.files[0].text;
        assert!(plain.starts_with("# odin\n\nThis directory is the home of the Bot named odin"));
        assert!(!plain.contains("## Your job"), "{plain}");
        assert!(plain.ends_with("## What I know\n"), "{plain}");
        for tool in [
            "wake_me",
            "add_schedule",
            "list_schedules",
            "pause_schedule",
            "resume_schedule",
            "remove_schedule",
            "create_bot",
            "list_bots",
            "set_avatar",
        ] {
            assert!(plain.contains(&format!("`{tool}`")), "{tool}: {plain}");
        }

        let with_job = agents_md("odin", Some(" Keep the meeting notes in order.\n"));
        let (before, after) = with_job
            .split_once("\n## Your job\n\nKeep the meeting notes in order.\n\nSo keep")
            .expect("its job right after the opening paragraph");
        assert!(before.ends_with("the next won't know.\n"), "{before}");
        assert!(after.starts_with(" what's worth remembering"), "{after}");
        assert_eq!(agents_md("odin", Some("  ")), agents_md("odin", None));
    }
}
