//! What the Dispatcher knows of each agent's sign-in (ADR 0036, WVE-239): the file the agent's
//! own program writes when the person signs in to it, the copy of it a Host is given, which
//! can't be renewed, and how the Dispatcher renews it by running the vendor's own program. This
//! is the one place that knows a vendor's file; a Host is told only how to use what it's given.
//!
//! - **`claude`**: Claude Code's `.credentials.json`. A Host gets the access token alone, for
//!   the agent's environment as `CLAUDE_CODE_OAUTH_TOKEN`, which Claude Code runs on with no
//!   file at all. Renewal runs `claude -p ""` against a private temporary config directory whose
//!   copy has `expiresAt` set to 0: Claude Code refreshes at startup before checking for a prompt
//!   and writes the new file with no model call.
//! - **`codex`**: Codex's `auth.json`. A Host gets the file with a placeholder where the
//!   renewal token was, at `.codex/auth.json` under the home: Codex won't read a sign-in
//!   without the field, and has no variable that takes a ChatGPT access token. Renewal runs
//!   `codex app-server --listen stdio://` against a private temporary `CODEX_HOME` with
//!   `cli_auth_credentials_store = "file"`, asks `account/read` with `refreshToken: true`, and
//!   reads the updated `auth.json` with no model call.

use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use serde_json::json;
use sha2::Digest as _;
use sha2::Sha256;
use tokio::io::AsyncBufReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::io::BufReader;
use tokio::process::Command;
use weave_host_protocol::Timestamp;
use weave_host_protocol::credentials::CredentialUse;
use weave_host_protocol::credentials::HeldCredential;
use zeroize::Zeroizing;

/// What stands where a renewal token was, in a copy.
const NOT_RENEWABLE: &str = "weave-copy-cannot-renew";

/// The agents the Dispatcher can give a sign-in to and renew, by id.
pub const AGENTS: [&str; 2] = ["claude", "codex"];

/// How long before expiry the Dispatcher renews each agent's sign-in.
/// Claude's access token lasts ~8 hours; Codex's lasts ~10 days.
const CLAUDE_RENEW_BEFORE: u64 = 60 * 60 * 1000;
const CODEX_RENEW_BEFORE: u64 = 24 * 60 * 60 * 1000;

/// How long a single vendor renewal command may run before being killed.
const RENEW_TIMEOUT: Duration = Duration::from_secs(60);

/// How long before expiry a sign-in for `agent` is due to be renewed, in milliseconds.
pub(crate) fn renew_before(agent: &str) -> u64 {
    match agent {
        "codex" => CODEX_RENEW_BEFORE,
        _ => CLAUDE_RENEW_BEFORE,
    }
}

/// The copy of `agent`'s sign-in file `value` that a Host holds as `name`, or why `value`
/// isn't that agent's sign-in.
pub(crate) fn copy(name: &str, agent: &str, value: &str) -> Result<HeldCredential, String> {
    let file: Value =
        serde_json::from_str(value).map_err(|_| format!("{agent}'s sign-in is a JSON file"))?;
    match agent {
        "claude" => {
            let signed_in = &file["claudeAiOauth"];
            let token = signed_in["accessToken"]
                .as_str()
                .filter(|token| !token.is_empty())
                .ok_or("this isn't Claude Code's .credentials.json: it has no access token")?;
            Ok(HeldCredential {
                name: name.to_owned(),
                used: CredentialUse::Environment {
                    agent: agent.to_owned(),
                    variable: "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
                },
                value: token.to_owned(),
                expires_at: signed_in["expiresAt"].as_u64(),
            })
        }
        "codex" => {
            let token = file["tokens"]["access_token"]
                .as_str()
                .filter(|token| !token.is_empty())
                .ok_or("this isn't Codex's auth.json: it has no access token")?;
            let expires_at = expiry(token);
            let mut copy = file.clone();
            copy["tokens"]["refresh_token"] = Value::String(NOT_RENEWABLE.to_owned());
            Ok(HeldCredential {
                name: name.to_owned(),
                used: CredentialUse::File {
                    path: ".codex/auth.json".to_owned(),
                },
                value: copy.to_string(),
                expires_at,
            })
        }
        other => Err(format!(
            "the Dispatcher can't give {other} a sign-in; it can {}",
            AGENTS.join(" and ")
        )),
    }
}

