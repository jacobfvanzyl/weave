//! The steering extension against the fake agent: a message for the running turn joins it.

// Test helpers outside `#[test]` functions fail fast too.
#![allow(clippy::expect_used)]

mod common;

use std::time::Duration;

use common::Harness;
use pretty_assertions::assert_eq;
use weave_acp_core::AgentEvent;
use weave_acp_core::ClientOptions;
use weave_acp_core::SteerOutcome;
use weave_acp_core::schema::ContentBlock;
use weave_acp_core::schema::SessionUpdate;
use weave_acp_core::schema::StopReason;
use weave_acp_core::supports_steering;

async fn next(harness: &mut Harness) -> AgentEvent {
    tokio::time::timeout(Duration::from_secs(10), harness.events.recv())
        .await
        .expect("timed out")
        .expect("event stream closed")
}

fn message_text(event: &AgentEvent) -> Option<&str> {
    match event {
        AgentEvent::SessionUpdate(notification) => match &notification.update {
            SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
                ContentBlock::Text(text) => Some(&text.text),
                _ => None,
            },
            _ => None,
        },
        _ => None,
    }
}

#[tokio::test]
async fn a_steered_message_joins_the_running_turn() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    assert!(harness.connection.agent().is_some_and(supports_steering));
    harness
        .connection
        .prompt(
            harness.session_id.clone(),
            vec![ContentBlock::from("slow 50")],
        )
        .expect("prompt");
    // Steer once the turn is under way.
    while message_text(&next(&mut harness).await).is_none() {}
    harness
        .connection
        .steer(
            harness.session_id.clone(),
            vec![ContentBlock::from("say hi instead")],
            7,
        )
        .expect("steer");

    let mut answer = None;
    let mut after = String::new();
    let stop_reason = loop {
        let event = next(&mut harness).await;
        if let Some(text) = message_text(&event)
            && answer.is_some()
        {
            after.push_str(text);
        }
        match event {
            AgentEvent::Steered { tag, result, .. } => answer = Some((tag, result.ok())),
            AgentEvent::TurnEnded { result, .. } => {
                break result.expect("prompt response").stop_reason;
            }
            _ => {}
        }
    };
    assert_eq!(answer, Some((7, Some(SteerOutcome::Injected))));
    // The turn answered it before ending, rather than finishing its chunks.
    assert!(after.contains("You steered: say hi instead"), "{after}");
    assert!(!after.contains("Chunk 50 of 50"), "{after}");
    assert_eq!(stop_reason, StopReason::EndTurn);
}

#[tokio::test]
async fn steering_with_no_turn_running_leaves_the_prompt_to_the_client() {
    let mut harness = Harness::start(ClientOptions::default()).await;
    harness
        .connection
        .steer(
            harness.session_id.clone(),
            vec![ContentBlock::from("hi")],
            1,
        )
        .expect("steer");
    loop {
        if let AgentEvent::Steered { tag, result, .. } = next(&mut harness).await {
            assert_eq!((tag, result.ok()), (1, Some(SteerOutcome::PromptRequired)));
            break;
        }
    }
}
