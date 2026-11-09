//! `weave projects`: the person's Projects, which the Dispatcher keeps (ADR 0031, WVE-189), each
//! a named piece of their work with at most one location on each of their Hosts: listing them,
//! registering a directory as one or as another Host's location of one, renaming one, removing
//! one location, and forgetting one.
//!
//! `weave projects add` registers a directory on the Host it's on: this computer's, or with
//! `--host` another of the person's, through the Dispatcher (WVE-195). It asks that Host where the
//! directory lies in git (`worktrees/list`): a repository is registered by its primary worktree,
//! with its remote, so all its worktrees are in the Project, and a directory outside one as it is.
//! A clone whose remote a Project with no location on that Host has is offered to that Project at
//! a terminal, and needs `--to` or `--name` without one. Listing works while the Dispatcher is
//! away, from what it listed last ([`crate::projects`]).

use std::path::Path;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context as _;
use anyhow::anyhow;
use anyhow::bail;
use clap::Args;
use clap::Subcommand;
use weave_dispatcher::client::DispatcherConnection;
use weave_host_client::HostConnection;
use weave_host_protocol::Empty;
use weave_host_protocol::dispatcher::AddProjectRequest;
use weave_host_protocol::dispatcher::NewLocation;
use weave_host_protocol::dispatcher::Project;
use weave_host_protocol::dispatcher::ProjectKind;
use weave_host_protocol::dispatcher::RemoveProjectRequest;
use weave_host_protocol::dispatcher::UpdateProjectRequest;
use weave_host_protocol::errors;
use weave_host_protocol::files::ListFilesRequest;
use weave_host_protocol::worktrees;
use weave_host_protocol::worktrees::ListWorktreesRequest;

use crate::args::directory_on;
use crate::ask;
use crate::clock::now_ms;
use crate::dispatcher;
use crate::host;
use crate::host::Target;
use crate::projects;
use crate::projects::Listed;

pub const LOG: &str = "warn";

/// What this command says hello to Hosts as.
const CLIENT: &str = "weave-cli";

#[derive(Args)]
pub struct ProjectsArgs {
    #[command(subcommand)]
    command: Option<ProjectsCommand>,
}

#[derive(Subcommand)]
enum ProjectsCommand {
    /// The Projects and where each is on your Hosts (the default). While the Dispatcher doesn't
    /// answer, the ones it listed last, saying how long ago.
    List(JsonArgs),
    /// Register a directory as a Project, or as its location on another Host: a repository by
    /// its primary worktree, so all its worktrees are in it, or a directory outside one.
    Add(AddArgs),
    /// A Project and where it is on your Hosts.
    Show(ProjectArgs),
    /// Rename a Project.
    Rename(RenameArgs),
    /// Change a Project: remove its location on one Host.
    Update(UpdateArgs),
    /// Forget a Project and all its locations. What's in its directories stays.
    Remove(ProjectArgs),
}

#[derive(Args, Default)]
struct JsonArgs {
    /// Print them as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct ProjectArgs {
    /// The Project's name or id.
    project: String,
    /// Print what the Dispatcher answered as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct AddArgs {
    /// The directory; this one when omitted. With --host, one on that computer, given whole or
    /// under ~, and this one's counterpart under the home there when omitted.
    dir: Option<PathBuf>,

    /// What to call a new Project; the directory's name, a repository's primary worktree's,
    /// when omitted.
    #[arg(long, conflicts_with = "to")]
    name: Option<String>,

    /// Add the directory to this Project, by its name or id, as its location on the Host, rather
    /// than making a new one.
    #[arg(long, value_name = "PROJECT")]
    to: Option<String>,

    /// The Host the directory is on, by its id or name as `weave hosts` lists them, reached
    /// through the Dispatcher; this computer's when omitted.
    #[arg(long, value_name = "HOST")]
    host: Option<String>,

