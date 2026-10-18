use std::collections::BTreeMap;

use agent_client_protocol::AcpAgentConfig;
use agent_client_protocol::schema::v1::AuthMethodTerminal;

/// An agent weave knows how to launch: an npm package run through `npx`, at a version pinned
/// so a session is reproducible until the preset is deliberately bumped. `weave update` can
/// launch newer versions than these without a rebuild.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Preset {
    pub id: &'static str,
    /// The npm package.
    pub package: &'static str,
    /// The version weave was tested with.
    pub version: &'static str,
    /// Arguments after the package.
    pub args: &'static [&'static str],
    /// The environment variable that makes the adapter run an installed CLI rather than the
    /// one it bundles, when it has one.
    pub binary_variable: Option<&'static str>,
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "claude",
        package: "@agentclientprotocol/claude-agent-acp",
        version: "0.86.0",
        args: &[],
        binary_variable: Some("CLAUDE_CODE_EXECUTABLE"),
    },
    Preset {
        id: "codex",
        package: "@agentclientprotocol/codex-acp",
        version: "2.1.1",
        args: &[],
        binary_variable: Some("CODEX_PATH"),
    },
    Preset {
        id: "gemini",
        package: "@google/gemini-cli",
        version: "0.63.0",
        args: &["--acp"],
        binary_variable: None,
    },
];

/// Every preset.
pub fn presets() -> &'static [Preset] {
    PRESETS
}

/// Identifiers accepted by [`AgentSpec::preset`].
pub fn preset_ids() -> impl Iterator<Item = &'static str> {
    PRESETS.iter().map(|preset| preset.id)
}

impl Preset {
    /// The preset named `id`.
    pub fn find(id: &str) -> Option<&'static Self> {
        PRESETS.iter().find(|preset| preset.id == id)
    }

    /// How to launch this preset's package at `version`.
    pub fn spec_at(&self, version: &str) -> AgentSpec {
        let package = format!("{}@{version}", self.package);
        AgentSpec::new(
            "npx",
            ["-y", package.as_str()]
                .into_iter()
                .chain(self.args.iter().copied()),
        )
    }
}

/// How to launch one ACP agent process.
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct AgentSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
}

impl AgentSpec {
    pub fn new(
        command: impl Into<String>,
        args: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            command: command.into(),
            args: args.into_iter().map(Into::into).collect(),
            env: BTreeMap::new(),
        }
    }

    /// A built-in launch command for a well-known agent, at its built-in version, if `id`
    /// names one.
    pub fn preset(id: &str) -> Option<Self> {
        Preset::find(id).map(|preset| preset.spec_at(preset.version))
    }

    /// The full command line, for display.
    pub fn display_command(&self) -> String {
        std::iter::once(self.command.as_str())
            .chain(self.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The interactive invocation for a `terminal` sign-in method: this agent's own command
    /// with the method's arguments appended and its environment applied over ours.
    pub fn for_terminal_sign_in(&self, method: &AuthMethodTerminal) -> Self {
        let mut spec = self.clone();
        spec.args.extend(method.args.iter().cloned());
        spec.env.extend(
            method
                .env
                .iter()
                .map(|(name, value)| (name.clone(), value.clone())),
        );
        spec
    }

    pub(crate) fn to_config(&self) -> AcpAgentConfig {
        AcpAgentConfig::new(&self.command)
            .args(self.args.iter().cloned())
            .envs(self.env.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_preset_id_resolves() {
        for id in preset_ids() {
            assert!(AgentSpec::preset(id).is_some(), "missing preset {id}");
        }
    }

    #[test]
    fn terminal_sign_in_appends_arguments_and_overrides_environment() {
        let mut spec = AgentSpec::new("agent", ["--acp"]);
        spec.env.insert("MODE".into(), "acp".into());
        let method = AuthMethodTerminal::new("login", "Log in")
            .args(vec!["--login".into()])
            .env(std::collections::HashMap::from([(
                "MODE".into(),
                "login".into(),
            )]));
        let login = spec.for_terminal_sign_in(&method);
        assert_eq!(login.args, ["--acp", "--login"]);
        assert_eq!(login.env.get("MODE").map(String::as_str), Some("login"));
    }

    #[test]
    fn presets_launch_their_package_at_a_version() {
        let gemini = Preset::find("gemini").expect("gemini");
        assert_eq!(
            gemini.spec_at("1.2.3").display_command(),
            "npx -y @google/gemini-cli@1.2.3 --acp"
        );
        assert_eq!(
            AgentSpec::preset("claude").map(|spec| spec.display_command()),
            Some("npx -y @agentclientprotocol/claude-agent-acp@0.86.0".to_owned())
        );
    }

    #[test]
    fn unknown_preset_is_none() {
        assert_eq!(AgentSpec::preset("nope"), None);
    }
}
