//! Fly Machines as a provider of computers (WVE-238): their REST API, with a token of the
//! person's. One Fly app holds every machine made here, each with a volume of its own for the
//! Host's state, mounted at [`STATE_PATH`].
//!
//! A machine's environment is part of its configuration at Fly, which anyone in the
//! organisation can read. What goes there is a join code good once for five minutes and a
//! Tailscale key, which should be one that works once.

use std::time::Duration;

use reqwest::Method;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;

use crate::machines::ENV_JOIN_CODE;
use crate::machines::ENV_TAILSCALE_KEY;
use crate::machines::Machine;
use crate::machines::MachineError;
use crate::machines::MachineSpec;
use crate::machines::MachineState;
use crate::machines::Machines;

/// Fly's Machines API.
pub const DEFAULT_API: &str = "https://api.machines.dev/v1";
/// Where a machine's volume is mounted, which the image keeps the Host's state under.
pub const STATE_PATH: &str = "/data";
/// What marks a machine as one made here, in its metadata.
const MADE_BY: &str = "weave";

/// How long one request to Fly may take.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// How often, and how many times, a volume's removal is tried again while its machine goes.
const VOLUME_RETRY: Duration = Duration::from_secs(2);
const VOLUME_TRIES: u32 = 15;

/// Where and as whom machines are made.
#[derive(Clone)]
pub struct FlyConfig {
    /// An API token of the person's.
    pub token: String,
    /// The app that holds the machines, made in `org` if it isn't there.
    pub app: String,
    pub org: String,
    pub region: String,
    pub api: String,
}

impl std::fmt::Debug for FlyConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FlyConfig")
            .field("token", &"<redacted>")
            .field("app", &self.app)
            .field("org", &self.org)
            .field("region", &self.region)
            .field("api", &self.api)
            .finish()
    }
}

impl FlyConfig {
    pub fn new(token: impl Into<String>, app: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            app: app.into(),
            org: "personal".to_owned(),
            region: "jnb".to_owned(),
            api: DEFAULT_API.to_owned(),
        }
    }
}

pub struct Fly {
    config: FlyConfig,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct FlyMachine {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    config: FlyMachineConfig,
}

#[derive(Default, Deserialize)]
struct FlyMachineConfig {
    #[serde(default)]
    image: String,
    #[serde(default)]
    mounts: Vec<FlyMount>,
    #[serde(default)]
    metadata: std::collections::BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct FlyMount {
    #[serde(default)]
    volume: String,
}

#[derive(Deserialize)]
struct FlyVolume {
    id: String,
}

impl FlyMachine {
    fn made_here(&self) -> bool {
        self.config.metadata.get("made_by").map(String::as_str) == Some(MADE_BY)
    }

    fn machine(self) -> Machine {
        let state = match self.state.as_str() {
            "created" | "starting" | "replacing" => MachineState::Starting,
            "started" => MachineState::Running,
            "stopped" | "stopping" | "suspended" | "suspending" => MachineState::Stopped,
            "destroying" | "destroyed" => MachineState::Gone,
            other => MachineState::Other(other.to_owned()),
        };
        let image = if self.config.image.is_empty() {
            None
        } else {
            Some(self.config.image)
        };
        Machine {
            id: self.id,
            name: self.name,
            state,
            image,
        }
    }
}

/// A volume's name at Fly: lowercase letters, digits and underscores, thirty at most.
fn volume_name(machine: &str) -> String {
    let name: String = machine
        .chars()
        .map(|c| match c.to_ascii_lowercase() {
            c @ ('a'..='z' | '0'..='9') => c,
            _ => '_',
        })
        .take(24)
        .collect();
    format!("state_{name}")
}

impl Fly {
    pub fn new(config: FlyConfig) -> Result<Self, MachineError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| MachineError(format!("no HTTP client for Fly: {error}")))?;
        Ok(Self { config, http })
    }

