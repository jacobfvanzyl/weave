//! What weave reads beyond what ACP defines, in one place.
//!
//! ACP tells a client a tool call's `kind` and human-readable `title`. Which command ran, what
//! was searched for, or which URL was fetched sits in `rawInput`, whose shape the protocol
//! leaves to each agent, and a thought is free text. Agents follow conventions there, and this
//! module is the only place weave relies on them. None is required: when one doesn't hold,
//! weave shows the title, as a client that knew none of them would.
//!
//! | Convention | Used by |
//! | --- | --- |
//! | `rawInput.command`: the command an execute call runs | codex-acp, claude-agent-acp |
//! | … or as an argv, where `[shell, "-lc", script]` shows as the script | Codex's exec events |
//! | `rawInput.url` for a fetch, `rawInput.query` for a web search | claude-agent-acp |
//! | `rawInput.pattern` and `rawInput.path` for a search | claude-agent-acp (Grep, Glob) |
//! | titles that open with their verb: `Read a.rs`, `Fetch url` | claude-agent-acp |
//! | a thought's `**Heading**` line names the work in progress | codex-acp reasoning summaries |
//! | a command named `$name` is a skill, invoked by mentioning `$name` anywhere in a message
//! rather than as `/name` | codex-acp (Codex's skills) |
//! | a `model_config` option that is a toggle (a boolean, or an On/Off select) names a model
//! setting, such as "Fast mode", shown while it's on | codex-acp, claude-agent-acp |
//!
//! Output of commands agents run themselves is an advertised `_meta` extension, handled in
//! `weave_acp_core` (`terminal_meta`, [`weave_acp_core::extension_terminal_id`]).

use serde_json::Value;
use weave_acp_core::schema::SessionConfigOption;
use weave_acp_core::schema::SessionConfigOptionCategory;

use crate::settings::current_value_name;

/// What a tool call's `rawInput` says, where it follows a known convention.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolInput {
    pub command: Option<String>,
    pub url: Option<String>,
    pub query: Option<String>,
    pub pattern: Option<String>,
    pub path: Option<String>,
}

impl ToolInput {
    pub fn from_raw(raw: Option<&Value>) -> Self {
        let Some(raw) = raw else {
            return Self::default();
        };
        let text = |key: &str| {
            raw.get(key)
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
        };
        let command = match raw.get("command") {
            Some(Value::String(command)) if !command.trim().is_empty() => Some(command.clone()),
            Some(Value::Array(parts)) => {
                let parts: Vec<&str> = parts.iter().filter_map(Value::as_str).collect();
                match parts.as_slice() {
                    [] => None,
                    [shell, flag, script]
                        if shell.ends_with("sh") && flag.starts_with('-') && flag.contains('c') =>
                    {
                        Some((*script).to_owned())
                    }
                    _ => Some(parts.join(" ")),
                }
            }
            _ => None,
        };
        Self {
            command,
            url: text("url"),
            query: text("query"),
            pattern: text("pattern"),
            path: text("path"),
        }
    }
}

/// `title` without a leading verb from `verbs` (ignoring case) and without code backticks.
pub fn title_without_verb(title: &str, verbs: &[&str]) -> String {
    let trimmed = title.trim();
    let rest = verbs
        .iter()
        .find_map(|verb| {
            let head = trimmed.get(..verb.len())?;
            (head.eq_ignore_ascii_case(verb) && trimmed[verb.len()..].starts_with(' '))
                .then(|| trimmed[verb.len()..].trim_start())
        })
        .unwrap_or(trimmed);
    rest.replace('`', "")
}

/// The heading of the latest `**Heading**` line in a thought.
pub fn thought_heading(thought: &str) -> Option<String> {
    thought.lines().rev().find_map(|line| {
        let inner = line.trim().strip_prefix("**")?;
        let end = inner.find("**")?;
        let heading = inner[..end].trim();
        (!heading.is_empty()).then(|| heading.to_owned())
    })
}

