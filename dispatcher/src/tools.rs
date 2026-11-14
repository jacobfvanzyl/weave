//! The Dispatcher's own service tools (WVE-171), which it declares on every Host's link and a
//! Bot's thread calls through the Host MCP server. Each is answered only for a Bot's own thread:
//! on the Bot's Host, its current thread, one it had, or the new one it's starting. Any other
//! thread gets a tool error in words for its agent, as does a call the tool refuses.
//!
//! - [`wakeups`] (WVE-118): `wake_me`, `list_wakeups` and `cancel_wakeup`, one-off prompts the
//!   Bot asks for itself.
//! - [`schedules`] (WVE-178): `add_schedule`, `list_schedules`, `pause_schedule`,
//!   `resume_schedule` and `remove_schedule`, over the recurring schedules that prompt the Bot,
//!   the person's for it too.
//! - [`bots`] (WVE-178): `create_bot`, which makes another Bot with the caller as its maker,
//!   `list_bots`, and `set_avatar` (WVE-223), the caller's own emoji and colour.
//!
//! None acts on a Bot other than the caller, but for `create_bot` making one; and a Bot made so
//! has no thread and no schedules until the person prompts it.

mod bots;
mod schedules;
mod wakeups;

use std::sync::Arc;

use agent_client_protocol::v1::schema::ContentBlock;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Map;
use serde_json::Value;
use weave_host_client::HostHandle;
use weave_host_protocol::tools::AnswerToolRequest;
use weave_host_protocol::tools::ClientToolResult;
use weave_host_protocol::tools::Tool;
use weave_host_protocol::tools::ToolCallNotification;

use crate::Shared;
use crate::store::StoredBot;
use crate::store::StoredHost;

/// What every tool's description begins with.
const ONLY: &str = "Only for a Bot's own thread: a Bot is a named assistant the person's weave \
                    Dispatcher keeps, working in threads the Dispatcher starts for it. Unless you \
                    are working as one of the person's Bots, don't call this: it refuses every \
                    other thread.";

/// The tools the Dispatcher declares on every Host, in the order agents see them.
pub(crate) fn tools() -> Vec<Tool> {
    [wakeups::tools(), schedules::tools(), bots::tools()].concat()
}

/// Answer `call`, which came from `calling` over `from`.
pub(crate) async fn answer(
    shared: Arc<Shared>,
    calling: StoredHost,
    from: HostHandle,
    call: ToolCallNotification,
) {
    let result = match respond(&shared, &calling, &call).await {
        Ok(text) => ClientToolResult::text(text),
        Err(why) => ClientToolResult::error(why),
    };
    let answered = from
        .send(AnswerToolRequest {
            call_id: call.call_id,
            result,
        })
        .await;
    if let Err(error) = answered {
        tracing::debug!(host = %calling.host_id, %error, "answering a tool call failed");
    }
}

/// The text the agent gets for `call`, or why it failed.
async fn respond(
    shared: &Shared,
    calling: &StoredHost,
    call: &ToolCallNotification,
) -> Result<String, String> {
    let tool = call.tool.as_str();
    let can = [
        (wakeups::NAMES, wakeups::CAN),
        (schedules::NAMES, schedules::CAN),
        (bots::NAMES, bots::CAN),
    ]
    .into_iter()
    .find_map(|(names, can)| names.contains(&tool).then_some(can))
    .ok_or_else(|| format!("The Dispatcher has no tool {tool}."))?;
    let bot = own_bot(shared, calling, &call.caller.thread_id.0)?.ok_or_else(|| {
        format!(
            "Only a Bot's own thread can {can}, and this thread isn't one of a Bot's: a Bot is \
             a named assistant the person's Dispatcher keeps, and its threads are those the \
             Dispatcher started for it."
        )
    })?;
    let given = &call.arguments;
    match tool {
        wakeups::WAKE_ME => wakeups::wake_me(shared, &bot, &call.call_id, arguments(tool, given)?),
        wakeups::LIST_WAKEUPS => wakeups::list(shared, &bot),
        wakeups::CANCEL_WAKEUP => wakeups::cancel(shared, &bot, arguments(tool, given)?),
        schedules::ADD_SCHEDULE => {
            schedules::add(shared, &bot, &call.call_id, arguments(tool, given)?)
        }
        schedules::LIST_SCHEDULES => schedules::list(shared, &bot),
        schedules::PAUSE_SCHEDULE => schedules::pause(shared, &bot, arguments(tool, given)?),
        schedules::RESUME_SCHEDULE => schedules::resume(shared, &bot, arguments(tool, given)?),
        schedules::REMOVE_SCHEDULE => schedules::remove(shared, &bot, arguments(tool, given)?),
        bots::CREATE_BOT => bots::create(shared, &bot, arguments(tool, given)?).await,
        bots::LIST_BOTS => bots::list(shared, &bot),
        bots::SET_AVATAR => bots::set_avatar(shared, &bot, arguments(tool, given)?),
        _ => Err(format!("The Dispatcher has no tool {tool}.")),
    }
}