/// When a JWT expires, from its claims, which aren't checked: only its issuer can.
fn expiry(jwt: &str) -> Option<Timestamp> {
    let claims = jwt.split('.').nth(1)?;
    let claims = URL_SAFE_NO_PAD.decode(claims.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&claims).ok()?;
    claims["exp"].as_u64()?.checked_mul(1000)
}

/// Renews a vendor's sign-in file by running the vendor's own program. Tests swap this out.
pub trait Renewer: Send + Sync {
    /// Renew `agent`'s sign-in file `current`, returning the new sign-in file contents.
    /// Error strings are shown to the person and stored in SQLite, so they must never carry a
    /// token or raw credential file.
    fn renew<'a>(
        &'a self,
        agent: &'a str,
        current: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Zeroizing<String>, String>> + Send + 'a>>;
}

/// Renews sign-ins by running the vendor's own unmodified program (`claude` or `codex`) in a
/// private temporary directory inside `work_root` (never `/tmp`, and removed on drop).
pub struct VendorRenewer {
    work_root: PathBuf,
    environment: BTreeMap<String, String>,
    timeout: Duration,
}

impl VendorRenewer {
    pub fn new(work_root: PathBuf, environment: BTreeMap<String, String>) -> Self {
        Self {
            work_root,
            environment,
            timeout: RENEW_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    fn base_env(&self, stripped: &[&str]) -> BTreeMap<String, String> {
        let mut env = self.environment.clone();
        for name in stripped {
            env.remove(*name);
        }
        env
    }
}

impl Renewer for VendorRenewer {
    fn renew<'a>(
        &'a self,
        agent: &'a str,
        current: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Zeroizing<String>, String>> + Send + 'a>> {
        Box::pin(async move {
            match agent {
                "claude" => renew_claude(self, current).await,
                "codex" => renew_codex(self, current).await,
                other => Err(format!(
                    "the Dispatcher can't renew {other}; it can {}",
                    AGENTS.join(" and ")
                )),
            }
        })
    }
}

/// A private 0700 directory inside `work_root`, removed when dropped so no sign-in lingers on
/// disk.
struct PrivateDir {
    path: PathBuf,
}

impl PrivateDir {
    fn create(root: &Path, label: &str) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|error| format!("creating renewal dir: {error}"))?;
        set_mode(root, 0o700)?;
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|error| format!("random dir name: {error}"))?;
        let suffix: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        let path = root.join(format!("{label}-{suffix}"));
        std::fs::create_dir(&path).map_err(|error| format!("creating renewal dir: {error}"))?;
        set_mode(&path, 0o700)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for PrivateDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|error| format!("setting permissions: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn write_private(path: &Path, contents: &[u8]) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| format!("writing temporary sign-in: {error}"))?;
        file.write_all(contents)
            .map_err(|error| format!("writing temporary sign-in: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("syncing temporary sign-in: {error}"))?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, contents)
            .map_err(|error| format!("writing temporary sign-in: {error}"))?;
    }
    Ok(())
}

/// The macOS Keychain service name Claude Code derives from a `CLAUDE_CONFIG_DIR`:
/// `Claude Code-credentials-<first 8 hex chars of sha256(config_dir)>`.
pub fn claude_keychain_service(config_dir: &Path) -> String {
    let digest = Sha256::digest(config_dir.to_string_lossy().as_bytes());
    let hex: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("Claude Code-credentials-{hex}")
}

/// The macOS Keychain account name Claude Code uses: `$USER` when it matches
/// `^[a-zA-Z0-9._-]+$`, else `"claude-code-user"`.
#[cfg(target_os = "macos")]
pub fn claude_keychain_account(env: &BTreeMap<String, String>) -> String {
    env.get("USER")
        .filter(|user| {
            !user.is_empty()
                && user
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        })
        .cloned()
        .unwrap_or_else(|| "claude-code-user".to_owned())
}

/// On macOS, read and immediately remove the temporary Keychain item Claude Code wrote for
/// `config_dir`, if any. Never touches the person's default `Claude Code-credentials` item.
#[cfg(target_os = "macos")]
pub fn take_macos_claude_keychain(
    config_dir: &Path,
    env: &BTreeMap<String, String>,
) -> Option<Zeroizing<String>> {
    let service = claude_keychain_service(config_dir);
    let account = claude_keychain_account(env);
    let output = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-a",
            &account,
            "-w",
            "-s",
            &service,
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok();
    let _ = std::process::Command::new("/usr/bin/security")
        .args(["delete-generic-password", "-a", &account, "-s", &service])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let output = output?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| Zeroizing::new(trimmed.to_owned()))
}

