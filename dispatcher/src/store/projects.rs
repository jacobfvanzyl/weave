//! The person's Projects (ADR 0031, WVE-189): each a name, a kind and, for a git Project, its
//! repository's remote, with at most one location on each Host that joined the Dispatcher. A
//! change checks what it must in the transaction that makes it, so two at once can't both take
//! a name or a location.

use std::path::Path;

use rusqlite::Connection;
use rusqlite::OptionalExtension as _;
use rusqlite::params;
use weave_host_protocol::dispatcher::NewLocation;
use weave_host_protocol::dispatcher::Project;
use weave_host_protocol::dispatcher::ProjectKind;
use weave_host_protocol::dispatcher::ProjectLocation;

use super::Store;
use super::failed;
use super::from_sql;
use super::random_id;
use super::to_sql;
use crate::now_ms;

/// Why a change to the Projects didn't happen.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ProjectError {
    /// The request was wrong, as this says.
    Refused(String),
    /// The database failed.
    Failed(String),
}

impl From<rusqlite::Error> for ProjectError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Failed(failed(error))
    }
}

/// What `projects/update` asks of one Project, done in this order.
#[derive(Clone, Debug, Default)]
pub(crate) struct Change {
    pub(crate) name: Option<String>,
    /// The Host whose location goes, by id or name.
    pub(crate) remove_host: Option<String>,
    pub(crate) add: Option<NewLocation>,
}

impl Store {
    /// The Projects, by name.
    pub(crate) fn projects(&self) -> Result<Vec<Project>, String> {
        all(&self.lock()).map_err(failed)
    }

    /// The Project `by` names, by id or else by name, ignoring case.
    pub(crate) fn project(&self, by: &str) -> Result<Option<Project>, String> {
        find(&self.lock(), by).map_err(failed)
    }

    /// A new Project called `name`, of the kind its first location, `location`, is.
    pub(crate) fn add_project(
        &self,
        name: &str,
        location: &NewLocation,
    ) -> Result<Project, ProjectError> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        let name = free_name(&transaction, name, None)?;
        place(&transaction, location)?;
        let now = now_ms();
        let project = Project {
            id: format!("p-{}", random_id()),
            name,
            kind: location.kind,
            remote: match location.kind {
                ProjectKind::Git => location.remote.clone(),
                ProjectKind::Directory => None,
            },
            locations: vec![ProjectLocation {
                host_id: location.host_id.clone(),
                path: location.path.clone(),
            }],
            created_at: now,
            updated_at: now,
        };
        transaction.execute(
            "INSERT INTO projects (id, name, kind, remote, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                project.id,
                project.name,
                project.kind.name(),
                project.remote,
                to_sql(now)
            ],
        )?;
        insert_location(&transaction, &project.id, location, now)?;
        transaction.commit()?;
        Ok(project)
    }

    /// Rename the Project `by` names, remove its location on a Host and add one, all or none.
    pub(crate) fn update_project(&self, by: &str, change: Change) -> Result<Project, ProjectError> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        let mut project = find(&transaction, by)?.ok_or_else(|| missing(by))?;
        let now = now_ms();
        let mut changed = false;
        if let Some(name) = &change.name {
            let name = free_name(&transaction, name, Some(&project.id))?;
            if name != project.name {
                transaction.execute(
                    "UPDATE projects SET name = ?2 WHERE id = ?1",
                    params![project.id, name],
                )?;
                project.name = name;
                changed = true;
            }
        }
        if let Some(host) = &change.remove_host {
            let host_id = located(&transaction, &project, host)?;
            transaction.execute(
                "DELETE FROM project_locations WHERE project_id = ?1 AND host_id = ?2",
                params![project.id, host_id],
            )?;
            project
                .locations
                .retain(|location| location.host_id != host_id);
            changed = true;
        }
        if let Some(location) = &change.add {
            changed |= join(&transaction, &mut project, location, now)?;
        }
        if changed {
            transaction.execute(
                "UPDATE projects SET updated_at = ?2 WHERE id = ?1",
                params![project.id, to_sql(now)],
            )?;
        }
        let project = find(&transaction, &project.id)?.ok_or_else(|| missing(by))?;
        transaction.commit()?;
        Ok(project)
    }

    /// Note that the Host `host_id`, which resolves remotes (WVE-213), reports `remote` for the
    /// repository at `repo` there. A git Project located there takes it for its remote, unless
    /// another of its locations' Hosts reported the remote it has: so a remote recorded from a
    /// URL's host as written, before Hosts resolved SSH host aliases, becomes the resolved one
    /// as the Hosts are updated, in any order, and two Hosts that disagree don't take turns.
    /// The Project, when its remote changed.
    pub(crate) fn reported_remote(
        &self,
        host_id: &str,
        repo: &Path,
        remote: &str,
    ) -> Result<Option<Project>, String> {
        let mut connection = self.lock();
        let transaction = connection.transaction().map_err(failed)?;
        let changed = reported(&transaction, host_id, repo, remote).map_err(failed)?;
        transaction.commit().map_err(failed)?;
        Ok(changed)
    }

    /// Forget the Project `by` names, and its locations, giving what it was.
    pub(crate) fn remove_project(&self, by: &str) -> Result<Project, ProjectError> {
        let mut connection = self.lock();
        let transaction = connection.transaction()?;
        let project = find(&transaction, by)?.ok_or_else(|| missing(by))?;
        transaction.execute("DELETE FROM projects WHERE id = ?1", params![project.id])?;
        transaction.commit()?;
        Ok(project)
    }
}

