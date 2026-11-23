//! Computers for Hosts, made in the cloud (ADR 0036, WVE-238, WVE-239).
//!
//! The Dispatcher runs no agents, and this doesn't change that: it makes the computer a Host
//! runs on using provider tokens kept in its encrypted credential store, and the Host there
//! joins like any other, over the connection it opens (ADR 0030), receiving its agent sign-ins
//! as soon as it connects. Two seams keep the parts apart:
//!
//! - [`Machines`]: a provider of computers, which knows nothing of Hosts. [`fly::Fly`] is the
//!   first, over Fly's Machines API, behind [`MachineBackend`] so tests can swap in a fake.
//! - [`Joining`]: what a launch asks of the Dispatcher, a code to join with and the Hosts that
//!   joined.
//!
//! [`launch`] goes from nothing to a Host that joined: a code, a machine whose image joins with
//! it (`scripts/host-image`), and a wait for the Host to connect. A machine whose Host never
//! joins is destroyed, so nothing is left running that the Dispatcher doesn't know of.

pub mod fly;
pub mod tailscale;

use std::collections::BTreeMap;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::Error;
use futures::future::BoxFuture;
use weave_host_protocol::dispatcher::CloudMachine;
use weave_host_protocol::dispatcher::CredentialKind;
use weave_host_protocol::dispatcher::DestroyMachineResponse;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::LaunchMachineRequest;
use weave_host_protocol::dispatcher::LaunchMachineResponse;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::MachineSettings;
use weave_host_protocol::dispatcher::OfferHostRequest;
use weave_host_protocol::dispatcher::OfferHostResponse;
use weave_host_protocol::dispatcher::UpdateMachineSettingsRequest;

use crate::Dispatcher;
use crate::Shared;
use crate::client::DispatcherConnection;
use crate::internal;
use crate::invalid;
use crate::machines::fly::Fly;
use crate::machines::fly::FlyConfig;
use crate::machines::tailscale::DEFAULT_TAG;
use crate::machines::tailscale::TailscaleClient;

/// Default credential name for the Fly API token in `weave credentials`.
pub const DEFAULT_FLY_CREDENTIAL: &str = "fly";
/// Default credential name for the Tailscale OAuth client secret in `weave credentials`.
pub const DEFAULT_TAILSCALE_CREDENTIAL: &str = "tailscale";
/// Default Fly organisation for a newly created app.
pub const DEFAULT_FLY_ORG: &str = "personal";
/// Default Fly region where new machines are created.
pub const DEFAULT_FLY_REGION: &str = "jnb";

/// The Dispatcher's URL, for the image's entrypoint to join.
pub const ENV_DISPATCHER_URL: &str = "WEAVE_DISPATCHER_URL";
/// The one-time code the Host joins with.
pub const ENV_JOIN_CODE: &str = "WEAVE_JOIN_CODE";
/// What the Dispatcher is to call the Host.
pub const ENV_HOST_NAME: &str = "WEAVE_HOST_NAME";
/// The key the machine joins the person's tailnet with, where the Dispatcher is.
pub const ENV_TAILSCALE_KEY: &str = "TS_AUTHKEY";

/// How long a launch waits for the Host to join: a code is good for five minutes.
pub const DEFAULT_WAIT: Duration = Duration::from_secs(4 * 60);
/// How often a launch looks for the Host.
pub const DEFAULT_POLL: Duration = Duration::from_secs(2);

/// A computer to make.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MachineSpec {
    /// Its name with the provider, which is the Host's too.
    pub name: String,
    /// The image it boots.
    pub image: String,
    /// The environment its entrypoint starts in.
    pub env: BTreeMap<String, String>,
    pub cpus: u32,
    pub memory_mb: u32,
    /// The size of the disk that outlives a stop, where the Host keeps its state; none at 0.
    pub state_gb: u32,
}

/// A computer a provider made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Machine {
    /// The provider's id for it.
    pub id: String,
    pub name: String,
    pub state: MachineState,
}

impl From<Machine> for CloudMachine {
    fn from(machine: Machine) -> Self {
        Self {
            id: machine.id,
            name: machine.name,
            state: machine.state.to_string(),
        }
    }
}

