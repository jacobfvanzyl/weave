//! The fake agent's `narrate` script, which the app's recorded journals fold (WVE-218): what it
//! says and does in order, a steer followed up with work of its own, cancelling it mid-way, and
//! failing it after the work.

// Test helpers outside `#[test]` functions fail fast too.
#![allow(clippy::expect_used)]

mod common;

use std::time::Duration;

use common::Harness;
use pretty_assertions::assert_eq;
use weave_acp_core::AgentEvent;
use weave_acp_core::ClientOptions;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;

/// A turn's updates as lines: what the agent said, joined per message, and each tool call started.
fn beats(updates: &[SessionUpdate]) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut saying = false;
    for update in updates {
        match update {
            SessionUpdate::AgentMessageChunk(chunk) => {
                let ContentBlock::Text(text) = &chunk.content else {
                    continue;
                };
                match lines.last_mut() {
                    Some(line) if saying => line.push_str(&text.text),
                    _ => lines.push(format!("say: {}", text.text)),
                }
                saying = true;
            }
            SessionUpdate::ToolCall(call) => {
                lines.push(format!("call: {}", call.title));
                saying = false;
            }
            _ => {}
        }
    }
    lines
}

/// The rest of the turn: its updates, and how it ended.
async fn finish(
    harness: &mut Harness,
    updates: &mut Vec<SessionUpdate>,
) -> Result<StopReason, String> {
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), harness.events.recv())
            .await
            .expect("timed out")
            .expect("event stream closed");
        match event {
            AgentEvent::SessionUpdate(notification) => updates.push(notification.update),
            AgentEvent::TurnEnded { result, .. } => {
                return result
                    .map(|response| response.stop_reason)
                    .map_err(|error| format!("{error:?}"));
            }
            _ => {}
        }
    }
}

/// Starts `prompt`, and waits for its first tool call to finish.
async fn after_first_call(harness: &mut Harness, prompt: &str) -> Vec<SessionUpdate> {
    harness
        .connection
        .prompt(harness.session_id.clone(), vec![ContentBlock::from(prompt)])
        .expect("prompt");
    let mut updates = Vec::new();
    loop {
        let event = tokio::time::timeout(Duration::from_secs(10), harness.events.recv())
            .await
            .expect("timed out")
            .expect("event stream closed");
        if let AgentEvent::SessionUpdate(notification) = event {
            let finished = matches!(notification.update, SessionUpdate::ToolCallUpdate(_));
            updates.push(notification.update);
            if finished {
                return updates;
            }
        }
    }
}

#[tokio::test]
async fn narrates_its_work_between_tool_calls_then_answers() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let log = harness.turn("/narrate", "allow").await;
    assert_eq!(log.stop_reason, Some(StopReason::EndTurn));
    assert_eq!(
        beats(&log.updates),
        [
            "say: I'll read the parser and find where it loads its fixtures.",
            "call: Read src/parser.rs",
            "call: Search fixtures/",
            "say: It reads them from the old path. I'll point it at tests/fixtures and run the tests.",
            "call: Edit src/parser.rs",
            "call: cargo test -p parser",
            "say: Done: the parser reads its fixtures from tests/fixtures, and the tests pass.",
        ]
    );
}

#[tokio::test]
async fn works_on_a_steer_before_going_on() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let mut updates = after_first_call(&mut harness, "/narrate").await;
    harness
        .connection
        .steer(
            harness.session_id.clone(),
            vec![ContentBlock::from("check the lexer too")],
            1,
        )
        .expect("steer");
    let stop = finish(&mut harness, &mut updates).await;
    assert_eq!(stop, Ok(StopReason::EndTurn));
    let beats = beats(&updates);
    let steered = beats
        .iter()
        .position(|beat| beat == "call: Search for check the lexer too")
        .expect("a tool call for the steer");
    // It goes on with the work after the steer's, and answers last, mentioning it.
    assert!(
        beats[steered + 1..].contains(&"call: cargo test -p parser".to_owned()),
        "{beats:?}"
    );
    let answer = beats.last().expect("an answer");
    assert!(
        answer.starts_with("say: Done:") && answer.ends_with("check the lexer too"),
        "{answer}"
    );
    assert_eq!(
        beats
            .iter()
            .filter(|beat| beat.starts_with("say: Done"))
            .count(),
        1,
        "{beats:?}"
    );
}

#[tokio::test]
async fn stops_mid_way_when_cancelled() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    let mut updates = after_first_call(&mut harness, "/narrate").await;
    harness
        .connection
        .cancel(harness.session_id.clone())
        .expect("cancel");
    let stop = finish(&mut harness, &mut updates).await;
    assert_eq!(stop, Ok(StopReason::Cancelled));
    let beats = beats(&updates);
    assert!(
        beats.contains(&"call: Read src/parser.rs".to_owned()),
        "{beats:?}"
    );
    assert!(
        !beats.iter().any(|beat| beat.starts_with("say: Done")),
        "{beats:?}"
    );
}

#[tokio::test]
async fn fails_after_its_work_with_fail() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    harness
        .connection
        .prompt(
            harness.session_id.clone(),
            vec![ContentBlock::from("/narrate fail")],
        )
        .expect("prompt");
    let mut updates = Vec::new();
    let stop = finish(&mut harness, &mut updates).await;
    let error = stop.expect_err("the prompt fails");
    assert!(error.contains("the turn failed after its work"), "{error}");
    let beats = beats(&updates);
    assert_eq!(
        beats
            .iter()
            .filter(|beat| beat.starts_with("call:"))
            .count(),
        4,
        "{beats:?}"
    );
    assert!(
        !beats.iter().any(|beat| beat.starts_with("say: Done")),
        "{beats:?}"
    );
}
