//! The person's Projects (ADR 0031, WVE-189), through the Dispatcher's socket and through a
//! device paired with it over its loopback WebSocket: adding one, renaming it, adding a second
//! Host's location, and removing it; names unique ignoring case, one location on each Host, a
//! location only like the Project's, and a Host's removal taking its locations; and clones made
//! through an SSH host alias and through the plain host being one repository (WVE-213).

#![allow(clippy::expect_used)]

mod common;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use futures::future::BoxFuture;
use pretty_assertions::assert_eq;
use weave_dispatcher::Dispatcher;
use weave_dispatcher::Work;
use weave_dispatcher::client::DispatcherConnection;
use weave_dispatcher::socket;
use weave_host::remotes::Hostname;
use weave_host::remotes::SshHosts;
use weave_host::remotes::SshTarget;
use weave_host_client::Credentials;
use weave_host_client::remote::DeviceKey;
use weave_host_client::remote::connect_websocket_as;
use weave_host_protocol::devices::OfferDeviceRequest;
use weave_host_protocol::dispatcher::AddProjectRequest;
use weave_host_protocol::dispatcher::DISPATCHER_SUBPROTOCOL;
use weave_host_protocol::dispatcher::GetProjectRequest;
use weave_host_protocol::dispatcher::ListProjectsRequest;
use weave_host_protocol::dispatcher::NewLocation;
use weave_host_protocol::dispatcher::PROJECTS_FEATURE;
use weave_host_protocol::dispatcher::Project;
use weave_host_protocol::dispatcher::ProjectKind;
use weave_host_protocol::dispatcher::ProjectLocation;
use weave_host_protocol::dispatcher::RemoveHostRequest;
use weave_host_protocol::dispatcher::RemoveProjectRequest;
use weave_host_protocol::dispatcher::UpdateProjectRequest;
use weave_host_protocol::worktrees::ListWorktreesRequest;
use weave_host_protocol::worktrees::RESOLVED_REMOTES_FEATURE;
use weave_remote::access::RemoteSettings;
use weave_remote::access::Serve;

use crate::common::ISOLATED_GIT;
use crate::common::WAIT;
use crate::common::World;
use crate::common::ask;
use crate::common::dispatcher_config;
use crate::common::info;
use crate::common::run;
use crate::common::start;

/// A Tailscale Serve that hands out `ws://` URLs to the listener itself.
struct FakeServe;

impl Serve for FakeServe {
    fn ensure(&self, listen: SocketAddr) -> BoxFuture<'_, Result<String, String>> {
        Box::pin(async move { Ok(format!("ws://{listen}")) })
    }

    fn remove(&self, _listen: SocketAddr) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

/// Two Hosts, studio and mini, joined to a Dispatcher from `dir` that serves devices too.
struct Setup {
    dir: tempfile::TempDir,
    dispatcher: Dispatcher,
    studio: World,
    mini: World,
}

impl Setup {
    async fn new() -> Self {
        Self::with(World::new().await, World::new().await).await
    }

    /// Studio and mini as `studio` and `mini`.
    async fn with(studio: World, mini: World) -> Self {
        let dir = tempfile::tempdir().expect("tempdir");
        let config = weave_dispatcher::DispatcherConfig {
            remote: Some(RemoteSettings::new(
                "127.0.0.1:0".parse().expect("an address"),
                Arc::new(FakeServe),
            )),
            ..dispatcher_config(dir.path())
        };
        let listening = socket::listen(&config.paths).expect("its socket");
        let dispatcher = Dispatcher::open(config).expect("opened");
        let serving = dispatcher.clone();
        tokio::spawn(async move { serving.serve(listening.listener).await });
        studio.join(&dispatcher, dir.path(), "studio").await;
        mini.join(&dispatcher, dir.path(), "mini").await;
        Self {
            dir,
            dispatcher,
            studio,
            mini,
        }
    }

    /// A device paired with the Dispatcher, asking it over the WebSocket.
    async fn device(&self) -> DispatcherConnection {
        let cli = ask(self.dir.path()).await;
        let offer = cli
            .send(OfferDeviceRequest {
                name: Some("iPad".to_owned()),
            })
            .await
            .expect("devices/offer");
        cli.shutdown().await;
        let url = offer.url.expect("a URL");
        let key = DeviceKey::generate();
        let paired = connect(
            &url,
            Credentials::Pair {
                code: offer.code,
                name: "iPad".to_owned(),
                key: key.clone(),
                service: false,
            },
        )
        .await;
        let device = paired.hello().device.clone().expect("its device");
        paired.shutdown().await;
        connect(
            &url,
            Credentials::Device {
                device_id: device.id,
                key,
                host_id: None,
            },
        )
        .await
    }
}

