//! The status `weave` exits with, which tells a script how a command went without reading what
//! it printed: whether it worked, couldn't reach the weave Host, or ran a turn that failed, was
//! cancelled or stopped short, or that it stopped waiting for a turn that waits on a person or
//! took too long (WVE-108). An error that isn't any of those exits with 1, and arguments clap
//! refuses with 2.
//!
//! How the turn went is in the status on purpose, unlike the A2A CLI's convention of keeping a
//! task's outcome out of it (`docs/research/a2a-and-agents-controlling-threads.md`): scripts and
//! agents composing threads branch on it, and 3 alone says the Host wasn't reached.

use std::error::Error;
use std::fmt;
use std::process::ExitCode;

use weave_acp_core::schema::StopReason;
use weave_host_protocol::sessions::TurnState;

/// What `weave`'s exit status says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// It worked, or the turn ended as the agent meant it to (`end_turn`).
    Success = 0,
    /// Any other error.
    Error = 1,
    /// The weave Host couldn't be reached: it isn't running, for a command that never starts
    /// one; it didn't start; or it went away while the command needed it.
    Unreachable = 3,
    /// The turn failed, or its thread closed under it.
    TurnFailed = 4,
    /// The turn was cancelled.
    Cancelled = 5,
    /// The turn stopped short otherwise: the agent's token limit, a refusal, too many model
    /// requests.
    Stopped = 6,
    /// The turn waits on a person, to answer a permission request or a question; it goes on
    /// once someone does.
    Waiting = 7,
    /// It stopped waiting for the turn at `--timeout`; the turn goes on.
    TimedOut = 8,
}

impl Status {
    /// How a turn that ended with `reason` went.
    pub fn of_stop(reason: StopReason) -> Self {
        match reason {
            StopReason::EndTurn => Self::Success,
            StopReason::Cancelled => Self::Cancelled,
            _ => Self::Stopped,
        }
    }

    /// How a turn that's over, in `state`, went.
    pub fn of_state(state: TurnState) -> Self {
        match state {
            TurnState::Ended | TurnState::Queued | TurnState::Running => Self::Success,
            TurnState::Waiting => Self::Waiting,
            TurnState::Stopped => Self::Stopped,
            TurnState::Cancelled => Self::Cancelled,
            TurnState::Failed => Self::TurnFailed,
        }
    }

    /// The status `error` exits with: the one it failed with, anywhere in its chain, else 1.
    pub fn of_error(error: &anyhow::Error) -> Self {
        error
            .chain()
            .find_map(|cause| cause.downcast_ref::<Failed>())
            .map_or(Self::Error, |failed| failed.status)
    }
}

impl From<Status> for ExitCode {
    fn from(status: Status) -> Self {
        Self::from(status as u8)
    }
}

/// `error`, exiting with `status` rather than 1. It reads as `error` does.
pub fn fail(status: Status, error: impl Into<anyhow::Error>) -> anyhow::Error {
    anyhow::Error::new(Failed {
        status,
        error: error.into(),
    })
}

/// `error`, exiting with [`Status::Unreachable`].
pub fn unreachable(error: impl Into<anyhow::Error>) -> anyhow::Error {
    fail(Status::Unreachable, error)
}

/// An error and the status it exits with. Its message and causes are the error's own.
#[derive(Debug)]
struct Failed {
    status: Status,
    error: anyhow::Error,
}

impl fmt::Display for Failed {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.error, f)
    }
}

impl Error for Failed {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.error.source()
    }
}

#[cfg(test)]
mod tests {
    use anyhow::Context;
    use anyhow::anyhow;
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn an_error_exits_with_the_status_it_failed_with_under_any_context() {
        assert_eq!(Status::of_error(&anyhow!("no")), Status::Error);
        let lost = Err::<(), _>(unreachable(anyhow!("lost the weave Host")))
            .context("reading the thread")
            .unwrap_err();
        assert_eq!(Status::of_error(&lost), Status::Unreachable);
        assert_eq!(
            format!("{lost:#}"),
            "reading the thread: lost the weave Host"
        );
    }

    #[test]
    fn a_failed_error_keeps_its_causes() {
        let error = Err::<(), _>(anyhow!("refused"))
            .context("connecting")
            .unwrap_err();
        let failed = fail(Status::TurnFailed, error);
        assert_eq!(format!("{failed:#}"), "connecting: refused");
        assert_eq!(Status::of_error(&failed), Status::TurnFailed);
    }

    #[test]
    fn a_turn_thats_over_exits_with_how_it_went() {
        assert_eq!(Status::of_state(TurnState::Ended), Status::Success);
        assert_eq!(Status::of_state(TurnState::Stopped), Status::Stopped);
        assert_eq!(Status::of_state(TurnState::Cancelled), Status::Cancelled);
        assert_eq!(Status::of_state(TurnState::Failed), Status::TurnFailed);
    }

    #[test]
    fn a_turn_exits_with_how_it_stopped() {
        assert_eq!(Status::of_stop(StopReason::EndTurn), Status::Success);
        assert_eq!(Status::of_stop(StopReason::Cancelled), Status::Cancelled);
        assert_eq!(Status::of_stop(StopReason::MaxTokens), Status::Stopped);
        assert_eq!(Status::of_stop(StopReason::Refusal), Status::Stopped);
        assert_eq!(
            Status::of_stop(StopReason::MaxTurnRequests),
            Status::Stopped
        );
    }
}
