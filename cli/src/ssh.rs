//! Reaching another of the person's computers to have its Host join the Dispatcher, or to pair
//! with the Dispatcher there: over SSH, where `weave hosts add studio` runs `weave hosts add
//! <url> <code> --json` (and `weave dispatcher connect homelab` runs `weave pair --json`), or
//! with the URL and code shown elsewhere.

use std::process::Command;
use std::process::Stdio;

use anyhow::Context as _;
use anyhow::bail;

/// What runs `ssh`, for tests to stand in for it.
const SSH_VARIABLE: &str = "WEAVE_SSH";

/// How `weave hosts add` reaches a Host, or `weave dispatcher connect` the Dispatcher.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reach {
    /// The URL and code `weave pair` showed there.
    Code { url: String, code: String },
    /// The computer, as `ssh` reaches it.
    Ssh(String),
}

/// What pairs with a program on another computer: the link its QR code holds, and the command
/// that shows it.
pub(crate) struct Pairing {
    link: &'static str,
    command: &'static str,
}

/// Pairing with the Dispatcher, as `weave pair` offers it.
pub(crate) const DISPATCHER: Pairing = Pairing {
    link: "weave://pair-dispatcher?",
    command: "weave pair",
};

/// A Host joining the Dispatcher with the URL and code `weave hosts add --code` shows (ADR 0030),
/// or a `weave://join-dispatcher?url=…&code=…` link to them.
pub(crate) const JOIN: Pairing = Pairing {
    link: "weave://join-dispatcher?",
    command: "weave hosts add --code",
};

/// How `host` and `code` reach what `pairing` pairs with.
pub(crate) fn reach_for(
    pairing: &Pairing,
    host: &str,
    code: Option<String>,
) -> anyhow::Result<Reach> {
    let command = pairing.command;
    if let Some(query) = host.strip_prefix(pairing.link) {
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
            bail!("give the code `{command}` shows there, after the URL");
        };
        return Ok(Reach::Code {
            url: host.to_owned(),
            code,
        });
    }
    if code.is_some() {
        bail!(
            "a code goes with the URL `{command}` shows there; over SSH, give the computer alone"
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
            "a command over SSH on {destination} doesn't find weave: {said}. The shell runs it \
             without its interactive startup files, so put weave on PATH where it looks: for \
             zsh, `export PATH=\"$HOME/.local/bin:$PATH\"` in ~/.zshenv there"
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
    fn a_host_joins_by_url_and_code_or_over_ssh() {
        let code = |url: &str, code: &str| Reach::Code {
            url: url.to_owned(),
            code: code.to_owned(),
        };
        let join =
            |host: &str, given: Option<&str>| reach_for(&JOIN, host, given.map(str::to_owned));
        assert_eq!(
            join(
                "weave://join-dispatcher?url=wss%3A%2F%2Fhomelab.example.ts.net%3A7342&code=ABC",
                None
            )
            .expect("a link"),
            code("wss://homelab.example.ts.net:7342", "ABC")
        );
        assert_eq!(
            join("wss://homelab.example.ts.net:7342", Some("ABC")).expect("as given"),
            code("wss://homelab.example.ts.net:7342", "ABC")
        );
        assert!(join("wss://homelab.example.ts.net:7342", None).is_err());
        assert_eq!(
            join("me@studio", None).expect("SSH"),
            Reach::Ssh("me@studio".to_owned())
        );
        assert!(join("studio", Some("ABC")).is_err());
        assert_eq!(
            reach_for(
                &DISPATCHER,
                "weave://pair-dispatcher?url=wss%3A%2F%2Fhomelab.example.ts.net%3A7342&code=ABC",
                None
            )
            .expect("a link"),
            code("wss://homelab.example.ts.net:7342", "ABC")
        );
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