    /// Print the Project as JSON. It asks nothing: a clone of a repository a Project has on
    /// other Hosts needs --to or --name.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct RenameArgs {
    /// The Project's name or id.
    project: String,
    /// Its new name, unique among your Projects ignoring case.
    name: String,
    /// Print the Project as JSON.
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
struct UpdateArgs {
    /// The Project's name or id.
    project: String,
    /// Remove its location on this Host, by its id or name. The Project stays, with its other
    /// locations.
    #[arg(long, value_name = "HOST")]
    remove_host: String,
    /// Print the Project as JSON.
    #[arg(long)]
    json: bool,
}

pub async fn command(args: ProjectsArgs) -> anyhow::Result<ExitCode> {
    let done = match args
        .command
        .unwrap_or_else(|| ProjectsCommand::List(JsonArgs::default()))
    {
        ProjectsCommand::List(JsonArgs { json }) => list(json).await,
        ProjectsCommand::Add(args) => add(args).await,
        ProjectsCommand::Show(args) => show(args).await,
        ProjectsCommand::Rename(RenameArgs {
            project,
            name,
            json,
        }) => {
            let request = UpdateProjectRequest {
                project: project.clone(),
                name: Some(name),
                remove_host: None,
                add: None,
            };
            change(request, json, |renamed| {
                format!("Renamed {project} to {}.", renamed.name)
            })
            .await
        }
        ProjectsCommand::Update(UpdateArgs {
            project,
            remove_host,
            json,
        }) => {
            let request = UpdateProjectRequest {
                project,
                name: None,
                remove_host: Some(remove_host.clone()),
                add: None,
            };
            change(request, json, |changed| match changed.locations.len() {
                0 => format!(
                    "Removed {}'s location on {remove_host}; it has none left.",
                    changed.name
                ),
                _ => format!("Removed {}'s location on {remove_host}.", changed.name),
            })
            .await
        }
        ProjectsCommand::Remove(args) => remove(args).await,
    };
    done.map(|()| ExitCode::SUCCESS)
}

async fn list(json: bool) -> anyhow::Result<()> {
    let listed = projects::list(&dispatcher::paths()?).await?;
    if let Some(note) = listed.note(now_ms()) {
        eprintln!("{note}");
    }
    if json {
        println!("{}", serde_json::to_string_pretty(&listed.projects)?);
    } else {
        print!("{}", describe(&listed));
    }
    Ok(())
}

async fn show(args: ProjectArgs) -> anyhow::Result<()> {
    let listed = projects::list(&dispatcher::paths()?).await?;
    if let Some(note) = listed.note(now_ms()) {
        eprintln!("{note}");
    }
    let project = listed.find(&args.project)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(project)?);
    } else {
        print!("{}", describe_one(project, &listed));
        println!("  {}", project.id);
    }
    Ok(())
}

/// `projects/update`, saying what it did with `said`.
async fn change(
    request: UpdateProjectRequest,
    json: bool,
    said: impl FnOnce(&Project) -> String,
) -> anyhow::Result<()> {
    let dispatcher = dispatcher::connect(&dispatcher::paths()?).await?;
    let changed = async {
        projects::offered(&dispatcher)?;
        let project = dispatcher.send(request).await?.project;
        refresh(&dispatcher).await;
        anyhow::Ok(project)
    }
    .await;
    dispatcher.shutdown().await;
    let project = changed?;
    if json {
        println!("{}", serde_json::to_string_pretty(&project)?);
    } else {
        println!("{}", said(&project));
    }
    Ok(())
}

async fn remove(args: ProjectArgs) -> anyhow::Result<()> {
    let dispatcher = dispatcher::connect(&dispatcher::paths()?).await?;
    let removed = async {
        projects::offered(&dispatcher)?;
        let removed = dispatcher
            .send(RemoveProjectRequest {
                project: args.project.clone(),
            })
            .await?;
        refresh(&dispatcher).await;
        anyhow::Ok(removed)
    }
    .await;
    dispatcher.shutdown().await;
    let removed: Empty = removed?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&removed)?);
    } else {
        println!(
            "Removed the Project {}. What's in its directories stays as it was.",
            args.project
        );
    }
    Ok(())
}

