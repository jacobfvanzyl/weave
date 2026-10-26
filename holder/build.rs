//! Builds libghostty-vt at the commit `ghostty.toml` pins, and links it statically (ADR 0022).
//!
//! The library comes from the first of:
//!
//! - `$GHOSTTY_VT_PREFIX`, a prefix that already holds `lib/libghostty-vt.a` and `include/`;
//! - the cache (`$WEAVE_GHOSTTY_CACHE`, else `$XDG_CACHE_HOME/weave/ghostty`, else
//!   `~/.cache/weave/ghostty`), which keeps one build per pinned commit and target, shared by
//!   every checkout and worktree;
//! - a build into the cache, with Ghostty's source from `$GHOSTTY_SRC` (a checkout at the pinned
//!   commit) or fetched with git, and Zig from `$ZIG`, from `zig` on PATH when its version is the
//!   pin's, or downloaded from ziglang.org and checked against the pin's checksum.
//!
//! A build into the cache also lays out Ghostty's resources as Ghostty's own (`share/ghostty`
//! with the shell integration, `share/terminfo` with its terminfo compiled by `tic`), which the
//! holder embeds (`resources.rs` in `OUT_DIR`) and writes out where its shells can find them.
//!
//! The bindings in `src/ffi/bindings.rs` are committed, so building needs no libclang;
//! `--features bindgen` regenerates them from the headers of the build it links.

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::fs::File;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;

#[derive(Deserialize)]
struct Pin {
    ghostty: GhosttyPin,
    zig: ZigPin,
}

#[derive(Deserialize)]
struct GhosttyPin {
    repository: String,
    commit: String,
}

#[derive(Deserialize)]
struct ZigPin {
    version: String,
    downloads: BTreeMap<String, Download>,
}

#[derive(Deserialize)]
struct Download {
    url: String,
    sha256: String,
}

type Result<T> = std::result::Result<T, String>;

/// What a cached build holds, written to its `.complete`; a build of another layout is redone.
/// 2: Ghostty's resources in `share/`.
const LAYOUT: &str = "2";

/// Prints Ghostty's terminfo source, as `ghostty +terminfo` does (`src/main_build_data.zig`
/// upstream).
const GEN_TERMINFO: &str = r#"const std = @import("std");
const terminfo = @import("terminfo");

pub fn main(init: std.process.Init) !void {
    var buffer: [1024]u8 = undefined;
    var stdout_writer = std.Io.File.stdout().writerStreaming(init.io, &buffer);
    try terminfo.ghostty.encode(&stdout_writer.interface);
    try stdout_writer.end();
}
"#;