#[cfg(target_os = "macos")]
struct KeychainCleanup {
    service: String,
    account: String,
}

#[cfg(target_os = "macos")]
impl Drop for KeychainCleanup {
    fn drop(&mut self) {
        let _ = std::process::Command::new("/usr/bin/security")
            .args([
                "delete-generic-password",
                "-a",
                &self.account,
                "-s",
                &self.service,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Renew Claude Code's `.credentials.json` by running `claude -p ""` against a private copy
/// whose `expiresAt` is set to 0: Claude Code refreshes at startup before checking for a prompt,
/// writes the fresh credentials, and exits with no model turn.
async fn renew_claude(renewer: &VendorRenewer, current: &str) -> Result<Zeroizing<String>, String> {
    let mut parsed: Value = serde_json::from_str(current)
        .map_err(|_| "Claude's sign-in isn't valid JSON".to_owned())?;
    let old_access = parsed["claudeAiOauth"]["accessToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Claude's sign-in has no access token")?
        .to_owned();
    let old_refresh = parsed["claudeAiOauth"]["refreshToken"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Claude's sign-in has no renewal token — sign in again with `weave credentials login claude`")?
        .to_owned();
    parsed["claudeAiOauth"]["expiresAt"] = json!(0);

    let dir = PrivateDir::create(&renewer.work_root, "claude")?;
    let config_dir = dir.path().join(".claude");
    std::fs::create_dir(&config_dir).map_err(|error| format!("creating renewal dir: {error}"))?;
    set_mode(&config_dir, 0o700)?;
    let creds_path = config_dir.join(".credentials.json");
    let seed = Zeroizing::new(parsed.to_string());
    write_private(&creds_path, seed.as_bytes())?;

    let mut env = renewer.base_env(&[
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    ]);
    env.insert("HOME".to_owned(), dir.path().display().to_string());
    env.insert(
        "CLAUDE_CONFIG_DIR".to_owned(),
        config_dir.display().to_string(),
    );

    #[cfg(target_os = "macos")]
    let _keychain_guard = {
        // Clear any stray temp item first so Claude reads our seeded .credentials.json,
        // and guarantee cleanup on drop.
        let _ = take_macos_claude_keychain(&config_dir, &env);
        KeychainCleanup {
            service: claude_keychain_service(&config_dir),
            account: claude_keychain_account(&env),
        }
    };

    let mut command = Command::new("claude");
    command
        .args(["-p", ""])
        .env_clear()
        .envs(&env)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "`claude` isn't installed on the Dispatcher's computer".to_owned()
        } else {
            format!("starting `claude`: {error}")
        }
    })?;
    // `claude -p ""` exits non-zero because the prompt is empty, AFTER finishing its startup
    // OAuth refresh; only a timeout or wait failure is a process error here.
    let _ = tokio::time::timeout(renewer.timeout, child.wait())
        .await
        .map_err(|_| "renewing Claude's sign-in timed out".to_owned())?
        .map_err(|error| format!("waiting for `claude`: {error}"))?;

    // On macOS Claude may save the refreshed JSON in the temp Keychain item and remove the file.
    #[cfg(target_os = "macos")]
    let updated = take_macos_claude_keychain(&config_dir, &env).or_else(|| {
        std::fs::read_to_string(&creds_path)
            .ok()
            .map(Zeroizing::new)
    });
    #[cfg(not(target_os = "macos"))]
    let updated = std::fs::read_to_string(&creds_path)
        .ok()
        .map(Zeroizing::new);

    let updated = updated.ok_or_else(|| {
        "Claude Code didn't write a renewed sign-in — sign in again with `weave credentials login claude`"
            .to_owned()
    })?;
    let check: Value = serde_json::from_str(&updated)
        .map_err(|_| "Claude Code wrote an unreadable sign-in file".to_owned())?;
    let new_access = check["claudeAiOauth"]["accessToken"].as_str().unwrap_or("");
    let new_refresh = check["claudeAiOauth"]["refreshToken"]
        .as_str()
        .unwrap_or("");
    let new_expires = check["claudeAiOauth"]["expiresAt"].as_u64().unwrap_or(0);
    if new_access.is_empty()
        || (new_access == old_access && new_refresh == old_refresh && new_expires == 0)
    {
        return Err(
            "Claude Code couldn't renew the sign-in — sign in again with `weave credentials login claude`"
                .to_owned(),
        );
    }
    copy("claude", "claude", &updated)?;
    Ok(updated)
}

/// Renew Codex's `auth.json` by running `codex app-server --listen stdio://` against a private
/// `CODEX_HOME` with file storage and sending `account/read` with `refreshToken: true`.
async fn renew_codex(renewer: &VendorRenewer, current: &str) -> Result<Zeroizing<String>, String> {
    let parsed: Value =
        serde_json::from_str(current).map_err(|_| "Codex's sign-in isn't valid JSON".to_owned())?;
    let old_access = parsed["tokens"]["access_token"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Codex's sign-in has no access token")?
        .to_owned();
    let old_refresh = parsed["tokens"]["refresh_token"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != NOT_RENEWABLE)
        .ok_or("Codex's sign-in has no renewal token — sign in again with `weave credentials login codex`")?
        .to_owned();

    let dir = PrivateDir::create(&renewer.work_root, "codex")?;
    let codex_home = dir.path().join(".codex");
    std::fs::create_dir(&codex_home).map_err(|error| format!("creating renewal dir: {error}"))?;
    set_mode(&codex_home, 0o700)?;
    write_private(
        &codex_home.join("config.toml"),
        b"cli_auth_credentials_store = \"file\"\n",
    )?;
    let auth_path = codex_home.join("auth.json");
    write_private(&auth_path, current.as_bytes())?;

    let mut env = renewer.base_env(&["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY"]);
    env.insert("HOME".to_owned(), dir.path().display().to_string());
    env.insert("CODEX_HOME".to_owned(), codex_home.display().to_string());

    let mut command = Command::new("codex");
    command
        .args(["app-server", "--listen", "stdio://"])
        .env_clear()
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "`codex` isn't installed on the Dispatcher's computer".to_owned()
        } else {
            format!("starting `codex`: {error}")
        }
    })?;

