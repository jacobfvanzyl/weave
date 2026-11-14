//! Which repository a remote names (WVE-213): its host and path, such as
//! `github.com/owner/name`, the same on every Host whatever SSH host alias or git URL rewrite
//! a clone uses. git's rewrites (`url.<base>.insteadOf`) are git's to apply: [`crate::git`]
//! asks it for the URL it would use (`git remote get-url`). An SSH remote's host, scp-style
//! (`host:path`) or `ssh://`, is then the `hostname` SSH's configuration gives it, as `ssh -G`
//! prints it without connecting, honouring `Include` and `Match`, unless that's an address or a
//! name within the one written ([`standing_for`]); an HTTPS remote's is as written. Each target is looked up once and kept for the Host's life, but one that took too
//! long, which is tried again after a while; when ssh is missing, fails or takes too long, the
//! host stays as written. Hosts are compared ignoring case, as SSH and DNS compare them, so an
//! identity's host is lowercase.
//!
//! Lookups go through [`SshHosts`], so tests give their own and never read the person's SSH
//! configuration.

use std::collections::BTreeMap;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// How long `ssh -G` may take.
const SSH_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a lookup that took too long is left before it's tried again.
const LATE_RETRY: Duration = Duration::from_secs(60);

/// Where SSH would connect for a host it's given.
pub trait SshHosts: Send + Sync {
    /// The host SSH's configuration has it connect to for `target`.
    fn hostname<'a>(&'a self, target: &'a SshTarget) -> BoxFuture<'a, Hostname>;
}

/// What looking up an SSH host's `hostname` found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Hostname {
    /// The host SSH connects to.
    Is(String),
    /// SSH couldn't say: it's missing, or failed. Kept, as asking again would say the same.
    Unknown,
    /// SSH took too long. Asked again after a while.
    Late,
}

/// An SSH remote's user, host and port, each safe to pass to `ssh` as a value: a host that
/// isn't a plain name, such as one beginning with `-` or holding a space, isn't one, as git
/// refuses such hosts too, and a user that isn't plain is left out.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SshTarget {
    user: Option<String>,
    host: String,
    port: Option<u16>,
}

impl SshTarget {
    /// The target for `host`, lowercase as SSH matches it, with `user` and `port` where they're
    /// plain; none for a host that isn't a plain name.
    pub fn new(user: Option<&str>, host: &str, port: Option<&str>) -> Option<Self> {
        if !plain(host) {
            return None;
        }
        Some(Self {
            user: user.filter(|user| plain(user)).map(str::to_owned),
            host: host.to_ascii_lowercase(),
            port: port.and_then(|port| port.parse().ok()),
        })
    }