fn main() {
    if let Err(error) = run() {
        eprintln!("weave-holder: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    for var in [
        "GHOSTTY_VT_PREFIX",
        "GHOSTTY_SRC",
        "ZIG",
        "WEAVE_GHOSTTY_CACHE",
    ] {
        println!("cargo:rerun-if-env-changed={var}");
    }
    println!("cargo:rerun-if-changed=ghostty.toml");
    let manifest = PathBuf::from(var("CARGO_MANIFEST_DIR")?);
    let pin: Pin = toml::from_str(&read(&manifest.join("ghostty.toml"))?)
        .map_err(|error| format!("ghostty.toml: {error}"))?;
    println!(
        "cargo:rustc-env=WEAVE_GHOSTTY_COMMIT={}",
        pin.ghostty.commit
    );

    let prefix = match env::var_os("GHOSTTY_VT_PREFIX") {
        Some(prefix) => PathBuf::from(prefix),
        None => cached_build(&pin)?,
    };
    link(&prefix)?;
    embed_resources(&prefix)?;
    #[cfg(feature = "bindgen")]
    bindings(&prefix, &manifest)?;
    Ok(())
}

/// The prefix of this commit's build for the target, building it first if the cache has none.
fn cached_build(pin: &Pin) -> Result<PathBuf> {
    let cache = cache_dir()?;
    let target = zig_name(&var("TARGET")?)?;
    let commit_dir = cache.join(&pin.ghostty.commit);
    let prefix = commit_dir.join(&target);
    let complete = prefix.join(".complete");
    if fs::read_to_string(&complete).is_ok_and(|layout| layout == LAYOUT) {
        return Ok(prefix);
    }

    create_dir(&commit_dir)?;
    // One build at a time across checkouts; the one that waited finds the other's build.
    let lock = File::create(cache.join(".lock")).map_err(|error| format!("cache lock: {error}"))?;
    lock.lock()
        .map_err(|error| format!("cache lock: {error}"))?;
    if fs::read_to_string(&complete).is_ok_and(|layout| layout == LAYOUT) {
        return Ok(prefix);
    }
    prune(&cache, pin)?;

    let fetched = commit_dir.join("src");
    let src = match env::var_os("GHOSTTY_SRC") {
        Some(src) => checked_checkout(PathBuf::from(src), pin)?,
        None => fetch_source(&fetched, pin)?,
    };
    let zig = zig(&cache, pin)?;
    println!(
        "cargo:warning=building libghostty-vt at Ghostty {} into {}, once per pin",
        short(&pin.ghostty.commit),
        commit_dir.display()
    );

    let staging = commit_dir.join(format!("{target}.partial"));
    remove_dir(&staging)?;
    let local_cache = commit_dir.join("zig-local");
    let mut build = Command::new(&zig);
    build
        .current_dir(&src)
        .env("ZIG_GLOBAL_CACHE_DIR", cache.join("zig-global"))
        .args([
            "build",
            "-Demit-lib-vt",
            "-Demit-xcframework=false",
            "-Doptimize=ReleaseFast",
        ]);
    if var("TARGET")? != var("HOST")? {
        build.arg(format!("-Dtarget={}", zig_triple(&var("TARGET")?)?));
    }
    build
        .arg("--prefix")
        .arg(&staging)
        .arg("--cache-dir")
        .arg(&local_cache);
    status(&mut build, "zig build")?;
    resources(&zig, &src, &staging, &local_cache, &cache)?;

    remove_dir(&prefix)?;
    rename(&staging, &prefix)?;
    fs::write(&complete, LAYOUT).map_err(|error| format!("{}: {error}", complete.display()))?;
    // Only the build is kept; the source and Zig's cache of it come back if the pin does.
    remove_dir(&local_cache)?;
    remove_dir(&fetched)?;
    Ok(prefix)
}

/// Lays out Ghostty's shell integration and its terminfo under `prefix/share`, as Ghostty
/// installs its own resources.
fn resources(
    zig: &Path,
    src: &Path,
    prefix: &Path,
    local_cache: &Path,
    cache: &Path,
) -> Result<()> {
    copy_dir(
        &src.join("src/shell-integration"),
        &prefix.join("share/ghostty/shell-integration"),
    )?;
    let terminfo = prefix.join("share/terminfo");
    create_dir(&terminfo)?;
    create_dir(local_cache)?;
    let script = local_cache.join("gen-terminfo.zig");
    fs::write(&script, GEN_TERMINFO).map_err(|error| format!("{}: {error}", script.display()))?;
    let output = Command::new(zig)
        .current_dir(src)
        .env("ZIG_GLOBAL_CACHE_DIR", cache.join("zig-global"))
        .arg("run")
        .arg("--cache-dir")
        .arg(local_cache)
        .args(["--dep", "terminfo"])
        .arg(format!("-Mroot={}", script.display()))
        .arg(format!(
            "-Mterminfo={}",
            src.join("src/terminfo/main.zig").display()
        ))
        .output()
        .map_err(|error| format!("generating the terminfo: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "generating the terminfo: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let source = terminfo.join("ghostty.terminfo");
    fs::write(&source, &output.stdout).map_err(|error| format!("{}: {error}", source.display()))?;
    status(
        Command::new("tic")
            .arg("-x")
            .arg("-o")
            .arg(&terminfo)
            .arg(&source),
        "compiling the terminfo with tic",
    )
}

/// Writes `resources.rs` into `OUT_DIR`: every file under `prefix/share`, embedded, by its path
/// below `share/`'s parent. A prefix without resources embeds none.
fn embed_resources(prefix: &Path) -> Result<()> {
    let mut files = Vec::new();
    let share = prefix.join("share");
    if share.is_dir() {
        walk(prefix, &share, &mut files)?;
    } else {
        println!(
            "cargo:warning={} has no share/; holders will start shells without Ghostty's terminfo or shell integration",
            prefix.display()
        );
    }
    files.sort();
    let mut code = String::from(
        "/// Ghostty's resources, by their path under the resources directory.\n\
         pub static FILES: &[(&str, &[u8])] = &[\n",
    );
    for (relative, absolute) in &files {
        code.push_str(&format!(
            "    ({relative:?}, include_bytes!({absolute:?})),\n"
        ));
    }
    code.push_str("];\n");
    let path = PathBuf::from(var("OUT_DIR")?).join("resources.rs");
    fs::write(&path, code).map_err(|error| format!("{}: {error}", path.display()))
}

/// Every file below `dir`, as its path relative to `root` and its absolute path.
fn walk(root: &Path, dir: &Path, files: &mut Vec<(String, String)>) -> Result<()> {
    let entries = fs::read_dir(dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|error| format!("{}: {error}", dir.display()))?
            .path();
        if path.is_dir() {
            walk(root, &path, files)?;
        } else if let Ok(relative) = path.strip_prefix(root) {
            files.push((
                relative.to_string_lossy().into_owned(),
                path.to_string_lossy().into_owned(),
            ));
        }
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    create_dir(to)?;
    let entries = fs::read_dir(from).map_err(|error| format!("{}: {error}", from.display()))?;
    for entry in entries {
        let path = entry
            .map_err(|error| format!("{}: {error}", from.display()))?
            .path();
        let Some(name) = path.file_name() else {
            continue;
        };
        if path.is_dir() {
            copy_dir(&path, &to.join(name))?;
        } else {
            fs::copy(&path, to.join(name))
                .map_err(|error| format!("{}: {error}", path.display()))?;
        }
    }
    Ok(())
}

fn cache_dir() -> Result<PathBuf> {
    if let Some(dir) = env::var_os("WEAVE_GHOSTTY_CACHE").filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    if let Some(dir) = env::var_os("XDG_CACHE_HOME").filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir).join("weave/ghostty"));
    }
    let home = env::var_os("HOME").ok_or("HOME isn't set; set WEAVE_GHOSTTY_CACHE")?;
    Ok(PathBuf::from(home).join(".cache/weave/ghostty"))
}