fn missing(by: &str) -> ProjectError {
    ProjectError::Refused(format!("there's no Project {by}"))
}

/// [`Store::reported_remote`] in `connection`'s transaction.
fn reported(
    connection: &Connection,
    host_id: &str,
    repo: &Path,
    remote: &str,
) -> rusqlite::Result<Option<Project>> {
    let located: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT project_locations.project_id, project_locations.remote \
             FROM project_locations JOIN projects ON projects.id = project_locations.project_id \
             WHERE project_locations.host_id = ?1 AND project_locations.path = ?2 \
             AND projects.kind = 'git'",
            params![host_id, text(repo)],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((project_id, before)) = located else {
        return Ok(None);
    };
    if before.as_deref() == Some(remote) {
        return Ok(None);
    }
    connection.execute(
        "UPDATE project_locations SET remote = ?3 WHERE project_id = ?1 AND host_id = ?2",
        params![project_id, host_id, remote],
    )?;
    let Some(mut project) = find(connection, &project_id)? else {
        return Ok(None);
    };
    let kept = match &project.remote {
        Some(ours) if ours == remote => return Ok(None),
        Some(ours) => connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM project_locations \
             WHERE project_id = ?1 AND host_id != ?2 AND remote = ?3)",
            params![project_id, host_id, ours],
            |row| row.get(0),
        )?,
        None => false,
    };
    if kept {
        return Ok(None);
    }
    let now = now_ms();
    connection.execute(
        "UPDATE projects SET remote = ?2, updated_at = ?3 WHERE id = ?1",
        params![project_id, remote, to_sql(now)],
    )?;
    project.remote = Some(remote.to_owned());
    project.updated_at = now;
    Ok(Some(project))
}

/// Add `location` to `project`, whose kind and remote it must share: whether that changed it.
/// One where the Project is already changes nothing; one elsewhere on that Host is refused.
fn join(
    connection: &Connection,
    project: &mut Project,
    location: &NewLocation,
    now: u64,
) -> Result<bool, ProjectError> {
    let host = host_name(connection, &location.host_id)?;
    let path = location.path.display();
    let name = &project.name;
    if let Some(existing) = project.location(&location.host_id) {
        if existing.path == location.path {
            return Ok(false);
        }
        let host = host.as_deref().unwrap_or(&location.host_id);
        return Err(ProjectError::Refused(format!(
            "{name} is at {} on {host} already, and has one location on each Host: \
             `weave projects update {name} --remove-host {host}` removes that one first",
            existing.path.display()
        )));
    }
    if location.kind != project.kind {
        let host = host.as_deref().unwrap_or(&location.host_id);
        let what = match location.kind {
            ProjectKind::Git => "in a git repository",
            ProjectKind::Directory => "a directory outside any repository",
        };
        return Err(ProjectError::Refused(format!(
            "{name} is a {} Project, and {path} on {host} is {what}",
            project.kind.name()
        )));
    }
    if project.kind == ProjectKind::Git {
        match (&project.remote, &location.remote) {
            (Some(ours), Some(theirs)) if ours != theirs => {
                let host = host.as_deref().unwrap_or(&location.host_id);
                return Err(ProjectError::Refused(format!(
                    "{name}'s repository is {ours}, and the one at {path} on {host} is {theirs}"
                )));
            }
            (None, Some(theirs)) => {
                connection.execute(
                    "UPDATE projects SET remote = ?2 WHERE id = ?1",
                    params![project.id, theirs],
                )?;
                project.remote = Some(theirs.clone());
            }
            _ => {}
        }
    }
    place(connection, location)?;
    insert_location(connection, &project.id, location, now)?;
    project.locations.push(ProjectLocation {
        host_id: location.host_id.clone(),
        path: location.path.clone(),
    });
    Ok(true)
}

