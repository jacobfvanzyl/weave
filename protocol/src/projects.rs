//! Which of the person's Projects a thread is in (ADR 0031, WVE-189). The Dispatcher keeps the
//! Projects ([`crate::dispatcher::Project`]) and the Hosts keep the threads, which know nothing
//! of them, so a client that has both works it out: [`containing`].

use crate::dispatcher::Project;
use crate::threads::ThreadListing;

/// The Project `listing`, a thread on the Host `host_id`, is in: of those with a location on
/// that Host, the one whose location is the thread's repository (`git.repo`, so every worktree
/// of a git Project's repository is in it) or contains its directory. A Project in a
/// subdirectory of another's wins, as the deepest. None when no Project has it.
pub fn containing<'a>(
    projects: &'a [Project],
    host_id: &str,
    listing: &ThreadListing,
) -> Option<&'a Project> {
    let repo = listing.git.as_ref().map(|git| git.repo.as_path());
    projects
        .iter()
        .filter_map(|project| {
            let path = project.location(host_id)?.path.as_path();
            (repo == Some(path) || listing.info.cwd.starts_with(path))
                .then(|| (path.components().count(), project))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, project)| project)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use agent_client_protocol::schema::v1::SessionInfo;
    use pretty_assertions::assert_eq;

    use super::*;
    use crate::dispatcher::ProjectKind;
    use crate::dispatcher::ProjectLocation;
    use crate::threads::ThreadStatus;
    use crate::worktrees::GitLocation;

    const MAC: &str = "h-mac";
    const HOMELAB: &str = "h-homelab";

    fn project(name: &str, kind: ProjectKind, locations: &[(&str, &str)]) -> Project {
        Project {
            id: format!("p-{name}"),
            name: name.to_owned(),
            kind,
            remote: None,
            locations: locations
                .iter()
                .map(|(host_id, path)| ProjectLocation {
                    host_id: (*host_id).to_owned(),
                    path: PathBuf::from(path),
                })
                .collect(),
            created_at: 1,
            updated_at: 1,
        }
    }

    /// A thread in `cwd`, in the repository whose primary worktree is `repo` when there's one.
    fn thread(cwd: &str, repo: Option<&str>) -> ThreadListing {
        ThreadListing {
            info: SessionInfo::new("s-1", cwd),
            agent_id: "claude".to_owned(),
            state: ThreadStatus::Open,
            activity: None,
            clients: 0,
            headless: false,
            last_activity_at: None,
            git: repo.map(|repo| GitLocation {
                repo: repo.into(),
                worktree: cwd.into(),
                branch: None,
                remote: None,
            }),
            started_by: None,
            started_by_host: None,
            continued_in: None,
            labels: Vec::new(),
            context: None,
            last_compaction: None,
            opened_by: None,
            opened_at: None,
        }
    }

    fn named(found: Option<&Project>) -> Option<&str> {
        found.map(|project| project.name.as_str())
    }

    #[test]
    fn every_worktree_of_a_registered_repository_is_in_its_project() {
        let projects = [project("odin", ProjectKind::Git, &[(MAC, "/code/odin")])];
        // The primary worktree, a directory in it, and a worktree beside it, which only its
        // repository places: its directory isn't under the primary worktree's.
        for (cwd, repo) in [
            ("/code/odin", "/code/odin"),
            ("/code/odin/src/parser", "/code/odin"),
            ("/code/odin.feature-auth", "/code/odin"),
        ] {
            assert_eq!(
                named(containing(&projects, MAC, &thread(cwd, Some(repo)))),
                Some("odin"),
                "{cwd}"
            );
        }
        // Another repository beside it, whose name only starts the same.
        assert_eq!(
            named(containing(
                &projects,
                MAC,
                &thread("/code/odin-docs", Some("/code/odin-docs"))
            )),
            None
        );
    }

    #[test]
    fn a_project_in_a_subdirectory_of_another_wins_there() {
        let projects = [
            project("mono", ProjectKind::Git, &[(MAC, "/code/mono")]),
            project(
                "vendored",
                ProjectKind::Git,
                &[(MAC, "/code/mono/vendor/lib")],
            ),
        ];
        let nested = thread("/code/mono/vendor/lib/src", Some("/code/mono/vendor/lib"));
        assert_eq!(named(containing(&projects, MAC, &nested)), Some("vendored"));
        // Even listed first.
        let reversed = [projects[1].clone(), projects[0].clone()];
        assert_eq!(named(containing(&reversed, MAC, &nested)), Some("vendored"));
        // The rest of the outer repository stays the outer Project's.
        let outer = thread("/code/mono/packages/app", Some("/code/mono"));
        assert_eq!(named(containing(&projects, MAC, &outer)), Some("mono"));
    }

    #[test]
    fn a_directory_outside_any_repository_contains_its_subdirectories() {
        let projects = [project(
            "notes",
            ProjectKind::Directory,
            &[(MAC, "/Users/jaco/notes")],
        )];
        for cwd in ["/Users/jaco/notes", "/Users/jaco/notes/2026/november"] {
            assert_eq!(
                named(containing(&projects, MAC, &thread(cwd, None))),
                Some("notes"),
                "{cwd}"
            );
        }
        assert_eq!(
            named(containing(&projects, MAC, &thread("/Users/jaco", None))),
            None
        );
    }

    #[test]
    fn only_the_threads_host_counts() {
        let projects = [
            project(
                "odin",
                ProjectKind::Git,
                &[(MAC, "/Users/jaco/odin"), (HOMELAB, "/home/jaco/odin")],
            ),
            project("lab", ProjectKind::Directory, &[(HOMELAB, "/srv/lab")]),
        ];
        // The same path on a Host where the Project isn't, or is somewhere else.
        assert_eq!(
            named(containing(&projects, MAC, &thread("/srv/lab", None))),
            None
        );
        assert_eq!(
            named(containing(
                &projects,
                HOMELAB,
                &thread("/Users/jaco/odin", Some("/Users/jaco/odin"))
            )),
            None
        );
        assert_eq!(
            named(containing(
                &projects,
                HOMELAB,
                &thread("/home/jaco/odin", Some("/home/jaco/odin"))
            )),
            Some("odin")
        );
        assert_eq!(
            named(containing(
                &projects,
                "h-elsewhere",
                &thread("/srv/lab", None)
            )),
            None
        );
    }
}
