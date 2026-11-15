//! Neovim in the Host's terminals (WVE-233): where the Neovim in each terminal listens, and the
//! two things the Host asks of it for the `nvim_open` and `nvim_state` tools, over its
//! MessagePack-RPC socket ([`rpc`]).
//!
//! Each terminal's shell gets `WEAVE_NVIM`, a socket path made from the terminal's id alone in
//! one private directory, which a Neovim the person starts there listens on, if their config or
//! `--listen` says so. So the Host finds a terminal's Neovim without asking the terminal
//! anything, and the terminals know nothing of editors. A socket goes when its terminal does
//! ([`forget`], [`sweep`]).
//!
//! The Host asks two things only, each a fixed Lua script given its arguments as arguments
//! (`nvim_exec_lua`), so nothing a tool is given becomes a command: show a file at a place
//! (`open.lua`), and say what's current and selected (`state.lua`). Before either it checks
//! Neovim's version and that it isn't waiting on a key, with requests Neovim answers at once
//! even then (`nvim_get_api_info`, `nvim_get_mode`); every request has a deadline.

pub mod msgpack;
pub(crate) mod rpc;

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;

use self::msgpack::Value;
use self::rpc::Rpc;
use self::rpc::RpcError;

/// The variable a terminal's shell has the socket path in.
pub const VARIABLE: &str = "WEAVE_NVIM";

/// The oldest Neovim the tools work with: `getregion()` reads a live selection from 0.10.
pub const OLDEST: (i64, i64) = (0, 10);

/// How long Neovim has to accept a connection, and to answer each request.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const CALL_TIMEOUT: Duration = Duration::from_secs(5);

const OPEN: &str = include_str!("open.lua");
const STATE: &str = include_str!("state.lua");

/// The line of Lua in the person's `init.lua` that has Neovim listen where the Host looks:
/// in a terminal of the Host's only, over a socket a Neovim that crashed left there (which
/// Neovim before 0.12 won't listen over itself), and hiding the variable from what Neovim
/// runs, such as a Neovim in its `:terminal`, which would otherwise take the socket over.
pub const INIT_LUA: &str = "if vim.env.WEAVE_NVIM then os.remove(vim.env.WEAVE_NVIM); \
    pcall(vim.fn.serverstart, vim.env.WEAVE_NVIM); vim.env.WEAVE_NVIM = nil end";

/// How the person has Neovim listen in a terminal, for a tool's error to tell them.
pub(crate) fn setup() -> String {
    format!(
        "weave sets WEAVE_NVIM in each terminal to a socket path for the Neovim there to listen \
         on. The person can add this line to their init.lua: `{INIT_LUA}`, or start Neovim with \
         `nvim --listen \"$WEAVE_NVIM\"`. A Neovim started before that doesn't listen, and \
         neither does one in a terminal opened before the Host set the variable."
    )
}

/// The socket the Neovim in the terminal `id` listens on, in `dir`; none when the path would
/// be too long for a Unix socket here.
pub(crate) fn socket(dir: &Path, id: &str) -> Option<PathBuf> {
    let path = dir.join(format!("{id}.sock"));
    (path.as_os_str().len() < max_socket_path()).then_some(path)
}

/// The bytes a Unix socket's path may have, less its terminating NUL's: 104 on macOS, 108 on
/// Linux.
fn max_socket_path() -> usize {
    // SAFETY: an all-zero sockaddr_un is valid.
    let address: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    address.sun_path.len()
}

