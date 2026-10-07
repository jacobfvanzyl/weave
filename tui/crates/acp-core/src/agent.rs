use std::collections::BTreeMap;

use agent_client_protocol::AcpAgentConfig;

/// Agent presets, pinned so a session is reproducible until a preset is deliberately bumped.
const PRESETS: &[(&str, &str, &[&str])] = &[
    (
        "claude",
        "npx",
        &["-y", "@agentclientprotocol/claude-agent-acp@0.86.0"],
    ),
    (
        "codex",
        "npx",
        &["-y", "@agentclientprotocol/codex-acp@2.1.1"],
    ),
    (
        "gemini",
        "npx",
        &["-y", "@google/gemini-cli@0.63.0", "--acp"],
    ),
];

/// Identifiers accepted by [`AgentSpec::preset`].
pub fn preset_ids() -> impl Iterator<Item = &'static str> {
    PRESETS.iter().map(|(id, _, _)| *id)
}

/// How to launch one ACP agent process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentSpec {
    pub command: String,
    pub args: Vec<String>,
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

    /// A built-in launch command for a well-known agent, if `id` names one.
    pub fn preset(id: &str) -> Option<Self> {
        PRESETS
            .iter()
            .find(|(preset_id, _, _)| *preset_id == id)
            .map(|(_, command, args)| Self::new(*command, args.iter().copied()))
    }

    /// The full command line, for display.
    pub fn display_command(&self) -> String {
        std::iter::once(self.command.as_str())
            .chain(self.args.iter().map(String::as_str))
            .collect::<Vec<_>>()
            .join(" ")
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
    fn unknown_preset_is_none() {
        assert_eq!(AgentSpec::preset("nope"), None);
    }
}