    pub fn user(&self) -> Option<&str> {
        self.user.as_deref()
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> Option<u16> {
        self.port
    }
}

/// Letters, digits, `.`, `_` and `-`, beginning with a letter or digit: nothing `ssh` could
/// read as an option, nor split into two arguments.
fn plain(text: &str) -> bool {
    text.chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// OpenSSH's own client, `ssh -G`, run with the agents' environment, as git runs it.
pub struct OpenSsh {
    environment: BTreeMap<String, String>,
}

impl OpenSsh {
    pub fn new(environment: &BTreeMap<String, String>) -> Self {
        Self {
            environment: environment.clone(),
        }
    }
}

impl SshHosts for OpenSsh {
    fn hostname<'a>(&'a self, target: &'a SshTarget) -> BoxFuture<'a, Hostname> {
        Box::pin(async move {
            let mut command = tokio::process::Command::new("ssh");
            command.arg("-G");
            if let Some(user) = target.user() {
                command.arg("-l").arg(user);
            }
            if let Some(port) = target.port() {
                command.arg("-p").arg(port.to_string());
            }
            command
                .arg("--")
                .arg(target.host())
                .envs(&self.environment)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            match tokio::time::timeout(SSH_TIMEOUT, command.output()).await {
                Err(_) => Hostname::Late,
                Ok(Ok(output)) if output.status.success() => {
                    configured_hostname(&String::from_utf8_lossy(&output.stdout))
                        .map_or(Hostname::Unknown, Hostname::Is)
                }
                Ok(_) => Hostname::Unknown,
            }
        })
    }
}

/// The `hostname` line of what `ssh -G` printed: one `keyword value` per line.
fn configured_hostname(printed: &str) -> Option<String> {
    printed.lines().find_map(|line| {
        let (keyword, value) = line.split_once(' ')?;
        let value = value.trim();
        (keyword.eq_ignore_ascii_case("hostname") && !value.is_empty()).then(|| value.to_owned())
    })
}

/// SSH hosts as written: none looked up, as for a Host whose tests mustn't read the person's
/// SSH configuration.
pub struct AsWritten;

impl SshHosts for AsWritten {
    fn hostname<'a>(&'a self, _target: &'a SshTarget) -> BoxFuture<'a, Hostname> {
        Box::pin(async { Hostname::Unknown })
    }
}

/// Remotes' identities for one Host, with what its SSH lookups found.
pub(crate) struct Remotes {
    ssh: Arc<dyn SshHosts>,
    known: Mutex<HashMap<SshTarget, Known>>,
}

/// What a lookup found, as kept.
#[derive(Clone)]
enum Known {
    /// The host to use instead, if any.
    Found(Option<String>),
    /// It took too long; ask again after this.
    Late(Instant),
}

impl std::fmt::Debug for Remotes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Remotes").finish_non_exhaustive()
    }
}

impl Remotes {
    pub(crate) fn new(ssh: Arc<dyn SshHosts>) -> Self {
        Self {
            ssh,
            known: Mutex::new(HashMap::new()),
        }
    }

    /// `url`'s identity, its host resolved through SSH's configuration when it's an SSH remote.
    /// None for a remote that's a path on this computer.
    pub(crate) async fn identity(&self, url: &str) -> Option<String> {
        let remote = Remote::parse(url)?;
        let target = SshTarget::new(remote.user, remote.host, remote.port).filter(|_| remote.ssh);
        let resolved = match target {
            Some(target) => self.hostname(&target).await,
            None => None,
        };
        Some(remote.identity(standing_for(remote.host, resolved).as_deref()))
    }

    /// `identity`, such as one another Host or an older record gives, with its host resolved
    /// here as an SSH host is: `github.com-kp/owner/name` is `github.com/owner/name` where
    /// `github.com-kp` is an alias for `github.com`.
    pub(crate) async fn resolved(&self, identity: &str) -> String {
        let Some((host, path)) = identity.split_once('/') else {
            return identity.to_owned();
        };
        let resolved = match SshTarget::new(None, host, None) {
            Some(target) => self.hostname(&target).await,
            None => None,
        };
        let host = standing_for(host, resolved).unwrap_or_else(|| host.to_owned());
        format!("{}/{path}", host.to_ascii_lowercase())
    }

    /// The host SSH connects to for `target`, if it says one: looked up once and kept, but
    /// for a lookup that took too long, which is tried again after [`LATE_RETRY`].
    async fn hostname(&self, target: &SshTarget) -> Option<String> {
        let known = lock(&self.known).get(target).cloned();
        match known {
            Some(Known::Found(host)) => return host,
            Some(Known::Late(until)) if Instant::now() < until => return None,
            _ => {}
        }
        let (kept, host) = match self.ssh.hostname(target).await {
            Hostname::Is(host) => (Known::Found(Some(host.clone())), Some(host)),
            Hostname::Unknown => (Known::Found(None), None),
            Hostname::Late => {
                tracing::warn!(
                    host = target.host(),
                    "ssh took too long to say where a remote's host goes; it's used as written \
                     for now"
                );
                (Known::Late(Instant::now() + LATE_RETRY), None)
            }
        };
        lock(&self.known).insert(target.clone(), kept);
        host
    }
}