/// Makes the sockets' directory, readable only by the user.
pub(crate) fn prepare(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::create_dir_all(dir)?;
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// The terminal `id` is gone: so is its socket, if a Neovim left one.
pub(crate) fn forget(dir: &Path, id: &str) {
    if let Some(socket) = socket(dir, id) {
        let _ = std::fs::remove_file(socket);
    }
}

/// Removes the sockets of terminals that aren't among `live`: what a Neovim left when its
/// terminal ended while the Host wasn't running.
pub(crate) fn sweep(dir: &Path, live: &[String]) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_suffix(".sock")
            && !live.iter().any(|live| live == id)
        {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Whether a Neovim accepts connections on `socket`; a file a Neovim left there isn't one.
pub(crate) async fn listening(socket: &Path) -> bool {
    Rpc::connect(socket, CONNECT_TIMEOUT).await.is_ok()
}

/// Why Neovim couldn't do what was asked, for a model to read after "The Neovim in …".
#[derive(Debug)]
pub(crate) enum NvimError {
    /// It couldn't be reached, or stopped answering.
    Unreachable(RpcError),
    /// It's older than [`OLDEST`].
    TooOld(String),
    /// It waits on a key to finish a command, or on an answer to a prompt.
    Waiting(String),
    /// `open` found the person in a mode other than Normal.
    Busy(String),
    /// It answered with an error, or with what the Host didn't expect.
    Failed(String),
}

impl std::fmt::Display for NvimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable(RpcError::TimedOut) => write!(
                f,
                "didn't answer in time: it may be busy, or showing the person a prompt"
            ),
            Self::Unreachable(error) => write!(f, "couldn't be reached: {error}"),
            Self::TooOld(version) => write!(
                f,
                "is version {version}, and these tools need Neovim {}.{} or later",
                OLDEST.0, OLDEST.1
            ),
            Self::Waiting(mode) => write!(
                f,
                "is waiting for the person to finish a command or answer a prompt ({mode}), so \
                 nothing was done. Try again in a moment."
            ),
            Self::Busy(mode) => write!(
                f,
                "is in {mode} mode, so nothing was opened: the person is in the middle of \
                 something, and opening a file would end it. nvim_state says what they have \
                 there. Try again once they're back in Normal mode, or tell them where to look."
            ),
            Self::Failed(why) => write!(f, "failed: {why}"),
        }
    }
}

impl From<RpcError> for NvimError {
    fn from(error: RpcError) -> Self {
        match error {
            RpcError::Remote(message) => Self::Failed(message),
            other => Self::Unreachable(other),
        }
    }
}

/// A place in a buffer, from 1; a line without a column for a linewise selection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Position {
    pub(crate) line: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) column: Option<u64>,
}

/// What `open` did.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Opened {
    /// The buffer's file, as Neovim names it.
    pub(crate) path: String,
    /// Where the cursor is now, which is short of what was asked past a line's or file's end.
    pub(crate) line: u64,
    pub(crate) column: u64,
    /// It opened in a split of its own, since the current window's buffer couldn't be let go.
    pub(crate) split: bool,
}

/// Neovim's current buffer, cursor, mode and selection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct State {
    /// The buffer's name, its file's path for a file; none for a buffer without one.
    pub(crate) path: Option<String>,
    /// `'buftype'`, for a buffer that isn't a file's, such as `terminal` or `help`.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) buffer_type: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub(crate) filetype: String,
    /// It has changes not yet written.
    pub(crate) modified: bool,
    pub(crate) mode: String,
    pub(crate) cursor: Position,
    /// While Visual or Select mode is on; none otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) selection: Option<Selection>,
}

/// A live selection: its kind, its first and last places, and its text, a string per line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(crate) struct Selection {
    /// `characters`, `lines` or `block`.
    pub(crate) kind: String,
    pub(crate) start: Position,
    pub(crate) end: Position,
    pub(crate) text: Vec<String>,
}

/// What `state.lua` gives.
#[derive(Deserialize)]
struct Reported {
    path: Option<String>,
    #[serde(default)]
    buftype: String,
    #[serde(default)]
    filetype: String,
    #[serde(default)]
    modified: bool,
    mode: String,
    cursor: Position,
    selection: Option<ReportedSelection>,
}

#[derive(Deserialize)]
struct ReportedSelection {
    kind: String,
    start: Position,
    end: Position,
    #[serde(default)]
    text: Vec<String>,
}

/// A file to open: absolute, and at a line, and a character column, when given, from 1.
pub(crate) struct Open<'a> {
    pub(crate) path: &'a Path,
    pub(crate) line: Option<u64>,
    pub(crate) column: Option<u64>,
}

/// Shows `open`'s file in the Neovim on `socket`, at its place.
pub(crate) async fn open(socket: &Path, open: &Open<'_>) -> Result<Opened, NvimError> {
    let mut rpc = ready(socket).await?;
    let number = |number: Option<u64>| {
        number
            .and_then(|number| i64::try_from(number).ok())
            .map_or(Value::Nil, Value::Int)
    };
    let answer = rpc
        .call(
            "nvim_exec_lua",
            vec![
                Value::str(OPEN),
                Value::Array(vec![
                    Value::str(open.path.to_string_lossy()),
                    number(open.line),
                    number(open.column),
                ]),
            ],
        )
        .await?;
    let answer = to_json(&answer);
    if let Some(mode) = answer.get("refused").and_then(serde_json::Value::as_str) {
        return Err(NvimError::Busy(mode_name(mode)));
    }
    serde_json::from_value(answer).map_err(|error| NvimError::Failed(error.to_string()))
}

