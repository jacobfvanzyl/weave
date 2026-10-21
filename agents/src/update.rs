//! Moving agents to their newest releases (WVE-92, WVE-93): the presets' adapters to npm's
//! `latest`, written to `agents.lock` beside the config, and the registry agents in use to a
//! refreshed ACP registry catalog, each only once it starts and answers `initialize`.
//! `weave update` runs it from scripts, and the Host for `agents/update`; where new versions
//! come from and how one is started are theirs to say ([`Upstream`], [`Check`]).

use std::cmp::Ordering;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::time::Duration;

use serde::Serialize;
use weave_acp_core::AgentConnection;
use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::Preset;

use crate::Config;
use crate::lock::Lock;
use crate::lock::compare;
use crate::registry;
use crate::registry::Cache;
use crate::registry::Fetched;

/// How long a new version gets to download and answer `initialize`.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Where new versions come from.
pub trait Upstream: Send + Sync {
    /// The version npm's `latest` tag names for `package`.
    fn latest<'a>(&'a self, package: &'a str) -> BoxFuture<'a, anyhow::Result<String>>;
    /// The ACP registry's catalog as it is now.
    fn catalog(&self) -> BoxFuture<'_, anyhow::Result<Fetched>>;
}

/// Whether a new version starts.
pub trait Check: Send + Sync {
    fn check<'a>(
        &'a self,
        spec: &'a AgentSpec,
        options: &'a ClientOptions,
    ) -> BoxFuture<'a, anyhow::Result<()>>;
}