/// The host `written` stands for, when SSH's configuration gives it a `hostname` that names
/// another: not an address, which names no repository's host, nor a name within the one written,
/// as `ssh.github.com` is within `github.com` where SSH reaches GitHub on port 443, which is the
/// same service, as an HTTPS remote of it is known by the name written.
fn standing_for(written: &str, hostname: Option<String>) -> Option<String> {
    let hostname = hostname?.to_ascii_lowercase();
    let written = written.to_ascii_lowercase();
    let within = hostname
        .strip_suffix(written.as_str())
        .is_some_and(|before| before.ends_with('.'));
    let address = hostname.parse::<std::net::IpAddr>().is_ok();
    (hostname != written && !within && !address).then_some(hostname)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A remote URL's parts that say where the repository is.
struct Remote<'a> {
    user: Option<&'a str>,
    host: &'a str,
    port: Option<&'a str>,
    /// Without slashes at either end or `.git`.
    path: &'a str,
    /// Reached over SSH: scp-style, or an `ssh://` URL.
    ssh: bool,
}

impl<'a> Remote<'a> {
    /// None for a remote that's a path on this computer, or one without a host or path.
    fn parse(url: &'a str) -> Option<Self> {
        let url = url.trim();
        let (ssh, authority, path) = match url.split_once("://") {
            Some((scheme, _)) if scheme.eq_ignore_ascii_case("file") => return None,
            Some((scheme, rest)) => {
                let (authority, path) = rest.split_once('/')?;
                let ssh = ["ssh", "git+ssh", "ssh+git"]
                    .iter()
                    .any(|ssh| scheme.eq_ignore_ascii_case(ssh));
                (ssh, authority, path)
            }
            None => {
                // `[user@]host:path`, unless a slash comes first, as in a path.
                let colon = url.find(':')?;
                if url[..colon].contains('/') {
                    return None;
                }
                (true, &url[..colon], &url[colon + 1..])
            }
        };
        let (user, host) = match authority.rsplit_once('@') {
            Some((user, host)) => (Some(user), host),
            None => (None, authority),
        };
        let (host, port) = match host.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => (host, Some(port)),
            _ => (host, None),
        };
        let path = path.trim_matches('/');
        let path = path
            .strip_suffix(".git")
            .unwrap_or(path)
            .trim_end_matches('/');
        (!host.is_empty() && !path.is_empty()).then_some(Self {
            user,
            host,
            port,
            path,
            ssh,
        })
    }

    /// `host/path`, with `resolved` for the host when there's one.
    fn identity(&self, resolved: Option<&str>) -> String {
        let host = resolved.unwrap_or(self.host).to_ascii_lowercase();
        format!("{host}/{}", self.path)
    }
}

