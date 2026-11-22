//! Computers for Hosts, made in the cloud (WVE-238, a spike behind the `machines` feature).
//!
//! The Dispatcher runs no agents, and this doesn't change that: it makes the computer a Host
//! runs on, and the Host there joins like any other, over the connection it opens (ADR 0030).
//! Two seams keep the parts apart:
//!
//! - [`Machines`]: a provider of computers, which knows nothing of Hosts. [`fly::Fly`] is the
//!   first, over Fly's Machines API.
//! - [`Joining`]: what a launch asks of the Dispatcher, a code to join with and the Hosts that
//!   joined. The [`Dispatcher`](crate::Dispatcher) answers it in its own process, and a
//!   [`DispatcherConnection`] over its API, which is how the CLI launches one today.
//!
//! [`launch`] goes from nothing to a Host that joined: a code, a machine whose image joins with
//! it (`scripts/host-image`), and a wait for the Host to connect. A machine whose Host never
//! joins is destroyed, so nothing is left running that the Dispatcher doesn't know of.

pub mod fly;
pub mod tailscale;

use std::collections::BTreeMap;
use std::future::Future;
use std::time::Duration;

use agent_client_protocol::Error;
use weave_host_protocol::dispatcher::DispatcherAddress;
use weave_host_protocol::dispatcher::DispatcherHost;
use weave_host_protocol::dispatcher::ListHostsRequest;
use weave_host_protocol::dispatcher::OfferHostRequest;
use weave_host_protocol::dispatcher::OfferHostResponse;

use crate::Dispatcher;
use crate::client::DispatcherConnection;

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