async fn connect(url: &str, credentials: Credentials) -> DispatcherConnection {
    let (transport, _closed) = connect_websocket_as(url, DISPATCHER_SUBPROTOCOL)
        .await
        .expect("the WebSocket");
    DispatcherConnection::connect_with(transport, info("weave-cli"), credentials)
        .await
        .expect("hello")
}

fn git(host_id: &str, path: &str, remote: &str) -> NewLocation {
    NewLocation {
        host_id: host_id.to_owned(),
        path: path.into(),
        kind: ProjectKind::Git,
        remote: Some(remote.to_owned()),
    }
}

fn located(project: &Project) -> Vec<(String, String)> {
    project
        .locations
        .iter()
        .map(|ProjectLocation { host_id, path }| (host_id.clone(), path.display().to_string()))
        .collect()
}

/// Add a Project on studio, rename it, add mini's clone, and remove it, through `cli`, checking
/// what's refused on the way.
async fn a_project_goes_through_its_life(cli: &DispatcherConnection, studio: &str, mini: &str) {
    assert!(cli.hello().offers(PROJECTS_FEATURE), "{:?}", cli.hello());
    let added = cli
        .send(AddProjectRequest {
            name: "Odin".to_owned(),
            location: git(studio, "/code/odin", "github.com/j/odin"),
        })
        .await
        .expect("projects/add")
        .project;
    assert_eq!(added.kind, ProjectKind::Git);
    assert_eq!(added.remote.as_deref(), Some("github.com/j/odin"));
    assert_eq!(
        located(&added),
        vec![(studio.to_owned(), "/code/odin".to_owned())]
    );

    // Names are unique ignoring case.
    let taken = cli
        .send(AddProjectRequest {
            name: "ODIN".to_owned(),
            location: git(studio, "/code/other", "github.com/j/other"),
        })
        .await
        .expect_err("a name taken");
    assert_eq!(taken.message, "there's a Project called Odin already");

    let renamed = cli
        .send(UpdateProjectRequest {
            project: "odin".to_owned(),
            name: Some("odin-engine".to_owned()),
            remove_host: None,
            add: None,
        })
        .await
        .expect("renamed")
        .project;
    assert_eq!(
        (renamed.id.as_str(), renamed.name.as_str()),
        (added.id.as_str(), "odin-engine")
    );

    // A second location on studio is refused; mini's clone joins.
    let second = cli
        .send(UpdateProjectRequest {
            project: added.id.clone(),
            name: None,
            remove_host: None,
            add: Some(git(studio, "/code/odin-2", "github.com/j/odin")),
        })
        .await
        .expect_err("a second location on studio");
    assert!(
        second
            .message
            .contains("is at /code/odin on studio already"),
        "{second}"
    );
    let fork = cli
        .send(UpdateProjectRequest {
            project: added.id.clone(),
            name: None,
            remove_host: None,
            add: Some(git(mini, "/home/me/odin", "github.com/someone/odin")),
        })
        .await
        .expect_err("another repository");
    assert!(
        fork.message.contains("is github.com/someone/odin"),
        "{fork}"
    );
    let joined = cli
        .send(UpdateProjectRequest {
            project: "ODIN-ENGINE".to_owned(),
            name: None,
            remove_host: None,
            add: Some(git(mini, "/home/me/odin", "github.com/j/odin")),
        })
        .await
        .expect("mini's clone joined")
        .project;
    assert_eq!(
        located(&joined),
        vec![
            (studio.to_owned(), "/code/odin".to_owned()),
            (mini.to_owned(), "/home/me/odin".to_owned()),
        ]
    );
    let got = cli
        .send(GetProjectRequest {
            project: "Odin-Engine".to_owned(),
        })
        .await
        .expect("projects/get")
        .project;
    assert_eq!(got, joined);
    let listed = cli
        .send(ListProjectsRequest {})
        .await
        .expect("projects/list")
        .projects;
    assert_eq!(listed, vec![joined]);

    // Removing one location keeps the Project; removing the Project forgets it.
    let left = cli
        .send(UpdateProjectRequest {
            project: "odin-engine".to_owned(),
            name: None,
            remove_host: Some("mini".to_owned()),
            add: None,
        })
        .await
        .expect("mini's location removed")
        .project;
    assert_eq!(
        located(&left),
        vec![(studio.to_owned(), "/code/odin".to_owned())]
    );
    cli.send(RemoveProjectRequest {
        project: "odin-engine".to_owned(),
    })
    .await
    .expect("projects/remove");
    assert_eq!(
        cli.send(ListProjectsRequest {})
            .await
            .expect("projects/list")
            .projects,
        Vec::new()
    );
    let gone = cli
        .send(GetProjectRequest {
            project: "odin-engine".to_owned(),
        })
        .await
        .expect_err("gone");
    assert_eq!(gone.message, "there's no Project odin-engine");
}