    let exchange = async {
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "codex stdin unavailable".to_owned())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "codex stdout unavailable".to_owned())?;
        let mut lines = BufReader::new(stdout).lines();

        let init = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"clientInfo": {"name": "weave", "version": env!("CARGO_PKG_VERSION")}},
        });
        stdin
            .write_all(format!("{init}\n").as_bytes())
            .await
            .map_err(|error| format!("writing to `codex`: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("flushing to `codex`: {error}"))?;

        wait_for_rpc_id(&mut lines, 1).await?;

        let initialized = json!({"jsonrpc": "2.0", "method": "initialized"});
        let refresh = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "account/read",
            "params": {"refreshToken": true},
        });
        stdin
            .write_all(format!("{initialized}\n{refresh}\n").as_bytes())
            .await
            .map_err(|error| format!("writing to `codex`: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("flushing to `codex`: {error}"))?;

        let _ = wait_for_rpc_id(&mut lines, 2).await;
        drop(stdin);
        Ok::<(), String>(())
    };

    let rpc_result = tokio::time::timeout(renewer.timeout, exchange).await;
    let _ = child.kill().await;
    let _ = child.wait().await;

    // Always inspect auth.json even if the RPC timed out or answered an error: Codex writes the
    // rotated refresh token to disk as soon as the OAuth endpoint replies.
    let updated = std::fs::read_to_string(&auth_path).ok().map(Zeroizing::new);
    if let Some(updated) = updated
        && let Ok(check) = serde_json::from_str::<Value>(&updated)
    {
        let new_access = check["tokens"]["access_token"].as_str().unwrap_or("");
        let new_refresh = check["tokens"]["refresh_token"].as_str().unwrap_or("");
        if !new_access.is_empty() && (new_access != old_access || new_refresh != old_refresh) {
            copy("codex", "codex", &updated)?;
            return Ok(updated);
        }
    }

    match rpc_result {
        Err(_) => Err("renewing Codex's sign-in timed out".to_owned()),
        Ok(Err(why)) => Err(why),
        Ok(Ok(())) => Err(
            "Codex couldn't renew the sign-in — sign in again with `weave credentials login codex`"
                .to_owned(),
        ),
    }
}

