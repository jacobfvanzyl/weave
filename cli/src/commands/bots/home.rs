//! What making a Bot's home did (ADR 0028, WVE-118, WVE-178), as `weave bots add` says it. The
//! Dispatcher has the Bot's Host make the home as it adds the Bot (`repos/init`): the directory,
//! a git repository of its own, and the Bot's first memory files, committed on their own unless
//! one of them was there.

use weave_host_protocol::worktrees::FilesMade;
use weave_host_protocol::worktrees::InitRepositoryResponse;

/// What making the home of the Bot called `name` did, in a sentence or two.
pub(super) fn said(made: &InitRepositoryResponse, name: &str) -> String {
    let place = made.path.display();
    let repository = match (made.created, made.initialized) {
        (true, true) => format!("Made {name}'s home, {place}, a git repository."),
        (true, false) => format!("Made {name}'s home, {place}."),
        (false, true) => format!("Made {place}, {name}'s home, a git repository."),
        (false, false) => format!("{name}'s home, {place}, is a git repository already."),
    };
    let files = match &made.files {
        Some(FilesMade::Kept { file }) => format!(
            " Its {} was there already, so what's there is left as it was.",
            file.display()
        ),
        Some(FilesMade::Committed) => {
            " Its first memory files, AGENTS.md and CLAUDE.md, are committed there.".to_owned()
        }
        Some(FilesMade::Uncommitted { why }) => format!(
            " Its first memory files, AGENTS.md and CLAUDE.md, are there but not committed: \
             {why}."
        ),
        None => String::new(),
    };
    format!("{repository}{files}")
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn what_making_a_home_did_is_said_plainly() {
        let made = InitRepositoryResponse {
            path: "/home/j/bots/odin".into(),
            created: true,
            initialized: true,
            files: Some(FilesMade::Committed),
        };
        assert_eq!(
            said(&made, "odin"),
            "Made odin's home, /home/j/bots/odin, a git repository. Its first memory files, \
             AGENTS.md and CLAUDE.md, are committed there."
        );
        let kept = InitRepositoryResponse {
            created: false,
            initialized: false,
            files: Some(FilesMade::Kept {
                file: "AGENTS.md".into(),
            }),
            ..made.clone()
        };
        assert_eq!(
            said(&kept, "odin"),
            "odin's home, /home/j/bots/odin, is a git repository already. Its AGENTS.md was \
             there already, so what's there is left as it was."
        );
        let uncommitted = InitRepositoryResponse {
            created: false,
            files: Some(FilesMade::Uncommitted {
                why: "git has no user.name and user.email to commit them as".to_owned(),
            }),
            ..made
        };
        assert_eq!(
            said(&uncommitted, "odin"),
            "Made /home/j/bots/odin, odin's home, a git repository. Its first memory files, \
             AGENTS.md and CLAUDE.md, are there but not committed: git has no user.name and \
             user.email to commit them as."
        );
    }
}