/// How a machine stands, as far as starting work on it goes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MachineState {
    /// Made or booting.
    Starting,
    Running,
    /// Not running, with its disk kept: it can be started.
    Stopped,
    /// Destroyed, or on its way.
    Gone,
    /// A state of the provider's own.
    Other(String),
}

impl std::fmt::Display for MachineState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Starting => f.write_str("starting"),
            Self::Running => f.write_str("running"),
            Self::Stopped => f.write_str("stopped"),
            Self::Gone => f.write_str("gone"),
            Self::Other(state) => f.write_str(state),
        }
    }
}

/// Why a provider couldn't do what it was asked, in words for the person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MachineError(pub String);

impl std::fmt::Display for MachineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MachineError {}

/// A provider of computers. It knows nothing of Hosts or the Dispatcher.
pub trait Machines: Send + Sync {
    /// Make a machine and start it.
    fn create(
        &self,
        spec: &MachineSpec,
    ) -> impl Future<Output = Result<Machine, MachineError>> + Send;

    /// The machines this provider made here.
    fn list(&self) -> impl Future<Output = Result<Vec<Machine>, MachineError>> + Send;

    fn get(&self, id: &str) -> impl Future<Output = Result<Machine, MachineError>> + Send;

    /// Start a stopped machine.
    fn start(&self, id: &str) -> impl Future<Output = Result<(), MachineError>> + Send;

    /// Stop a machine, keeping its disk.
    fn stop(&self, id: &str) -> impl Future<Output = Result<(), MachineError>> + Send;

    /// Destroy a machine and its disk.
    fn destroy(&self, id: &str) -> impl Future<Output = Result<(), MachineError>> + Send;
}

/// Object-safe form of [`Machines`], used by [`MachineBackend`].
pub trait DynMachines: Send + Sync {
    fn create<'a>(&'a self, spec: &'a MachineSpec) -> BoxFuture<'a, Result<Machine, MachineError>>;
    fn list<'a>(&'a self) -> BoxFuture<'a, Result<Vec<Machine>, MachineError>>;
    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Machine, MachineError>>;
    fn start<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), MachineError>>;
    fn stop<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), MachineError>>;
    fn destroy<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), MachineError>>;
}

impl<M: Machines> DynMachines for M {
    fn create<'a>(&'a self, spec: &'a MachineSpec) -> BoxFuture<'a, Result<Machine, MachineError>> {
        Box::pin(Machines::create(self, spec))
    }

    fn list<'a>(&'a self) -> BoxFuture<'a, Result<Vec<Machine>, MachineError>> {
        Box::pin(Machines::list(self))
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Machine, MachineError>> {
        Box::pin(Machines::get(self, id))
    }

    fn start<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), MachineError>> {
        Box::pin(Machines::start(self, id))
    }

    fn stop<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), MachineError>> {
        Box::pin(Machines::stop(self, id))
    }

    fn destroy<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), MachineError>> {
        Box::pin(Machines::destroy(self, id))
    }
}

/// Seam between the Dispatcher's `machines/*` API and the external cloud APIs (Fly Machines and
/// Tailscale OAuth). Production uses [`LiveBackend`]; tests swap in a fake.
pub trait MachineBackend: Send + Sync {
    fn machines(&self, config: &FlyConfig) -> Result<Box<dyn DynMachines>, MachineError>;
    fn mint_tailscale_key<'a>(
        &'a self,
        client: &'a TailscaleClient,
        description: &'a str,
    ) -> BoxFuture<'a, Result<String, MachineError>>;
}

/// Calls Fly's Machines API and Tailscale's OAuth API over HTTPS.
#[derive(Default)]
pub struct LiveBackend;

impl MachineBackend for LiveBackend {
    fn machines(&self, config: &FlyConfig) -> Result<Box<dyn DynMachines>, MachineError> {
        Ok(Box::new(Fly::new(config.clone())?))
    }

    fn mint_tailscale_key<'a>(
        &'a self,
        client: &'a TailscaleClient,
        description: &'a str,
    ) -> BoxFuture<'a, Result<String, MachineError>> {
        Box::pin(client.mint_key(description))
    }
}

