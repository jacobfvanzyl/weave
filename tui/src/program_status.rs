//! The thread's status for the terminal, as OSC 7501 reports it ([Program Status], Rex's spec),
//! so a multiplexer's sidebar can show which threads are working and which wait on the person
//! (ADR 0018). Weave keeps one record, the root, with `app=weave`. Reports go only to a
//! terminal that answered the startup probe's query, and only in states and kinds it accepts.
//!
//! [Program Status]: https://www.superlogical.com/rex/docs/build/program-status

use base64::Engine;

use crate::notify::sanitize;

/// The question the startup probe asks. A terminal that takes reports answers it ahead of DA1.
pub const QUERY: &[u8] = b"\x1b]7501;?\x1b\\";

const APP: &str = "weave";
/// `msg`, at most 4 bytes a character, stays well inside the spec's 2048 decoded bytes.
const MAX_MSG_CHARS: usize = 200;
/// `title`'s 192 decoded bytes.
const MAX_TITLE_CHARS: usize = 48;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    /// Open, no turn running.
    Idle,
    Working,
    /// A pending request waits on the person.
    Blocked(Kind),
    /// A turn ended, and the person hasn't been back since.
    Done,
    /// A turn failed, or the thread can't go on.
    Error,
}

/// What a blocked thread waits for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Permission,
    /// A form elicitation.
    Question,
    /// A URL elicitation.
    Auth,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Working => "working",
            Self::Blocked(_) => "blocked",
            Self::Done => "done",
            Self::Error => "error",
        }
    }

    /// The nearest state to report instead, for a terminal that doesn't accept this one.
    fn fallback(self) -> Option<Self> {
        match self {
            Self::Blocked(_) => Some(Self::Working),
            Self::Error => Some(Self::Done),
            Self::Done | Self::Working => Some(Self::Idle),
            Self::Idle => None,
        }
    }
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Self::Permission => "permission",
            Self::Question => "question",
            Self::Auth => "auth",
        }
    }
}

/// What the thread is doing, for its record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub state: State,
    /// What it waits on, what it finished, or why it failed.
    pub msg: Option<String>,
    /// The thread's title.
    pub title: Option<String>,
}

/// The terminal takes reports: the states and kinds it said it accepts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Support {
    states: Vec<String>,
    kinds: Vec<String>,
}

impl Support {
    /// What the terminal answered to [`QUERY`] among `replies`, if it did.
    pub fn from_replies(replies: &[u8]) -> Option<Self> {
        const PREFIX: &[u8] = b"\x1b]7501;?";
        let start = replies
            .windows(PREFIX.len())
            .position(|window| window == PREFIX)?
            + PREFIX.len();
        let rest = &replies[start..];
        let end = rest
            .iter()
            .position(|byte| *byte == 0x07 || *byte == 0x1b)?;
        let payload = std::str::from_utf8(&rest[..end]).ok()?;
        // The last of a repeated key counts.
        let list = |key: &str, default: &[&str]| {
            payload
                .split(':')
                .rev()
                .filter_map(|pair| pair.split_once('='))
                .find(|(name, _)| *name == key)
                .map_or_else(
                    || default.iter().map(|&value| value.to_owned()).collect(),
                    |(_, values)| values.split(',').map(str::to_owned).collect(),
                )
        };
        Some(Self {
            states: list("states", &["idle", "working", "done", "blocked", "error"]),
            kinds: list("kinds", &["permission", "question", "auth"]),
        })
    }

