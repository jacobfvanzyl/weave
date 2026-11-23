//! Local git credential helper for the Host (ADR 0036, WVE-239).
//!
//! The Host listens on a private Unix socket (`git-credentials.sock`, mode `0600`, peer-UID
//! checked) and injects `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*` plus
//! `WEAVE_GIT_CREDENTIAL_SOCKET` into every agent and terminal it launches. Tokens are never
//! written into `.gitconfig`, `.git-credentials`, or process environments: when git needs
//! HTTPS credentials for a repository, it invokes `weave git-credential get`, which asks this
//! socket for the repository's `(host, path)`. The Host answers only for non-expired
//! `CredentialUse::Git` entries whose remote matches that exact repository over HTTPS.

use std::collections::BTreeMap;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde::Serialize;
use tokio::io::AsyncBufReadExt as _;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;
use tokio::io::BufReader;
use tokio::net::UnixListener;
use tokio::net::UnixStream;

use crate::Shared;
use crate::journal;
use crate::socket;

/// The Host's git credential socket, set in agents' and terminals' environments.
pub const SOCKET_VARIABLE: &str = "WEAVE_GIT_CREDENTIAL_SOCKET";

/// Maximum request or response line length on `git-credentials.sock`.
const MAX_LINE_BYTES: u64 = 16 * 1024;
/// How long one lookup over the local Unix socket may take.
const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize, Deserialize)]
struct LookupRequest {
    protocol: String,
    host: String,
    path: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LookupResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
}

/// Accept `weave git-credential` lookups on `listener` until the Host stops. Only peers with
/// the socket owner's UID are served.
pub(crate) async fn serve(shared: Arc<Shared>, listener: UnixListener) {
    let owner = socket::owner(&listener);
    let mut stop = shared.stop.subscribe();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    match socket::peer(&stream, owner) {
                        socket::Peer::Owner => {}
                        socket::Peer::Other(uid) => {
                            tracing::warn!(uid, "refused a git-credential connection from another user");
                            continue;
                        }
                        socket::Peer::Unknown => continue,
                    }
                    let shared = Arc::clone(&shared);
                    tokio::spawn(async move {
                        let _ = tokio::time::timeout(IO_TIMEOUT, handle(shared, stream)).await;
                    });
                }
                Err(error) => tracing::warn!(%error, "accepting a git-credential connection failed"),
            },
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break;
                }
            }
        }
    }
}

async fn handle(shared: Arc<Shared>, mut stream: UnixStream) -> io::Result<()> {
    let (read, mut write) = stream.split();
    let mut limited = BufReader::new(read.take(MAX_LINE_BYTES));
    let mut line = String::new();
    let read_bytes = limited.read_line(&mut line).await?;
    if read_bytes == 0 {
        return Ok(());
    }
    let response = match serde_json::from_str::<LookupRequest>(line.trim()) {
        Ok(request) if request.protocol.eq_ignore_ascii_case("https") => shared
            .credentials
            .git_for(&request.host, &request.path, journal::now_ms())
            .map(|(username, password)| LookupResponse {
                username: Some(username),
                password: Some(password),
            })
            .unwrap_or_default(),
        _ => LookupResponse::default(),
    };
    let mut payload = serde_json::to_vec(&response).map_err(io::Error::other)?;
    payload.push(b'\n');
    write.write_all(&payload).await?;
    write.flush().await
}

/// Configure git's credential helper in `env` via `GIT_CONFIG_*` and
/// `WEAVE_GIT_CREDENTIAL_SOCKET`, preserving any existing `GIT_CONFIG_*` entries.
///
/// For each normalized Project remote currently held by the Host (`host/owner/repo`), we
/// prepend an empty helper reset (`credential.https://<remote>.helper = ""`) followed by
/// `weave git-credential` (and the same for `<remote>.git`), so the Host's scoped token takes
/// precedence over global helpers such as `osxkeychain` or `gh` only for those exact
/// repositories. A fallback `credential.helper` entry also covers Projects whose git
/// credential is attached after the process started.
pub fn apply_environment(
    env: &mut BTreeMap<String, String>,
    socket: &Path,
    helper_exe: &Path,
    remotes: &[String],
) {
    env.insert(SOCKET_VARIABLE.to_owned(), socket.display().to_string());
    let helper_cmd = format!(
        "!'{}' git-credential",
        shell_single_quote(&helper_exe.display().to_string())
    );
    let mut count = env
        .get("GIT_CONFIG_COUNT")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut push = |key: String, value: String| {
        env.insert(format!("GIT_CONFIG_KEY_{count}"), key);
        env.insert(format!("GIT_CONFIG_VALUE_{count}"), value);
        count += 1;
    };
    push("credential.useHttpPath".to_owned(), "true".to_owned());
    push("credential.helper".to_owned(), helper_cmd.clone());
    for remote in remotes {
        for suffix in ["", ".git"] {
            let key = format!("credential.https://{remote}{suffix}.helper");
            push(key.clone(), String::new());
            push(key, helper_cmd.clone());
        }
    }
    env.insert("GIT_CONFIG_COUNT".to_owned(), count.to_string());
}

