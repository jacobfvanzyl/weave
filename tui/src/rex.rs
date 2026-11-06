//! A thread's terminals as Rex panes in the TUI's own tab (WVE-167, ADR 0018, ADR 0022), behind
//! detecting Rex: the TUI runs in a Rex pane (`REX_SESSION`, `REX_BLOCK`) and `rex` is on the
//! `PATH`. Each pane runs `weave terminals attach <id>` and is only a place to show the terminal:
//! the TUI's thread panel starts, names and ends terminals, and closing a pane hides its terminal
//! here while it keeps running for every device.
//!
//! The first pane goes to the right of the TUI, and each later one below the last, in a column.
//! Rex doesn't say what a pane runs, so the TUI keeps which pane shows which terminal, for its own
//! pane, in `$XDG_STATE_HOME/weave/rex-panes.json`, and checks it against Rex's blocks: a
//! `/reload` stays in the same pane, so it finds its panes again. Everything here waits on `rex`,
//! so the app calls it off the UI thread.

use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use serde::Deserialize;
use serde::Serialize;

/// How much of the tab the column of terminals takes, beside the TUI.
const COLUMN_PERCENT: u8 = 40;
/// The variables `weave terminals attach` needs from the TUI to find the same Host, which a
/// Rex pane started from the login shell's environment wouldn't have.
const PASSED: [&str; 3] = ["WEAVE_DAEMON_DIR", "XDG_STATE_HOME", "XDG_RUNTIME_DIR"];

/// A terminal's pane, in the order they were placed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pane {
    pub terminal: String,
    pub block: String,
}

/// The Rex pane the TUI runs in, and how to reach Rex.
#[derive(Clone, Debug)]
pub struct Rex {
    session: String,
    block: String,
    rex: PathBuf,
    /// The record of panes, when there's a state directory.
    record: Option<PathBuf>,
    /// What runs in a pane: this weave.
    weave: PathBuf,
}

impl Rex {
    /// The Rex pane this TUI runs in, when it runs in one and `rex` is on the `PATH`.
    pub fn detect() -> Option<Self> {
        let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let session = var("REX_SESSION")?;
        let block = var("REX_BLOCK")?;
        let rex = find_on_path("rex")?;
        let weave = std::env::current_exe().ok()?;
        Some(Self {
            session,
            block,
            rex,
            record: record_location(),
            weave,
        })
    }

    /// The panes this TUI placed that Rex still has, in order.
    pub fn placed(&self) -> Vec<Pane> {
        let recorded = self.recorded();
        let Ok(blocks) = self.blocks() else {
            return recorded;
        };
        let alive: Vec<Pane> = recorded
            .into_iter()
            .filter(|pane| blocks.contains(&pane.block))
            .collect();
        self.save(&alive);
        alive
    }

    /// Show `terminal` in a pane of its own, labelled `label`, below the last of `panes` or to
    /// the right of the TUI; or focus its pane if it has one. The panes after.
    pub fn show(&self, panes: &[Pane], terminal: &str, label: &str) -> Result<Vec<Pane>, String> {
        let mut panes = panes.to_vec();
        if let Some(pane) = panes.iter().find(|pane| pane.terminal == terminal) {
            self.rex(&["focus", "-s", &self.session, &pane.block])?;
            return Ok(panes);
        }
        let (anchor, direction, ratio) = match panes.last() {
            Some(last) => (last.block.as_str(), "below", 50),
            None => (self.block.as_str(), "right", COLUMN_PERCENT),
        };
        let ratio = ratio.to_string();
        let mut args: Vec<String> = [
            "split",
            "-s",
            &self.session,
            "-b",
            anchor,
            "--split",
            direction,
            "--ratio",
            &ratio,
            "--label",
            label,
            "--shell",
            "none",
            "--json",
            "--",
        ]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
        args.extend(self.attach_command(terminal));
        let output = self.rex_owned(&args)?;
        let block = serde_json::from_str::<Split>(&output)
            .ok()
            .and_then(|split| split.block_ids.into_iter().next())
            .ok_or_else(|| format!("rex split said nothing of the pane: {output}"))?;
        panes.push(Pane {
            terminal: terminal.to_owned(),
            block,
        });
        self.save(&panes);
        Ok(panes)
    }

