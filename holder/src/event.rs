//! The events a holder sends its clients, under the names and with the payloads Rex documents for
//! a terminal's events (`terminal.*` in <https://www.superlogical.com/rex/docs/reference/events>),
//! so a Rex block can later stand in for a holder (ADR 0022). weave's additions come last.

use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum Event {
    /// The terminal's program exited; `error` is set when it failed.
    ChildExited {
        exit_code: i32,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    /// The program reported a working directory (OSC 7): a URL, as the program sent it.
    PwdChanged {
        pwd: String,
        owner: Option<String>,
    },
    TitleChanged {
        title: String,
        owner: Option<String>,
    },
    Bell {},
    ProcessChanged {
        generation: u64,
        foreground: Process,
        ancestors: Vec<Process>,
    },
    /// OSC 9 or OSC 777.
    DesktopNotification {
        title: String,
        body: String,
    },
    /// OSC 9;4.
    ProgressReport {
        state: ProgressState,
        progress: Option<u8>,
    },
    /// OSC 52: the program wrote to the clipboard. Reads are refused (ADR 0022).
    ClipboardWritten {
        text: String,
    },
    /// OSC 7501.
    ProgramStatusChanged {
        id: String,
        record: ProgramStatus,
        reason: Reason,
    },
    ProgramStatusRemoved {
        ids: Vec<String>,
        reason: Reason,
    },

    /// weave's: a command started or ended (OSC 133).
    CommandChanged(Command),
    /// weave's: the terminal took a new size.
    SizeChanged(Size),
    /// weave's: the terminal's label changed.
    LabelChanged {
        label: Option<String>,
    },
    /// weave's: the client fell behind, so a fresh restore follows and replaces its screen: a
    /// snapshot, or for a client attached with `restore: "vt"` the formatter's VT.
    Resync {
        codec: String,
        restore: String,
        snapshot_bytes: usize,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Process {
    pub pid: i32,
    pub name: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgressState {
    Remove,
    Set,
    Error,
    Indeterminate,
    Pause,
}

/// An OSC 7501 record, as the program reported it, with `title` and `msg` decoded.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProgramStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub state: ProgramState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<BlockedKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProgramState {
    Idle,
    Working,
    Done,
    Blocked,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedKind {
    Permission,
    Question,
    Auth,
}

/// Why OSC 7501 records changed or went.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// The program reported it.
    Report,
    /// The program cleared it (`state=clear`).
    Clear,
    /// A new prompt began (OSC 133 `A`), which ends `working` and `blocked` records.
    Prompt,
    /// The program exited, which ends `working` and `blocked` records.
    Exit,
    /// The terminal was fully reset (RIS).
    Reset,
}

/// Whether a command runs, by OSC 133: its command line while it runs, its exit code after.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Command {
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn events_carry_rexs_names_and_payloads() {
        let json = |event: Event| serde_json::to_value(event).unwrap();
        assert_eq!(json(Event::Bell {}), json!({"type": "bell", "payload": {}}));
        assert_eq!(
            json(Event::PwdChanged {
                pwd: "file://mac/src".into(),
                owner: None
            }),
            json!({"type": "pwd_changed", "payload": {"pwd": "file://mac/src", "owner": null}})
        );
        assert_eq!(
            json(Event::ChildExited {
                exit_code: 0,
                error: None
            }),
            json!({"type": "child_exited", "payload": {"exit_code": 0}})
        );
        assert_eq!(
            json(Event::CommandChanged(Command {
                running: false,
                command: None,
                exit_code: Some(1)
            })),
            json!({"type": "command_changed", "payload": {"running": false, "exit_code": 1}})
        );
    }
}
