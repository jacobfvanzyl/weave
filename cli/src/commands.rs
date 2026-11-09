//! The `weave` subcommands, one module for each thing the person manages. Each has its
//! `command` and `LOG`, the diagnostics it logs to stderr by default (`RUST_LOG` overrides it).
//! What more than one of them uses lives beside this module, in the crate's root.

pub mod agents;
pub mod daemon;
pub mod devices;
pub mod dispatcher;
pub mod hosts;
pub mod projects;
pub mod run;
pub mod schedules;
pub mod terminals;
pub mod threads;
pub mod worktrees;

/// SIGTERM or SIGINT. A closing terminal's SIGHUP is ignored.
pub(crate) async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::SignalKind;
        use tokio::signal::unix::signal;
        let (Ok(mut terminate), Ok(mut interrupt), Ok(_hangup)) = (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
            signal(SignalKind::hangup()),
        ) else {
            return std::future::pending().await;
        };
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