    /// One request to Fly: its status and what it answered, which is JSON or nothing.
    async fn ask(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(StatusCode, Value), MachineError> {
        let what = format!("{method} {path}");
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.config.api))
            .bearer_auth(&self.config.token);
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let response = request
            .send()
            .await
            .map_err(|error| MachineError(format!("Fly didn't answer {what}: {error}")))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| MachineError(format!("Fly's answer to {what} broke off: {error}")))?;
        let value = serde_json::from_str(&text).unwrap_or(Value::String(text));
        Ok((status, value))
    }

    /// [`Self::ask`], with anything but success an error in Fly's words.
    async fn done(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, MachineError> {
        let what = format!("{method} {path}");
        let (status, value) = self.ask(method, path, body).await?;
        if status.is_success() {
            return Ok(value);
        }
        let why = match value.get("error").and_then(Value::as_str) {
            Some(error) => error.to_owned(),
            None => value.to_string(),
        };
        Err(MachineError(format!(
            "Fly refused {what} ({status}): {why}"
        )))
    }

    fn read<T: serde::de::DeserializeOwned>(what: &str, value: Value) -> Result<T, MachineError> {
        serde_json::from_value(value)
            .map_err(|error| MachineError(format!("Fly's {what} wasn't as expected: {error}")))
    }

    fn app(&self) -> String {
        format!("/apps/{}", self.config.app)
    }

    /// Make the app that holds the machines, if it isn't there.
    async fn ensure_app(&self) -> Result<(), MachineError> {
        let (status, _) = self.ask(Method::GET, &self.app(), None).await?;
        if status.is_success() {
            return Ok(());
        }
        self.done(
            Method::POST,
            "/apps",
            Some(json!({ "app_name": self.config.app, "org_slug": self.config.org })),
        )
        .await
        .map(|_| ())
    }

    async fn fly_machine(&self, id: &str) -> Result<FlyMachine, MachineError> {
        let value = self
            .done(Method::GET, &format!("{}/machines/{id}", self.app()), None)
            .await?;
        Self::read("machine", value)
    }

    /// Remove a volume, trying again while the machine that held it is still going.
    async fn remove_volume(&self, id: &str) -> Result<(), MachineError> {
        let path = format!("{}/volumes/{id}", self.app());
        let mut tries = 0;
        loop {
            tries += 1;
            match self.done(Method::DELETE, &path, None).await {
                Ok(_) => return Ok(()),
                Err(error) if tries >= VOLUME_TRIES => return Err(error),
                Err(_) => tokio::time::sleep(VOLUME_RETRY).await,
            }
        }
    }
}

impl Machines for Fly {
    async fn create(&self, spec: &MachineSpec) -> Result<Machine, MachineError> {
        self.ensure_app().await?;
        let mut config = json!({
            "image": spec.image,
            "env": spec.env,
            "guest": { "cpu_kind": "shared", "cpus": spec.cpus, "memory_mb": spec.memory_mb },
            "restart": { "policy": "on-failure", "max_retries": 3 },
            "metadata": { "made_by": MADE_BY },
        });
        let mut volume = None;
        if spec.state_gb > 0 {
            let made = self
                .done(
                    Method::POST,
                    &format!("{}/volumes", self.app()),
                    Some(json!({
                        "name": volume_name(&spec.name),
                        "region": self.config.region,
                        "size_gb": spec.state_gb,
                    })),
                )
                .await?;
            let made: FlyVolume = Self::read("volume", made)?;
            config["mounts"] = json!([{ "volume": made.id, "path": STATE_PATH }]);
            volume = Some(made.id);
        }
        let made = self
            .done(
                Method::POST,
                &format!("{}/machines", self.app()),
                Some(json!({
                    "name": spec.name,
                    "region": self.config.region,
                    "config": config,
                })),
            )
            .await;
        match made {
            Ok(made) => Ok(Self::read::<FlyMachine>("machine", made)?.machine()),
            Err(error) => {
                // No machine took the volume, so nothing would ever remove it.
                if let Some(volume) = volume {
                    let _ = self.remove_volume(&volume).await;
                }
                Err(error)
            }
        }
    }

    async fn list(&self) -> Result<Vec<Machine>, MachineError> {
        let (status, value) = self
            .ask(Method::GET, &format!("{}/machines", self.app()), None)
            .await?;
        // No app yet is no machines.
        if status == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !status.is_success() {
            return Err(MachineError(format!(
                "Fly refused to list machines ({status}): {value}"
            )));
        }
        let machines: Vec<FlyMachine> = Self::read("machines", value)?;
        Ok(machines
            .into_iter()
            .filter(FlyMachine::made_here)
            .map(FlyMachine::machine)
            .collect())
    }

    async fn get(&self, id: &str) -> Result<Machine, MachineError> {
        Ok(self.fly_machine(id).await?.machine())
    }

    async fn start(&self, id: &str) -> Result<(), MachineError> {
        self.done(
            Method::POST,
            &format!("{}/machines/{id}/start", self.app()),
            None,
        )
        .await
        .map(|_| ())
    }

    async fn stop(&self, id: &str) -> Result<(), MachineError> {
        self.done(
            Method::POST,
            &format!("{}/machines/{id}/stop", self.app()),
            None,
        )
        .await
        .map(|_| ())
    }

