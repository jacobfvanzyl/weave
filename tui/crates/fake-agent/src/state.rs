//! Sessions, sign-in, and settings, optionally persisted to a JSON file so a later process
//! can list, load, and resume what an earlier one recorded.

use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_client_protocol::Error;
use agent_client_protocol::schema::v1::ClientCapabilities;
use agent_client_protocol::schema::v1::McpServer;
use agent_client_protocol::schema::v1::SessionConfigOption;
use agent_client_protocol::schema::v1::SessionConfigOptionCategory;
use agent_client_protocol::schema::v1::SessionConfigOptionValue;
use agent_client_protocol::schema::v1::SessionConfigSelectGroup;
use agent_client_protocol::schema::v1::SessionConfigSelectOption;
use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::schema::v1::SessionMode;
use agent_client_protocol::schema::v1::SessionModeState;
use agent_client_protocol::schema::v1::SessionUpdate;
use serde::Deserialize;
use serde::Serialize;
use tokio::sync::Notify;

use crate::FakeAgentConfig;

const MODES: [(&str, &str); 2] = [("ask", "Ask"), ("code", "Code")];

/// A model group: id, display name, and its `(id, name)` models.
type ModelGroup = (
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
);

const MODELS: [ModelGroup; 2] = [
    ("fast", "Fast", &[("small", "Small")]),
    ("smart", "Smart", &[("large", "Large"), ("huge", "Huge")]),
];

/// What survives between agent processes.
#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    authenticated: bool,
    sessions: Vec<StoredSession>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct StoredSession {
    pub id: String,
    pub cwd: PathBuf,
    pub title: Option<String>,
    pub updated_at: String,
    /// Every update the session sent, replayed by `session/load`.
    pub history: Vec<SessionUpdate>,
}

/// A session open on this connection.
pub(crate) struct LiveSession {
    pub settings: Settings,
    pub cancel: Arc<Cancellation>,
    pub mcp_servers: Vec<McpServer>,
}

pub(crate) struct State {
    pub config: FakeAgentConfig,
    pub client: ClientCapabilities,
    pub authenticated: bool,
    pub sessions: Vec<StoredSession>,
    /// Sessions deleted here, which another process's saved copy mustn't bring back.
    pub deleted: HashSet<String>,
    pub live: HashMap<SessionId, LiveSession>,
}

impl State {
    pub fn new(config: FakeAgentConfig) -> Self {
        let persisted = saved(&config).unwrap_or_default();
        Self {
            config,
            client: ClientCapabilities::default(),
            authenticated: persisted.authenticated,
            sessions: persisted.sessions,
            deleted: HashSet::new(),
            live: HashMap::new(),
        }
    }

    /// Take in sessions other processes saved since this one started, as an agent's own
    /// storage shows every process's sessions (the weave daemon runs one per session).
    pub fn merge_saved(&mut self) {
        let Some(persisted) = saved(&self.config) else {
            return;
        };
        for session in persisted.sessions {
            if !self.deleted.contains(&session.id)
                && !self.sessions.iter().any(|known| known.id == session.id)
            {
                self.sessions.push(session);
            }
        }
    }

    /// Save, keeping what other processes saved.
    pub fn persist(&mut self) {
        self.merge_saved();
        let Some(path) = &self.config.state_path else {
            return;
        };
        let persisted = Persisted {
            authenticated: self.authenticated,
            sessions: self.sessions.clone(),
        };
        if let Ok(text) = serde_json::to_string_pretty(&persisted) {
            let _ = std::fs::write(path, text);
        }
    }

    pub fn require_auth(&self) -> Result<(), Error> {
        if self.config.require_auth && !self.authenticated {
            Err(Error::auth_required())
        } else {
            Ok(())
        }
    }

    /// Whether the client asked for compaction updates (an ACP Preview feature).
    pub fn client_supports_compaction(&self) -> bool {
        supports_compaction(&self.client)
    }

    pub fn client_supports_booleans(&self) -> bool {
        self.client
            .session
            .as_ref()
            .and_then(|session| session.config_options.as_ref())
            .is_some_and(|config| config.boolean.is_some())
    }

    pub fn stored(&self, session_id: &SessionId) -> Option<&StoredSession> {
        self.sessions
            .iter()
            .find(|session| session.id == session_id.to_string())
    }

    pub fn stored_mut(&mut self, session_id: &SessionId) -> Option<&mut StoredSession> {
        self.sessions
            .iter_mut()
            .find(|session| session.id == session_id.to_string())
    }

    /// Open a session on this connection with default settings.
    pub fn open(
        &mut self,
        session_id: &SessionId,
        mcp_servers: Vec<McpServer>,
    ) -> (SessionModeState, Vec<SessionConfigOption>) {
        let settings = Settings::default();
        let modes = settings.modes();
        let options = settings.config_options(self.client_supports_booleans());
        self.live.insert(
            session_id.clone(),
            LiveSession {
                settings,
                cancel: Arc::new(Cancellation::default()),
                mcp_servers,
            },
        );
        (modes, options)
    }
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true)
}