async fn wait_for_rpc_id(
    lines: &mut tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    wanted: u64,
) -> Result<(), String> {
    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|error| format!("reading from `codex`: {error}"))?
    {
        if let Ok(message) = serde_json::from_str::<Value>(&line)
            && message.get("id").and_then(Value::as_u64) == Some(wanted)
        {
            return Ok(());
        }
    }
    Err("`codex` exited before answering".to_owned())
}

/// Run `agent`'s own unmodified sign-in program interactively in the person's terminal against a
/// private temporary directory (removed on drop) and return the resulting sign-in file contents.
/// Never touches the person's `~/.claude`, `~/.codex`, or default macOS Keychain entry.
pub fn sign_in_interactive(
    work_root: &Path,
    agent: &str,
    device_auth: bool,
) -> Result<Zeroizing<String>, String> {
    match agent {
        "claude" => sign_in_claude(work_root),
        "codex" => sign_in_codex(work_root, device_auth),
        other => Err(format!(
            "weave can't sign in to {other}; it can {}",
            AGENTS.join(" and ")
        )),
    }
}

fn sign_in_claude(work_root: &Path) -> Result<Zeroizing<String>, String> {
    let dir = PrivateDir::create(work_root, "login-claude")?;
    let config_dir = dir.path().join(".claude");
    std::fs::create_dir(&config_dir).map_err(|error| format!("creating sign-in dir: {error}"))?;
    set_mode(&config_dir, 0o700)?;
    let creds_path = config_dir.join(".credentials.json");

    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    for stripped in [
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
    ] {
        env.remove(stripped);
    }
    env.insert("HOME".to_owned(), dir.path().display().to_string());
    env.insert(
        "CLAUDE_CONFIG_DIR".to_owned(),
        config_dir.display().to_string(),
    );

    #[cfg(target_os = "macos")]
    let _keychain_guard = {
        let _ = take_macos_claude_keychain(&config_dir, &env);
        KeychainCleanup {
            service: claude_keychain_service(&config_dir),
            account: claude_keychain_account(&env),
        }
    };

    let status = std::process::Command::new("claude")
        .args(["auth", "login"])
        .env_clear()
        .envs(&env)
        .status()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "`claude` isn't installed on this computer".to_owned()
            } else {
                format!("starting `claude auth login`: {error}")
            }
        })?;
    if !status.success() {
        return Err(format!("`claude auth login` exited with {status}"));
    }

    #[cfg(target_os = "macos")]
    let written = take_macos_claude_keychain(&config_dir, &env).or_else(|| {
        std::fs::read_to_string(&creds_path)
            .ok()
            .map(Zeroizing::new)
    });
    #[cfg(not(target_os = "macos"))]
    let written = std::fs::read_to_string(&creds_path)
        .ok()
        .map(Zeroizing::new);

    let written = written
        .ok_or_else(|| "`claude auth login` finished without writing credentials".to_owned())?;
    copy("claude", "claude", &written)?;
    Ok(written)
}