/// A remote URL as written as a host and path, such as `github.com/owner/name`: no scheme,
/// credentials, port or `.git`, and no SSH host resolved. None for a remote that's a path on
/// this computer.
#[cfg(test)]
pub(crate) fn as_written(url: &str) -> Option<String> {
    Remote::parse(url).map(|remote| remote.identity(None))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use pretty_assertions::assert_eq;

    use super::*;

    /// SSH's configuration as a table of aliases, counting lookups and keeping each target.
    #[derive(Default)]
    struct Aliases {
        hosts: BTreeMap<String, Hostname>,
        asked: Mutex<Vec<SshTarget>>,
        count: AtomicUsize,
    }

    impl Aliases {
        fn with(hosts: &[(&str, Hostname)]) -> Arc<Self> {
            Arc::new(Self {
                hosts: hosts
                    .iter()
                    .map(|(host, found)| ((*host).to_owned(), found.clone()))
                    .collect(),
                ..Self::default()
            })
        }
    }

    impl SshHosts for Aliases {
        fn hostname<'a>(&'a self, target: &'a SshTarget) -> BoxFuture<'a, Hostname> {
            self.count.fetch_add(1, Ordering::SeqCst);
            lock(&self.asked).push(target.clone());
            let found = self
                .hosts
                .get(target.host())
                // SSH connects to a host no `Host` block names as it's written.
                .unwrap_or(&Hostname::Is(target.host().to_ascii_lowercase()))
                .clone();
            Box::pin(async move { found })
        }
    }

    #[test]
    fn remotes_as_written_are_host_and_path_without_credentials() {
        let cases = [
            (
                "git@github.com:jacobfvanzyl/weave.git",
                Some("github.com/jacobfvanzyl/weave"),
            ),
            (
                "https://jaco:t0ken@github.com/jacobfvanzyl/weave.git",
                Some("github.com/jacobfvanzyl/weave"),
            ),
            (
                "ssh://git@gitlab.example.com:2222/group/sub/project",
                Some("gitlab.example.com/group/sub/project"),
            ),
            (
                "git@github.com-kp:Keyphase-Technologies/odin.git",
                Some("github.com-kp/Keyphase-Technologies/odin"),
            ),
            (
                "https://github.com/jacobfvanzyl/weave/",
                Some("github.com/jacobfvanzyl/weave"),
            ),
            (
                "https://GitHub.com/jacobfvanzyl/Weave",
                Some("github.com/jacobfvanzyl/Weave"),
            ),
            ("file:///srv/git/weave.git", None),
            ("/srv/git/weave.git", None),
            ("../weave", None),
            ("./with:colon/repo", None),
        ];
        for (url, expected) in cases {
            assert_eq!(as_written(url).as_deref(), expected, "{url}");
        }
    }

    #[tokio::test]
    async fn an_ssh_alias_is_known_by_the_host_it_stands_for() {
        let aliases = Aliases::with(&[("github.com-kp", Hostname::Is("github.com".to_owned()))]);
        let remotes = Remotes::new(aliases.clone());
        for url in [
            "git@github.com-kp:Keyphase-Technologies/odin.git",
            "ssh://git@github.com-kp/Keyphase-Technologies/odin",
            "git+ssh://github.com-kp:22/Keyphase-Technologies/odin.git",
            "git@github.com:Keyphase-Technologies/odin.git",
        ] {
            assert_eq!(
                remotes.identity(url).await.as_deref(),
                Some("github.com/Keyphase-Technologies/odin"),
                "{url}"
            );
        }
        // The user and port go to SSH, for its `Match` blocks; the second URL's target was
        // the first's, so it wasn't asked again.
        assert_eq!(lock(&aliases.asked).len(), 3);
        assert_eq!(
            lock(&aliases.asked)[1],
            SshTarget {
                user: None,
                host: "github.com-kp".to_owned(),
                port: Some(22),
            }
        );
        assert_eq!(
            lock(&aliases.asked)[0],
            SshTarget {
                user: Some("git".to_owned()),
                host: "github.com-kp".to_owned(),
                port: None,
            }
        );
        // An identity another Host or an older record gives resolves the same way.
        assert_eq!(
            remotes
                .resolved("github.com-kp/Keyphase-Technologies/odin")
                .await,
            "github.com/Keyphase-Technologies/odin"
        );
    }

    #[tokio::test]
    async fn https_remotes_are_not_resolved_through_ssh() {
        let aliases =
            Aliases::with(&[("github.com", Hostname::Is("elsewhere.example".to_owned()))]);
        let remotes = Remotes::new(aliases.clone());
        assert_eq!(
            remotes
                .identity("https://github.com/jacobfvanzyl/weave.git")
                .await
                .as_deref(),
            Some("github.com/jacobfvanzyl/weave")
        );
        assert_eq!(remotes.identity("/srv/git/weave.git").await, None);
        assert_eq!(aliases.count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn each_target_is_looked_up_once() {
        let aliases = Aliases::with(&[("github.com-kp", Hostname::Is("github.com".to_owned()))]);
        let remotes = Remotes::new(aliases.clone());
        for _ in 0..3 {
            remotes.identity("git@github.com-kp:o/one.git").await;
            remotes.identity("git@github.com-kp:o/two.git").await;
        }
        assert_eq!(aliases.count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_host_ssh_cant_place_stays_as_written() {
        let aliases = Aliases::with(&[("broken", Hostname::Unknown), ("slow", Hostname::Late)]);
        let remotes = Remotes::new(aliases.clone());
        assert_eq!(
            remotes.identity("git@broken:o/r.git").await.as_deref(),
            Some("broken/o/r")
        );
        assert_eq!(
            remotes.identity("git@Slow:o/r.git").await.as_deref(),
            Some("slow/o/r")
        );
        // Failing is kept; taking too long is asked again only after a while.
        remotes.identity("git@broken:o/r.git").await;
        remotes.identity("git@Slow:o/r.git").await;
        assert_eq!(aliases.count.load(Ordering::SeqCst), 2);
        let remotes = Remotes::new(Arc::new(AsWritten));
        assert_eq!(
            remotes
                .identity("git@github.com-kp:o/r.git")
                .await
                .as_deref(),
            Some("github.com-kp/o/r")
        );
    }

    #[tokio::test]
    async fn a_host_that_isnt_a_plain_name_never_reaches_ssh() {
        let aliases = Aliases::with(&[]);
        let remotes = Remotes::new(aliases.clone());
        for url in [
            "-oProxyCommand=touch$IFS:o/r",
            "git@-oProxyCommand=x:o/r",
            "ssh://-oProxyCommand=x/o/r",
            "git@two words:o/r",
            "git@tab\there:o/r",
            "git@semi;colon:o/r",
            "git@.dot:o/r",
            "git@[::1]:o/r",
        ] {
            // Its identity is as written, never looked up.
            assert!(remotes.identity(url).await.is_some(), "{url}");
        }
        assert_eq!(aliases.count.load(Ordering::SeqCst), 0);
        assert_eq!(
            remotes.resolved("-oProxyCommand=x/o/r").await,
            "-oproxycommand=x/o/r"
        );
        assert_eq!(aliases.count.load(Ordering::SeqCst), 0);
        // A user that isn't plain is left out, and the host still looked up.
        assert_eq!(
            SshTarget::new(Some("-oProxyCommand=x"), "github.com-kp", Some("x")),
            Some(SshTarget {
                user: None,
                host: "github.com-kp".to_owned(),
                port: None,
            })
        );
        assert_eq!(SshTarget::new(None, "-p", None), None);
        assert_eq!(SshTarget::new(None, "", None), None);
    }

    #[tokio::test]
    async fn a_hostname_within_the_host_or_an_address_leaves_it_as_written() {
        let aliases = Aliases::with(&[
            ("github.com", Hostname::Is("ssh.github.com".to_owned())),
            ("gitlab.corp", Hostname::Is("10.0.0.5".to_owned())),
            ("kp.github.com", Hostname::Is("github.com".to_owned())),
        ]);
        let remotes = Remotes::new(aliases);
        for (url, expected) in [
            ("git@github.com:o/r.git", "github.com/o/r"),
            ("git@gitlab.corp:o/r.git", "gitlab.corp/o/r"),
            ("git@kp.github.com:o/r.git", "github.com/o/r"),
        ] {
            assert_eq!(
                remotes.identity(url).await.as_deref(),
                Some(expected),
                "{url}"
            );
        }
    }

    #[test]
    fn ssh_g_gives_the_hostname_line() {
        let printed = "host github.com-kp\nuser git\nhostname github.com\nport 22\n";
        assert_eq!(configured_hostname(printed).as_deref(), Some("github.com"));
        assert_eq!(configured_hostname("user git\n"), None);
    }
}