/// `name`, trimmed, if no other Project than `except` has it, ignoring case.
fn free_name(
    connection: &Connection,
    name: &str,
    except: Option<&str>,
) -> Result<String, ProjectError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ProjectError::Refused("a Project needs a name".to_owned()));
    }
    if name.chars().any(char::is_control) {
        return Err(ProjectError::Refused(
            "a Project's name is one line of text".to_owned(),
        ));
    }
    let folded = name.to_lowercase();
    let taken = all(connection)?.into_iter().find(|project| {
        Some(project.id.as_str()) != except && project.name.to_lowercase() == folded
    });
    match taken {
        Some(taken) => Err(ProjectError::Refused(format!(
            "there's a Project called {} already",
            taken.name
        ))),
        None => Ok(name.to_owned()),
    }
}

/// Check `location` may be one: its Host joined, its path is whole, and no Project is there.
fn place(connection: &Connection, location: &NewLocation) -> Result<(), ProjectError> {
    let Some(host) = host_name(connection, &location.host_id)? else {
        return Err(ProjectError::Refused(format!(
            "the Host {} hasn't joined the Dispatcher: `weave hosts add` there joins it",
            location.host_id
        )));
    };
    let path = &location.path;
    if !path.is_absolute() {
        return Err(ProjectError::Refused(format!(
            "{} isn't a whole path on {host}",
            path.display()
        )));
    }
    let taken: Option<String> = connection
        .query_row(
            "SELECT projects.name FROM project_locations \
             JOIN projects ON projects.id = project_locations.project_id \
             WHERE project_locations.host_id = ?1 AND project_locations.path = ?2",
            params![location.host_id, text(path)],
            |row| row.get(0),
        )
        .optional()?;
    match taken {
        Some(other) => Err(ProjectError::Refused(format!(
            "{} on {host} belongs to {other} already",
            path.display()
        ))),
        None => Ok(()),
    }
}

/// The Host `by` names, by id or name, that `project` has a location on.
fn located(connection: &Connection, project: &Project, by: &str) -> Result<String, ProjectError> {
    let mut statement = connection.prepare("SELECT host_id, name FROM hosts")?;
    let hosts: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let host_id = hosts
        .iter()
        .find(|(host_id, _)| host_id == by)
        .or_else(|| hosts.iter().find(|(_, name)| name.eq_ignore_ascii_case(by)))
        .map(|(host_id, _)| host_id.clone())
        .ok_or_else(|| {
            ProjectError::Refused(format!("no Host called {by} has joined the Dispatcher"))
        })?;
    match project.location(&host_id) {
        Some(_) => Ok(host_id),
        None => Err(ProjectError::Refused(format!(
            "{} has no location on {by}",
            project.name
        ))),
    }
}

fn host_name(connection: &Connection, host_id: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT name FROM hosts WHERE host_id = ?1",
            params![host_id],
            |row| row.get(0),
        )
        .optional()
}