    /// Close `terminal`'s pane, which leaves the terminal running. The panes after.
    pub fn hide(&self, panes: &[Pane], terminal: &str) -> Result<Vec<Pane>, String> {
        let mut panes = panes.to_vec();
        if let Some(index) = panes.iter().position(|pane| pane.terminal == terminal) {
            let pane = panes.remove(index);
            // A pane already gone is hidden as well.
            let _ = self.rex(&["block", "close", "-s", &self.session, &pane.block]);
            self.save(&panes);
        }
        Ok(panes)
    }

    /// Close the TUI's own pane when it's the only one in its tab, which closes the tab: for a
    /// TUI quitting because its thread was closed. Rex ends the TUI with its pane, so this is
    /// the last thing it does.
    pub fn close_if_alone(&self) {
        let Ok(output) = self.rex(&["block", "ls", "-s", &self.session, "--json"]) else {
            return;
        };
        let Ok(listed) = serde_json::from_str::<Blocks>(&output) else {
            return;
        };
        let window = listed
            .blocks
            .iter()
            .find(|block| block.block_id == self.block)
            .and_then(|block| block.window_id.clone());
        let alone = window.is_some()
            && listed
                .blocks
                .iter()
                .filter(|block| block.window_id == window)
                .count()
                == 1;
        if alone {
            let _ = self.rex(&["block", "close", "-s", &self.session, &self.block]);
        }
    }

    /// The command a pane runs: `weave terminals attach <id>`, with what finds the same Host.
    fn attach_command(&self, terminal: &str) -> Vec<String> {
        let passed: Vec<String> = PASSED
            .iter()
            .filter_map(|name| {
                std::env::var(name)
                    .ok()
                    .filter(|value| !value.is_empty())
                    .map(|value| format!("{name}={value}"))
            })
            .collect();
        let mut command = Vec::new();
        if !passed.is_empty() {
            command.push("/usr/bin/env".to_owned());
            command.extend(passed);
        }
        command.push(self.weave.display().to_string());
        command.extend(["terminals", "attach", terminal].map(str::to_owned));
        command
    }

    /// The session's blocks, by id.
    fn blocks(&self) -> Result<Vec<String>, String> {
        let output = self.rex(&["block", "ls", "-s", &self.session, "--json"])?;
        let listed: Blocks = serde_json::from_str(&output).map_err(|error| error.to_string())?;
        Ok(listed
            .blocks
            .into_iter()
            .map(|block| block.block_id)
            .collect())
    }

    fn rex(&self, args: &[&str]) -> Result<String, String> {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        self.rex_owned(&args)
    }

    fn rex_owned(&self, args: &[String]) -> Result<String, String> {
        let output = Command::new(&self.rex)
            .arg("--autostart=false")
            .args(args)
            .output()
            .map_err(|error| format!("running rex: {error}"))?;
        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).into_owned())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(stderr.trim().to_owned())
        }
    }

    /// This pane's key in the record.
    fn key(&self) -> String {
        format!("{}/{}", self.session, self.block)
    }

    fn recorded(&self) -> Vec<Pane> {
        self.record
            .as_deref()
            .map(read_record)
            .and_then(|mut record| record.remove(&self.key()))
            .unwrap_or_default()
    }

    fn save(&self, panes: &[Pane]) {
        let Some(path) = &self.record else { return };
        let mut record = read_record(path);
        if panes.is_empty() {
            record.remove(&self.key());
        } else {
            record.insert(self.key(), panes.to_vec());
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string_pretty(&record) {
            let _ = std::fs::write(path, text);
        }
    }
}

#[derive(Deserialize)]
struct Split {
    #[serde(default)]
    block_ids: Vec<String>,
}