/// What to update.
#[derive(Clone, Debug, Default)]
pub struct Request {
    /// Only these agents. By default, every preset and the registry agents the config names.
    pub agents: Vec<String>,
    /// Say what would change, and change nothing.
    pub dry_run: bool,
    /// Go back to weave's built-in preset versions.
    pub reset: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub agents: Vec<Entry>,
    /// The registry's catalog, when a registry agent was in scope.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog: Option<CatalogEntry>,
    pub dry_run: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub agent: String,
    pub source: Source,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package: Option<String>,
    /// The version launched before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// The version launched after, or that would be.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub outcome: Outcome,
    /// Why it was skipped or failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// The CLI the adapter runs in a session: `bundled`, or the installed one its variable
    /// names. Only for presets that bundle one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Preset,
    Registry,
    Config,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Current,
    WouldUpdate,
    Updated,
    WouldReset,
    Reset,
    Skipped,
    Failed,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl Report {
    /// Whether a lookup or a check failed.
    pub fn failed(&self) -> bool {
        self.agents
            .iter()
            .map(|entry| entry.outcome)
            .chain(self.catalog.iter().map(|catalog| catalog.outcome))
            .any(|outcome| outcome == Outcome::Failed)
    }
}

/// What an update covers.
enum Target {
    Preset(&'static Preset),
    Registry(String),
    /// The config gives its command, so it's the user's to update.
    Configured(String),
}

fn targets(config: &Config, named: &[String]) -> Vec<Target> {
    let target = |id: &str| {
        let configured = config
            .agents
            .get(id)
            .is_some_and(|agent| agent.command.is_some());
        match Preset::find(id) {
            _ if configured => Target::Configured(id.to_owned()),
            Some(preset) => Target::Preset(preset),
            None => Target::Registry(id.to_owned()),
        }
    };
    if !named.is_empty() {
        return named.iter().map(|id| target(id)).collect();
    }
    let mut ids: Vec<String> = weave_acp_core::preset_ids().map(str::to_owned).collect();
    let in_use = config
        .agents
        .keys()
        .cloned()
        .chain(config.default_agent.clone());
    for id in in_use {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    // Agents the config gives a command are reported only when named.
    ids.iter()
        .map(|id| target(id))
        .filter(|target| !matches!(target, Target::Configured(_)))
        .collect()
}

/// Update what `request` names under `config`, whose lock is at `lock_path`, with the
/// registry's catalog and agents in `cache`.
pub async fn update(
    request: &Request,
    config: &Config,
    lock_path: &Path,
    cache: &Cache,
    upstream: &dyn Upstream,
    check: &dyn Check,
) -> anyhow::Result<Report> {
    let targets = targets(config, &request.agents);
    let mut lock = config.lock.clone();
    let mut entries = Vec::new();
    let mut registry_ids = Vec::new();
    for target in targets {
        match target {
            Target::Configured(agent) => entries.push(Entry {
                agent,
                source: Source::Config,
                package: None,
                from: None,
                to: None,
                outcome: Outcome::Skipped,
                note: Some("the config gives its command".to_owned()),
                cli: None,
            }),
            Target::Preset(preset) if request.reset => {
                entries.push(reset(preset, &mut lock, request.dry_run));
            }
            Target::Preset(preset) => {
                entries.push(
                    update_preset(
                        preset, config, &mut lock, lock_path, request, upstream, check,
                    )
                    .await?,
                );
            }
            Target::Registry(id) if !request.reset => registry_ids.push(id),
            Target::Registry(_) => {}
        }
    }
    if request.reset && !request.dry_run {
        lock.write(lock_path)?;
    }
    let catalog = if registry_ids.is_empty() {
        None
    } else {
        Some(
            update_registry(
                &registry_ids,
                config,
                cache,
                request.dry_run,
                upstream,
                check,
                &mut entries,
            )
            .await,
        )
    };
    Ok(Report {
        agents: entries,
        catalog,
        dry_run: request.dry_run,
    })
}

fn reset(preset: &'static Preset, lock: &mut Lock, dry_run: bool) -> Entry {
    let from = lock.version_of(preset);
    let locked = lock.agents.contains_key(preset.id);
    if locked && !dry_run {
        lock.agents.remove(preset.id);
    }
    Entry {
        agent: preset.id.to_owned(),
        source: Source::Preset,
        package: Some(preset.package.to_owned()),
        to: Some(preset.version.to_owned()),
        outcome: match (locked, dry_run) {
            (false, _) => Outcome::Current,
            (true, true) => Outcome::WouldReset,
            (true, false) => Outcome::Reset,
        },
        from: Some(from),
        note: None,
        cli: None,
    }
}

async fn update_preset(
    preset: &'static Preset,
    config: &Config,
    lock: &mut Lock,
    lock_path: &Path,
    request: &Request,
    upstream: &dyn Upstream,
    check: &dyn Check,
) -> anyhow::Result<Entry> {
    let from = lock.version_of(preset);
    let mut entry = Entry {
        agent: preset.id.to_owned(),
        source: Source::Preset,
        package: Some(preset.package.to_owned()),
        from: Some(from.clone()),
        to: None,
        outcome: Outcome::Current,
        note: None,
        cli: cli(config, preset),
    };
    let latest = match upstream.latest(preset.package).await {
        Ok(latest) => latest,
        Err(error) => {
            entry.outcome = Outcome::Failed;
            entry.note = Some(format!("{error:#}"));
            return Ok(entry);
        }
    };
    if compare(&latest, &from) != Ordering::Greater {
        return Ok(entry);
    }
    entry.to = Some(latest.clone());
    if request.dry_run {
        entry.outcome = Outcome::WouldUpdate;
        return Ok(entry);
    }
    let (spec, options) = config.configure(preset.id, preset.spec_at(&latest));
    match check.check(&spec, &options).await {
        Ok(()) => {
            lock.set(preset, &latest);
            lock.write(lock_path)?;
            entry.outcome = Outcome::Updated;
        }
        Err(error) => {
            entry.outcome = Outcome::Failed;
            entry.note = Some(format!(
                "{latest} doesn't start, so {from} stays: {error:#}"
            ));
        }
    }
    Ok(entry)
}

/// The CLI `preset`'s adapter runs: the installed one its variable names, in the config's
/// `env` for it or this environment, else the one it bundles.
fn cli(config: &Config, preset: &Preset) -> Option<String> {
    let variable = preset.binary_variable?;
    let configured = config
        .agents
        .get(preset.id)
        .and_then(|agent| agent.env.get(variable).cloned());
    let installed =
        configured.or_else(|| std::env::var(variable).ok().filter(|path| !path.is_empty()));
    Some(installed.unwrap_or_else(|| "bundled".to_owned()))
}

async fn update_registry(
    ids: &[String],
    config: &Config,
    cache: &Cache,
    dry_run: bool,
    upstream: &dyn Upstream,
    check: &dyn Check,
    entries: &mut Vec<Entry>,
) -> CatalogEntry {
    let entry = |agent: &str, from: Option<String>, to: Option<String>, outcome, note| Entry {
        agent: agent.to_owned(),
        source: Source::Registry,
        package: None,
        from,
        to,
        outcome,
        note,
        cli: None,
    };
    let fetched = match upstream.catalog().await {
        Ok(fetched) => fetched,
        Err(error) => {
            let note = format!("{error:#}");
            for id in ids {
                entries.push(entry(id, None, None, Outcome::Failed, Some(note.clone())));
            }
            return CatalogEntry {
                outcome: Outcome::Failed,
                note: Some(note),
            };
        }
    };
    let cached = registry::cached(cache);
    for id in ids {
        let from = cached
            .as_ref()
            .and_then(|registry| registry.find(id))
            .map(|agent| agent.version.clone());
        let Some(agent) = fetched.registry.find(id) else {
            let note = "not a preset, or in the ACP registry".to_owned();
            entries.push(entry(id, from, None, Outcome::Failed, Some(note)));
            continue;
        };
        let to = Some(agent.version.clone());
        if from == to {
            entries.push(entry(id, from, None, Outcome::Current, None));
            continue;
        }
        if dry_run {
            entries.push(entry(id, from, to, Outcome::WouldUpdate, None));
            continue;
        }
        let checked = async {
            let spec = registry::agent_spec(cache, agent).await?;
            let (spec, options) = config.configure(id, spec);
            check.check(&spec, &options).await
        };
        match checked.await {
            Ok(()) => entries.push(entry(id, from, to, Outcome::Updated, None)),
            Err(error) => {
                let note = format!("doesn't start: {error:#}");
                entries.push(entry(id, from, to, Outcome::Failed, Some(note)));
            }
        }
    }
    if dry_run {
        return CatalogEntry {
            outcome: Outcome::WouldUpdate,
            note: None,
        };
    }
    match registry::store(cache, &fetched) {
        Ok(()) => CatalogEntry {
            outcome: Outcome::Updated,
            note: None,
        },
        Err(error) => CatalogEntry {
            outcome: Outcome::Failed,
            note: Some(format!("{error:#}")),
        },
    }
}

/// The npm and ACP registries.
pub struct Network;

impl Upstream for Network {
    fn latest<'a>(&'a self, package: &'a str) -> BoxFuture<'a, anyhow::Result<String>> {
        Box::pin(crate::npm::latest(package))
    }

    fn catalog(&self) -> BoxFuture<'_, anyhow::Result<Fetched>> {
        Box::pin(registry::fetch_catalog())
    }
}

/// No npm or registry: every lookup fails, as when offline. For tests whose agents aren't
/// looked up, or mustn't reach the network.
pub struct Offline;

impl Upstream for Offline {
    fn latest<'a>(&'a self, _package: &'a str) -> BoxFuture<'a, anyhow::Result<String>> {
        Box::pin(async { anyhow::bail!("offline") })
    }