fn insert_location(
    connection: &Connection,
    project_id: &str,
    location: &NewLocation,
    now: u64,
) -> rusqlite::Result<()> {
    connection
        .execute(
            "INSERT INTO project_locations (project_id, host_id, path, added_at) \
             VALUES (?1, ?2, ?3, ?4)",
            params![
                project_id,
                location.host_id,
                text(&location.path),
                to_sql(now)
            ],
        )
        .map(drop)
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Every Project with its locations, by name.
fn all(connection: &Connection) -> rusqlite::Result<Vec<Project>> {
    let mut statement = connection.prepare(
        "SELECT id, name, kind, remote, created_at, updated_at FROM projects \
         ORDER BY name COLLATE NOCASE, id",
    )?;
    let mut projects: Vec<Project> = statement
        .query_map([], |row| {
            let kind: String = row.get(2)?;
            Ok(Project {
                id: row.get(0)?,
                name: row.get(1)?,
                kind: match kind.as_str() {
                    "git" => ProjectKind::Git,
                    _ => ProjectKind::Directory,
                },
                remote: row.get(3)?,
                locations: Vec::new(),
                created_at: from_sql(row.get(4)?),
                updated_at: from_sql(row.get(5)?),
            })
        })?
        .collect::<Result<_, _>>()?;
    let mut statement = connection.prepare(
        "SELECT project_id, host_id, path FROM project_locations ORDER BY added_at, rowid",
    )?;
    let locations = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            ProjectLocation {
                host_id: row.get(1)?,
                path: row.get::<_, String>(2)?.into(),
            },
        ))
    })?;
    for located in locations {
        let (project_id, location) = located?;
        if let Some(project) = projects.iter_mut().find(|project| project.id == project_id) {
            project.locations.push(location);
        }
    }
    Ok(projects)
}

