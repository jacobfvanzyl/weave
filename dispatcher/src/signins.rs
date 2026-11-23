//! What the Dispatcher knows of each agent's sign-in (ADR 0036, WVE-239): the file the agent's
//! own program writes when the person signs in to it, and the copy of it a Host is given, which
//! can't be renewed. This is the one place that knows a vendor's file; a Host is told only how
//! to use what it's given.
//!
//! - **`claude`**: Claude Code's `.credentials.json`. A Host gets the access token alone, for
//!   the agent's environment as `CLAUDE_CODE_OAUTH_TOKEN`, which Claude Code runs on with no
//!   file at all.
//! - **`codex`**: Codex's `auth.json`. A Host gets the file with a placeholder where the
//!   renewal token was, at `.codex/auth.json` under the home: Codex won't read a sign-in
//!   without the field, and has no variable that takes a ChatGPT access token.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use weave_host_protocol::Timestamp;
use weave_host_protocol::credentials::CredentialUse;
use weave_host_protocol::credentials::HeldCredential;

/// What stands where a renewal token was, in a copy.
const NOT_RENEWABLE: &str = "weave-copy-cannot-renew";

/// The agents the Dispatcher can give a sign-in to, by id.
pub(crate) const AGENTS: [&str; 2] = ["claude", "codex"];

/// The copy of `agent`'s sign-in file `value` that a Host holds as `name`, or why `value`
/// isn't that agent's sign-in.
pub(crate) fn copy(name: &str, agent: &str, value: &str) -> Result<HeldCredential, String> {
    let file: Value =
        serde_json::from_str(value).map_err(|_| format!("{agent}'s sign-in is a JSON file"))?;
    match agent {
        "claude" => {
            let signed_in = &file["claudeAiOauth"];
            let token = signed_in["accessToken"]
                .as_str()
                .filter(|token| !token.is_empty())
                .ok_or("this isn't Claude Code's .credentials.json: it has no access token")?;
            Ok(HeldCredential {
                name: name.to_owned(),
                used: CredentialUse::Environment {
                    agent: agent.to_owned(),
                    variable: "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
                },
                value: token.to_owned(),
                expires_at: signed_in["expiresAt"].as_u64(),
            })
        }
        "codex" => {
            let token = file["tokens"]["access_token"]
                .as_str()
                .filter(|token| !token.is_empty())
                .ok_or("this isn't Codex's auth.json: it has no access token")?;
            let expires_at = expiry(token);
            let mut copy = file.clone();
            copy["tokens"]["refresh_token"] = Value::String(NOT_RENEWABLE.to_owned());
            Ok(HeldCredential {
                name: name.to_owned(),
                used: CredentialUse::File {
                    path: ".codex/auth.json".to_owned(),
                },
                value: copy.to_string(),
                expires_at,
            })
        }
        other => Err(format!(
            "the Dispatcher can't give {other} a sign-in; it can {}",
            AGENTS.join(" and ")
        )),
    }
}

/// When a JWT expires, from its claims, which aren't checked: only its issuer can.
fn expiry(jwt: &str) -> Option<Timestamp> {
    let claims = jwt.split('.').nth(1)?;
    let claims = URL_SAFE_NO_PAD.decode(claims.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&claims).ok()?;
    claims["exp"].as_u64()?.checked_mul(1000)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    fn jwt(claims: &Value) -> String {
        let part = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());
        format!(
            "{}.{}.signature",
            part(&json!({"alg": "none"})),
            part(claims)
        )
    }

    #[test]
    fn a_host_gets_claudes_access_token_alone() {
        let file = json!({"claudeAiOauth": {
            "accessToken": "access", "refreshToken": "renewal", "expiresAt": 1_795_400_000_000u64,
            "scopes": ["user:inference"],
        }});
        let copy = copy("claude", "claude", &file.to_string()).expect("a copy");
        assert_eq!(
            copy.used,
            CredentialUse::Environment {
                agent: "claude".to_owned(),
                variable: "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
            }
        );
        assert_eq!(copy.value, "access");
        assert_eq!(copy.expires_at, Some(1_795_400_000_000));
    }

    #[test]
    fn a_host_gets_codexs_file_without_its_renewal_token() {
        let access = jwt(&json!({"exp": 1_795_400_000u64}));
        let file = json!({"auth_mode": "chatgpt", "tokens": {
            "id_token": "id", "access_token": access, "refresh_token": "renewal",
            "account_id": "account",
        }, "last_refresh": "2026-11-14T17:08:11Z"});
        let copy = copy("codex", "codex", &file.to_string()).expect("a copy");
        assert_eq!(
            copy.used,
            CredentialUse::File {
                path: ".codex/auth.json".to_owned(),
            }
        );
        assert!(!copy.value.contains("renewal"), "{}", copy.value);
        let written: Value = serde_json::from_str(&copy.value).expect("JSON");
        assert_eq!(written["tokens"]["refresh_token"], NOT_RENEWABLE);
        assert_eq!(written["tokens"]["access_token"], access);
        assert_eq!(written["tokens"]["account_id"], "account");
        assert_eq!(copy.expires_at, Some(1_795_400_000_000));
    }

    #[test]
    fn what_isnt_an_agents_sign_in_is_refused() {
        assert!(copy("x", "claude", "not json").is_err());
        assert!(copy("x", "claude", "{\"tokens\":{}}").is_err());
        assert!(copy("x", "codex", "{\"claudeAiOauth\":{}}").is_err());
        let refused = copy("x", "gemini", "{}").expect_err("an agent it doesn't know");
        assert!(refused.contains("claude and codex"), "{refused}");
    }
}