    async fn destroy(&self, id: &str) -> Result<(), MachineError> {
        let machine = self.fly_machine(id).await?;
        if !machine.made_here() {
            return Err(MachineError(format!(
                "machine {id} wasn't made by weave, so it is left alone"
            )));
        }
        self.done(
            Method::DELETE,
            &format!("{}/machines/{id}?force=true", self.app()),
            None,
        )
        .await?;
        for mount in machine.config.mounts {
            if !mount.volume.is_empty() {
                self.remove_volume(&mount.volume).await?;
            }
        }
        Ok(())
    }

    async fn update_image(&self, id: &str, image: &str) -> Result<Machine, MachineError> {
        let path = format!("{}/machines/{id}", self.app());
        let raw = self.done(Method::GET, &path, None).await?;
        let machine: FlyMachine = Self::read("machine", raw.clone())?;
        if !machine.made_here() {
            return Err(MachineError(format!(
                "machine {id} wasn't made by weave, so it is left alone"
            )));
        }
        let mut config = raw
            .get("config")
            .cloned()
            .filter(Value::is_object)
            .ok_or_else(|| MachineError(format!("Fly's machine {id} had no config object")))?;
        if let Some(obj) = config.as_object_mut() {
            obj.insert("image".to_owned(), Value::String(image.to_owned()));
            // Strip single-use bootstrap secrets so reboots never carry spent tokens.
            if let Some(env) = obj.get_mut("env").and_then(Value::as_object_mut) {
                env.remove(ENV_TAILSCALE_KEY);
                env.remove(ENV_JOIN_CODE);
            }
        }
        let updated = self
            .done(Method::POST, &path, Some(json!({ "config": config })))
            .await?;
        Ok(Self::read::<FlyMachine>("machine", updated)?.machine())
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::Value;
    use serde_json::json;
    use tokio::io::AsyncReadExt;
    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;

    use super::Fly;
    use super::FlyConfig;
    use super::volume_name;
    use crate::machines::ENV_JOIN_CODE;
    use crate::machines::ENV_TAILSCALE_KEY;
    use crate::machines::Machines;

    #[test]
    fn a_volume_is_named_in_what_fly_allows() {
        assert_eq!(volume_name("cloud-1"), "state_cloud_1");
        assert_eq!(
            volume_name("A Very Long Name For A Machine Indeed").len(),
            30
        );
    }

    #[tokio::test]
    async fn update_image_swaps_image_preserves_mounts_and_strips_bootstrap_env() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let existing = json!({
            "id": "m-1",
            "name": "cloud-1",
            "state": "started",
            "config": {
                "image": "registry.fly.io/weave-hosts:old",
                "env": {
                    "WEAVE_HOST_NAME": "cloud-1",
                    "WEAVE_DISPATCHER_URL": "wss://homelab.ts.net:7342",
                    ENV_TAILSCALE_KEY: "tskey-spent",
                    ENV_JOIN_CODE: "code-spent",
                },
                "guest": { "cpu_kind": "shared", "cpus": 1, "memory_mb": 1024 },
                "mounts": [{ "volume": "vol_123", "path": "/data" }],
                "metadata": { "made_by": "weave" },
            }
        });
        let server = tokio::spawn(async move {
            let mut posted: Option<Value> = None;
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().await.expect("accept");
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.expect("read");
                let req = String::from_utf8_lossy(&buf[..n]);
                let (status, body) = if req.starts_with("GET ") {
                    ("200 OK", existing.to_string())
                } else {
                    let body_str = req.split("\r\n\r\n").nth(1).unwrap_or("");
                    let json_body: Value = serde_json::from_str(body_str).expect("json body");
                    posted = Some(json_body.clone());
                    let resp = json!({
                        "id": "m-1",
                        "name": "cloud-1",
                        "state": "started",
                        "config": json_body["config"],
                    });
                    ("200 OK", resp.to_string())
                };
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(reply.as_bytes()).await.expect("write");
            }
            posted.expect("POST captured")
        });

        let mut config = FlyConfig::new("tok", "weave-hosts");
        config.api = format!("http://{addr}");
        let fly = Fly::new(config).expect("fly");
        let updated = fly
            .update_image("m-1", "registry.fly.io/weave-hosts:new")
            .await
            .expect("updated");
        assert_eq!(updated.id, "m-1");
        assert_eq!(
            updated.image.as_deref(),
            Some("registry.fly.io/weave-hosts:new")
        );

        let posted = server.await.expect("server");
        let posted_config = &posted["config"];
        assert_eq!(posted_config["image"], "registry.fly.io/weave-hosts:new");
        assert_eq!(posted_config["mounts"][0]["volume"], "vol_123");
        assert_eq!(posted_config["env"]["WEAVE_HOST_NAME"], "cloud-1");
        assert!(posted_config["env"].get(ENV_TAILSCALE_KEY).is_none());
        assert!(posted_config["env"].get(ENV_JOIN_CODE).is_none());
    }
}