/// Removes builds of other commits and other versions of Zig, which only an older pin needs.
fn prune(cache: &Path, pin: &Pin) -> Result<()> {
    let zig = format!("zig-{}", pin.zig.version);
    let entries = fs::read_dir(cache).map_err(|error| format!("{}: {error}", cache.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let commit = name.len() == 40 && name.bytes().all(|byte| byte.is_ascii_hexdigit());
        let other_zig = name.starts_with("zig-") && name != "zig-global" && name != zig;
        if (commit && name != pin.ghostty.commit) || other_zig {
            remove_dir(&entry.path())?;
        }
    }
    Ok(())
}

/// Ghostty's source at the pinned commit, fetched alone (`--depth 1`) into `dir`.
fn fetch_source(dir: &Path, pin: &Pin) -> Result<PathBuf> {
    remove_dir(dir)?;
    create_dir(dir)?;
    git(dir, &["init", "-q"])?;
    git(
        dir,
        &[
            "fetch",
            "-q",
            "--depth",
            "1",
            &pin.ghostty.repository,
            &pin.ghostty.commit,
        ],
    )?;
    git(
        dir,
        &[
            "-c",
            "advice.detachedHead=false",
            "checkout",
            "-q",
            "FETCH_HEAD",
        ],
    )?;
    checked_checkout(dir.to_path_buf(), pin)
}

/// `src`, refused unless git says it's at the pinned commit.
fn checked_checkout(src: PathBuf, pin: &Pin) -> Result<PathBuf> {
    let head = git(&src, &["rev-parse", "HEAD"])?;
    if head != pin.ghostty.commit {
        return Err(format!(
            "{} is at Ghostty {head}, but ghostty.toml pins {}",
            src.display(),
            pin.ghostty.commit
        ));
    }
    Ok(src)
}

fn git(dir: &Path, args: &[&str]) -> Result<String> {
    let mut command = Command::new("git");
    command
        .current_dir(dir)
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    let output = command.output().map_err(|error| format!("git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "git {} in {}: {}",
            args.join(" "),
            dir.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A Zig of the pinned version: `$ZIG`, `zig` on PATH, or one downloaded into the cache.
fn zig(cache: &Path, pin: &Pin) -> Result<PathBuf> {
    if let Some(zig) = env::var_os("ZIG") {
        let zig = PathBuf::from(zig);
        let version = zig_version(&zig);
        if version.as_deref() != Some(pin.zig.version.as_str()) {
            return Err(format!(
                "$ZIG is Zig {}, but ghostty.toml needs {}",
                version.as_deref().unwrap_or("of no version"),
                pin.zig.version
            ));
        }
        return Ok(zig);
    }
    if zig_version(Path::new("zig")).as_deref() == Some(pin.zig.version.as_str()) {
        return Ok(PathBuf::from("zig"));
    }

    let dir = cache.join(format!("zig-{}", pin.zig.version));
    let zig = dir.join("zig");
    if zig.exists() {
        return Ok(zig);
    }
    let host = zig_name(&var("HOST")?)?;
    let download = pin.zig.downloads.get(&host).ok_or_else(|| {
        format!(
            "ghostty.toml has no Zig for {host}; set ZIG to a Zig {}",
            pin.zig.version
        )
    })?;
    let archive = cache.join(format!("zig-{}-{host}.tar.xz", pin.zig.version));
    status(
        Command::new("curl")
            .args([
                "--proto",
                "=https",
                "--tlsv1.2",
                "-fsSL",
                "--retry",
                "3",
                "-o",
            ])
            .arg(&archive)
            .arg(&download.url),
        "downloading Zig",
    )?;
    let bytes = fs::read(&archive).map_err(|error| format!("{}: {error}", archive.display()))?;
    let digest = Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if digest != download.sha256 {
        let _ = fs::remove_file(&archive);
        return Err(format!(
            "{} has checksum {digest}, not {}",
            download.url, download.sha256
        ));
    }
    let staging = cache.join(format!("zig-{}.partial", pin.zig.version));
    remove_dir(&staging)?;
    create_dir(&staging)?;
    status(
        Command::new("tar")
            .arg("-xJf")
            .arg(&archive)
            .arg("-C")
            .arg(&staging)
            .args(["--strip-components", "1"]),
        "unpacking Zig",
    )?;
    rename(&staging, &dir)?;
    let _ = fs::remove_file(&archive);
    Ok(zig)
}

fn zig_version(zig: &Path) -> Option<String> {
    let output = Command::new(zig).arg("version").output().ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// `aarch64-macos` and the like, as `ghostty.toml` names Zig's builds, for a Rust target triple.
fn zig_name(triple: &str) -> Result<String> {
    let arch = triple.split('-').next().unwrap_or_default();
    let os = if triple.contains("-apple-darwin") {
        "macos"
    } else if triple.contains("-linux-") {
        "linux"
    } else {
        return Err(format!("weave-holder doesn't build for {triple}"));
    };
    match arch {
        "aarch64" | "x86_64" => Ok(format!("{arch}-{os}")),
        _ => Err(format!("weave-holder doesn't build for {triple}")),
    }
}

/// Zig's `-Dtarget` for a Rust target triple, when building for another computer than this one.
fn zig_triple(triple: &str) -> Result<String> {
    let name = zig_name(triple)?;
    Ok(if triple.ends_with("-musl") {
        format!("{name}-musl")
    } else if triple.contains("-linux-") {
        format!("{name}-gnu")
    } else {
        name
    })
}

/// Links `libghostty-vt.a` from `prefix`.
fn link(prefix: &Path) -> Result<()> {
    let archive = prefix.join("lib/libghostty-vt.a");
    println!("cargo:rerun-if-changed={}", archive.display());
    // From a directory with only the archive: beside the dylib, ld64 links the dylib even for
    // `static=`.
    let dir = PathBuf::from(var("OUT_DIR")?).join("static");
    create_dir(&dir)?;
    fs::copy(&archive, dir.join("libghostty-vt.a"))
        .map_err(|error| format!("{}: {error}", archive.display()))?;
    println!("cargo:rustc-link-search=native={}", dir.display());
    println!("cargo:rustc-link-lib=static=ghostty-vt");
    // simdutf and highway, inside libghostty-vt, are C++.
    let cxx = if var("CARGO_CFG_TARGET_OS")? == "macos" {
        "c++"
    } else {
        "stdc++"
    };
    println!("cargo:rustc-link-lib={cxx}");
    Ok(())
}

#[cfg(feature = "bindgen")]
fn bindings(prefix: &Path, manifest: &Path) -> Result<()> {
    let include = prefix.join("include");
    let path = manifest.join("src/ffi/bindings.rs");
    bindgen::Builder::default()
        .header(include.join("ghostty/vt.h").to_string_lossy())
        .clang_arg(format!("-I{}", include.display()))
        .clang_arg("-DGHOSTTY_STATIC")
        .allowlist_function("ghostty_.*")
        .allowlist_type("Ghostty.*")
        .allowlist_var("GHOSTTY_.*")
        .prepend_enum_name(false)
        .derive_default(true)
        .raw_line(
            "// Generated by `cargo build -p weave-holder --features bindgen` from the headers of \
             libghostty-vt at the commit ghostty.toml pins. Don't edit.",
        )
        .generate()
        .map_err(|error| format!("bindgen: {error}"))?
        .write_to_file(&path)
        .map_err(|error| format!("{}: {error}", path.display()))
}

fn short(commit: &str) -> &str {
    commit.get(..8).unwrap_or(commit)
}

fn var(name: &str) -> Result<String> {
    env::var(name).map_err(|_| format!("${name} isn't set"))
}

fn read(path: &Path) -> Result<String> {
    fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn create_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(|error| format!("{}: {error}", path.display()))
}

fn remove_dir(path: &Path) -> Result<()> {
    match fs::remove_dir_all(path) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            Err(format!("{}: {error}", path.display()))
        }
        _ => Ok(()),
    }
}

fn rename(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to).map_err(|error| format!("{} to {}: {error}", from.display(), to.display()))
}

fn status(command: &mut Command, what: &str) -> Result<()> {
    let status = command
        .status()
        .map_err(|error| format!("{what}: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{what} failed ({status})"))
    }
}