    /// The bytes that report `status`, or clear weave's record with `None`.
    pub fn sequence(&self, status: Option<&Status>) -> String {
        let accepted = |state: State| self.states.iter().any(|name| name == state.name());
        let state = status.and_then(|status| {
            std::iter::successors(Some(status.state), |state| state.fallback())
                .find(|state| accepted(*state))
        });
        let (Some(status), Some(state)) = (status, state) else {
            return "\x1b]7501;state=clear\x1b\\".to_owned();
        };
        let mut pairs = vec![format!("state={}", state.name())];
        if let State::Blocked(kind) = state
            && self.kinds.iter().any(|name| name == kind.name())
        {
            pairs.push(format!("kind={}", kind.name()));
        }
        pairs.push(format!("app={APP}"));
        let text = |key: &str, value: Option<&String>, max: usize| {
            value
                .map(|value| sanitize(value, max))
                .filter(|text| !text.is_empty())
                .map(|text| {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(text);
                    format!("{key}={encoded}")
                })
        };
        pairs.extend(text("title", status.title.as_ref(), MAX_TITLE_CHARS));
        pairs.extend(text("msg", status.msg.as_ref(), MAX_MSG_CHARS));
        format!("\x1b]7501;{}\x1b\\", pairs.join(":"))
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn all() -> Support {
        Support::from_replies(b"\x1b]7501;?\x07\x1b[?62c").expect("supported")
    }

    fn status(state: State, msg: Option<&str>) -> Status {
        Status {
            state,
            msg: msg.map(str::to_owned),
            title: None,
        }
    }

    fn decode(text: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(text)
            .expect("base64");
        String::from_utf8(bytes).expect("utf-8")
    }

    #[test]
    fn a_terminal_takes_reports_only_when_it_answered_the_query() {
        // As Rex answers.
        let rex = Support::from_replies(
            b"\x1b]11;rgb:0000/0000/0000\x1b\\\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\\x1b[?62;22c",
        );
        assert_eq!(rex, Some(all()));
        assert_eq!(Support::from_replies(b"\x1b[?62c"), None);
        assert_eq!(
            Support::from_replies(b"\x1b]7501;?:states=idle,working:kinds=\x1b\\"),
            Some(Support {
                states: vec!["idle".into(), "working".into()],
                kinds: vec![String::new()],
            })
        );
    }

    #[test]
    fn reports_carry_their_text_in_base64_on_one_line() {
        let sequence = all().sequence(Some(&Status {
            state: State::Blocked(Kind::Permission),
            msg: Some("Approval requested:\n$ cargo test\x1b[31m".into()),
            title: Some("Fix the build".into()),
        }));
        let body = sequence
            .strip_prefix("\x1b]7501;")
            .and_then(|rest| rest.strip_suffix("\x1b\\"))
            .expect("an OSC 7501 report");
        let pairs: Vec<(&str, &str)> = body
            .split(':')
            .filter_map(|pair| pair.split_once('='))
            .collect();
        assert_eq!(
            pairs[..3],
            [
                ("state", "blocked"),
                ("kind", "permission"),
                ("app", "weave")
            ]
        );
        assert_eq!(pairs[3].0, "title");
        assert_eq!(decode(pairs[3].1), "Fix the build");
        assert_eq!(pairs[4].0, "msg");
        assert_eq!(decode(pairs[4].1), "Approval requested: $ cargo test[31m");
    }

    #[test]
    fn reports_without_text_and_clearing() {
        assert_eq!(
            all().sequence(Some(&status(State::Working, None))),
            "\x1b]7501;state=working:app=weave\x1b\\"
        );
        assert_eq!(
            all().sequence(Some(&status(State::Idle, Some(" \n ")))),
            "\x1b]7501;state=idle:app=weave\x1b\\"
        );
        assert_eq!(all().sequence(None), "\x1b]7501;state=clear\x1b\\");
    }

    #[test]
    fn text_stays_inside_the_specs_limits() {
        let long = "é".repeat(5000);
        let sequence = all().sequence(Some(&Status {
            state: State::Error,
            msg: Some(long.clone()),
            title: Some(long),
        }));
        assert!(sequence.len() <= 4096, "{}", sequence.len());
        for pair in sequence.trim_end_matches("\x1b\\").split(':') {
            if let Some(("msg" | "title", text)) = pair.split_once('=') {
                let limit = if pair.starts_with("msg") { 2048 } else { 192 };
                assert!(decode(text).len() <= limit);
            }
        }
    }

    #[test]
    fn states_and_kinds_the_terminal_doesnt_accept_fall_back() {
        let some = Support {
            states: vec!["idle".into(), "working".into(), "done".into()],
            kinds: vec!["question".into()],
        };
        let report = |state| some.sequence(Some(&status(state, None)));
        assert_eq!(
            report(State::Blocked(Kind::Permission)),
            "\x1b]7501;state=working:app=weave\x1b\\"
        );
        assert_eq!(report(State::Error), "\x1b]7501;state=done:app=weave\x1b\\");
        let blocked = Support {
            states: vec!["blocked".into()],
            kinds: vec!["question".into()],
        };
        assert_eq!(
            blocked.sequence(Some(&status(State::Blocked(Kind::Auth), None))),
            "\x1b]7501;state=blocked:app=weave\x1b\\"
        );
        // Nothing it accepts: the record goes.
        assert_eq!(
            blocked.sequence(Some(&status(State::Idle, None))),
            "\x1b]7501;state=clear\x1b\\"
        );
    }
}
