//! Which agents there are and how to launch them: the configuration's agents, the presets
//! and the ACP registry, with the configuration's settings applied; the environment they
//! start in; and moving them to newer releases ([`update`]). The Host resolves agents with
//! this, as do `weave smoke`, `login` and `logout`, which talk to agents directly.

pub mod config;
pub mod environment;
pub mod lock;
pub mod npm;
pub mod registry;
pub mod update;

use weave_acp_core::AgentSpec;
use weave_acp_core::ClientOptions;
use weave_acp_core::Preset;

pub use crate::config::Config;

/// Where an agent was found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// The configuration gives its command.
    Config,
    /// One weave knows, with a pinned version.
    Preset,
    /// The ACP registry's catalog.
    Registry,
}

/// An agent ready to launch.
#[derive(Clone, Debug)]
pub struct Resolved {
    pub id: String,
    /// The registry's name for it, else its id.
    pub name: String,
    pub source: Source,
    /// The version launched: a preset's, the newer of its built-in and locked one, or the
    /// registry's. None for agents the configuration gives a command.
    pub version: Option<String>,
    /// A preset's npm package.
    pub package: Option<String>,
    pub spec: AgentSpec,
    /// The client services to offer it, from the configuration.
    pub options: ClientOptions,
    /// Why an out-of-date registry catalog was used, when it was.
    pub warning: Option<String>,
}

/// The agent `id` names: one the configuration defines, a preset, or else an ACP registry
/// agent, downloaded into `cache` if it runs from its own build, with the configuration's
/// settings for that name applied. `None` when nothing has that name.
pub async fn resolve(
    config: &Config,
    id: &str,
    cache: &registry::Cache,
) -> anyhow::Result<Option<Resolved>> {
    let defined = config
        .agents
        .get(id)
        .is_some_and(|agent| agent.command.is_some());
    if let Some(spec) = config.local_agent(id) {
        let (spec, options) = config.configure(id, spec);
        let preset = Preset::find(id).filter(|_| !defined);
        return Ok(Some(Resolved {
            id: id.to_owned(),
            name: id.to_owned(),
            source: if defined {
                Source::Config
            } else {
                Source::Preset
            },
            version: preset.map(|preset| config.lock.version_of(preset)),
            package: preset.map(|preset| preset.package.to_owned()),
            spec,
            options,
            warning: None,
        }));
    }
    let loaded = registry::load(cache, false).await?;
    let Some(agent) = loaded.registry.find(id) else {
        return Ok(None);
    };
    let spec = registry::agent_spec(cache, agent).await?;
    let (spec, options) = config.configure(id, spec);
    Ok(Some(Resolved {
        id: id.to_owned(),
        name: agent.name.clone(),
        source: Source::Registry,
        version: Some(agent.version.clone()),
        package: None,
        spec,
        options,
        warning: loaded.warning,
    }))
}

/// Why `id` names no agent, for messages.
pub fn unknown(config: &Config, id: &str) -> String {
    format!(
        "unknown agent {id:?}: not one of {} or in the ACP registry (`weave agents` lists them)",
        config.known_agents().join(", ")
    )
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[tokio::test]
    async fn configured_agents_and_presets_resolve_without_the_registry() {
        let config: Config = toml::from_str(
            r#"
            [agents.claude]
            terminal = false

            [agents.local]
            command = "my-agent"
            "#,
        )
        .expect("config");
        // A cache with no catalog in it: these never reach for one.
        let cache = registry::Cache::new(std::path::PathBuf::from("/nonexistent"));
        let claude = resolve(&config, "claude", &cache)
            .await
            .expect("resolves")
            .expect("preset");
        assert_eq!(claude.source, Source::Preset);
        assert!(!claude.options.terminals);
        let preset = Preset::find("claude").expect("claude");
        assert_eq!(claude.version.as_deref(), Some(preset.version));
        assert_eq!(claude.package.as_deref(), Some(preset.package));
        let local = resolve(&config, "local", &cache)
            .await
            .expect("resolves")
            .expect("configured");
        assert_eq!(
            (local.source, local.spec.command.as_str()),
            (Source::Config, "my-agent")
        );
        assert_eq!((local.version, local.package), (None, None));
    }
}