/// Keep what the Dispatcher lists now, after a change, for when it's away.
async fn refresh(dispatcher: &DispatcherConnection) {
    let kept = match projects::from(dispatcher).await {
        Ok(listed) => projects::keep(&listed),
        Err(error) => Err(error),
    };
    if let Err(error) = kept {
        tracing::warn!(error = %format!("{error:#}"), "keeping the Projects for when the Dispatcher is away");
    }
}

async fn add(args: AddArgs) -> anyhow::Result<()> {
    let AddArgs {
        dir,
        name,
        to,
        host,
        json,
    } = args;
    let target = match host.as_deref() {
        Some(host) => Target::choose(false, Some(host)).await?,
        None => Target::Shared(host::paths()?),
    };
    let (connection, _events) = match &target {
        Target::Shared(paths) => HostConnection::connect(
            host::open(paths).await?,
            host::client_info(CLIENT),
            host::capabilities(CLIENT),
        )
        .await
        .map_err(anyhow::Error::from)?,
        Target::Carried(carry) => carry.connect(CLIENT).await?,
        Target::InProcess => bail!("a Host inside this process has no directories to register"),
    };
    let elsewhere = target.carried().map(host::Carry::name);
    let found = locate(&connection, elsewhere.as_deref(), dir.as_deref()).await;
    let host_id = connection.hello().host.id.clone();
    connection.shutdown().await;
    let (path, kind, remote) = found?;
    let location = NewLocation {
        host_id,
        path,
        kind,
        remote,
    };
    let dispatcher = dispatcher::connect(&dispatcher::paths()?).await?;
    let registered = async {
        let registered = register(&dispatcher, location, name, to, json).await?;
        refresh(&dispatcher).await;
        anyhow::Ok(registered)
    }
    .await;
    dispatcher.shutdown().await;
    let (project, said) = registered?;
    if json {
        println!("{}", serde_json::to_string_pretty(&project)?);
    } else {
        println!("{said}");
    }
    Ok(())
}

/// Where `dir` lies on the Host `connection` reaches, which is on another computer, `elsewhere`,
/// when it's named: a repository by its primary worktree and remote, or a directory outside one,
/// with symlinks resolved here, as the Host compares paths.
async fn locate(
    connection: &HostConnection,
    elsewhere: Option<&str>,
    dir: Option<&Path>,
) -> anyhow::Result<(PathBuf, ProjectKind, Option<String>)> {
    let path = match elsewhere {
        None => {
            let dir = dir.unwrap_or(Path::new("."));
            let path = dir
                .canonicalize()
                .with_context(|| format!("directory {}", dir.display()))?;
            if !path.is_dir() {
                bail!("{} isn't a directory", path.display());
            }
            path
        }
        Some(host) => there(connection, host, dir).await?,
    };
    if !connection
        .hello()
        .features
        .iter()
        .any(|feature| feature == worktrees::FEATURE)
    {
        bail!(
            "the Host there runs weave {}, which can't say where a directory lies in git: update \
             it",
            connection.hello().host.version
        );
    }
    match connection
        .send(ListWorktreesRequest { repo: path.clone() })
        .await
    {
        Ok(found) => Ok((found.repo, ProjectKind::Git, found.remote)),
        Err(error) if errors::is(&error, errors::NOT_A_REPOSITORY) => {
            Ok((path, ProjectKind::Directory, None))
        }
        Err(error) => Err(anyhow!(
            "asking where {} lies in git: {error}",
            path.display()
        )),
    }
}

