//! A session's queue (WVE-107): prompts waiting, in order, to start its next turns, held by the
//! session's task and journaled, so it outlives the clients that added to it and the Host
//! that held it. The session task starts the first prompt whenever no turn of its own runs,
//! unless the queue is paused.

use std::collections::VecDeque;

use weave_host_protocol::queue::QueuePause;
use weave_host_protocol::queue::QueuedPrompt;

use crate::journal::Entry;
use crate::journal::Record;

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Queue {
    pub(crate) prompts: VecDeque<QueuedPrompt>,
    /// Why it waits rather than start the next turn. Only meaningful while prompts wait: a
    /// paused queue that empties isn't paused any more.
    pub(crate) paused: Option<QueuePause>,
}

impl Queue {
    /// The queue a journal leaves: carried on in its header, then changed by what follows.
    pub(crate) fn from_records(records: &[Record]) -> Self {
        let mut queue = Self::default();
        for record in records {
            match &record.entry {
                Entry::Header {
                    queue: carried,
                    queue_paused,
                    ..
                } => {
                    queue.prompts = carried.iter().cloned().collect();
                    queue.paused = *queue_paused;
                }
                Entry::Queued {
                    queued_id,
                    prompt,
                    origin,
                    ..
                } => queue.prompts.push_back(QueuedPrompt {
                    id: queued_id.clone(),
                    prompt: prompt.clone(),
                    origin: origin.clone(),
                    queued_at: record.at,
                }),
                Entry::Unqueued { queued_id, .. }
                | Entry::TurnStarted {
                    queued_id: Some(queued_id),
                    ..
                } => {
                    queue.take(queued_id);
                }
                Entry::QueuePaused { reason } => queue.paused = Some(*reason),
                Entry::QueueResumed { .. } => queue.paused = None,
                _ => {}
            }
        }
        queue
    }

    /// Take `queued_id` out, if it's still waiting.
    pub(crate) fn take(&mut self, queued_id: &str) -> Option<QueuedPrompt> {
        let index = self
            .prompts
            .iter()
            .position(|queued| queued.id == queued_id)?;
        let taken = self.prompts.remove(index);
        if self.prompts.is_empty() {
            self.paused = None;
        }
        taken
    }

    /// Why it's paused, as clients see it: never while nothing waits.
    pub(crate) fn pause(&self) -> Option<QueuePause> {
        self.paused.filter(|_| !self.prompts.is_empty())
    }

    /// Whether a turn should start from it now, given no turn runs.
    pub(crate) fn is_ready(&self) -> bool {
        !self.prompts.is_empty() && self.paused.is_none()
    }
}

/// A new queued prompt's id.
pub(crate) fn new_id() -> String {
    format!("q-{}", crate::devices::random_id(6))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_acp_core::AgentSpec;
    use weave_acp_core::schema::ContentBlock;
    use weave_host_protocol::policy::PermissionPolicy;
    use weave_host_protocol::sessions::TurnOrigin;

    use super::*;

    fn record(entry: Entry) -> Record {
        Record { entry, at: 7 }
    }

    fn queued(id: &str) -> Entry {
        Entry::Queued {
            queued_id: id.to_owned(),
            prompt: vec![ContentBlock::from(id.to_owned())],
            origin: TurnOrigin::Run {},
            key: None,
        }
    }

    fn ids(queue: &Queue) -> Vec<&str> {
        queue
            .prompts
            .iter()
            .map(|queued| queued.id.as_str())
            .collect()
    }

    #[test]
    fn a_journal_leaves_the_queue_its_events_built() {
        let mut header = Entry::header(
            "s1".into(),
            AgentSpec::new("agent", ["--acp"]),
            "agent",
            "/repo".into(),
            PermissionPolicy::ask(),
            None,
            None,
        );
        if let Entry::Header { queue, .. } = &mut header {
            queue.push(QueuedPrompt {
                id: "carried".to_owned(),
                prompt: Vec::new(),
                origin: TurnOrigin::Run {},
                queued_at: 1,
            });
        }
        let records = [
            record(header),
            record(queued("a")),
            record(queued("b")),
            record(queued("c")),
            record(Entry::TurnStarted {
                session_id: "s1".into(),
                at_ms: 7,
                prompt: Vec::new(),
                origin: None,
                queued_id: Some("carried".to_owned()),
                key: None,
            }),
            record(Entry::Unqueued {
                queued_id: "b".to_owned(),
                by: None,
            }),
            record(Entry::QueuePaused {
                reason: QueuePause::Cancelled,
            }),
        ];
        let queue = Queue::from_records(&records);
        assert_eq!(ids(&queue), ["a", "c"]);
        assert_eq!(queue.pause(), Some(QueuePause::Cancelled));
        assert_eq!(queue.prompts[0].queued_at, 7);
        assert!(!queue.is_ready());
    }

    #[test]
    fn a_paused_queue_that_empties_is_no_longer_paused() {
        let mut queue = Queue::from_records(&[
            record(queued("a")),
            record(Entry::QueuePaused {
                reason: QueuePause::Failed,
            }),
        ]);
        assert_eq!(queue.pause(), Some(QueuePause::Failed));
        assert!(queue.take("a").is_some());
        assert_eq!(queue.paused, None);
        assert!(queue.take("a").is_none());
    }
}
