//! The npm registry, asked over HTTP which version of a package is `latest`, for `weave
//! update`; launching still goes through `npx`. `npm_config_registry` names another registry,
//! as npm itself reads it.

use anyhow::Context;
use serde::Deserialize;

const DEFAULT_REGISTRY: &str = "https://registry.npmjs.org";

/// The version `package`'s `latest` tag names.
pub async fn latest(package: &str) -> anyhow::Result<String> {
    let url = latest_url(&registry(), package);
    let bytes = crate::registry::fetch(&url)
        .await
        .with_context(|| format!("asking npm for the latest {package}"))?;
    parse_latest(&bytes).with_context(|| format!("reading npm's answer for {package}"))
}

fn registry() -> String {
    ["npm_config_registry", "NPM_CONFIG_REGISTRY"]
        .into_iter()
        .find_map(|name| std::env::var(name).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| DEFAULT_REGISTRY.to_owned())
}

/// A scoped package's `/` is escaped, as the registry wants it.
fn latest_url(registry: &str, package: &str) -> String {
    format!(
        "{}/{}/latest",
        registry.trim_end_matches('/'),
        package.replace('/', "%2F")
    )
}

fn parse_latest(bytes: &[u8]) -> anyhow::Result<String> {
    #[derive(Deserialize)]
    struct Manifest {
        version: String,
    }
    Ok(serde_json::from_slice::<Manifest>(bytes)?.version)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn scoped_packages_are_escaped_and_the_version_read() {
        assert_eq!(
            latest_url(
                "https://registry.npmjs.org/",
                "@agentclientprotocol/claude-agent-acp"
            ),
            "https://registry.npmjs.org/@agentclientprotocol%2Fclaude-agent-acp/latest"
        );
        let manifest = br#"{"name":"@google/gemini-cli","version":"0.70.1","bin":{}}"#;
        assert_eq!(parse_latest(manifest).expect("a version"), "0.70.1");
        assert!(parse_latest(b"{}").is_err());
    }
}