    fn catalog(&self) -> BoxFuture<'_, anyhow::Result<Fetched>> {
        Box::pin(async { anyhow::bail!("offline") })
    }
}

/// Start the agent here and wait for its `initialize` answer: that downloads a new version and
/// shows it speaks ACP, without a session, a prompt or a sign-in.
pub struct Starts;

impl Check for Starts {
    fn check<'a>(
        &'a self,
        spec: &'a AgentSpec,
        options: &'a ClientOptions,
    ) -> BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(async move {
            let started = tokio::time::timeout(CHECK_TIMEOUT, async {
                let (connection, _events) = AgentConnection::spawn(spec, None, *options).await?;
                let initialized = connection.initialize().await;
                connection.shutdown().await;
                initialized.map(|_| ()).map_err(anyhow::Error::from)
            })
            .await;
            match started {
                Ok(result) => result,
                Err(_) => anyhow::bail!(
                    "it didn't answer initialize within {} minutes",
                    CHECK_TIMEOUT.as_secs() / 60
                ),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    use anyhow::Context;
    use pretty_assertions::assert_eq;

    use super::*;

    /// npm and the registry as a test has them.
    struct Stub {
        latest: BTreeMap<&'static str, Result<&'static str, &'static str>>,
        catalog: Option<&'static str>,
    }

    impl Upstream for Stub {
        fn latest<'a>(&'a self, package: &'a str) -> BoxFuture<'a, anyhow::Result<String>> {
            let found = self.latest.get(package).copied();
            Box::pin(async move {
                match found {
                    Some(Ok(version)) => Ok(version.to_owned()),
                    Some(Err(why)) => anyhow::bail!("{why}"),
                    None => anyhow::bail!("no such package"),
                }
            })
        }

        fn catalog(&self) -> BoxFuture<'_, anyhow::Result<Fetched>> {
            Box::pin(async move {
                let json = self.catalog.context("the registry is down")?;
                Fetched::parse(json.as_bytes().to_vec())
            })
        }
    }

    /// Starts every agent but those whose command line contains one of `failing`, noting
    /// what it was asked to start.
    #[derive(Default)]
    struct Checks {
        failing: Vec<&'static str>,
        started: Mutex<Vec<String>>,
    }

    impl Check for Checks {
        fn check<'a>(
            &'a self,
            spec: &'a AgentSpec,
            _options: &'a ClientOptions,
        ) -> BoxFuture<'a, anyhow::Result<()>> {
            Box::pin(async move {
                let command = spec.display_command();
                if let Ok(mut started) = self.started.lock() {
                    started.push(command.clone());
                }
                if self.failing.iter().any(|failing| command.contains(failing)) {
                    anyhow::bail!("it exited");
                }
                Ok(())
            })
        }
    }