/// What's current in the Neovim on `socket`, and selected.
pub(crate) async fn state(socket: &Path) -> Result<State, NvimError> {
    let mut rpc = ready(socket).await?;
    let answer = rpc
        .call(
            "nvim_exec_lua",
            vec![Value::str(STATE), Value::Array(Vec::new())],
        )
        .await?;
    let reported: Reported = serde_json::from_value(to_json(&answer))
        .map_err(|error| NvimError::Failed(error.to_string()))?;
    Ok(State {
        path: reported.path,
        buffer_type: reported.buftype,
        filetype: reported.filetype,
        modified: reported.modified,
        mode: mode_name(&reported.mode),
        cursor: reported.cursor,
        selection: reported.selection.map(|selection| Selection {
            kind: match selection.kind.as_str() {
                "char" => "characters".to_owned(),
                "line" => "lines".to_owned(),
                other => other.to_owned(),
            },
            start: selection.start,
            end: selection.end,
            text: selection.text,
        }),
    })
}

/// A connection to the Neovim on `socket`, once it's said it's new enough and isn't waiting on
/// a key, both of which it answers at once whatever it's doing.
async fn ready(socket: &Path) -> Result<Rpc, NvimError> {
    let mut rpc = Rpc::connect(socket, CONNECT_TIMEOUT)
        .await
        .map_err(NvimError::Unreachable)?;
    rpc.set_timeout(CALL_TIMEOUT);
    let info = rpc.call("nvim_get_api_info", Vec::new()).await?;
    let version = info
        .as_array()
        .and_then(|info| info.get(1))
        .and_then(|metadata| metadata.get("version"));
    let part = |name: &str| {
        version
            .and_then(|version| version.get(name))
            .and_then(Value::as_i64)
            .unwrap_or_default()
    };
    let (major, minor, patch) = (part("major"), part("minor"), part("patch"));
    if (major, minor) < OLDEST {
        return Err(NvimError::TooOld(format!("{major}.{minor}.{patch}")));
    }
    let mode = rpc.call("nvim_get_mode", Vec::new()).await?;
    if mode.get("blocking") == Some(&Value::Bool(true)) {
        let code = mode.get("mode").and_then(Value::as_str).unwrap_or_default();
        return Err(NvimError::Waiting(mode_name(code)));
    }
    Ok(rpc)
}

/// A mode as `mode()` gives it, by name.
fn mode_name(code: &str) -> String {
    let name = match code {
        "n" | "nt" => "Normal",
        "v" | "vs" => "Visual",
        "V" | "Vs" => "Visual Line",
        "\u{16}" | "\u{16}s" => "Visual Block",
        "s" => "Select",
        "S" => "Select Line",
        "\u{13}" => "Select Block",
        "t" => "Terminal",
        "c" | "cv" | "cr" => "Command-line",
        "r" | "rm" | "r?" => "prompt",
        "!" => "shell",
        _ if code.starts_with("no") => "Operator-pending",
        _ if code.starts_with("ni") || code.starts_with("nR") || code.starts_with("nV") => {
            "Insert (one Normal mode command)"
        }
        _ if code.starts_with('i') => "Insert",
        _ if code.starts_with('R') => "Replace",
        _ => return format!("the mode {code:?}"),
    };
    name.to_owned()
}

/// A MessagePack value as JSON: map keys that aren't strings as their JSON, extension types
/// (Neovim's handles) as null.
fn to_json(value: &Value) -> serde_json::Value {
    use serde_json::Value as Json;
    match value {
        Value::Nil | Value::Ext(..) => Json::Null,
        Value::Bool(value) => Json::Bool(*value),
        Value::Int(number) => Json::from(*number),
        Value::Float(number) => {
            serde_json::Number::from_f64(*number).map_or(Json::Null, Json::Number)
        }
        Value::Str(text) => Json::String(text.clone()),
        Value::Bin(bytes) => Json::String(String::from_utf8_lossy(bytes).into_owned()),
        Value::Array(items) => Json::Array(items.iter().map(to_json).collect()),
        Value::Map(entries) => Json::Object(
            entries
                .iter()
                .map(|(key, value)| {
                    let key = match key {
                        Value::Str(key) => key.clone(),
                        other => to_json(other).to_string(),
                    };
                    (key, to_json(value))
                })
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests;