/// The Bot whose own thread `thread`, on `calling`, is: its current thread, one it had, or the
/// new one it's starting.
fn own_bot(
    shared: &Shared,
    calling: &StoredHost,
    thread: &str,
) -> Result<Option<StoredBot>, String> {
    let bots = shared
        .store
        .bots()
        .map_err(|why| format!("The Dispatcher couldn't read its Bots: {why}."))?;
    Ok(bots
        .into_iter()
        .find(|bot| bot.host_id == calling.host_id && owns(bot, thread)))
}

fn owns(bot: &StoredBot, thread: &str) -> bool {
    bot.thread.as_deref() == Some(thread)
        || bot.threads.iter().any(|had| had.thread_id == thread)
        || bot
            .new_thread
            .as_ref()
            .and_then(|new_thread| new_thread.thread.as_deref())
            == Some(thread)
}

fn arguments<T: DeserializeOwned>(tool: &str, arguments: &Map<String, Value>) -> Result<T, String> {
    serde_json::from_value(Value::Object(arguments.clone()))
        .map_err(|error| format!("The arguments don't fit {tool}'s input: {error}."))
}

fn to_text(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| error.to_string())
}

/// The text of `prompt`, its text blocks one after another.
fn text_of(prompt: &[ContentBlock]) -> String {
    prompt
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text(text) => Some(text.text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `why`, an API error's words, as a sentence: its first letter a capital, ending in a full stop.
fn sentence(why: &str) -> String {
    let why = why.trim().trim_end_matches('.');
    let mut chars = why.chars();
    match chars.next() {
        Some(first) => format!("{}{}.", first.to_uppercase(), chars.as_str()),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_host_protocol::tools::MAX_SERVICE_TOOL_NAME;
    use weave_host_protocol::tools::MAX_SERVICE_TOOLS;

    use super::*;

    #[test]
    fn the_tools_are_the_bots_own_and_within_the_hosts_limits() {
        let tools = tools();
        let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
        assert_eq!(
            names,
            [wakeups::NAMES, schedules::NAMES, bots::NAMES,].concat()
        );
        assert!(tools.len() <= MAX_SERVICE_TOOLS);
        // As agents see them, after the name the Host knows the Dispatcher by, which may be long.
        for tool in &tools {
            assert!(
                tool.name.len() + "homelab-dispatcher__".len() <= MAX_SERVICE_TOOL_NAME,
                "{}",
                tool.name
            );
            assert!(tool.description.starts_with(ONLY), "{}", tool.name);
            assert_eq!(
                tool.input_schema["additionalProperties"], false,
                "{}",
                tool.name
            );
        }
    }

    #[test]
    fn an_api_error_reads_as_a_sentence() {
        assert_eq!(
            sentence("there's a schedule called tick already"),
            "There's a schedule called tick already."
        );
        assert_eq!(sentence(" ok. "), "Ok.");
        assert_eq!(sentence(""), "");
    }
}
