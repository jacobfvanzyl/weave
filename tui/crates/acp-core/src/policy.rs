//! Answering permission requests without asking anyone, by a [`PermissionPolicy`]: as the
//! weave daemon does for headless sessions, and `weave smoke` for its one turn.

use std::collections::HashMap;

use agent_client_protocol::schema::v1::PermissionOptionKind;
use agent_client_protocol::schema::v1::RequestPermissionOutcome;
use agent_client_protocol::schema::v1::RequestPermissionRequest;
use agent_client_protocol::schema::v1::RequestPermissionResponse;
use agent_client_protocol::schema::v1::SelectedPermissionOutcome;
use agent_client_protocol::schema::v1::SessionUpdate;
use agent_client_protocol::schema::v1::ToolCallId;
use agent_client_protocol::schema::v1::ToolKind;
use serde::Deserialize;
use serde::Serialize;

/// How a session's permission requests are answered.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPolicy {
    /// Tool kinds approved without asking anyone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub approve: Vec<ToolKind>,
    /// What happens to the rest.
    #[serde(default)]
    pub otherwise: Unapproved,
}

/// What happens to permission requests a policy doesn't approve.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unapproved {
    /// Ask the attached clients, and wait for one if none is attached.
    #[default]
    Ask,
    /// Reject them, and dismiss elicitations: nobody is there to answer.
    Reject,
}

impl PermissionPolicy {
    /// Ask attached clients, waiting for one when none is attached: an interactive session.
    pub fn ask() -> Self {
        Self::default()
    }

    /// Approve `kinds` and reject the rest: nobody is there to ask.
    pub fn headless(approve: Vec<ToolKind>) -> Self {
        Self {
            approve,
            otherwise: Unapproved::Reject,
        }
    }

    /// Whether anything is answered without a client.
    pub fn is_headless(&self) -> bool {
        !self.approve.is_empty() || self.otherwise == Unapproved::Reject
    }

    /// The answer to `request` for a tool of `kind`: allowed once if the kind is approved,
    /// rejected once if the policy rejects the rest, or `None` for a person to answer.
    pub fn answer(
        &self,
        request: &RequestPermissionRequest,
        kind: ToolKind,
    ) -> Option<RequestPermissionResponse> {
        if self.approve.contains(&kind)
            && let Some(answer) = choose(
                request,
                &[
                    PermissionOptionKind::AllowOnce,
                    PermissionOptionKind::AllowAlways,
                ],
            )
        {
            return Some(answer);
        }
        match self.otherwise {
            Unapproved::Ask => None,
            Unapproved::Reject => Some(
                choose(
                    request,
                    &[
                        PermissionOptionKind::RejectOnce,
                        PermissionOptionKind::RejectAlways,
                    ],
                )
                // With no way to say no, it's answered as a cancelled turn's would be.
                .unwrap_or_else(|| {
                    RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled)
                }),
            ),
        }
    }

    /// Whether elicitations are dismissed, as nobody is there to answer them.
    pub fn dismisses_elicitations(&self) -> bool {
        self.otherwise == Unapproved::Reject
    }
}

/// The first option of the earliest kind in `preference`.
fn choose(
    request: &RequestPermissionRequest,
    preference: &[PermissionOptionKind],
) -> Option<RequestPermissionResponse> {
    preference.iter().find_map(|kind| {
        request
            .options
            .iter()
            .find(|option| option.kind == *kind)
            .map(|option| {
                RequestPermissionResponse::new(RequestPermissionOutcome::Selected(
                    SelectedPermissionOutcome::new(option.option_id.clone()),
                ))
            })
    })
}

/// Each tool call's kind as the agent reported it: agents may leave the kind out of the
/// permission request that follows a tool call.
#[derive(Default)]
pub struct ToolKinds(HashMap<ToolCallId, ToolKind>);

impl ToolKinds {
    pub fn observe(&mut self, update: &SessionUpdate) {
        match update {
            SessionUpdate::ToolCall(call) => {
                self.0.insert(call.tool_call_id.clone(), call.kind);
            }
            SessionUpdate::ToolCallUpdate(update) => {
                if let Some(kind) = update.fields.kind {
                    self.0.insert(update.tool_call_id.clone(), kind);
                }
            }
            _ => {}
        }
    }

    /// The kind of tool `request` asks about, from the request or else its tool call.
    pub fn of(&self, request: &RequestPermissionRequest) -> ToolKind {
        let call = &request.tool_call;
        call.fields
            .kind
            .or_else(|| self.0.get(&call.tool_call_id).copied())
            .unwrap_or(ToolKind::Other)
    }
}

#[cfg(test)]
mod tests {
    use agent_client_protocol::schema::v1::PermissionOption;
    use agent_client_protocol::schema::v1::ToolCall;
    use agent_client_protocol::schema::v1::ToolCallUpdate;
    use agent_client_protocol::schema::v1::ToolCallUpdateFields;
    use pretty_assertions::assert_eq;

    use super::*;

    fn request() -> RequestPermissionRequest {
        RequestPermissionRequest::new(
            "s1",
            ToolCallUpdate::new("t1", ToolCallUpdateFields::new()),
            vec![
                PermissionOption::new("always", "Always", PermissionOptionKind::AllowAlways),
                PermissionOption::new("once", "Once", PermissionOptionKind::AllowOnce),
                PermissionOption::new("no", "No", PermissionOptionKind::RejectOnce),
            ],
        )
    }

    fn selected(option: &str) -> Option<RequestPermissionResponse> {
        Some(RequestPermissionResponse::new(
            RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option.to_owned())),
        ))
    }

    #[test]
    fn approved_kinds_are_allowed_once_and_the_rest_follow_the_policy() {
        let headless = PermissionPolicy::headless(vec![ToolKind::Read]);
        assert_eq!(
            headless.answer(&request(), ToolKind::Read),
            selected("once")
        );
        assert_eq!(
            headless.answer(&request(), ToolKind::Execute),
            selected("no")
        );
        assert_eq!(
            PermissionPolicy::ask().answer(&request(), ToolKind::Read),
            None
        );
        assert!(headless.dismisses_elicitations());
        assert!(!PermissionPolicy::ask().dismisses_elicitations());
    }

    #[test]
    fn a_request_without_a_rejection_is_cancelled() {
        let mut request = request();
        request
            .options
            .retain(|option| option.kind != PermissionOptionKind::RejectOnce);
        assert_eq!(
            PermissionPolicy::headless(Vec::new()).answer(&request, ToolKind::Edit),
            Some(RequestPermissionResponse::new(
                RequestPermissionOutcome::Cancelled
            ))
        );
    }

    #[test]
    fn a_requests_kind_comes_from_its_tool_call_when_left_out() {
        let mut kinds = ToolKinds::default();
        assert_eq!(kinds.of(&request()), ToolKind::Other);
        kinds.observe(&SessionUpdate::ToolCall(
            ToolCall::new("t1", "Write a.rs").kind(ToolKind::Edit),
        ));
        assert_eq!(kinds.of(&request()), ToolKind::Edit);
    }
}
