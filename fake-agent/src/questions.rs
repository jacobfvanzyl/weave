//! The questions agents ask through forms, in the shapes their ACP adapters give them, each
//! with its free-text companion, for the `questions` script and clients' tests.

use agent_client_protocol::schema::v1::ElicitationSchema;

/// One form an adapter asks with.
pub struct QuestionForm {
    /// What `questions <name>` asks for.
    pub name: &'static str,
    pub adapter: &'static str,
    pub message: &'static str,
    pub schema: ElicitationSchema,
}

/// claude-agent-acp 0.97.0's `AskUserQuestion`, a single-select and a multi-select with an
/// "Other" each (`question_<n>_custom`: the answer in place of a pick, or one more of the
/// multi-select's), then codex-acp 2.3.0's `request_user_input` (a required single-select with
/// "None of the above", and a note sent with the pick, marked in `_meta.codex`).
pub fn question_forms() -> Vec<QuestionForm> {
    [
        (
            "claude",
            "Claude",
            "Please answer the following questions.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "question_0": {
                        "type": "string",
                        "title": "Database",
                        "description": "Which database should the service use?",
                        "oneOf": [
                            {
                                "const": "Postgres",
                                "title": "Postgres",
                                "description": "Relational, with the tooling the team has"
                            },
                            { "const": "SQLite", "title": "SQLite", "description": "One file, no server" }
                        ]
                    },
                    "question_0_custom": {
                        "type": "string",
                        "title": "Other",
                        "description": "Type your own answer, or add a note to the option you chose above (optional)."
                    },
                    "question_1": {
                        "type": "array",
                        "title": "Checks",
                        "description": "Which checks should run before each commit?",
                        "items": {
                            "anyOf": [
                                { "const": "Tests", "title": "Tests" },
                                { "const": "Lint", "title": "Lint", "description": "cargo clippy" },
                                { "const": "Format", "title": "Format" }
                            ]
                        }
                    },
                    "question_1_custom": {
                        "type": "string",
                        "title": "Other",
                        "description": "Type your own answer to add to your selection above (optional)."
                    }
                }
            }),
        ),
        (
            "codex",
            "Codex",
            "Codex needs your input to continue.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "deploy_target": {
                        "type": "string",
                        "title": "Where should this deploy?",
                        "description": "Deploy",
                        "_meta": { "codex": { "isOther": true } },
                        "oneOf": [
                            {
                                "const": "Staging",
                                "title": "Staging",
                                "description": "The shared staging cluster"
                            },
                            { "const": "Production", "title": "Production" },
                            {
                                "const": "None of the above",
                                "title": "None of the above",
                                "description": "Provide a different answer in the note field."
                            }
                        ]
                    },
                    "deploy_target_note": {
                        "type": "string",
                        "title": "Additional answer or note",
                        "_meta": { "codex": { "questionId": "deploy_target", "role": "user_note" } }
                    }
                },
                "required": ["deploy_target"]
            }),
        ),
    ]
    .into_iter()
    .filter_map(|(name, adapter, message, schema)| {
        // Each is written to parse; a test checks that both do.
        let schema = serde_json::from_value(schema).ok()?;
        Some(QuestionForm {
            name,
            adapter,
            message,
            schema,
        })
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::ElicitationPropertySchema;

    use super::*;

    #[test]
    fn both_forms_parse_with_their_companions_meta() {
        let forms = question_forms();
        let names: Vec<&str> = forms.iter().map(|form| form.name).collect();
        assert_eq!(names, ["claude", "codex"]);
        let Some(ElicitationPropertySchema::String(note)) =
            forms[1].schema.properties.get("deploy_target_note")
        else {
            panic!("a string note");
        };
        let role = note
            .meta
            .as_ref()
            .and_then(|meta| meta.get("codex"))
            .and_then(|codex| codex.get("role"));
        assert_eq!(role, Some(&serde_json::json!("user_note")));
        assert!(matches!(
            forms[0].schema.properties.get("question_1"),
            Some(ElicitationPropertySchema::Array(_))
        ));
    }
}
