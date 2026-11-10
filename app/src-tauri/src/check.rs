//! The terminal check's side of the core (WVE-205, `scripts/mac-terminal-check.ts`): started
//! with `WEAVE_TERMINAL_CHECK=<directory>` and `WEAVE_TERMINAL_CHECK_TERMINAL=<id>`, the app
//! opens on that one terminal of this Mac's Host, over the whole window, instead of the person's
//! Sessions, and the page and the script that started it talk through files in the directory:
//! the script leaves the page a `request`, and the page reports what it measured and drew.
//! Without those variables, which nothing sets but the script, none of this does anything.

use std::path::PathBuf;

use serde::Deserialize;

/// A run of the check: where its files go, and the terminal it draws.
#[derive(Clone, Debug)]
pub struct Check {
    directory: PathBuf,
    pub terminal: String,
}

/// What the page reports: text, or a picture of its canvas as a `data:` URL's base64.
#[derive(Debug, Deserialize)]
pub struct Report {
    name: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    png: Option<String>,
}

impl Check {
    /// The check the environment asks for, if it does.
    pub fn from_env() -> Option<Self> {
        let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty());
        let terminal = var("WEAVE_TERMINAL_CHECK_TERMINAL")?.into_string().ok()?;
        let safe = terminal
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character));
        Some(Self {
            directory: PathBuf::from(var("WEAVE_TERMINAL_CHECK")?),
            terminal,
        })
        .filter(|_| safe)
    }

    /// What the script asked of the page since it last looked, if anything.
    pub fn poll(&self) -> Option<String> {
        let path = self.directory.join("request");
        let request = std::fs::read_to_string(&path).ok()?;
        std::fs::remove_file(&path).ok()?;
        Some(request.trim().to_owned())
    }

    /// Keeps a report beside the others, by its name.
    pub fn report(&self, report: &Report) -> Result<(), String> {
        let named = !report.name.is_empty()
            && report
                .name
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character));
        if !named {
            return Err("a report's name is letters, digits, - and _".to_owned());
        }
        let write = |extension: &str, bytes: &[u8]| {
            // Whole or not at all: the script reads a report as soon as it's there.
            let path = self.directory.join(format!("{}.{extension}", report.name));
            let partial = path.with_extension(format!("{extension}.partial"));
            std::fs::write(&partial, bytes)
                .and_then(|()| std::fs::rename(&partial, &path))
                .map_err(|error| format!("{}: {error}", path.display()))
        };
        if let Some(png) = &report.png {
            write("png", &base64(png).ok_or("the picture isn't base64")?)?;
        }
        if let Some(text) = &report.text {
            write("json", text.as_bytes())?;
        }
        Ok(())
    }
}

/// Standard base64, as a `data:` URL has it.
fn base64(text: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(text.len() / 4 * 3);
    let (mut bits, mut held) = (0_u32, 0_u32);
    for character in text.bytes().filter(|byte| *byte != b'=') {
        let value = match character {
            b'A'..=b'Z' => character - b'A',
            b'a'..=b'z' => character - b'a' + 26,
            b'0'..=b'9' => character - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        held = held << 6 | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(u8::try_from(held >> bits & 0xff).ok()?);
        }
    }
    Some(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn a_report_is_kept_by_its_name_and_a_request_is_read_once() {
        let directory = tempfile::tempdir().expect("a directory");
        let check = Check {
            directory: directory.path().to_owned(),
            terminal: "t-1".to_owned(),
        };
        assert_eq!(check.poll(), None);
        std::fs::write(directory.path().join("request"), "shot shell\n").expect("written");
        assert_eq!(check.poll(), Some("shot shell".to_owned()));
        assert_eq!(check.poll(), None);

        let report = |name: &str| Report {
            name: name.to_owned(),
            text: Some("{}".to_owned()),
            png: Some("aGVsbG8=".to_owned()),
        };
        check.report(&report("shell")).expect("kept");
        assert_eq!(
            std::fs::read(directory.path().join("shell.png")).expect("a picture"),
            b"hello"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("shell.json")).expect("text"),
            "{}"
        );
        assert!(check.report(&report("../elsewhere")).is_err());
        assert!(check.report(&report("")).is_err());
    }
}