fn shell_single_quote(text: &str) -> String {
    text.replace('\'', "'\\''")
}

/// Client side of `weave git-credential <action>`, invoked by git.
///
/// Only answers `get` for `https` URLs; `store` and `erase` succeed silently so git never
/// writes tokens back. If the socket isn't set or unreachable, exits cleanly with no output so
/// git falls through to any other configured authentication.
pub async fn helper<R, W>(action: Option<&str>, mut input: R, mut output: W) -> io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    if action != Some("get") {
        return Ok(());
    }
    let Some(socket) = std::env::var_os(SOCKET_VARIABLE)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    else {
        return Ok(());
    };
    helper_io(&socket, &mut input, &mut output).await
}

async fn helper_io<R, W>(socket: &Path, input: &mut R, output: &mut W) -> io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let Some(request) = read_git_attributes(input).await? else {
        return Ok(());
    };
    if !request.protocol.eq_ignore_ascii_case("https")
        || request.host.is_empty()
        || request.path.is_empty()
    {
        return Ok(());
    }
    let response = match tokio::time::timeout(IO_TIMEOUT, query_socket(socket, &request)).await {
        Ok(Ok(response)) => response,
        // Socket absent, Host stopped, or timed out: stay silent so git can fall through.
        Ok(Err(_)) | Err(_) => return Ok(()),
    };
    if let (Some(username), Some(password)) = (response.username, response.password)
        && safe_line(&username)
        && safe_line(&password)
    {
        let reply = format!("username={username}\npassword={password}\n");
        output.write_all(reply.as_bytes()).await?;
        output.flush().await?;
    }
    Ok(())
}

fn safe_line(value: &str) -> bool {
    !value.is_empty() && !value.contains(['\r', '\n', '\0'])
}

async fn read_git_attributes<R: tokio::io::AsyncRead + Unpin>(
    input: &mut R,
) -> io::Result<Option<LookupRequest>> {
    let mut reader = BufReader::new(input.take(MAX_LINE_BYTES));
    let mut protocol = String::new();
    let mut host = String::new();
    let mut path = String::new();
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader.read_line(&mut line).await?;
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        match key {
            "protocol" => protocol = value.to_owned(),
            "host" => host = value.to_owned(),
            "path" => path = value.to_owned(),
            "url" => parse_url(value, &mut protocol, &mut host, &mut path),
            _ => {}
        }
    }
    if protocol.is_empty() && host.is_empty() && path.is_empty() {
        return Ok(None);
    }
    Ok(Some(LookupRequest {
        protocol,
        host,
        path,
    }))
}

fn parse_url(url: &str, protocol: &mut String, host: &mut String, path: &mut String) {
    let Some((scheme, rest)) = url.split_once("://") else {
        return;
    };
    let rest = match rest.split_once('@') {
        Some((_, after_user)) => after_user,
        None => rest,
    };
    let (h, p) = match rest.split_once('/') {
        Some((h, p)) => (h, p),
        None => (rest, ""),
    };
    if protocol.is_empty() {
        *protocol = scheme.to_owned();
    }
    if host.is_empty() {
        *host = h.to_owned();
    }
    if path.is_empty() {
        *path = p.to_owned();
    }
}