/// `dir` on another computer's Host, `host`, as a whole path there: `~/…` under the home there,
/// which its `files/list` gives, and it a directory there.
async fn there(
    connection: &HostConnection,
    host: &str,
    dir: Option<&Path>,
) -> anyhow::Result<PathBuf> {
    let named = directory_on(dir, host, "DIR")?;
    let path = match named.strip_prefix("~") {
        Ok(under) => {
            let home = connection
                .send(ListFilesRequest {
                    path: None,
                    hidden: false,
                })
                .await
                .map_err(|error| anyhow!("finding the home directory on {host}: {error}"))?
                .home;
            match under.as_os_str().is_empty() {
                true => home,
                false => home.join(under),
            }
        }
        Err(_) => named,
    };
    let listed = connection
        .send(ListFilesRequest {
            path: Some(path),
            hidden: false,
        })
        .await
        .map_err(|error| anyhow!("on {host}, {error}"))?;
    Ok(listed.path)
}

/// Register `location` with the Dispatcher: as the location of the Project `to` names, or of the
/// one whose repository it is, when the person agrees, or as a new Project called `name` or
/// after its directory. What it did, and what to say about it.
async fn register(
    dispatcher: &DispatcherConnection,
    location: NewLocation,
    name: Option<String>,
    to: Option<String>,
    json: bool,
) -> anyhow::Result<(Project, String)> {
    let listed = projects::from(dispatcher).await?;
    let place = format!(
        "{} on {}",
        location.path.display(),
        listed.host_name(&location.host_id)
    );
    let already = listed.projects.iter().find(|project| {
        project
            .location(&location.host_id)
            .is_some_and(|there| there.path == location.path)
    });
    if let Some(project) = already {
        let asked = to.as_deref().or(name.as_deref());
        if asked.is_none_or(|asked| listed.find(asked).is_ok_and(|named| named.id == project.id)) {
            return Ok((
                project.clone(),
                format!("{place} is {}'s already.", project.name),
            ));
        }
    }
    if let Some(to) = to {
        let project = join(dispatcher, &listed, &to, location).await?;
        let said = format!("Added {place} to {}.", project.name);
        return Ok((project, said));
    }
    if name.is_none() && location.kind == ProjectKind::Git && location.remote.is_some() {
        let matching: Vec<&Project> = listed
            .projects
            .iter()
            .filter(|project| {
                project.kind == ProjectKind::Git
                    && project.remote == location.remote
                    && project.location(&location.host_id).is_none()
            })
            .collect();
        match matching[..] {
            [] => {}
            [project] => {
                let hosts = hosts_of(project, &listed);
                let name = &project.name;
                if !json && ask::can() {
                    if ask::ask(&format!(
                        "{name} has this repository on {hosts}; add this clone to {name}? [Y/n] "
                    ))? {
                        let project = join(dispatcher, &listed, &project.id, location).await?;
                        let said = format!("Added {place} to {}.", project.name);
                        return Ok((project, said));
                    }
                    bail!(
                        "left {place} alone: `weave projects add --name <name>` makes a Project of \
                         its own of it"
                    );
                }
                bail!(
                    "{name} has this repository on {hosts}: `weave projects add --to {name}` adds \
                     this clone to it, or `--name <name>` makes a Project of its own of it"
                );
            }
            ref several => {
                let names: Vec<&str> = several
                    .iter()
                    .map(|project| project.name.as_str())
                    .collect();
                bail!(
                    "{} have this repository: `weave projects add --to <project>` adds this clone \
                     to one of them, or `--name <name>` makes a Project of its own of it",
                    names.join(" and ")
                );
            }
        }
    }
    let name = match name {
        Some(name) => name,
        None => location
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
            .with_context(|| {
                format!(
                    "{} has no name to give a Project: give one with --name",
                    location.path.display()
                )
            })?,
    };
    let kind = location.kind;
    let project = dispatcher
        .send(AddProjectRequest { name, location })
        .await?
        .project;
    let what = match kind {
        ProjectKind::Git => "a git Project",
        ProjectKind::Directory => "a directory Project",
    };
    let said = format!("Added {}, {what}, at {place}.", project.name);
    Ok((project, said))
}