#[derive(Deserialize)]
struct Blocks {
    #[serde(default)]
    blocks: Vec<Block>,
}

#[derive(Deserialize)]
struct Block {
    block_id: String,
    #[serde(default)]
    window_id: Option<String>,
}

/// Each TUI pane's terminal panes, by `<session>/<block>`.
type Record = BTreeMap<String, Vec<Pane>>;

fn read_record(path: &Path) -> Record {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn record_location() -> Option<PathBuf> {
    let state = std::env::var_os("XDG_STATE_HOME")
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|home| !home.is_empty())
                .map(|home| PathBuf::from(home).join(".local/state"))
        })?;
    Some(state.join("weave/rex-panes.json"))
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    /// A `rex` that logs its arguments and answers as Rex would.
    fn fake_rex(dir: &Path, blocks: &[&str]) -> PathBuf {
        let rex = dir.join("rex");
        let listed: Vec<String> = blocks
            .iter()
            .map(|block| format!(r#"{{"block_id": "{block}"}}"#))
            .collect();
        let script = format!(
            "#!/bin/sh\necho \"$@\" >> '{log}'\ncase \"$2 $3\" in\n  \
             'block ls') echo '{{\"blocks\": [{listed}]}}' ;;\n  \
             'split -s') echo '{{\"block_ids\": [\"block:new-'$(wc -l < '{log}' | tr -d ' ')'\"]}}' ;;\n\
             esac\n",
            log = dir.join("log").display(),
            listed = listed.join(", "),
        );
        std::fs::write(&rex, script).expect("rex");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&rex, std::fs::Permissions::from_mode(0o755)).expect("mode");
        }
        rex
    }

    fn rex_in(dir: &Path, blocks: &[&str]) -> Rex {
        Rex {
            session: "session:s".to_owned(),
            block: "block:tui".to_owned(),
            rex: fake_rex(dir, blocks),
            record: Some(dir.join("rex-panes.json")),
            weave: PathBuf::from("/bin/weave"),
        }
    }

    fn log(dir: &Path) -> Vec<String> {
        std::fs::read_to_string(dir.join("log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    #[test]
    fn panes_stack_to_the_right_of_the_tui_and_focus_once_shown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let rex = rex_in(dir.path(), &[]);
        let panes = rex.show(&[], "t-1", "tests").expect("shown");
        let panes = rex.show(&panes, "t-2", "server").expect("shown");
        let again = rex.show(&panes, "t-1", "tests").expect("focused");
        assert_eq!(again, panes);
        let log = log(dir.path());
        assert!(
            log[0].starts_with(
                "--autostart=false split -s session:s -b block:tui --split right --ratio 40 \
                 --label tests --shell none --json --"
            ),
            "{log:?}"
        );
        assert!(
            log[0].ends_with("/bin/weave terminals attach t-1"),
            "{log:?}"
        );
        assert!(
            log[1].contains(&format!("-b {} --split below --ratio 50", panes[0].block)),
            "{log:?}"
        );
        assert_eq!(
            log[2],
            format!("--autostart=false focus -s session:s {}", panes[0].block)
        );
    }

    #[test]
    fn the_record_finds_the_panes_rex_still_has_and_hiding_closes_one() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = rex_in(dir.path(), &[]);
        let panes = first.show(&[], "t-1", "one").expect("shown");
        let panes = first.show(&panes, "t-2", "two").expect("shown");

        // After a reload, Rex still has only the second pane.
        let reloaded = rex_in(dir.path(), &[&panes[1].block]);
        assert_eq!(reloaded.placed(), [panes[1].clone()]);
        let hidden = reloaded.hide(&[panes[1].clone()], "t-2").expect("hidden");
        assert!(hidden.is_empty());
        assert!(
            log(dir.path()).last().is_some_and(
                |line| line.ends_with(&format!("block close -s session:s {}", panes[1].block))
            ),
            "{:?}",
            log(dir.path())
        );
        assert!(reloaded.recorded().is_empty());
    }
}