/// What a launch asks of the Dispatcher.
pub trait Joining: Sync {
    /// A code for a Host on another computer, and the URL it connects to.
    fn offer(&self) -> impl Future<Output = Result<OfferHostResponse, Error>> + Send;

    /// The Hosts that joined.
    fn hosts(&self) -> impl Future<Output = Result<Vec<DispatcherHost>, Error>> + Send;
}

impl Joining for Dispatcher {
    async fn offer(&self) -> Result<OfferHostResponse, Error> {
        self.offer_host(false).await
    }

    async fn hosts(&self) -> Result<Vec<DispatcherHost>, Error> {
        Dispatcher::hosts(self)
    }
}

impl Joining for DispatcherConnection {
    async fn offer(&self) -> Result<OfferHostResponse, Error> {
        self.send(OfferHostRequest { here: false }).await
    }

    async fn hosts(&self) -> Result<Vec<DispatcherHost>, Error> {
        Ok(self.send(ListHostsRequest {}).await?.hosts)
    }
}

/// A Host to launch.
#[derive(Clone, Debug)]
pub struct Launch {
    /// The Host's name with the Dispatcher, and the machine's with its provider.
    pub name: String,
    pub image: String,
    /// The key the machine joins the tailnet with, when the Dispatcher is reached over one.
    pub tailscale_key: Option<String>,
    pub cpus: u32,
    pub memory_mb: u32,
    pub state_gb: u32,
    /// How long to wait for the Host to join.
    pub wait: Duration,
    /// How often to look for it.
    pub poll: Duration,
}

impl Launch {
    /// A small machine with a disk for the Host's state.
    pub fn new(name: impl Into<String>, image: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            image: image.into(),
            tailscale_key: None,
            cpus: 1,
            memory_mb: 1024,
            state_gb: 1,
            wait: DEFAULT_WAIT,
            poll: DEFAULT_POLL,
        }
    }
}

/// A Host that joined from a machine this made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Launched {
    pub machine: Machine,
    pub host: DispatcherHost,
    /// From asking for the code to the Host being connected.
    pub took: Duration,
}

/// Why a launch made no Host.
#[derive(Debug)]
pub enum LaunchError {
    /// Nothing was made: the name is taken, or the Dispatcher has no URL for Hosts elsewhere.
    Refused(String),
    Dispatcher(Error),
    Provider(MachineError),
    /// The machine was made and its Host never joined. It was destroyed, unless `left` says why
    /// it couldn't be.
    NeverJoined {
        machine: Machine,
        waited: Duration,
        left: Option<MachineError>,
    },
}

impl std::fmt::Display for LaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(why) => f.write_str(why),
            Self::Dispatcher(error) => write!(f, "the Dispatcher: {}", error.message),
            Self::Provider(error) => write!(f, "{error}"),
            Self::NeverJoined {
                machine,
                waited,
                left,
            } => {
                write!(
                    f,
                    "machine {} ({}) was {} after {} seconds and its Host hadn't joined",
                    machine.name,
                    machine.id,
                    machine.state,
                    waited.as_secs()
                )?;
                match left {
                    None => f.write_str("; it was destroyed"),
                    Some(why) => write!(f, "; it could not be destroyed: {why}"),
                }
            }
        }
    }
}

impl std::error::Error for LaunchError {}

/// From nothing to a Host that joined: ask for a code, make a machine whose image joins with
/// it, and wait for a Host of that name to connect. A machine whose Host doesn't is destroyed.
pub async fn launch(
    joining: &impl Joining,
    machines: &impl Machines,
    launch: Launch,
) -> Result<Launched, LaunchError> {
    launch_dyn(joining, machines, launch).await
}