/// Add `location` to the Project `to` names.
async fn join(
    dispatcher: &DispatcherConnection,
    listed: &Listed,
    to: &str,
    location: NewLocation,
) -> anyhow::Result<Project> {
    let project = listed.find(to)?;
    Ok(dispatcher
        .send(UpdateProjectRequest {
            project: project.id.clone(),
            name: None,
            remove_host: None,
            add: Some(location),
        })
        .await?
        .project)
}

/// The Hosts `project` is on, by name: "mac and homelab".
fn hosts_of(project: &Project, listed: &Listed) -> String {
    let names: Vec<&str> = project
        .locations
        .iter()
        .map(|location| listed.host_name(&location.host_id))
        .collect();
    names.join(" and ")
}

/// Each Project, its kind and where it is on each Host.
fn describe(listed: &Listed) -> String {
    if listed.projects.is_empty() {
        return "You have no Projects; `weave projects add` in a directory makes one of it.\n"
            .to_owned();
    }
    listed
        .projects
        .iter()
        .map(|project| describe_one(project, listed))
        .collect()
}

/// "odin  git, github.com/j/odin" and a line for each location: "  homelab  /home/jaco/odin".
fn describe_one(project: &Project, listed: &Listed) -> String {
    let remote = project
        .remote
        .as_deref()
        .map(|remote| format!(", {remote}"))
        .unwrap_or_default();
    let mut text = format!("{}  {}{remote}\n", project.name, project.kind.name());
    if project.locations.is_empty() {
        text.push_str("  on no Host: those it was on have left the Dispatcher\n");
        return text;
    }
    let width = project
        .locations
        .iter()
        .map(|location| listed.host_name(&location.host_id).chars().count())
        .max()
        .unwrap_or(0);
    for location in &project.locations {
        text.push_str(&format!(
            "  {:width$}  {}\n",
            listed.host_name(&location.host_id),
            location.path.display()
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_host_protocol::dispatcher::ProjectLocation;

    use super::*;
    use crate::projects::HostName;

    #[test]
    fn projects_are_listed_with_where_each_is() {
        let location = |host_id: &str, path: &str| ProjectLocation {
            host_id: host_id.to_owned(),
            path: path.into(),
        };
        let listed = Listed {
            projects: vec![
                Project {
                    id: "p-1".to_owned(),
                    name: "odin".to_owned(),
                    kind: ProjectKind::Git,
                    remote: Some("github.com/j/odin".to_owned()),
                    locations: vec![
                        location("h-lab", "/home/jaco/odin"),
                        location("h-mac", "/Users/jaco/odin"),
                    ],
                    created_at: 0,
                    updated_at: 0,
                },
                Project {
                    id: "p-2".to_owned(),
                    name: "notes".to_owned(),
                    kind: ProjectKind::Directory,
                    remote: None,
                    locations: Vec::new(),
                    created_at: 0,
                    updated_at: 0,
                },
            ],
            hosts: vec![
                HostName {
                    host_id: "h-lab".to_owned(),
                    name: "homelab".to_owned(),
                },
                HostName {
                    host_id: "h-mac".to_owned(),
                    name: "mac".to_owned(),
                },
            ],
            listed_at: 0,
            offline: None,
        };
        assert_eq!(
            describe(&listed),
            "odin  git, github.com/j/odin\n  \
             homelab  /home/jaco/odin\n  \
             mac      /Users/jaco/odin\n\
             notes  directory\n  \
             on no Host: those it was on have left the Dispatcher\n"
        );
        assert_eq!(hosts_of(&listed.projects[0], &listed), "homelab and mac");
        assert_eq!(
            listed.whereabouts(&listed.projects[0]),
            "on homelab (/home/jaco/odin) and mac (/Users/jaco/odin)"
        );
        assert!(
            describe(&Listed {
                projects: Vec::new(),
                ..listed
            })
            .starts_with("You have no Projects")
        );
    }
}