    fn request(dry_run: bool, reset: bool, agents: &[&str]) -> Request {
        Request {
            agents: agents.iter().map(|id| (*id).to_owned()).collect(),
            dry_run,
            reset,
        }
    }

    fn npm() -> Stub {
        Stub {
            latest: BTreeMap::from([
                ("@agentclientprotocol/claude-agent-acp", Ok("9.0.0")),
                ("@agentclientprotocol/codex-acp", Ok("9.0.0")),
                ("@google/gemini-cli", Ok("0.0.1")),
            ]),
            catalog: None,
        }
    }

    struct World {
        dir: tempfile::TempDir,
    }

    impl World {
        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().expect("tempdir"),
            }
        }

        fn config(&self, text: &str) -> Config {
            let path = self.dir.path().join("config.toml");
            std::fs::write(&path, text).expect("config");
            Config::load(Some(&path)).expect("loads").config
        }

        fn lock_path(&self) -> PathBuf {
            self.dir.path().join("agents.lock")
        }

        fn lock(&self) -> Lock {
            Lock::read(&self.lock_path()).expect("readable")
        }

        fn cache(&self) -> Cache {
            Cache::new(self.dir.path().join("cache"))
        }
    }

    fn outcomes(report: &Report) -> Vec<(String, Outcome)> {
        report
            .agents
            .iter()
            .map(|entry| (entry.agent.clone(), entry.outcome))
            .collect()
    }

    #[tokio::test]
    async fn a_dry_run_says_what_would_change_and_writes_nothing() {
        let world = World::new();
        let config = world.config("");
        let checks = Checks::default();
        let report = update(
            &request(true, false, &[]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &npm(),
            &checks,
        )
        .await
        .expect("report");
        assert_eq!(
            outcomes(&report),
            [
                ("claude".to_owned(), Outcome::WouldUpdate),
                ("codex".to_owned(), Outcome::WouldUpdate),
                ("gemini".to_owned(), Outcome::Current),
            ]
        );
        assert!(!world.lock_path().exists());
        assert!(
            checks.started.lock().expect("lock").is_empty(),
            "nothing started"
        );
        assert!(!report.failed());
    }

    #[tokio::test]
    async fn a_new_version_counts_only_once_it_starts() {
        let world = World::new();
        let config = world.config("[agents.codex]\nenv = { CODEX_PATH = \"/opt/codex\" }\n");
        let checks = Checks {
            failing: vec!["codex-acp"],
            ..Checks::default()
        };
        let report = update(
            &request(false, false, &[]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &npm(),
            &checks,
        )
        .await
        .expect("report");
        assert_eq!(report.agents[0].outcome, Outcome::Updated);
        assert_eq!(report.agents[1].outcome, Outcome::Failed);
        assert!(report.failed(), "the script hears of it");
        let lock = world.lock();
        let claude = Preset::find("claude").expect("claude");
        let codex = Preset::find("codex").expect("codex");
        assert_eq!(lock.version_of(claude), "9.0.0");
        assert_eq!(lock.version_of(codex), codex.version, "the old one stays");
        assert_eq!(
            *checks.started.lock().expect("lock"),
            [
                "npx -y @agentclientprotocol/claude-agent-acp@9.0.0",
                "npx -y @agentclientprotocol/codex-acp@9.0.0",
            ]
        );
        let claude_cli = std::env::var("CLAUDE_CODE_EXECUTABLE")
            .ok()
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| "bundled".to_owned());
        assert_eq!(report.agents[0].cli.as_deref(), Some(claude_cli.as_str()));
        assert_eq!(report.agents[1].cli.as_deref(), Some("/opt/codex"));
        assert_eq!(report.agents[2].cli, None, "gemini bundles no CLI");
        assert!(
            report.agents[1]
                .note
                .as_deref()
                .is_some_and(|note| note.starts_with("9.0.0 doesn't start")),
            "{:?}",
            report.agents[1].note
        );

        // Run again: claude is current now.
        let config = world.config("");
        let again = update(
            &request(false, false, &["claude"]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &npm(),
            &Checks::default(),
        )
        .await
        .expect("report");
        assert_eq!(outcomes(&again), [("claude".to_owned(), Outcome::Current)]);
    }

    #[tokio::test]
    async fn a_failed_lookup_fails_and_configured_agents_are_skipped() {
        let world = World::new();
        let config = world.config("[agents.claude]\ncommand = \"my-claude\"\n");
        let mut upstream = npm();
        upstream
            .latest
            .insert("@agentclientprotocol/codex-acp", Err("npm is down"));
        let report = update(
            &request(false, false, &["claude", "codex"]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &upstream,
            &Checks::default(),
        )
        .await
        .expect("report");
        assert_eq!(
            outcomes(&report),
            [
                ("claude".to_owned(), Outcome::Skipped),
                ("codex".to_owned(), Outcome::Failed),
            ]
        );
        assert_eq!(report.agents[1].note.as_deref(), Some("npm is down"));
        assert!(report.failed());
    }

    #[tokio::test]
    async fn resetting_goes_back_to_the_built_in_versions() {
        let world = World::new();
        let mut lock = Lock::default();
        lock.set(Preset::find("claude").expect("claude"), "9.0.0");
        lock.write(&world.lock_path()).expect("lock");
        let config = world.config("");
        let dry = update(
            &request(true, true, &[]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &npm(),
            &Checks::default(),
        )
        .await
        .expect("report");
        assert_eq!(dry.agents[0].outcome, Outcome::WouldReset);
        assert!(world.lock_path().exists(), "a dry run keeps it");
        let report = update(
            &request(false, true, &[]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &npm(),
            &Checks::default(),
        )
        .await
        .expect("report");
        assert_eq!(
            outcomes(&report),
            [
                ("claude".to_owned(), Outcome::Reset),
                ("codex".to_owned(), Outcome::Current),
                ("gemini".to_owned(), Outcome::Current),
            ]
        );
        assert!(!world.lock_path().exists());
    }

    const CATALOG: &str = r#"{"agents": [{"id": "some-acp", "name": "Some", "version": "2.0.0",
        "distribution": {"npx": {"package": "some-acp@2.0.0"}}}]}"#;

    #[tokio::test]
    async fn registry_agents_in_use_follow_a_refreshed_catalog() {
        let world = World::new();
        let config = world.config("default_agent = \"some-acp\"\n");
        let upstream = Stub {
            catalog: Some(CATALOG),
            ..npm()
        };
        let dry = update(
            &request(true, false, &[]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &upstream,
            &Checks::default(),
        )
        .await
        .expect("report");
        let some = dry.agents.last().expect("the registry agent");
        assert_eq!(
            (some.agent.as_str(), some.outcome),
            ("some-acp", Outcome::WouldUpdate)
        );
        assert!(
            registry::cached(&world.cache()).is_none(),
            "a dry run caches nothing"
        );

        let checks = Checks::default();
        let report = update(
            &request(false, false, &["some-acp"]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &upstream,
            &checks,
        )
        .await
        .expect("report");
        assert_eq!(
            outcomes(&report),
            [("some-acp".to_owned(), Outcome::Updated)]
        );
        assert_eq!(
            report.catalog.as_ref().map(|catalog| catalog.outcome),
            Some(Outcome::Updated)
        );
        assert!(
            registry::cached(&world.cache())
                .is_some_and(|registry| registry.find("some-acp").is_some())
        );
        assert_eq!(
            *checks.started.lock().expect("lock"),
            ["npx -y some-acp@2.0.0"]
        );

        let down = Stub {
            catalog: None,
            ..npm()
        };
        let failed = update(
            &request(false, false, &["some-acp"]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &down,
            &Checks::default(),
        )
        .await
        .expect("report");
        assert!(failed.failed());
    }

    #[tokio::test]
    async fn the_json_report_names_each_agent_and_what_happened() {
        let world = World::new();
        let config = world.config("");
        let report = update(
            &request(true, false, &["claude"]),
            &config,
            &world.lock_path(),
            &world.cache(),
            &npm(),
            &Checks::default(),
        )
        .await
        .expect("report");
        let json = serde_json::to_value(&report).expect("json");
        let cli = std::env::var("CLAUDE_CODE_EXECUTABLE")
            .ok()
            .filter(|path| !path.is_empty())
            .unwrap_or_else(|| "bundled".to_owned());
        assert_eq!(
            json,
            serde_json::json!({
                "agents": [{
                    "agent": "claude",
                    "source": "preset",
                    "package": "@agentclientprotocol/claude-agent-acp",
                    "from": Preset::find("claude").expect("claude").version,
                    "to": "9.0.0",
                    "outcome": "wouldUpdate",
                    "cli": cli,
                }],
                "dryRun": true,
            })
        );
    }
}
