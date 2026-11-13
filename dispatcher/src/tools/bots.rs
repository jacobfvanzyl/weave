//! A Bot making another (WVE-178), when the person asks it to, and listing the person's Bots.
//!
//! - `create_bot` adds one as `bots/add` does ([`Shared::add_bot`]), with the caller as its maker:
//!   its Host makes its home, `~/bots/<name>`, whose `AGENTS.md` starts with its job; it has the
//!   caller's agent, Host and time zone unless it names another agent or Host, and the policy
//!   `bots/add` gives, which asks the person. It's refused once there are [`MOST_BOTS`] Bots,
//!   before its home is made and again as it's written down; the person adding one isn't held
//!   to that.
//! - `set_avatar` (WVE-223) changes the calling Bot's own avatar, its emoji and the colour it's
//!   drawn on, as `bots/update` does, when the person asks.
//! - A Bot made so has no thread and no schedules until the person prompts it, and none of the
//!   Dispatcher's tools lets a Bot prompt or schedule another.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use weave_host_protocol::dispatcher::AddBotRequest;
use weave_host_protocol::dispatcher::Bot;
use weave_host_protocol::dispatcher::BotColor;
use weave_host_protocol::dispatcher::BotState;
use weave_host_protocol::dispatcher::UpdateBotRequest;
use weave_host_protocol::tools::Tool;
use weave_host_protocol::worktrees::FilesMade;
use weave_host_protocol::worktrees::InitRepositoryResponse;

use super::ONLY;
use super::to_text;
use crate::Shared;
use crate::bots::said;
use crate::store::MOST_BOTS;
use crate::store::StoredBot;

/// Make another Bot, with the calling Bot as its maker.
pub(super) const CREATE_BOT: &str = "create_bot";

/// The person's Bots.
pub(super) const LIST_BOTS: &str = "list_bots";

/// Change the calling Bot's own avatar.
pub(super) const SET_AVATAR: &str = "set_avatar";

/// These tools, in the order agents see them.
pub(super) const NAMES: &[&str] = &[CREATE_BOT, LIST_BOTS, SET_AVATAR];

/// What only a Bot's own thread can do with them, as one that isn't is told.
pub(super) const CAN: &str = "make another Bot, list the person's Bots or change its own avatar";

/// The Bot tools, in the order agents see them.
pub(super) fn tools() -> Vec<Tool> {
    vec![
        Tool {
            name: CREATE_BOT.to_owned(),
            title: "Make a Bot".to_owned(),
            description: format!(
                "{ONLY} Make another Bot, when the person asks you for one: a named assistant \
                 of its own, with a home of its own on its Host, ~/bots/<name>, a git \
                 repository whose AGENTS.md starts with its job. It works with your agent, on \
                 your Host, in your time zone, unless you name another agent or Host, and asks \
                 the person before anything its permission policy doesn't approve. It's \
                 recorded as made by this Bot. It does nothing until the person prompts it: it \
                 has no thread and no schedules, and no Bot can prompt or schedule it, so tell \
                 the person it's there. Refused once the person has {MOST_BOTS} Bots. Answers \
                 with the new Bot, as list_bots gives it, and what making its home did, as \
                 JSON."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "minLength": 1, "description": "Its name, unique \
                        among the person's Bots ignoring case, such as Scribe."},
                    "job": {"type": "string", "minLength": 1, "description": "What it's for, in \
                        a sentence or a few, as the person put it: its home's AGENTS.md starts \
                        with this."},
                    "agent": {"type": "string", "description": "The agent it works with, by \
                        id, such as claude or codex; yours when absent."},
                    "host": {"type": "string", "description": "The Host it works on, by name \
                        or id; yours when absent."}
                },
                "required": ["name", "job"],
                "additionalProperties": false
            }),
        },
        Tool {
            name: LIST_BOTS.to_owned(),
            title: "List the Bots".to_owned(),
            description: format!(
                "{ONLY} List the person's Bots, by name: each one's agent, Host and home there; \
                 its state (working, needsYou or idle); why its schedules are paused, if they \
                 are; its avatar's emoji and color, if it has them; madeBy, the Bot that made \
                 it, if one did; and you: true on this Bot. Answers with them as JSON."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
        },
        Tool {
            name: SET_AVATAR.to_owned(),
            title: "Set your avatar".to_owned(),
            description: format!(
                "{ONLY} Change your own avatar, which the person sees beside your name: an \
                 emoji, on a colour. Call it when the person asks you to change how you look, \
                 or to pick an avatar for yourself. Give the emoji, the color or both; what you \
                 leave out stays as it is, and null clears it. Answers with this Bot as \
                 list_bots gives it, as JSON."
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "emoji": {"type": ["string", "null"], "description": "One emoji, such as \
                        🦉; null for none."},
                    "color": {"type": ["string", "null"], "enum": colors(), "description": "The \
                        colour it's drawn on; null for none."}
                },
                "additionalProperties": false
            }),
        },
    ]
}

/// `create_bot`'s arguments.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Create {
    name: String,
    job: String,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    host: Option<String>,
}

/// The colours `set_avatar` takes, and `null`.
fn colors() -> Vec<Value> {
    BotColor::ALL
        .into_iter()
        .map(|color| Value::from(color.name()))
        .chain([Value::Null])
        .collect()
}

