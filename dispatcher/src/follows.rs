//! Following the turns calls from other Hosts began (ADR 0029, WVE-185): on the named Host's
//! link, through the `sessions/watch` it keeps anyway. When a followed thread goes idle, or
//! the link connects, the Dispatcher reads the turn with `sessions/get`, following one the Host
//! stopped under into its continuation (WVE-168), or waiting for that in a headless thread,
//! and once it's over reports how it ended to
//! the calling thread, as the calling Host reports on its own threads (ADR 0023). When one
//! waits on a person, it reads what's asked by observing the thread for a moment, and reports
//! each request once. Reports are deliveries to the calling Host, so they land however long it
//! is away.

use agent_client_protocol::schema::v1::SessionId;
use weave_host_client::HostHandle;
use weave_host_protocol::errors;
use weave_host_protocol::reports::Asks;
use weave_host_protocol::reports::Named;
use weave_host_protocol::reports::ended_text;
use weave_host_protocol::reports::waiting_text;
use weave_host_protocol::sessions::AttachSessionRequest;
use weave_host_protocol::sessions::CloseWhen;
use weave_host_protocol::sessions::DetachSessionRequest;
use weave_host_protocol::sessions::GetSessionRequest;
use weave_host_protocol::sessions::OtherThread;
use weave_host_protocol::sessions::SessionStatus;
use weave_host_protocol::sessions::TurnState;
use weave_host_protocol::turns::TurnId;

use crate::Shared;
use crate::calls;
use crate::store::Follow;
use crate::store::StoredHost;

/// How many continuations of an interrupted turn are followed, at most.
const MOST_CONTINUATIONS: usize = 64;

/// Report the followed turns on `host` that are over, in the thread `only` names or in all.
pub(crate) async fn check(
    shared: &Shared,
    host: &StoredHost,
    handle: &HostHandle,
    only: Option<&SessionId>,
) {
    let follows = match shared.store.follows(&host.host_id) {
        Ok(follows) => follows,
        Err(why) => {
            tracing::warn!(host = %host.host_id, %why, "reading the turns followed failed");
            return;
        }
    };
    for mut follow in follows {
        if only.is_some_and(|only| *only.0 != *follow.session_id) {
            continue;
        }
        let session_id = SessionId::new(follow.session_id.clone());
        let mut got = None;
        for _ in 0..MOST_CONTINUATIONS {
            let read = handle
                .send(GetSessionRequest {
                    session_id: session_id.clone(),
                    turn_id: Some(TurnId::from(follow.turn_id.clone())),
                })
                .await;
            let next = match &read {
                Ok(read) => read
                    .latest_turn
                    .as_ref()
                    .filter(|turn| turn.state.is_over())
                    .and_then(|turn| turn.continued_in.clone()),
                Err(_) => None,
            };
            got = Some(read);
            let Some(next) = next else { break };
            if let Err(why) = shared.store.continued_follow(&follow.id, &next) {
                tracing::warn!(follow = %follow.id, %why, "recording a turn's continuation failed");
                break;
            }
            tracing::info!(host = %host.host_id, interrupted = %follow.turn_id, continuation = %next, "a followed turn was interrupted and continued");
            follow.turn_id = next.to_string();
        }
        let Some(got) = got else { continue };
        let text = match got {
            Ok(got) => match got.latest_turn {
                // A headless thread continues a turn its Host stopped under once the Host
                // takes it up again (WVE-144), which may not have happened yet.
                Some(latest)
                    if latest.state == TurnState::Interrupted
                        && latest.continued_in.is_none()
                        && got.session.headless =>
                {
                    continue;
                }
                Some(latest) if latest.state.is_over() => {
                    ended_text(&Named::of(&got.session, Some(&host.name)), Some(&latest))
                }
                // A thread that isn't open runs nothing: it closed before the turn ran, or its
                // Host stopped under the turn and, the thread not being headless, didn't take
                // it up again.
                Some(latest)
                    if got.session.state != SessionStatus::Open && !got.session.headless =>
                {
                    let named = Named::of(&got.session, Some(&host.name));
                    if latest.state == TurnState::Queued {
                        format!(
                            "[weave] Thread {named} closed before the turn {} your thread \
                             began there ran, so it won't run.",
                            follow.turn_id
                        )
                    } else {
                        format!(
                            "[weave] Thread {named} stopped with its Host during the turn {} \
                             your thread began there, and isn't open now, so the turn won't go \
                             on. read_session with host {} says how the thread stands.",
                            follow.turn_id, host.name
                        )
                    }
                }
                Some(_) => continue,
                None => no_turn(host, &follow),
            },
            Err(error)
                if errors::is(&error, errors::UNKNOWN_TURN)
                    || errors::is(&error, errors::UNKNOWN_SESSION) =>
            {
                no_turn(host, &follow)
            }
            Err(error) => {
                tracing::debug!(host = %host.host_id, follow = %follow.id, %error, "reading a followed turn failed");
                return;
            }
        };
        let report = calls::report_work(&follow.caller, about(host, &follow), text);
        match shared.store.unfollow(&follow, Some(report)) {
            Ok(()) => shared.wake(&follow.calling_host),
            Err(why) => {
                tracing::warn!(follow = %follow.id, %why, "recording a followed turn's end failed")
            }
        }
    }
}

