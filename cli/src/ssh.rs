//! Reaching another of the person's computers to pair with its Host: over SSH, where `weave
//! dispatcher add-host studio` runs `weave pair --json` for a code, or with the URL and code
//! `weave pair` showed there.

use std::process::Command;
use std::process::Stdio;

use anyhow::Context as _;
use anyhow::bail;

/// What runs `ssh`, for tests to stand in for it.
const SSH_VARIABLE: &str = "WEAVE_SSH";

/// How `weave dispatcher add-host` reaches a Host.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reach {
    /// The URL and code `weave pair` showed there.
    Code { url: String, code: String },
    /// The computer, as `ssh` reaches it.
    Ssh(String),
}

/// How `host` and `code` reach a Host: a URL or `weave://pair` link with its code, or
/// otherwise a computer SSH reaches.
pub(crate) fn reach(host: &str, code: Option<String>) -> anyhow::Result<Reach> {
    if let Some(query) = host.strip_prefix("weave://pair?") {
        let field = |name: &str| {
            query
                .split('&')
                .find_map(|pair| pair.strip_prefix(name)?.strip_prefix('='))
                .map(percent_decode)
        };
        let (Some(url), Some(linked)) = (field("url"), field("code")) else {
            bail!("the link names no URL and code");
        };
        return Ok(Reach::Code {
            url,
            code: code.unwrap_or(linked),
        });
    }
    if host.contains("://") {
        let Some(code) = code else {
            bail!("give the code `weave pair` shows there, after the URL");
        };
        return Ok(Reach::Code {
            url: host.to_owned(),
            code,
        });
    }
    if code.is_some() {
        bail!(
            "a code goes with the URL `weave pair` shows there; over SSH, give the computer alone"
        );
    }
    Ok(Reach::Ssh(host.to_owned()))
}

/// What to call a Host SSH reaches at `destination`: its computer, without the user or port.
pub(crate) fn ssh_name(destination: &str) -> String {
    let host = destination
        .rsplit_once('@')
        .map_or(destination, |(_, host)| host);
    host.split(':').next().unwrap_or(host).to_owned()
}

/// Run `weave args…` on `destination` over SSH, without prompting: what it printed.
pub(crate) fn ssh(destination: &str, args: &[&str]) -> anyhow::Result<String> {
    let program = std::env::var(SSH_VARIABLE).unwrap_or_else(|_| "ssh".to_owned());
    let remote: Vec<String> = std::iter::once("weave")
        .chain(args.iter().copied())
        .map(shell_quote)
        .collect();
    let output = Command::new(&program)
        .args(["-o", "BatchMode=yes", destination])
        .arg(remote.join(" "))
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("running {program}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let said = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    match output.status.code() {
        Some(127) => bail!(
            "a command over SSH on {destination} doesn't find weave: {said}. `weave daemon \
             install` there says how to have it"
        ),
        Some(255) => bail!("couldn't reach {destination} over SSH: {said}"),
        _ => bail!("`weave {}` failed on {destination}: {said}", args.join(" ")),
    }
}

/// `text` as one word for a POSIX shell.
fn shell_quote(text: &str) -> String {
    let plain = !text.is_empty()
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_./:=@%+,".contains(&byte));
    if plain {
        text.to_owned()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = bytes
            .get(at + 1..at + 3)
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[at], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                at += 3;
            }
            (byte, _) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn a_host_is_reached_by_url_and_code_or_over_ssh() {
        let code = |url: &str, code: &str| Reach::Code {
            url: url.to_owned(),
            code: code.to_owned(),
        };
        assert_eq!(
            reach(
                "weave://pair?url=wss%3A%2F%2Fstudio.example.ts.net%3A7341&code=ABC",
                None
            )
            .expect("a link"),
            code("wss://studio.example.ts.net:7341", "ABC")
        );
        assert_eq!(
            reach("wss://studio.example.ts.net:7341", Some("ABC".to_owned())).expect("as given"),
            code("wss://studio.example.ts.net:7341", "ABC")
        );
        assert!(reach("wss://studio.example.ts.net:7341", None).is_err());
        assert_eq!(
            reach("me@studio", None).expect("SSH"),
            Reach::Ssh("me@studio".to_owned())
        );
        assert!(reach("studio", Some("ABC".to_owned())).is_err());
    }

    #[test]
    fn a_host_over_ssh_is_named_by_its_computer() {
        assert_eq!(ssh_name("studio"), "studio");
        assert_eq!(ssh_name("me@studio.local"), "studio.local");
        assert_eq!(ssh_name("me@studio:2222"), "studio");
    }

    #[test]
    fn words_for_the_remote_shell_are_quoted_when_they_need_it() {
        assert_eq!(shell_quote("ws://127.0.0.1:7341"), "ws://127.0.0.1:7341");
        assert_eq!(shell_quote("Jaco's Mac"), r"'Jaco'\''s Mac'");
        assert_eq!(shell_quote(""), "''");
    }
}