/// `set_avatar`'s arguments: each absent to leave as it is, `null` to clear.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Avatar {
    #[serde(default, deserialize_with = "given")]
    emoji: Option<Option<String>>,
    #[serde(default, deserialize_with = "given")]
    color: Option<Option<BotColor>>,
}

/// A field that's there, `null` or not.
fn given<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A Bot as the tools give it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Listed {
    name: String,
    agent: String,
    host: String,
    /// Whole on its Host.
    home: String,
    state: BotState,
    /// Why its schedules are paused, while they are.
    #[serde(skip_serializing_if = "Option::is_none")]
    paused: Option<String>,
    /// Its avatar.
    #[serde(skip_serializing_if = "Option::is_none")]
    emoji: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    color: Option<BotColor>,
    /// The Bot that made it, by name, if one did.
    #[serde(skip_serializing_if = "Option::is_none")]
    made_by: Option<String>,
    /// It's the calling Bot.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    you: bool,
}

#[derive(Serialize)]
struct Bots {
    bots: Vec<Listed>,
}

#[derive(Serialize)]
struct Made {
    made: Listed,
    /// What making its home on its Host did.
    #[serde(skip_serializing_if = "Option::is_none")]
    home: Option<InitRepositoryResponse>,
    /// What the calling Bot should do now.
    next: String,
}

/// `create_bot`: add a Bot made by `bot`.
pub(super) async fn create(
    shared: &Shared,
    bot: &StoredBot,
    asked: Create,
) -> Result<String, String> {
    let name = asked.name.trim().to_owned();
    if name.is_empty() {
        return Err("A new Bot needs a name.".to_owned());
    }
    let job = asked.job.trim().to_owned();
    if job.is_empty() {
        return Err(
            "A new Bot needs a job: what it's for, as the person put it, which its home's \
             AGENTS.md starts with."
                .to_owned(),
        );
    }
    let given = |value: Option<String>| {
        value
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let request = AddBotRequest {
        name: name.clone(),
        host: given(asked.host).unwrap_or_else(|| bot.host_id.clone()),
        agent_id: given(asked.agent).unwrap_or_else(|| bot.agent_id.clone()),
        home: None,
        job: Some(job),
        policy: None,
        mode: None,
        new_thread_at: None,
        zone: Some(bot.zone.clone()),
        pause_after: None,
        emoji: None,
        color: None,
    };
    let added = shared
        .add_bot(request, Some(&bot.id))
        .await
        .map_err(|error| {
            format!(
                "Couldn't make {name}: {}.",
                said(&error).trim().trim_end_matches('.')
            )
        })?;
    tracing::info!(bot = %bot.name, made = %added.bot.name, "a Bot made another");
    let made = listed(added.bot, &bot.id);
    let mut next = format!(
        "{} is made, with its home at {} on {}. It does nothing until the person prompts it: it \
         has no thread and no schedules yet, and no Bot can prompt or schedule it. Tell the \
         person it's there, and what it's for.",
        made.name, made.home, made.host
    );
    match added.home.as_ref().and_then(|home| home.files.as_ref()) {
        Some(FilesMade::Kept { file }) => next.push_str(&format!(
            " Its home was there already with {}, which was kept, so its job isn't written \
             there.",
            file.display()
        )),
        Some(FilesMade::Uncommitted { why }) => next.push_str(&format!(
            " Its first memory files were written but not committed: {why}."
        )),
        _ => {}
    }
    to_text(&Made {
        made,
        home: added.home,
        next,
    })
}

/// `set_avatar`: change `bot`'s own emoji and colour.
pub(super) fn set_avatar(
    shared: &Shared,
    bot: &StoredBot,
    asked: Avatar,
) -> Result<String, String> {
    if asked.emoji.is_none() && asked.color.is_none() {
        return Err("Give an emoji, a color or both: null clears one.".to_owned());
    }
    let changed = shared
        .update_bot(UpdateBotRequest {
            bot: bot.id.clone(),
            emoji: asked.emoji,
            color: asked.color,
            ..UpdateBotRequest::default()
        })
        .map_err(|error| {
            format!(
                "Couldn't change your avatar: {}.",
                said(&error).trim().trim_end_matches('.')
            )
        })?;
    to_text(&listed(changed, &bot.id))
}

/// `list_bots`: the person's Bots, by name, `bot` among them.
pub(super) fn list(shared: &Shared, bot: &StoredBot) -> Result<String, String> {
    let bots = shared
        .bots()
        .map_err(|error| format!("The Dispatcher couldn't read its Bots: {}.", said(&error)))?;
    to_text(&Bots {
        bots: bots
            .into_iter()
            .map(|listed_bot| listed(listed_bot, &bot.id))
            .collect(),
    })
}

/// `bot` as the tools give it, to the Bot `caller`.
fn listed(bot: Bot, caller: &str) -> Listed {
    Listed {
        you: bot.id == caller,
        made_by: bot.created_by_name.or_else(|| {
            bot.created_by
                .is_some()
                .then(|| "a Bot since removed".to_owned())
        }),
        name: bot.name,
        agent: bot.agent_id,
        host: bot.host_name,
        home: bot.home.display().to_string(),
        state: bot.state,
        paused: bot.paused,
        emoji: bot.emoji,
        color: bot.color,
    }
}