/// The Project `by` names, by id or else by name, ignoring case.
fn find(connection: &Connection, by: &str) -> rusqlite::Result<Option<Project>> {
    let mut projects = all(connection)?;
    let folded = by.trim().to_lowercase();
    let by_id = projects.iter().position(|project| project.id == by);
    let found = by_id.or_else(|| {
        projects
            .iter()
            .position(|project| project.name.to_lowercase() == folded)
    });
    Ok(found.map(|index| projects.swap_remove(index)))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;
    use crate::store::StoredHost;

    fn host(id: &str, name: &str) -> StoredHost {
        StoredHost {
            host_id: id.to_owned(),
            name: name.to_owned(),
            url: String::new(),
            device_id: "d-dispatcher".to_owned(),
            paired_at: 1,
            refused: None,
            public_key: None,
            joined_at: Some(1),
            here: false,
        }
    }

    fn git(host_id: &str, path: &str, remote: Option<&str>) -> NewLocation {
        NewLocation {
            host_id: host_id.to_owned(),
            path: path.into(),
            kind: ProjectKind::Git,
            remote: remote.map(str::to_owned),
        }
    }

    fn directory(host_id: &str, path: &str) -> NewLocation {
        NewLocation {
            host_id: host_id.to_owned(),
            path: path.into(),
            kind: ProjectKind::Directory,
            remote: None,
        }
    }

    fn refused(result: Result<Project, ProjectError>) -> String {
        match result {
            Err(ProjectError::Refused(why)) => why,
            other => panic!("not refused: {other:?}"),
        }
    }

    fn store() -> Store {
        let store = Store::in_memory();
        store.put_host(&host("h-mac", "mac")).expect("kept");
        store.put_host(&host("h-lab", "homelab")).expect("kept");
        store
    }

    #[test]
    fn a_project_spans_hosts_one_location_on_each() {
        let store = store();
        let odin = store
            .add_project(
                " Odin ",
                &git("h-mac", "/Users/jaco/odin", Some("github.com/j/odin")),
            )
            .expect("added");
        assert_eq!(odin.name, "Odin");
        assert_eq!(odin.kind, ProjectKind::Git);
        assert_eq!(odin.remote.as_deref(), Some("github.com/j/odin"));
        assert!(odin.id.starts_with("p-"), "{}", odin.id);

        let joined = store
            .update_project(
                "odin",
                Change {
                    add: Some(git("h-lab", "/home/jaco/odin", Some("github.com/j/odin"))),
                    ..Change::default()
                },
            )
            .expect("joined");
        let hosts: Vec<&str> = joined
            .locations
            .iter()
            .map(|location| location.host_id.as_str())
            .collect();
        assert_eq!(hosts, ["h-mac", "h-lab"]);
        // The same location again changes nothing.
        let again = store
            .update_project(
                &odin.id,
                Change {
                    add: Some(git("h-lab", "/home/jaco/odin", Some("github.com/j/odin"))),
                    ..Change::default()
                },
            )
            .expect("unchanged");
        assert_eq!(again, joined);
        // Another on that Host is refused, and moving it there is removing and adding at once.
        let second = refused(store.update_project(
            "odin",
            Change {
                add: Some(git("h-lab", "/srv/odin", Some("github.com/j/odin"))),
                ..Change::default()
            },
        ));
        assert!(
            second.contains("is at /home/jaco/odin on homelab already"),
            "{second}"
        );
        let moved = store
            .update_project(
                "odin",
                Change {
                    remove_host: Some("HOMELAB".to_owned()),
                    add: Some(git("h-lab", "/srv/odin", Some("github.com/j/odin"))),
                    ..Change::default()
                },
            )
            .expect("moved");
        assert_eq!(
            moved
                .location("h-lab")
                .map(|location| location.path.clone()),
            Some("/srv/odin".into())
        );
        assert_eq!(store.projects().expect("listed"), vec![moved]);
    }

    #[test]
    fn names_are_unique_ignoring_case() {
        let store = store();
        store
            .add_project("Odin", &git("h-mac", "/code/odin", None))
            .expect("added");
        for name in ["odin", "ODIN", "  oDiN"] {
            let why = refused(store.add_project(name, &directory("h-mac", "/notes")));
            assert_eq!(why, "there's a Project called Odin already");
        }
        assert!(refused(store.add_project("  ", &directory("h-mac", "/notes"))).contains("name"));
        let notes = store
            .add_project("notes", &directory("h-mac", "/notes"))
            .expect("added");
        let taken = refused(store.update_project(
            &notes.id,
            Change {
                name: Some("ODIN".to_owned()),
                ..Change::default()
            },
        ));
        assert_eq!(taken, "there's a Project called Odin already");
        // A Project may change its own name's case.
        let renamed = store
            .update_project(
                "odin",
                Change {
                    name: Some("ODIN".to_owned()),
                    ..Change::default()
                },
            )
            .expect("renamed");
        assert_eq!(renamed.name, "ODIN");
        assert_eq!(
            store
                .project("odin")
                .expect("found")
                .map(|project| project.id),
            Some(renamed.id)
        );
    }

    #[test]
    fn a_location_joins_only_a_project_like_it() {
        let store = store();
        store
            .add_project(
                "odin",
                &git("h-mac", "/code/odin", Some("github.com/j/odin")),
            )
            .expect("added");
        store
            .add_project("notes", &directory("h-mac", "/notes"))
            .expect("added");
        let add = |project: &str, location| {
            store.update_project(
                project,
                Change {
                    add: Some(location),
                    ..Change::default()
                },
            )
        };
        let other = refused(add(
            "odin",
            git("h-lab", "/code/odin", Some("github.com/j/fork")),
        ));
        assert!(other.contains("is github.com/j/fork"), "{other}");
        let plain = refused(add("odin", directory("h-lab", "/code/odin")));
        assert!(
            plain.contains("a directory outside any repository"),
            "{plain}"
        );
        let repository = refused(add("notes", git("h-lab", "/notes", None)));
        assert!(
            repository.contains("is in a git repository"),
            "{repository}"
        );
        // Another Project's location, or a Host that never joined.
        let taken = refused(
            add("notes", directory("h-lab", "/x"))
                .and_then(|_| store.add_project("lab notes", &directory("h-lab", "/x"))),
        );
        assert_eq!(taken, "/x on homelab belongs to notes already");
        let stranger = refused(store.add_project("lab", &directory("h-nobody", "/lab")));
        assert!(stranger.contains("hasn't joined"), "{stranger}");
        let relative = refused(store.add_project("lab", &directory("h-lab", "lab")));
        assert!(relative.contains("isn't a whole path"), "{relative}");
        // A git Project without a remote takes the first one a location brings.
        store
            .add_project("scratch", &git("h-mac", "/code/scratch", None))
            .expect("added");
        let joined = add(
            "scratch",
            git("h-lab", "/code/scratch", Some("github.com/j/scratch")),
        )
        .expect("joined");
        assert_eq!(joined.remote.as_deref(), Some("github.com/j/scratch"));
    }

    /// Odin, recorded on 2026-11-09 from both of its clones' remotes as written, through an
    /// SSH alias (WVE-213): it takes the resolved remote from whichever of its Hosts reports
    /// first, keeps both locations, and doesn't take back what a Host not yet updated, or one
    /// that disagrees, would say.
    #[test]
    fn a_remote_recorded_as_written_follows_what_resolving_hosts_report() {
        let store = store();
        let alias = "github.com-kp/Keyphase-Technologies/odin";
        let resolved = "github.com/Keyphase-Technologies/odin";
        let odin = store
            .add_project("Odin", &git("h-mac", "/Users/jaco/odin", Some(alias)))
            .expect("added");
        store
            .update_project(
                "odin",
                Change {
                    add: Some(git("h-lab", "/home/jaco/odin", Some(alias))),
                    ..Change::default()
                },
            )
            .expect("joined");
        // Another repository on the Host, and a directory Project, are left alone.
        assert_eq!(
            store
                .reported_remote("h-mac", Path::new("/Users/jaco/other"), resolved)
                .expect("noted"),
            None
        );
        // homelab is updated first.
        let healed = store
            .reported_remote("h-lab", Path::new("/home/jaco/odin"), resolved)
            .expect("noted")
            .expect("changed");
        assert_eq!(healed.remote.as_deref(), Some(resolved));
        assert_eq!(healed.locations.len(), 2);
        assert!(healed.updated_at >= odin.updated_at);
        assert_eq!(store.project("odin").expect("found"), Some(healed));
        // Reporting it again changes nothing.
        assert_eq!(
            store
                .reported_remote("h-lab", Path::new("/home/jaco/odin"), resolved)
                .expect("noted"),
            None
        );
        // A Host that disagrees doesn't take it back while homelab says what it is; the Mac's
        // clone then joins with the resolved remote.
        assert_eq!(
            store
                .reported_remote("h-mac", Path::new("/Users/jaco/odin"), alias)
                .expect("noted"),
            None
        );
        assert_eq!(
            store
                .reported_remote("h-mac", Path::new("/Users/jaco/odin"), resolved)
                .expect("noted"),
            None
        );
        let odin = store.project("odin").expect("found").expect("there");
        assert_eq!(odin.remote.as_deref(), Some(resolved));
        let hosts: Vec<&str> = odin
            .locations
            .iter()
            .map(|location| location.host_id.as_str())
            .collect();
        assert_eq!(hosts, ["h-mac", "h-lab"]);
        // A clone made through the plain host joins it once it's moved.
        let moved = store
            .update_project(
                "odin",
                Change {
                    remove_host: Some("mac".to_owned()),
                    add: Some(git("h-mac", "/Users/jaco/code/odin", Some(resolved))),
                    ..Change::default()
                },
            )
            .expect("joined");
        assert_eq!(moved.locations.len(), 2);
        // A git Project without a remote takes the first a Host reports.
        store
            .add_project("scratch", &git("h-mac", "/code/scratch", None))
            .expect("added");
        let taken = store
            .reported_remote("h-mac", Path::new("/code/scratch"), "github.com/j/scratch")
            .expect("noted")
            .expect("changed");
        assert_eq!(taken.remote.as_deref(), Some("github.com/j/scratch"));
    }

    #[test]
    fn removing_a_host_takes_its_locations_and_the_project_stays() {
        let store = store();
        let odin = store
            .add_project("odin", &git("h-lab", "/code/odin", None))
            .expect("added");
        assert!(store.remove_host("h-lab").expect("removed"));
        let left = store.project("odin").expect("found").expect("still there");
        assert_eq!(left.locations, Vec::new());
        assert!(left.updated_at >= odin.updated_at);
        let gone = store.remove_project("odin").expect("removed");
        assert_eq!(gone.id, odin.id);
        assert_eq!(store.projects().expect("listed"), Vec::new());
        assert!(refused(store.remove_project("odin")).contains("no Project odin"));
    }
}