fn sign_in_codex(work_root: &Path, device_auth: bool) -> Result<Zeroizing<String>, String> {
    let dir = PrivateDir::create(work_root, "login-codex")?;
    let codex_home = dir.path().join(".codex");
    std::fs::create_dir(&codex_home).map_err(|error| format!("creating sign-in dir: {error}"))?;
    set_mode(&codex_home, 0o700)?;
    write_private(
        &codex_home.join("config.toml"),
        b"cli_auth_credentials_store = \"file\"\n",
    )?;
    let auth_path = codex_home.join("auth.json");

    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    for stripped in ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY"] {
        env.remove(stripped);
    }
    env.insert("HOME".to_owned(), dir.path().display().to_string());
    env.insert("CODEX_HOME".to_owned(), codex_home.display().to_string());

    let mut command = std::process::Command::new("codex");
    command.arg("login");
    if device_auth {
        command.arg("--device-auth");
    }
    let status = command.env_clear().envs(&env).status().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "`codex` isn't installed on this computer".to_owned()
        } else {
            format!("starting `codex login`: {error}")
        }
    })?;
    if !status.success() {
        return Err(format!("`codex login` exited with {status}"));
    }

    let written = std::fs::read_to_string(&auth_path)
        .map(Zeroizing::new)
        .map_err(|_| "`codex login` finished without writing auth.json".to_owned())?;
    copy("codex", "codex", &written)?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    fn jwt(claims: &Value) -> String {
        let part = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());
        format!(
            "{}.{}.signature",
            part(&json!({"alg": "none"})),
            part(claims)
        )
    }

    #[test]
    fn a_host_gets_claudes_access_token_alone() {
        let file = json!({"claudeAiOauth": {
            "accessToken": "access", "refreshToken": "renewal", "expiresAt": 1_795_400_000_000u64,
            "scopes": ["user:inference"],
        }});
        let copy = copy("claude", "claude", &file.to_string()).expect("a copy");
        assert_eq!(
            copy.used,
            CredentialUse::Environment {
                agent: "claude".to_owned(),
                variable: "CLAUDE_CODE_OAUTH_TOKEN".to_owned(),
            }
        );
        assert_eq!(copy.value, "access");
        assert_eq!(copy.expires_at, Some(1_795_400_000_000));
    }

    #[test]
    fn a_host_gets_codexs_file_without_its_renewal_token() {
        let access = jwt(&json!({"exp": 1_795_400_000u64}));
        let file = json!({"auth_mode": "chatgpt", "tokens": {
            "id_token": "id", "access_token": access, "refresh_token": "renewal",
            "account_id": "account",
        }, "last_refresh": "2026-11-14T17:08:11Z"});
        let copy = copy("codex", "codex", &file.to_string()).expect("a copy");
        assert_eq!(
            copy.used,
            CredentialUse::File {
                path: ".codex/auth.json".to_owned(),
            }
        );
        assert!(!copy.value.contains("renewal"), "{}", copy.value);
        let written: Value = serde_json::from_str(&copy.value).expect("JSON");
        assert_eq!(written["tokens"]["refresh_token"], NOT_RENEWABLE);
        assert_eq!(written["tokens"]["access_token"], access);
        assert_eq!(written["tokens"]["account_id"], "account");
        assert_eq!(copy.expires_at, Some(1_795_400_000_000));
    }

    #[test]
    fn what_isnt_an_agents_sign_in_is_refused() {
        assert!(copy("x", "claude", "not json").is_err());
        assert!(copy("x", "claude", "{\"tokens\":{}}").is_err());
        assert!(copy("x", "codex", "{\"claudeAiOauth\":{}}").is_err());
        let refused = copy("x", "gemini", "{}").expect_err("an agent it doesn't know");
        assert!(refused.contains("claude and codex"), "{refused}");
    }

    #[test]
    fn claude_keychain_service_hashes_the_config_dir() {
        let service = claude_keychain_service(Path::new("/tmp/test-claude"));
        assert!(service.starts_with("Claude Code-credentials-"), "{service}");
        assert_eq!(service.len(), "Claude Code-credentials-".len() + 8);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn vendor_renewer_drives_claude_and_codex_in_private_dirs() {
        use std::os::unix::fs::PermissionsExt as _;

        let root = tempfile::tempdir().expect("tempdir");
        let bin = root.path().join("bin");
        let work = root.path().join("work");
        std::fs::create_dir_all(&bin).expect("bin");

        // Stand-in `claude`: verifies expiresAt was zeroed, writes refreshed credentials, exits 1
        // just as `claude -p ""` does.
        let fake_claude = bin.join("claude");
        std::fs::write(
            &fake_claude,
            r#"#!/bin/sh
grep -q '"expiresAt":0' "$CLAUDE_CONFIG_DIR/.credentials.json" || exit 2
cat > "$CLAUDE_CONFIG_DIR/.credentials.json" <<'EOF'
{"claudeAiOauth":{"accessToken":"claude-fresh","refreshToken":"claude-refresh-2","expiresAt":4102444800000}}
EOF
exit 1
"#,
        )
        .expect("fake claude");
        std::fs::set_permissions(&fake_claude, std::fs::Permissions::from_mode(0o755))
            .expect("chmod");

        // Stand-in `codex`: speaks app-server initialize + account/read {refreshToken:true} and
        // updates $CODEX_HOME/auth.json.
        let fresh_jwt = jwt(&json!({"exp": 4_102_444_800u64}));
        let fake_codex = bin.join("codex");
        std::fs::write(
            &fake_codex,
            format!(
                r#"#!/bin/sh
grep -q 'cli_auth_credentials_store = "file"' "$CODEX_HOME/config.toml" || exit 2
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*) printf '{{"id":1,"result":{{}}}}\n' ;;
    *'"id":2'*)
      printf '{{"auth_mode":"chatgpt","tokens":{{"id_token":"id","access_token":"{fresh_jwt}","refresh_token":"codex-refresh-2","account_id":"acct"}}}}\n' > "$CODEX_HOME/auth.json"
      printf '{{"id":2,"result":{{"account":{{}}}}}}\n'
      exit 0
      ;;
  esac
done
"#
            ),
        )
        .expect("fake codex");
        std::fs::set_permissions(&fake_codex, std::fs::Permissions::from_mode(0o755))
            .expect("chmod");

        let mut env = BTreeMap::new();
        env.insert(
            "PATH".to_owned(),
            format!(
                "{}:{}",
                bin.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
        let renewer = VendorRenewer::new(work.clone(), env).with_timeout(Duration::from_secs(5));

        let claude_old = json!({"claudeAiOauth": {
            "accessToken": "claude-old",
            "refreshToken": "claude-refresh-1",
            "expiresAt": 1_795_400_000_000u64,
        }})
        .to_string();
        let claude_new = renewer
            .renew("claude", &claude_old)
            .await
            .expect("claude renewed");
        assert!(claude_new.contains("claude-fresh"), "{}", &*claude_new);

        let old_jwt = jwt(&json!({"exp": 1_795_400_000u64}));
        let codex_old = json!({"auth_mode": "chatgpt", "tokens": {
            "id_token": "id",
            "access_token": old_jwt,
            "refresh_token": "codex-refresh-1",
            "account_id": "acct",
        }})
        .to_string();
        let codex_new = renewer
            .renew("codex", &codex_old)
            .await
            .expect("codex renewed");
        assert!(codex_new.contains("codex-refresh-2"), "{}", &*codex_new);

        // Temporary renewal dirs are cleaned up on drop.
        assert_eq!(std::fs::read_dir(&work).expect("work").count(), 0);
    }
}