/// Same as [`launch`], over a trait-object [`DynMachines`].
pub async fn launch_dyn(
    joining: &impl Joining,
    machines: &dyn DynMachines,
    launch: Launch,
) -> Result<Launched, LaunchError> {
    let began = tokio::time::Instant::now();
    let taken = joining
        .hosts()
        .await
        .map_err(LaunchError::Dispatcher)?
        .into_iter()
        .any(|host| host.name.eq_ignore_ascii_case(&launch.name));
    if taken {
        return Err(LaunchError::Refused(format!(
            "a Host called {} joined the Dispatcher already",
            launch.name
        )));
    }
    let offer = joining.offer().await.map_err(LaunchError::Dispatcher)?;
    let DispatcherAddress::Url(url) = offer.address else {
        return Err(LaunchError::Refused(
            "the Dispatcher gave no URL a Host elsewhere can reach".to_owned(),
        ));
    };
    let mut env = BTreeMap::from([
        (ENV_DISPATCHER_URL.to_owned(), url),
        (ENV_JOIN_CODE.to_owned(), offer.code),
        (ENV_HOST_NAME.to_owned(), launch.name.clone()),
    ]);
    if let Some(key) = launch.tailscale_key {
        env.insert(ENV_TAILSCALE_KEY.to_owned(), key);
    }
    let spec = MachineSpec {
        name: launch.name.clone(),
        image: launch.image,
        env,
        cpus: launch.cpus,
        memory_mb: launch.memory_mb,
        state_gb: launch.state_gb,
    };
    let machine = machines
        .create(&spec)
        .await
        .map_err(LaunchError::Provider)?;

    let deadline = began + launch.wait;
    loop {
        // An unreachable Dispatcher is no reason to destroy a machine that may yet join.
        if let Ok(hosts) = joining.hosts().await
            && let Some(host) = hosts
                .into_iter()
                .find(|host| host.name == launch.name && host.connected)
        {
            return Ok(Launched {
                machine,
                host,
                took: began.elapsed(),
            });
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(launch.poll).await;
    }
    let machine = machines.get(&machine.id).await.unwrap_or(machine);
    let left = machines.destroy(&machine.id).await.err();
    Err(LaunchError::NeverJoined {
        machine,
        waited: began.elapsed(),
        left,
    })
}

struct SharedJoining(Arc<Shared>);

impl Joining for SharedJoining {
    async fn offer(&self) -> Result<OfferHostResponse, Error> {
        crate::api::offer_host(&self.0, false).await
    }

    async fn hosts(&self) -> Result<Vec<DispatcherHost>, Error> {
        self.0.hosts()
    }
}

impl Shared {
    pub(crate) fn machine_settings(&self) -> Result<MachineSettings, Error> {
        self.store.machine_settings().map_err(internal)
    }

    pub(crate) fn update_machine_settings(
        &self,
        request: &UpdateMachineSettingsRequest,
    ) -> Result<MachineSettings, Error> {
        self.store.update_machine_settings(request).map_err(invalid)
    }

    /// Read a `token` credential from the encrypted store for cloud provider calls. Fails with
    /// `credentialsLocked` while locked, or invalid params when missing or not a token.
    fn token_credential(&self, name: &str, what: &str) -> Result<String, Error> {
        let Some((kind, value)) = self.credentials.value(&self.store, name)? else {
            return Err(invalid(format!(
                "no credential called {name}: `weave credentials set {name}` keeps {what}"
            )));
        };
        if kind != CredentialKind::Token {
            return Err(invalid(format!(
                "{name} isn't a token credential, so it can't be used for {what}"
            )));
        }
        let trimmed = value.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            return Err(invalid(format!("credential {name} is empty")));
        }
        Ok(trimmed.to_owned())
    }

    fn fly_client(&self, settings: &MachineSettings) -> Result<Box<dyn DynMachines>, Error> {
        let app = settings.fly_app.as_deref().ok_or_else(|| {
            invalid(
                "no Fly app is configured: `weave hosts machines config --fly-app <app>` sets it",
            )
        })?;
        let cred_name = settings
            .fly_credential
            .as_deref()
            .unwrap_or(DEFAULT_FLY_CREDENTIAL);
        let token = self.token_credential(cred_name, "your Fly API token")?;
        let mut config = FlyConfig::new(token, app);
        config.org = settings
            .fly_org
            .as_deref()
            .unwrap_or(DEFAULT_FLY_ORG)
            .to_owned();
        config.region = settings
            .fly_region
            .as_deref()
            .unwrap_or(DEFAULT_FLY_REGION)
            .to_owned();
        self.config
            .machines
            .machines(&config)
            .map_err(|error| internal(error.0))
    }

    async fn mint_tailscale_key(
        &self,
        settings: &MachineSettings,
        host_name: &str,
    ) -> Result<Option<String>, Error> {
        let Some(client_id) = settings.tailscale_client_id.as_deref() else {
            return Ok(None);
        };
        let cred_name = settings
            .tailscale_credential
            .as_deref()
            .unwrap_or(DEFAULT_TAILSCALE_CREDENTIAL);
        let secret = self.token_credential(cred_name, "your Tailscale OAuth client secret")?;
        let mut client = TailscaleClient::new(client_id, secret);
        client.tag = settings
            .tailscale_tag
            .as_deref()
            .unwrap_or(DEFAULT_TAG)
            .to_owned();
        let key = self
            .config
            .machines
            .mint_tailscale_key(&client, &format!("weave host {host_name}"))
            .await
            .map_err(|error| internal(error.0))?;
        Ok(Some(key))
    }

    pub(crate) async fn list_machines(&self) -> Result<Vec<CloudMachine>, Error> {
        let settings = self.machine_settings()?;
        let machines = self.fly_client(&settings)?;
        let listed = machines.list().await.map_err(|error| internal(error.0))?;
        Ok(listed.into_iter().map(CloudMachine::from).collect())
    }

    pub(crate) async fn launch_machine(
        self: &Arc<Self>,
        request: LaunchMachineRequest,
    ) -> Result<LaunchMachineResponse, Error> {
        let name = request.name.trim().to_owned();
        if name.is_empty() || name.chars().any(char::is_control) {
            return Err(invalid("a machine needs a single-line name"));
        }
        let settings = self.machine_settings()?;
        let image = request
            .image
            .or_else(|| settings.image.clone())
            .filter(|image| !image.trim().is_empty())
            .ok_or_else(|| {
                invalid(
                    "no image given: pass --image or set a default with `weave hosts machines \
                     config --image <image>`",
                )
            })?;
        let machines = self.fly_client(&settings)?;
        // Check before minting a Tailscale key so a duplicate name never wastes one.
        let taken = self
            .hosts()?
            .into_iter()
            .any(|host| host.name.eq_ignore_ascii_case(&name));
        if taken {
            return Err(invalid(format!(
                "a Host called {name} joined the Dispatcher already"
            )));
        }
        let tailscale_key = self.mint_tailscale_key(&settings, &name).await?;
        let defaults = Launch::new(name, image);
        let launched = launch_dyn(
            &SharedJoining(Arc::clone(self)),
            machines.as_ref(),
            Launch {
                tailscale_key,
                cpus: request.cpus.unwrap_or(defaults.cpus),
                memory_mb: request.memory_mb.unwrap_or(defaults.memory_mb),
                state_gb: request.state_gb.unwrap_or(defaults.state_gb),
                wait: request
                    .wait_secs
                    .map(Duration::from_secs)
                    .unwrap_or(defaults.wait),
                poll: self.config.machine_poll,
                ..defaults
            },
        )
        .await
        .map_err(|error| match error {
            LaunchError::Refused(why) => invalid(why),
            LaunchError::Dispatcher(error) => error,
            other => internal(other.to_string()),
        })?;
        Ok(LaunchMachineResponse {
            machine: launched.machine.into(),
            host: launched.host,
            took_ms: u64::try_from(launched.took.as_millis()).unwrap_or(u64::MAX),
        })
    }

    pub(crate) async fn destroy_machine(
        self: &Arc<Self>,
        by: &str,
    ) -> Result<DestroyMachineResponse, Error> {
        let settings = self.machine_settings()?;
        let machines = self.fly_client(&settings)?;
        let listed = machines.list().await.map_err(|error| internal(error.0))?;
        let machine = listed
            .into_iter()
            .find(|machine| machine.id == by || machine.name == by)
            .ok_or_else(|| invalid(format!("no machine {by} that weave made")))?;
        machines
            .destroy(&machine.id)
            .await
            .map_err(|error| internal(error.0))?;
        let host_removed = self.remove_host(&machine.name).await.is_ok();
        Ok(DestroyMachineResponse {
            machine: machine.into(),
            host_removed,
        })
    }
}
