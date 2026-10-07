//! The ACP agent registry: a catalog of agents and how to launch them, which `--agent <id>`
//! falls back to after the config's agents and the presets, as Zed and Toad offer them.
//!
//! See <https://agentclientprotocol.com/get-started/registry>. The catalog is cached for a
//! day. Agents distributed as npm or PyPI packages run through `npx` or `uvx`; a binary
//! distribution is downloaded once for this platform, checked against its sha256 when the
//! registry gives one, and unpacked into the cache.

use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::SystemTime;

use anyhow::Context;
use anyhow::bail;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use weave_acp_core::AgentSpec;

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/// How long a fetched catalog is used before it is fetched again.
const MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
/// Written into an agent's directory once it is completely unpacked.
const INSTALLED_MARKER: &str = ".weave-installed";

/// The aggregated `registry.json`. Fields weave doesn't use are ignored, so additions to the
/// format don't break it.
#[derive(Debug, Deserialize)]
pub struct Registry {
    pub agents: Vec<RegistryAgent>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RegistryAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub distribution: Distribution,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Distribution {
    /// Archives by platform, as `darwin-aarch64`.
    #[serde(default)]
    pub binary: BTreeMap<String, BinaryTarget>,
    pub npx: Option<Package>,
    pub uvx: Option<Package>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct BinaryTarget {
    pub archive: String,
    /// The program, relative to the unpacked archive.
    pub cmd: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Package {
    /// The package, with its version.
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// How an agent runs on one platform.
#[derive(Clone, Copy, Debug)]
pub enum Launcher<'a> {
    Binary(&'a BinaryTarget),
    Npx(&'a Package),
    Uvx(&'a Package),
}

impl Launcher<'_> {
    pub fn kind(self) -> &'static str {
        match self {
            Self::Binary(_) => "binary",
            Self::Npx(_) => "npx",
            Self::Uvx(_) => "uvx",
        }
    }
}

impl Registry {
    pub fn parse(bytes: &[u8]) -> anyhow::Result<Self> {
        serde_json::from_slice(bytes).context("reading the ACP agent registry")
    }

    pub fn find(&self, id: &str) -> Option<&RegistryAgent> {
        self.agents.iter().find(|agent| agent.id == id)
    }
}

impl RegistryAgent {
    /// How the agent runs on `platform`: its own build when there's one, needing no runtime,
    /// else its npm package, else its PyPI package.
    pub fn launcher(&self, platform: &str) -> Option<Launcher<'_>> {
        let distribution = &self.distribution;
        distribution
            .binary
            .get(platform)
            .map(Launcher::Binary)
            .or_else(|| distribution.npx.as_ref().map(Launcher::Npx))
            .or_else(|| distribution.uvx.as_ref().map(Launcher::Uvx))
    }
}

/// This machine's platform as the registry names them, such as `darwin-aarch64`.
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// Where the catalog and unpacked agents are kept.
pub struct Cache {
    root: PathBuf,
}

impl Cache {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// `$XDG_CACHE_HOME/weave`, else `~/.cache/weave`.
    pub fn default_location() -> anyhow::Result<Self> {
        let base = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache")))
            .context("no cache directory for the agent registry: set HOME or XDG_CACHE_HOME")?;
        Ok(Self::new(base.join("weave")))
    }

    fn catalog(&self) -> PathBuf {
        self.root.join("registry.json")
    }

    /// Where `agent`'s build for `platform` is unpacked.
    fn agent_dir(&self, agent: &RegistryAgent, platform: &str) -> anyhow::Result<PathBuf> {
        for part in [&agent.id, &agent.version] {
            let safe = !part.is_empty()
                && !part.starts_with('.')
                && part
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "-_.+".contains(ch));
            if !safe {
                bail!(
                    "the registry entry {:?} has an unusable id or version",
                    agent.id
                );
            }
        }
        Ok(self
            .root
            .join("agents")
            .join(&agent.id)
            .join(&agent.version)
            .join(platform))
    }
}

/// The catalog, and how current it is.
pub struct Loaded {
    pub registry: Registry,
    pub fetched: SystemTime,
    /// Why an out-of-date copy is being used, when it is.
    pub warning: Option<String>,
}

/// The catalog: the cached copy while it is less than a day old (unless `refresh`), else
/// fetched again, falling back to the cached copy when that fails.
pub async fn load(cache: &Cache, refresh: bool) -> anyhow::Result<Loaded> {
    let path = cache.catalog();
    let cached_at = std::fs::metadata(&path)
        .and_then(|metadata| metadata.modified())
        .ok();
    let fresh = cached_at.is_some_and(|at| at.elapsed().is_ok_and(|age| age < MAX_AGE));
    if fresh
        && !refresh
        && let (Some(fetched), Ok(registry)) = (cached_at, read_catalog(&path))
    {
        return Ok(Loaded {
            registry,
            fetched,
            warning: None,
        });
    }
    match fetch(REGISTRY_URL).await {
        Ok(bytes) => {
            let registry = Registry::parse(&bytes)?;
            // A cache that can't be written only costs a fetch next time.
            let warning = write_atomically(&path, &bytes)
                .err()
                .map(|error| format!("couldn't cache the ACP agent registry: {error:#}"));
            Ok(Loaded {
                registry,
                fetched: SystemTime::now(),
                warning,
            })
        }
        Err(error) => match (cached_at, read_catalog(&path)) {
            (Some(fetched), Ok(registry)) => Ok(Loaded {
                registry,
                fetched,
                warning: Some(format!(
                    "couldn't refresh the ACP agent registry ({error:#}); using the copy from \
                     {} ago",
                    age(fetched)
                )),
            }),
            _ => Err(error.context("fetching the ACP agent registry")),
        },
    }
}

fn read_catalog(path: &Path) -> anyhow::Result<Registry> {
    Registry::parse(&std::fs::read(path)?)
}

fn write_atomically(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    let dir = path.parent().context("cache path")?;
    std::fs::create_dir_all(dir)?;
    let temporary = dir.join(format!(".registry-{}.json", std::process::id()));
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// How long ago `at` was, roughly, as "3 hours".
pub fn age(at: SystemTime) -> String {
    let seconds = at.elapsed().map(|age| age.as_secs()).unwrap_or_default();
    let (count, unit) = match seconds {
        0..120 => return "moments".to_owned(),
        120..7_200 => (seconds / 60, "minutes"),
        7_200..172_800 => (seconds / 3_600, "hours"),
        _ => (seconds / 86_400, "days"),
    };
    format!("{count} {unit}")
}

fn client() -> anyhow::Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("weave/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .context("creating an HTTP client")
}

async fn fetch(url: &str) -> anyhow::Result<Vec<u8>> {
    let response = client()?
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await?
        .error_for_status()?;
    Ok(response.bytes().await?.to_vec())
}

/// How to launch `agent` on this machine, downloading its build first if that's how it runs
/// and it isn't unpacked yet.
pub async fn agent_spec(cache: &Cache, agent: &RegistryAgent) -> anyhow::Result<AgentSpec> {
    let platform = platform();
    let Some(launcher) = agent.launcher(&platform) else {
        bail!(
            "{} has no build for {platform} and no npx or uvx package",
            agent.name
        );
    };
    let (mut spec, env) = match launcher {
        Launcher::Npx(package) => (
            AgentSpec::new(
                "npx",
                ["-y", package.package.as_str()]
                    .into_iter()
                    .chain(package.args.iter().map(String::as_str)),
            ),
            &package.env,
        ),
        Launcher::Uvx(package) => (
            AgentSpec::new(
                "uvx",
                std::iter::once(package.package.as_str())
                    .chain(package.args.iter().map(String::as_str)),
            ),
            &package.env,
        ),
        Launcher::Binary(target) => {
            let program = install(cache, agent, target, &platform).await?;
            (
                AgentSpec::new(program.to_string_lossy(), target.args.iter()),
                &target.env,
            )
        }
    };
    spec.env.extend(env.clone());
    Ok(spec)
}

/// The program of `agent`'s build for `platform`, downloaded and unpacked the first time.
async fn install(
    cache: &Cache,
    agent: &RegistryAgent,
    target: &BinaryTarget,
    platform: &str,
) -> anyhow::Result<PathBuf> {
    let dir = cache.agent_dir(agent, platform)?;
    let program = program_path(&target.cmd)?;
    if dir.join(INSTALLED_MARKER).is_file() {
        return Ok(dir.join(program));
    }
    let parent = dir.parent().context("agent directory")?.to_owned();
    std::fs::create_dir_all(&parent).with_context(|| format!("creating {}", parent.display()))?;
    eprintln!(
        "Downloading {} {} for {platform} from {}",
        agent.name, agent.version, target.archive
    );
    let archive = parent.join(format!(".download-{}", std::process::id()));
    let downloaded = download(&target.archive, &archive, target.sha256.as_deref()).await;
    let installed = match downloaded {
        Ok(()) => {
            let target = target.clone();
            let (archive, dir) = (archive.clone(), dir.clone());
            tokio::task::spawn_blocking(move || unpack_into(&archive, &target, &dir))
                .await
                .context("unpacking")?
        }
        Err(error) => Err(error),
    };
    let _ = std::fs::remove_file(&archive);
    installed.with_context(|| format!("installing {} {}", agent.name, agent.version))?;
    Ok(dir.join(program))
}

/// Download `url` to `to`, checking it against `sha256` when given.
async fn download(url: &str, to: &Path, sha256: Option<&str>) -> anyhow::Result<()> {
    let mut response = client()?.get(url).send().await?.error_for_status()?;
    let mut file = File::create(to).with_context(|| format!("creating {}", to.display()))?;
    let mut hasher = Sha256::new();
    while let Some(chunk) = response.chunk().await? {
        hasher.update(&chunk);
        file.write_all(&chunk)?;
    }
    file.flush()?;
    if let Some(expected) = sha256 {
        verify(&hasher.finalize(), expected)?;
    }
    Ok(())
}

fn verify(digest: &[u8], expected: &str) -> anyhow::Result<()> {
    let actual: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    if !actual.eq_ignore_ascii_case(expected.trim()) {
        bail!("the download's sha256 is {actual}, but the registry says {expected}");
    }
    Ok(())
}

/// Unpack `archive` for `target` into `dir`, replacing anything there, so that `dir` is
/// either absent or complete.
fn unpack_into(archive: &Path, target: &BinaryTarget, dir: &Path) -> anyhow::Result<()> {
    let parent = dir.parent().context("agent directory")?;
    let staging = parent.join(format!(".unpack-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;
    let unpacked = unpack(archive, &target.archive, &target.cmd, &staging).and_then(|()| {
        let program = staging.join(program_path(&target.cmd)?);
        if !program.is_file() {
            bail!("the archive has no {}", target.cmd);
        }
        make_executable(&program)?;
        std::fs::write(staging.join(INSTALLED_MARKER), "")?;
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
        }
        std::fs::rename(&staging, dir)?;
        Ok(())
    });
    if unpacked.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    unpacked
}

/// Unpack `archive`, downloaded from `url`, into `dest`, by the kind of file the URL names.
/// A download that isn't an archive is the program itself, saved where `cmd` names it.
fn unpack(archive: &Path, url: &str, cmd: &str, dest: &Path) -> anyhow::Result<()> {
    let name = url
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let file = File::open(archive)?;
    if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        untar(flate2::read::GzDecoder::new(file), dest)
    } else if name.ends_with(".tar.bz2") || name.ends_with(".tbz2") || name.ends_with(".tbz") {
        untar(bzip2::read::BzDecoder::new(file), dest)
    } else if name.ends_with(".tar") {
        untar(file, dest)
    } else if name.ends_with(".zip") {
        // Entries naming paths outside `dest` are refused.
        zip::ZipArchive::new(file)?.extract(dest)?;
        Ok(())
    } else {
        let program = dest.join(program_path(cmd)?);
        if let Some(parent) = program.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(archive, &program)?;
        Ok(())
    }
}

fn untar(reader: impl Read, dest: &Path) -> anyhow::Result<()> {
    let mut archive = tar::Archive::new(reader);
    archive.set_preserve_permissions(true);
    // Entries naming paths outside `dest` are skipped.
    archive.unpack(dest)?;
    Ok(())
}

/// `cmd` as a path inside the unpacked archive.
fn program_path(cmd: &str) -> anyhow::Result<PathBuf> {
    let path: PathBuf = Path::new(cmd)
        .components()
        .filter(|component| !matches!(component, Component::CurDir))
        .collect();
    let inside = !path.as_os_str().is_empty()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    if !inside {
        bail!("the registry's command {cmd:?} isn't a path inside the agent's archive");
    }
    Ok(path)
}

#[cfg(unix)]
fn make_executable(program: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = std::fs::metadata(program)?.permissions();
    if permissions.mode() & 0o111 == 0 {
        permissions.set_mode(permissions.mode() | 0o755);
        std::fs::set_permissions(program, permissions)?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_program: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    const CATALOG: &str = r#"{
        "version": "1.0.0",
        "agents": [
            {
                "id": "tool",
                "name": "Tool",
                "version": "1.2.0",
                "description": "A binary agent",
                "icon": "https://example.com/tool.svg",
                "distribution": {
                    "binary": {
                        "darwin-aarch64": {
                            "archive": "https://example.com/tool.tar.gz",
                            "cmd": "./bin/tool",
                            "args": ["acp"],
                            "env": {"TOOL_MODE": "acp"}
                        }
                    },
                    "npx": {"package": "tool@1.2.0", "args": ["--acp"]}
                }
            },
            {
                "id": "py",
                "name": "Py",
                "version": "0.1.0",
                "description": "A Python agent",
                "distribution": {"uvx": {"package": "py-agent==0.1.0"}}
            }
        ],
        "extensions": []
    }"#;

    #[test]
    fn agents_prefer_their_own_build_then_npx_then_uvx() {
        let registry = Registry::parse(CATALOG.as_bytes()).expect("catalog");
        let tool = registry.find("tool").expect("tool");
        assert_eq!(
            tool.launcher("darwin-aarch64").map(Launcher::kind),
            Some("binary")
        );
        assert_eq!(
            tool.launcher("linux-x86_64").map(Launcher::kind),
            Some("npx")
        );
        let py = registry.find("py").expect("py");
        assert_eq!(
            py.launcher("darwin-aarch64").map(Launcher::kind),
            Some("uvx")
        );
        assert!(registry.find("missing").is_none());
    }

    #[tokio::test]
    async fn package_agents_run_through_npx_and_uvx() {
        let registry = Registry::parse(CATALOG.as_bytes()).expect("catalog");
        let cache = Cache::new(PathBuf::from("/nonexistent"));
        let py = agent_spec(&cache, registry.find("py").expect("py"))
            .await
            .expect("spec");
        assert_eq!(py.display_command(), "uvx py-agent==0.1.0");
        let mut tool = registry.find("tool").expect("tool").clone();
        tool.distribution.binary.clear();
        let tool = agent_spec(&cache, &tool).await.expect("spec");
        assert_eq!(tool.display_command(), "npx -y tool@1.2.0 --acp");
    }

    #[tokio::test]
    async fn an_unpacked_build_runs_from_the_cache() {
        let root = tempfile::tempdir().expect("tempdir");
        let cache = Cache::new(root.path().to_owned());
        let registry = Registry::parse(CATALOG.as_bytes()).expect("catalog");
        let mut tool = registry.find("tool").expect("tool").clone();
        let target = tool
            .distribution
            .binary
            .remove("darwin-aarch64")
            .expect("target");
        tool.distribution.binary.insert(platform(), target);
        let dir = cache.agent_dir(&tool, &platform()).expect("dir");
        std::fs::create_dir_all(dir.join("bin")).expect("dirs");
        std::fs::write(dir.join("bin/tool"), "").expect("program");
        std::fs::write(dir.join(INSTALLED_MARKER), "").expect("marker");

        let spec = agent_spec(&cache, &tool).await.expect("spec");
        assert_eq!(PathBuf::from(&spec.command), dir.join("bin/tool"));
        assert_eq!(spec.args, ["acp"]);
        assert_eq!(spec.env.get("TOOL_MODE").map(String::as_str), Some("acp"));
    }

    fn tar_gz(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (path, data, mode) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(*mode);
            header.set_cksum();
            builder
                .append_data(&mut header, path, *data)
                .expect("entry");
        }
        builder
            .into_inner()
            .and_then(flate2::write::GzEncoder::finish)
            .expect("archive")
    }

    fn target(archive: &str, cmd: &str) -> BinaryTarget {
        BinaryTarget {
            archive: archive.to_owned(),
            cmd: cmd.to_owned(),
            args: Vec::new(),
            env: BTreeMap::new(),
            sha256: None,
        }
    }

    #[test]
    fn archives_unpack_completely_or_not_at_all() {
        let root = tempfile::tempdir().expect("tempdir");
        let archive = root.path().join("download");
        let dir = root.path().join("agent");

        std::fs::write(&archive, tar_gz(&[("bin/tool", b"#!/bin/sh\n", 0o644)])).expect("write");
        unpack_into(
            &archive,
            &target("https://x/tool.tar.gz", "./bin/tool"),
            &dir,
        )
        .expect("unpacked");
        assert!(dir.join(INSTALLED_MARKER).is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("bin/tool"))
                .expect("program")
                .permissions()
                .mode();
            assert_eq!(mode & 0o111, 0o111);
        }

        // An archive without the program leaves nothing behind.
        let other = root.path().join("other");
        std::fs::write(&archive, tar_gz(&[("README", b"hi", 0o644)])).expect("write");
        assert!(unpack_into(&archive, &target("https://x/a.tgz", "./tool"), &other).is_err());
        assert!(!other.exists());
    }

    #[test]
    fn zips_and_bare_programs_unpack() {
        let root = tempfile::tempdir().expect("tempdir");
        let archive = root.path().join("download");
        let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        zip.start_file("tool", zip::write::SimpleFileOptions::default())
            .expect("entry");
        zip.write_all(b"program").expect("data");
        let bytes = zip.finish().expect("zip").into_inner();
        std::fs::write(&archive, bytes).expect("write");
        let dir = root.path().join("zipped");
        unpack_into(&archive, &target("https://x/tool.zip", "./tool"), &dir).expect("zip");
        assert_eq!(std::fs::read(dir.join("tool")).expect("tool"), b"program");

        std::fs::write(&archive, b"binary").expect("write");
        let dir = root.path().join("bare");
        unpack_into(
            &archive,
            &target("https://x/download/tool-linux-amd64?raw=1", "./tool"),
            &dir,
        )
        .expect("bare");
        assert_eq!(std::fs::read(dir.join("tool")).expect("tool"), b"binary");
    }

    #[test]
    fn commands_stay_inside_the_archive() {
        assert_eq!(
            program_path("./bin/tool").expect("inside"),
            PathBuf::from("bin/tool")
        );
        assert!(program_path("../tool").is_err());
        assert!(program_path("/usr/bin/tool").is_err());
        assert!(program_path("./").is_err());
    }

    #[test]
    fn checksums_must_match() {
        let digest = Sha256::digest(b"abc");
        assert!(
            verify(
                &digest,
                "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD"
            )
            .is_ok()
        );
        assert!(verify(&digest, "00").is_err());
    }

    #[test]
    fn unusable_ids_and_versions_never_become_paths() {
        let cache = Cache::new(PathBuf::from("/cache"));
        let mut agent = Registry::parse(CATALOG.as_bytes())
            .expect("catalog")
            .agents
            .remove(0);
        assert_eq!(
            cache.agent_dir(&agent, "linux-x86_64").expect("dir"),
            PathBuf::from("/cache/agents/tool/1.2.0/linux-x86_64")
        );
        agent.version = "../../etc".to_owned();
        assert!(cache.agent_dir(&agent, "linux-x86_64").is_err());
    }
}
