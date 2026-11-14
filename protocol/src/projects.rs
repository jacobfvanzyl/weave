//! Which of the person's Projects a thread is in (ADR 0031, WVE-189). The Dispatcher keeps the
//! Projects ([`crate::dispatcher::Project`]) and the Hosts keep the threads, which know nothing
//! of them, so a client that has both works it out: [`containing`].
//!
//! Agents read them too (WVE-208), with the Host tool `list_projects`, which the Dispatcher
//! answers with [`ListedProjects`], and name one as `project` to `start_thread` and
//! `list_threads`, which their Host works out with it.

use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;
use serde::Serialize;

use crate::dispatcher::Project;
use crate::dispatcher::ProjectLocation;
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
    containing_directory(projects, host_id, &listing.info.cwd, repo)
}

/// The Project the directory `cwd` on the Host `host_id` is in, as [`containing`] places a
/// thread there: `repo` is the primary worktree of the repository `cwd` is in, if it's in one.
pub fn containing_directory<'a>(
    projects: &'a [Project],
    host_id: &str,
    cwd: &Path,
    repo: Option<&Path>,
) -> Option<&'a Project> {
    projects
        .iter()
        .filter_map(|project| {
            let path = project.location(host_id)?.path.as_path();
            (repo == Some(path) || cwd.starts_with(path))
                .then(|| (path.components().count(), project))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, project)| project)
}

/// What the Host tool `list_projects` answers, as the Dispatcher lists it for a Host's agent:
/// the person's Projects, and the names of the Hosts their locations are on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ListedProjects {
    /// The calling thread's Host.
    pub host_id: String,
    /// By name.
    pub projects: Vec<Project>,
    /// Every Host the Dispatcher is paired with, the calling one included.
    pub hosts: Vec<NamedHost>,
}

/// One of the person's Hosts, by its id and the name the Dispatcher knows it by.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct NamedHost {
    pub host_id: String,
    pub name: String,
}

impl ListedProjects {
    /// The Host `by` names, by id or name, ignoring case.
    pub fn host(&self, by: &str) -> Option<&NamedHost> {
        self.hosts
            .iter()
            .find(|host| host.host_id == by)
            .or_else(|| {
                self.hosts
                    .iter()
                    .find(|host| host.name.eq_ignore_ascii_case(by))
            })
    }

    /// What `host_id` is called: its name, or its id when it has none here.
    fn name_of<'a>(&'a self, host_id: &'a str) -> &'a str {
        self.hosts
            .iter()
            .find(|host| host.host_id == host_id)
            .map_or(host_id, |host| host.name.as_str())
    }

    /// The Project `by` names, by id or name, ignoring case; or why there's none.
    pub fn project(&self, by: &str) -> Result<&Project, String> {
        self.projects
            .iter()
            .find(|project| project.id == by)
            .or_else(|| {
                self.projects
                    .iter()
                    .find(|project| project.name.eq_ignore_ascii_case(by))
            })
            .ok_or_else(|| {
                format!("There's no Project {by}: list_projects lists the person's Projects.")
            })
    }

    /// Where `project` is on the Host `on` names, by id or name, or on the calling Host when
    /// `on` is none; or why it isn't there, naming the Hosts it is on.
    pub fn location<'a>(
        &'a self,
        project: &'a Project,
        on: Option<&str>,
    ) -> Result<&'a ProjectLocation, String> {
        let (host_id, named) = match on {
            None => (
                self.host_id.as_str(),
                self.name_of(&self.host_id).to_owned(),
            ),
            Some(by) => match self.host(by) {
                Some(host) => (host.host_id.as_str(), by.to_owned()),
                None => {
                    return Err(format!(
                        "There's no Host {by}: list_hosts lists the person's Hosts."
                    ));
                }
            },
        };
        project.location(host_id).ok_or_else(|| {
            let on: Vec<&str> = project
                .locations
                .iter()
                .map(|location| self.name_of(&location.host_id))
                .collect();
            if on.is_empty() {
                format!(
                    "{} has no location on {named}, nor on any other Host.",
                    project.name
                )
            } else {
                format!(
                    "{} has no location on {named}; it's on {}.",
                    project.name,
                    listing(&on)
                )
            }
        })
    }
}