#[tokio::test(flavor = "multi_thread")]
async fn projects_through_the_socket() {
    let setup = Setup::new().await;
    let (studio, mini) = (setup.studio.host_id().await, setup.mini.host_id().await);
    let cli = ask(setup.dir.path()).await;
    a_project_goes_through_its_life(&cli, &studio, &mini).await;
    cli.shutdown().await;
    setup.dispatcher.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn projects_through_a_paired_device() {
    let setup = Setup::new().await;
    let (studio, mini) = (setup.studio.host_id().await, setup.mini.host_id().await);
    let device = setup.device().await;
    assert!(device.hello().device.is_some(), "a paired device");
    a_project_goes_through_its_life(&device, &studio, &mini).await;
    device.shutdown().await;
    setup.dispatcher.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn removing_a_host_drops_its_locations() {
    let setup = Setup::new().await;
    let (studio, mini) = (setup.studio.host_id().await, setup.mini.host_id().await);
    let cli = ask(setup.dir.path()).await;
    let added = cli
        .send(AddProjectRequest {
            name: "notes".to_owned(),
            location: NewLocation {
                host_id: mini.clone(),
                path: "/home/me/notes".into(),
                kind: ProjectKind::Directory,
                remote: None,
            },
        })
        .await
        .expect("added")
        .project;
    cli.send(UpdateProjectRequest {
        project: "notes".to_owned(),
        name: None,
        remove_host: None,
        add: Some(NewLocation {
            host_id: studio.clone(),
            path: "/Users/me/notes".into(),
            kind: ProjectKind::Directory,
            remote: None,
        }),
    })
    .await
    .expect("studio's joined");
    // A directory Project takes only directories, and only Hosts that joined.
    let repository = cli
        .send(UpdateProjectRequest {
            project: "notes".to_owned(),
            name: None,
            remove_host: Some("studio".to_owned()),
            add: Some(git(&studio, "/code/notes", "github.com/j/notes")),
        })
        .await
        .expect_err("a repository");
    assert!(
        repository.message.contains("is in a git repository"),
        "{repository}"
    );
    let stranger = cli
        .send(AddProjectRequest {
            name: "lab".to_owned(),
            location: git("h-nobody", "/lab", "github.com/j/lab"),
        })
        .await
        .expect_err("a Host that never joined");
    assert!(stranger.message.contains("hasn't joined"), "{stranger}");

    cli.send(RemoveHostRequest {
        host: "mini".to_owned(),
    })
    .await
    .expect("hosts/remove");
    let left = setup.dispatcher.projects().expect("projects");
    assert_eq!(left.len(), 1);
    assert_eq!(
        located(&left[0]),
        vec![(studio.clone(), "/Users/me/notes".to_owned())],
        "the refused change left studio's as it was, and mini's went with it"
    );
    assert!(left[0].updated_at >= added.updated_at);

    // A Project with none left stays, and says so.
    cli.send(RemoveHostRequest {
        host: "studio".to_owned(),
    })
    .await
    .expect("hosts/remove");
    let left = setup.dispatcher.projects().expect("projects");
    assert_eq!(
        (left[0].name.as_str(), left[0].locations.len()),
        ("notes", 0)
    );
    cli.shutdown().await;
    setup.dispatcher.stop().await;
}

/// The Projects outlive the Dispatcher's restarts.
#[tokio::test(flavor = "multi_thread")]
async fn projects_outlive_a_restart() {
    let world = World::new().await;
    let dir = tempfile::tempdir().expect("tempdir");
    let (dispatcher, serving) = start(dir.path());
    world.join(&dispatcher, dir.path(), "studio").await;
    let studio = world.host_id().await;
    let added = dispatcher
        .add_project(AddProjectRequest {
            name: "odin".to_owned(),
            location: git(&studio, "/code/odin", "github.com/j/odin"),
        })
        .expect("added");
    dispatcher.stop().await;
    serving.abort();
    let _ = serving.await;

    let (dispatcher, serving) = start(dir.path());
    assert_eq!(dispatcher.projects().expect("projects"), vec![added]);
    dispatcher.stop().await;
    serving.abort();
}

/// SSH's configuration as the person's has it: `github.com-kp` a `Host` alias for `github.com`,
/// to pick an account's key, and every other host as written.
struct Aliased;

impl SshHosts for Aliased {
    fn hostname<'a>(&'a self, target: &'a SshTarget) -> BoxFuture<'a, Hostname> {
        let host = match target.host() {
            "github.com-kp" => "github.com",
            host => host,
        }
        .to_owned();
        Box::pin(async move { Hostname::Is(host) })
    }
}

/// A repository at `dir` whose `origin` is `remote`, with a commit, away from the configuration
/// of whoever runs the tests.
fn repository(dir: &Path, remote: &str) {
    std::fs::create_dir_all(dir).expect("the repository's directory");
    for args in [
        &["init", "-q", "-b", "main"][..],
        &["remote", "add", "origin", remote],
        &["commit", "-q", "--allow-empty", "-m", "first"],
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .envs(ISOLATED_GIT.iter().copied())
            .output()
            .expect("git");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

/// Where `world`'s Host says the repository at `dir` is, and its remote.
async fn where_is(world: &World, dir: &Path) -> (std::path::PathBuf, Option<String>) {
    let local = world.local().await;
    assert!(
        local
            .hello()
            .features
            .iter()
            .any(|feature| feature == RESOLVED_REMOTES_FEATURE),
        "{:?}",
        local.hello().features
    );
    let listed = local
        .send(ListWorktreesRequest {
            repo: dir.to_path_buf(),
        })
        .await
        .expect("worktrees/list");
    local.shutdown().await;
    (listed.repo, listed.remote)
}

/// A clone made through an SSH host alias and one made through the plain host are one
/// repository (WVE-213): their Hosts give one remote, and the second joins the first's Project.
/// A Project recorded before Hosts resolved aliases, with the alias as written, takes the
/// resolved remote once a Host that resolves it has a thread open in one of its locations, and
/// keeps both.
#[tokio::test(flavor = "multi_thread")]
async fn clones_through_an_ssh_alias_and_the_plain_host_are_one_project() {
    let setup = Setup::with(
        World::with_ssh(Arc::new(Aliased)).await,
        World::with_ssh(Arc::new(Aliased)).await,
    )
    .await;
    let (studio, mini) = (setup.studio.host_id().await, setup.mini.host_id().await);
    let resolved = "github.com/Keyphase-Technologies/odin";
    let alias = "github.com-kp/Keyphase-Technologies/odin";
    repository(
        &setup.studio.home().join("odin"),
        "git@github.com-kp:Keyphase-Technologies/odin.git",
    );
    repository(
        &setup.mini.home().join("odin"),
        "git@github.com:Keyphase-Technologies/odin.git",
    );
    let (studio_odin, studio_remote) =
        where_is(&setup.studio, &setup.studio.home().join("odin")).await;
    let (mini_odin, mini_remote) = where_is(&setup.mini, &setup.mini.home().join("odin")).await;
    assert_eq!(studio_remote.as_deref(), Some(resolved));
    assert_eq!(mini_remote.as_deref(), Some(resolved));
    let studio_path = studio_odin.display().to_string();
    let mini_path = mini_odin.display().to_string();

    // Registered as the app and `weave projects add` do, from what each Host says.
    let cli = ask(setup.dir.path()).await;
    cli.send(AddProjectRequest {
        name: "Odin".to_owned(),
        location: git(&studio, &studio_path, resolved),
    })
    .await
    .expect("projects/add");
    let joined = cli
        .send(UpdateProjectRequest {
            project: "odin".to_owned(),
            name: None,
            remove_host: None,
            add: Some(git(&mini, &mini_path, resolved)),
        })
        .await
        .expect("mini's clone joined")
        .project;
    assert_eq!(joined.remote.as_deref(), Some(resolved));
    assert_eq!(
        located(&joined),
        vec![
            (studio.clone(), studio_path.clone()),
            (mini.clone(), mini_path.clone()),
        ]
    );
    cli.send(RemoveProjectRequest {
        project: "odin".to_owned(),
    })
    .await
    .expect("projects/remove");

    // As WVE-189 recorded Odin, from Hosts that took the alias as written.
    cli.send(AddProjectRequest {
        name: "Odin".to_owned(),
        location: git(&studio, &studio_path, alias),
    })
    .await
    .expect("projects/add");
    let recorded = cli
        .send(UpdateProjectRequest {
            project: "odin".to_owned(),
            name: None,
            remove_host: None,
            add: Some(git(&mini, &mini_path, alias)),
        })
        .await
        .expect("joined as recorded")
        .project;
    assert_eq!(recorded.remote.as_deref(), Some(alias));

    // A thread opens in studio's clone.
    let Work::Run(mut request) = run(&setup.studio, "hello") else {
        panic!("a run");
    };
    request.cwd = setup.studio.home().join("odin");
    let local = setup.studio.local().await;
    local.send(request).await.expect("thread/run");
    let healed = tokio::time::timeout(WAIT, async {
        loop {
            let project = setup.dispatcher.projects().expect("projects").remove(0);
            if project.remote.as_deref() == Some(resolved) {
                return project;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("Odin's remote resolved in time");
    assert_eq!(healed.id, recorded.id);
    assert_eq!(located(&healed), located(&recorded));
    assert!(healed.updated_at >= recorded.updated_at);
    local.shutdown().await;
    cli.shutdown().await;
    setup.dispatcher.stop().await;
}