/// Whether an advertised command is a skill mentioned as `$name` in a message, as Codex
/// invokes skills, rather than a slash command sent as `/name`.
pub fn is_mention_command(name: &str) -> bool {
    name.starts_with('$')
}

/// Model settings switched on, by short name: "Fast mode" reads "fast".
pub fn model_toggles_on(options: &[SessionConfigOption]) -> Vec<String> {
    options
        .iter()
        .filter(|option| option.category == Some(SessionConfigOptionCategory::ModelConfig))
        .filter(|option| {
            current_value_name(option).is_some_and(|value| value.eq_ignore_ascii_case("on"))
        })
        .map(|option| {
            let name = option.name.trim().to_lowercase();
            name.strip_suffix(" mode")
                .unwrap_or(&name)
                .trim()
                .to_owned()
        })
        .filter(|name| !name.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn commands_come_from_strings_or_argvs() {
        // codex-acp and claude-agent-acp.
        let input = ToolInput::from_raw(Some(&json!({"command": "cargo test", "cwd": "/repo"})));
        assert_eq!(input.command.as_deref(), Some("cargo test"));
        // An argv, with a shell wrapper shown as its script.
        let wrapped = json!({"command": ["/bin/zsh", "-lc", "ls -la"]});
        assert_eq!(
            ToolInput::from_raw(Some(&wrapped)).command.as_deref(),
            Some("ls -la")
        );
        let argv = json!({"command": ["git", "status"]});
        assert_eq!(
            ToolInput::from_raw(Some(&argv)).command.as_deref(),
            Some("git status")
        );
    }

    #[test]
    fn anything_else_is_left_unknown() {
        assert_eq!(ToolInput::from_raw(None), ToolInput::default());
        let odd = json!({"command": 3, "url": "", "query": ["x"]});
        assert_eq!(ToolInput::from_raw(Some(&odd)), ToolInput::default());
        let search = json!({"pattern": "TODO", "path": "src"});
        let input = ToolInput::from_raw(Some(&search));
        assert_eq!(
            (input.pattern.as_deref(), input.path.as_deref()),
            (Some("TODO"), Some("src"))
        );
    }

    #[test]
    fn model_settings_that_are_on_read_by_short_name() {
        use weave_acp_core::schema::SessionConfigSelectOption;

        let fast = |on: bool| {
            SessionConfigOption::boolean("fast-mode", "Fast mode", on)
                .category(SessionConfigOptionCategory::ModelConfig)
        };
        // As codex-acp and claude-agent-acp offer it to clients with booleans.
        assert_eq!(model_toggles_on(&[fast(true)]), ["fast"]);
        assert!(model_toggles_on(&[fast(false)]).is_empty());
        // And as an On/Off select to clients without them.
        let select = SessionConfigOption::select(
            "fast",
            "Fast mode",
            "on",
            vec![
                SessionConfigSelectOption::new("on", "On"),
                SessionConfigSelectOption::new("off", "Off"),
            ],
        )
        .category(SessionConfigOptionCategory::ModelConfig);
        assert_eq!(model_toggles_on(&[select]), ["fast"]);
        // Other categories aren't model settings.
        let verbose = SessionConfigOption::boolean("verbose", "Verbose", true);
        assert!(model_toggles_on(&[verbose]).is_empty());
    }

    #[test]
    fn titles_lose_their_verb_and_thoughts_give_their_heading() {
        assert_eq!(
            title_without_verb("Read src/lib.rs", &["read"]),
            "src/lib.rs"
        );
        assert_eq!(title_without_verb("Find `**/*.rs`", &["find"]), "**/*.rs");
        assert_eq!(title_without_verb("Reader", &["read"]), "Reader");
        assert_eq!(
            thought_heading("**Planning**\nfirst\n**Inspecting the parser**\nmore").as_deref(),
            Some("Inspecting the parser")
        );
        assert_eq!(thought_heading("no heading here"), None);
    }
}