/// `names` as prose: "a", "a and b", "a, b and c".
fn listing(names: &[&str]) -> String {
    match names {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// The directory `cwd` names inside a Project's location `dir`, which it's relative to; `dir`
/// itself when there's none. Refused when it's absolute, under the home as `~/…`, or reaches
/// out of `dir` with `..`.
pub fn inside(dir: &Path, cwd: Option<&Path>) -> Result<PathBuf, String> {
    let Some(cwd) = cwd else {
        return Ok(dir.to_path_buf());
    };
    let relative = cwd
        .components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir));
    if !relative || cwd.starts_with("~") {
        return Err(format!(
            "With project, cwd is a directory inside the Project, relative to it, such as \
             app, not {}: leave project out to name a directory of your own.",
            cwd.display()
        ));
    }
    Ok(dir.join(cwd))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use agent_client_protocol::v1::schema::SessionInfo;
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

    fn listed() -> ListedProjects {
        ListedProjects {
            host_id: MAC.to_owned(),
            projects: vec![
                project(
                    "Odin",
                    ProjectKind::Git,
                    &[(MAC, "/Users/jaco/odin"), (HOMELAB, "/home/jaco/odin")],
                ),
                project("lab", ProjectKind::Directory, &[(HOMELAB, "/srv/lab")]),
                project("gone", ProjectKind::Directory, &[]),
            ],
            hosts: vec![
                NamedHost {
                    host_id: MAC.to_owned(),
                    name: "mac".to_owned(),
                },
                NamedHost {
                    host_id: HOMELAB.to_owned(),
                    name: "homelab".to_owned(),
                },
                NamedHost {
                    host_id: "h-studio".to_owned(),
                    name: "studio".to_owned(),
                },
            ],
        }
    }

    #[test]
    fn a_project_is_found_on_the_host_named_or_the_calling_one() {
        let listed = listed();
        let odin = listed.project("odin").expect("by name, ignoring case");
        assert_eq!(listed.project("p-Odin"), Ok(odin));
        let path = |on| {
            listed
                .location(odin, on)
                .map(|location| location.path.clone())
        };
        assert_eq!(path(None), Ok(PathBuf::from("/Users/jaco/odin")));
        assert_eq!(path(Some("HOMELAB")), Ok(PathBuf::from("/home/jaco/odin")));
        assert_eq!(path(Some(HOMELAB)), Ok(PathBuf::from("/home/jaco/odin")));
        assert_eq!(
            path(Some("studio")),
            Err("Odin has no location on studio; it's on mac and homelab.".to_owned())
        );
        assert_eq!(
            path(Some("nowhere")),
            Err("There's no Host nowhere: list_hosts lists the person's Hosts.".to_owned())
        );
        let lab = listed.project("lab").expect("lab");
        assert_eq!(
            listed.location(lab, None).map(drop),
            Err("lab has no location on mac; it's on homelab.".to_owned())
        );
        let gone = listed.project("gone").expect("gone");
        assert_eq!(
            listed.location(gone, Some("homelab")).map(drop),
            Err("gone has no location on homelab, nor on any other Host.".to_owned())
        );
        assert_eq!(
            listed.project("thor"),
            Err("There's no Project thor: list_projects lists the person's Projects.".to_owned())
        );
    }

    #[test]
    fn cwd_with_a_project_is_inside_it() {
        let dir = Path::new("/home/jaco/odin");
        assert_eq!(inside(dir, None), Ok(dir.to_path_buf()));
        assert_eq!(
            inside(dir, Some(Path::new("app/ui"))),
            Ok(dir.join("app/ui"))
        );
        for refused in ["/srv/lab", "~/odin", "../thor", "app/../../thor"] {
            assert!(inside(dir, Some(Path::new(refused))).is_err(), "{refused}");
        }
    }
}