async fn query_socket(socket: &Path, request: &LookupRequest) -> io::Result<LookupResponse> {
    let mut stream = UnixStream::connect(socket).await?;
    let (read, mut write) = stream.split();
    let mut payload = serde_json::to_vec(request).map_err(io::Error::other)?;
    payload.push(b'\n');
    write.write_all(&payload).await?;
    write.flush().await?;
    write.shutdown().await?;

    let mut reader = BufReader::new(read.take(MAX_LINE_BYTES));
    let mut line = String::new();
    let bytes = reader.read_line(&mut line).await?;
    if bytes == 0 {
        return Ok(LookupResponse::default());
    }
    serde_json::from_str(line.trim()).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use weave_host_protocol::credentials::CredentialUse;
    use weave_host_protocol::credentials::HeldCredential;

    use super::*;
    use crate::Daemon;
    use crate::DaemonConfig;

    #[test]
    fn apply_environment_preserves_existing_git_config_entries() {
        let mut env = BTreeMap::from([
            ("GIT_CONFIG_COUNT".to_owned(), "1".to_owned()),
            ("GIT_CONFIG_KEY_0".to_owned(), "user.name".to_owned()),
            ("GIT_CONFIG_VALUE_0".to_owned(), "Jaco".to_owned()),
        ]);
        apply_environment(
            &mut env,
            Path::new("/run/user/1000/weave/git-credentials.sock"),
            Path::new("/opt/my tools/weave"),
            &["github.com/owner/repo".to_owned()],
        );
        assert_eq!(
            env.get(SOCKET_VARIABLE).map(String::as_str),
            Some("/run/user/1000/weave/git-credentials.sock")
        );
        assert_eq!(
            env.get("GIT_CONFIG_KEY_0").map(String::as_str),
            Some("user.name")
        );
        assert_eq!(
            env.get("GIT_CONFIG_KEY_1").map(String::as_str),
            Some("credential.useHttpPath")
        );
        assert_eq!(
            env.get("GIT_CONFIG_VALUE_1").map(String::as_str),
            Some("true")
        );
        assert_eq!(
            env.get("GIT_CONFIG_KEY_2").map(String::as_str),
            Some("credential.helper")
        );
        assert_eq!(
            env.get("GIT_CONFIG_VALUE_2").map(String::as_str),
            Some("!'/opt/my tools/weave' git-credential")
        );
        assert_eq!(
            env.get("GIT_CONFIG_KEY_3").map(String::as_str),
            Some("credential.https://github.com/owner/repo.helper")
        );
        assert_eq!(env.get("GIT_CONFIG_VALUE_3").map(String::as_str), Some(""));
        assert_eq!(
            env.get("GIT_CONFIG_KEY_4").map(String::as_str),
            Some("credential.https://github.com/owner/repo.helper")
        );
        assert_eq!(
            env.get("GIT_CONFIG_KEY_5").map(String::as_str),
            Some("credential.https://github.com/owner/repo.git.helper")
        );
        assert_eq!(env.get("GIT_CONFIG_VALUE_5").map(String::as_str), Some(""));
        assert_eq!(
            env.get("GIT_CONFIG_KEY_6").map(String::as_str),
            Some("credential.https://github.com/owner/repo.git.helper")
        );
        assert_eq!(env.get("GIT_CONFIG_COUNT").map(String::as_str), Some("7"));
    }

    #[tokio::test]
    async fn socket_answers_only_matching_https_repository() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket_path = dir.path().join("git-credentials.sock");
        let daemon = Daemon::new(DaemonConfig::in_process(None));
        daemon
            .shared
            .credentials
            .sync(vec![HeldCredential {
                name: "git:p-1:personal-git".to_owned(),
                used: CredentialUse::Git {
                    remote: "github.com/j/odin".to_owned(),
                    username: "x-access-token".to_owned(),
                },
                value: "ghp_secret_personal".to_owned(),
                expires_at: Some(journal::now_ms() + 60_000),
            }])
            .expect("synced");

        let server_daemon = daemon.clone();
        let server_socket = socket_path.clone();
        let server = tokio::spawn(async move {
            server_daemon
                .serve_git_credentials(&server_socket)
                .await
                .expect("served");
        });
        for _ in 0..50 {
            if socket_path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let query = |input: &'static str| {
            let socket_path = socket_path.clone();
            async move {
                let mut reader = input.as_bytes();
                let mut out = Vec::new();
                helper_io(&socket_path, &mut reader, &mut out)
                    .await
                    .expect("helper");
                String::from_utf8(out).expect("utf8")
            }
        };

        // Matching HTTPS repo (with .git suffix and mixed case host).
        assert_eq!(
            query("protocol=https\nhost=GitHub.com\npath=j/odin.git\n\n").await,
            "username=x-access-token\npassword=ghp_secret_personal\n"
        );
        // Matching via url= attribute.
        assert_eq!(
            query("url=https://github.com/j/odin\n\n").await,
            "username=x-access-token\npassword=ghp_secret_personal\n"
        );
        // Different repo on same host gets nothing.
        assert_eq!(
            query("protocol=https\nhost=github.com\npath=j/other.git\n\n").await,
            ""
        );
        // Plain HTTP never receives a token.
        assert_eq!(
            query("protocol=http\nhost=github.com\npath=j/odin.git\n\n").await,
            ""
        );

        daemon.stop();
        server.await.expect("stopped");
    }
}