/// Tell the callers of the followed turn running in `session_id` on `host`, which waits on a
/// person, what it asks that they haven't been told.
pub(crate) async fn waiting(
    shared: &Shared,
    host: &StoredHost,
    handle: &HostHandle,
    session_id: &SessionId,
) {
    let follows: Vec<Follow> = match shared.store.follows(&host.host_id) {
        Ok(follows) => follows
            .into_iter()
            .filter(|follow| *follow.session_id == *session_id.0)
            .collect(),
        Err(why) => {
            tracing::warn!(host = %host.host_id, %why, "reading the turns followed failed");
            return;
        }
    };
    if follows.is_empty() {
        return;
    }
    let attached = handle
        .send(AttachSessionRequest {
            session_id: session_id.clone(),
            after: None,
            agent_id: None,
            cwd: None,
            trace: false,
            observe: true,
        })
        .await;
    let _ = handle
        .send(DetachSessionRequest {
            session_id: session_id.clone(),
            close: CloseWhen::Never,
        })
        .await;
    let state = match attached {
        Ok(attached) => attached.state,
        Err(error) => {
            tracing::debug!(host = %host.host_id, %session_id, %error, "observing a followed thread failed");
            return;
        }
    };
    let running = state
        .turns
        .iter()
        .find(|turn| turn.session_id == *session_id)
        .and_then(|turn| turn.turn_id.clone());
    let Some(running) = running else { return };
    let named = Named {
        session_id,
        title: state.title.as_deref(),
        agent_id: &state.agent.id,
        host: Some(&host.name),
    };
    let asked: Vec<(String, Asks)> = state
        .pending
        .iter()
        .filter_map(|pending| Some((pending.id.to_string(), Asks::of(pending)?)))
        .collect();
    for mut follow in follows {
        if *follow.turn_id != *running.to_string() {
            continue;
        }
        let mut told = false;
        for (pending_id, asks) in &asked {
            if follow.told.contains(pending_id) {
                continue;
            }
            calls::report(
                shared,
                &follow.calling_host,
                &follow.caller,
                about(host, &follow),
                waiting_text(&named, asks),
            );
            follow.told.push(pending_id.clone());
            told = true;
        }
        if told && let Err(why) = shared.store.told(&follow.id, &follow.told) {
            tracing::warn!(follow = %follow.id, %why, "recording what a caller was told failed");
        }
    }
}

/// The thread a report on `follow` is about.
fn about(host: &StoredHost, follow: &Follow) -> OtherThread {
    OtherThread {
        session_id: SessionId::new(follow.session_id.clone()),
        host: host.host_id.clone(),
        host_name: Some(host.name.clone()),
    }
}

/// The report on a followed turn its Host has no record of.
fn no_turn(host: &StoredHost, follow: &Follow) -> String {
    format!(
        "[weave] Thread {} on {} no longer has the turn {} your thread began there, as when \
         its prompt was taken out of the queue. read_session with host {} says how the thread \
         stands.",
        follow.session_id, host.name, follow.turn_id, host.name
    )
}
