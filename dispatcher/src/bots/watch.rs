//! `bots/watch` (WVE-178): the connections to the Dispatcher's API that follow the Bots, as an
//! app shows them. Whatever may change how a Bot lists, the API, a Host's link and the scheduler,
//! asks for [`Shared::bots_changed`], which lists the Bots again and tells each watcher of those
//! that differ from what they were last told, and of those that are gone. One list of what was
//! told serves every watcher: a new watcher is told first what the others hadn't been, then
//! answered with the same list, under the one lock, so none misses a change or hears one twice.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Mutex;

use agent_client_protocol::ConnectionTo;
use agent_client_protocol::Error;
use weave_host_protocol::DispatcherClient;
use weave_host_protocol::dispatcher::Bot;
use weave_host_protocol::dispatcher::BotRemovedNotification;
use weave_host_protocol::dispatcher::BotUpdatedNotification;

use crate::Shared;
use crate::lock;

/// The connections watching the Bots, and the Bots as they were last told.
#[derive(Default)]
pub(crate) struct Watchers {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// By id.
    told: BTreeMap<String, Bot>,
    /// By the API connection's number.
    watchers: HashMap<u64, ConnectionTo<DispatcherClient>>,
}

impl Shared {
    /// Have the connection `id` watch the Bots: what they are now, from which it's told of
    /// every change.
    pub(crate) fn watch_bots(
        &self,
        id: u64,
        cx: ConnectionTo<DispatcherClient>,
    ) -> Result<Vec<Bot>, Error> {
        let mut state = lock(&self.bot_watchers.state);
        let bots = self.bots()?;
        tell(&mut state, &bots);
        state.watchers.insert(id, cx);
        Ok(bots)
    }

    /// The connection `id` stops watching the Bots, as when it ends.
    pub(crate) fn unwatch_bots(&self, id: u64) {
        let mut state = lock(&self.bot_watchers.state);
        state.watchers.remove(&id);
        if state.watchers.is_empty() {
            state.told.clear();
        }
    }

    /// Something may have changed how a Bot lists: tell those watching the Bots of each that did.
    /// Take no lock of the links' before this, as it reads them.
    pub(crate) fn bots_changed(&self) {
        let mut state = lock(&self.bot_watchers.state);
        if state.watchers.is_empty() {
            return;
        }
        match self.bots() {
            Ok(bots) => tell(&mut state, &bots),
            Err(error) => tracing::warn!(%error, "listing the Bots for those watching failed"),
        }
    }
}

/// Tell `state`'s watchers how `bots` differ from what they were told, and keep `bots` as what
/// they were. Watchers that have gone are dropped.
fn tell(state: &mut State, bots: &[Bot]) {
    let mut told = BTreeMap::new();
    let mut updated = Vec::new();
    for bot in bots {
        if state.told.get(&bot.id) != Some(bot) {
            updated.push(BotUpdatedNotification { bot: bot.clone() });
        }
        told.insert(bot.id.clone(), bot.clone());
    }
    let removed: Vec<BotRemovedNotification> = state
        .told
        .keys()
        .filter(|id| !told.contains_key(*id))
        .map(|id| BotRemovedNotification { bot: id.clone() })
        .collect();
    state.told = told;
    if updated.is_empty() && removed.is_empty() {
        return;
    }
    state.watchers.retain(|_, cx| {
        updated
            .iter()
            .all(|notification| cx.send_notification(notification.clone()).is_ok())
            && removed
                .iter()
                .all(|notification| cx.send_notification(notification.clone()).is_ok())
    });
}