/// A new, globally unique session id, so persisted sessions from different runs never collide.
fn saved(config: &FakeAgentConfig) -> Option<Persisted> {
    let text = std::fs::read_to_string(config.state_path.as_deref()?).ok()?;
    serde_json::from_str(&text).ok()
}

pub(crate) fn new_session_id() -> SessionId {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_nanos());
    SessionId::new(format!("fake-{nanos:x}"))
}

pub(crate) struct Settings {
    pub mode: String,
    pub model: String,
    pub verbose: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mode: "ask".to_owned(),
            model: "small".to_owned(),
            verbose: false,
        }
    }
}

impl Settings {
    pub fn modes(&self) -> SessionModeState {
        SessionModeState::new(
            self.mode.clone(),
            MODES
                .iter()
                .map(|(id, name)| SessionMode::new(*id, *name))
                .collect(),
        )
    }

    pub fn is_mode(id: &str) -> bool {
        MODES.iter().any(|(mode, _)| *mode == id)
    }

    pub fn config_options(&self, booleans: bool) -> Vec<SessionConfigOption> {
        let modes = MODES
            .iter()
            .map(|(id, name)| SessionConfigSelectOption::new(*id, *name))
            .collect::<Vec<_>>();
        let models = MODELS
            .iter()
            .map(|(group, name, models)| {
                let options = models
                    .iter()
                    .map(|(id, name)| SessionConfigSelectOption::new(*id, *name))
                    .collect();
                SessionConfigSelectGroup::new(*group, *name, options)
            })
            .collect::<Vec<_>>();
        let mut options = vec![
            SessionConfigOption::select("mode", "Mode", self.mode.clone(), modes)
                .category(SessionConfigOptionCategory::Mode),
            SessionConfigOption::select("model", "Model", self.model.clone(), models)
                .category(SessionConfigOptionCategory::Model),
        ];
        if booleans {
            options.push(SessionConfigOption::boolean(
                "verbose",
                "Verbose",
                self.verbose,
            ));
        }
        options
    }

    pub fn set(
        &mut self,
        config_id: &str,
        value: &SessionConfigOptionValue,
        booleans: bool,
    ) -> Result<(), Error> {
        let invalid = || Error::invalid_params().data(format!("invalid value for {config_id}"));
        match (config_id, value) {
            ("mode", SessionConfigOptionValue::ValueId { value })
                if Self::is_mode(&value.to_string()) =>
            {
                self.mode = value.to_string();
            }
            ("model", SessionConfigOptionValue::ValueId { value })
                if MODELS.iter().any(|(_, _, models)| {
                    models.iter().any(|(id, _)| *id == value.to_string())
                }) =>
            {
                self.model = value.to_string();
            }
            ("verbose", SessionConfigOptionValue::Boolean { value }) if booleans => {
                self.verbose = *value
            }
            _ => return Err(invalid()),
        }
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct Cancellation {
    cancelled: AtomicBool,
    pub notify: Notify,
}

impl Cancellation {
    pub fn reset(&self) {
        self.cancelled.store(false, Ordering::SeqCst);
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Sleep unless cancelled first. Returns whether the turn was cancelled.
    pub async fn sleep(&self, duration: Duration) -> bool {
        let notified = self.notify.notified();
        if self.is_cancelled() {
            return true;
        }
        tokio::select! {
            () = notified => true,
            () = tokio::time::sleep(duration) => self.is_cancelled(),
        }
    }
}

/// Run the interactive sign-in a `terminal` auth method launches: confirm, then persist.
pub fn interactive_login(state_path: Option<&Path>) -> std::io::Result<bool> {
    use std::io::BufRead;
    use std::io::Write;
    let mut stdout = std::io::stdout();
    writeln!(stdout, "Fake Agent sign-in")?;
    write!(stdout, "Type 'yes' to sign in: ")?;
    stdout.flush()?;
    let mut answer = String::new();
    std::io::stdin().lock().read_line(&mut answer)?;
    if answer.trim() != "yes" {
        writeln!(stdout, "Sign-in cancelled.")?;
        return Ok(false);
    }
    let mut persisted = state_path
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Persisted>(&text).ok())
        .unwrap_or_default();
    persisted.authenticated = true;
    if let Some(path) = state_path {
        std::fs::write(
            path,
            serde_json::to_string_pretty(&persisted).unwrap_or_default(),
        )?;
    }
    writeln!(stdout, "Signed in.")?;
    Ok(true)
}

/// Whether `client` advertised `session.compaction`; agents send compaction updates only then.
/// Whether `client` advertised `subagents`; agents send subagent updates only then.
pub fn supports_subagents(client: &ClientCapabilities) -> bool {
    client.subagents.is_some()
}

pub fn supports_compaction(client: &ClientCapabilities) -> bool {
    client
        .session
        .as_ref()
        .is_some_and(|session| session.compaction.is_some())
}
