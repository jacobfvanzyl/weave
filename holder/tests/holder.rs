//! The holder as the Host meets it: the real binary, a real shell on a real PTY, and its socket.

#![allow(clippy::unwrap_used)]

use std::collections::BTreeMap;
use std::io::BufRead;
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

use pretty_assertions::assert_eq;
use serde_json::Value;
use serde_json::json;
use weave_holder::protocol;
use weave_holder::vt::Format;
use weave_holder::vt::Formatting;
use weave_holder::vt::Terminal;

const HOLDER: &str = env!("CARGO_BIN_EXE_weave-holder");
const WAIT: Duration = Duration::from_secs(20);

struct Holder {
    dir: tempfile::TempDir,
    process: Option<Child>,
    record: Value,
}

impl Holder {
    fn socket(&self) -> PathBuf {
        PathBuf::from(self.record["socket"].as_str().unwrap())
    }

    fn connect(&self) -> Client {
        Client::connect(&self.socket())
    }

    /// Waits for a holder started with `serve` to end, and says how.
    fn wait(&mut self) -> std::process::ExitStatus {
        self.process.take().unwrap().wait().unwrap()
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
    }
}

/// The environment a test's program starts in: enough to run, nothing of the person's.
fn env(home: &Path) -> BTreeMap<String, String> {
    BTreeMap::from([
        ("HOME".into(), home.display().to_string()),
        ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
        ("PS1".into(), "$ ".into()),
        ("LANG".into(), "C".into()),
    ])
}

fn args(dir: &Path, id: &str, shell: &str, env: &BTreeMap<String, String>) -> Vec<String> {
    let env_file = dir.join(format!("{id}.env.json"));
    std::fs::write(&env_file, serde_json::to_vec(env).unwrap()).unwrap();
    [
        "--dir",
        &dir.join("terminals").display().to_string(),
        "--id",
        id,
        "--cwd",
        &dir.display().to_string(),
        "--shell",
        shell,
        "--label",
        "dev server",
        "--scope",
        "/src/weave",
        "--opened-from",
        "thread-1",
        "--env-file",
        &env_file.display().to_string(),
    ]
    .map(String::from)
    .to_vec()
}

fn serve_with(shell: &str, env: impl FnOnce(&Path) -> BTreeMap<String, String>) -> Holder {
    serve_command(shell, env, &[])
}

fn serve_command(
    shell: &str,
    env: impl FnOnce(&Path) -> BTreeMap<String, String>,
    command: &[&str],
) -> Holder {
    let dir = tempfile::tempdir().unwrap();
    let env = env(dir.path());
    let command: Vec<&str> = if command.is_empty() {
        Vec::new()
    } else {
        [&["--"], command].concat()
    };
    let mut process = std::process::Command::new(HOLDER)
        .arg("serve")
        .args(args(dir.path(), "t1", shell, &env))
        .args(command)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    BufReader::new(process.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let record: Value = serde_json::from_str(&line).unwrap();
    assert!(record["error"].is_null(), "{record}");
    Holder {
        dir,
        process: Some(process),
        record,
    }
}

fn serve() -> Holder {
    serve_with("/bin/sh", env)
}

enum Frame {
    Json(Value),
    Snapshot(Vec<u8>),
    Output(Vec<u8>),
}

/// A client of a holder, as the Host is: its frames, and a replica of the terminal once attached.
struct Client {
    stream: UnixStream,
    frames: Option<mpsc::Receiver<Frame>>,
    next_id: u64,
    replica: Option<Terminal>,
    events: Vec<Value>,
}

impl Client {
    fn connect(socket: &Path) -> Self {
        let stream = UnixStream::connect(socket).unwrap();
        let mut client = Self {
            stream,
            frames: None,
            next_id: 0,
            replica: None,
            events: Vec::new(),
        };
        client.start_reading();
        client
    }

    /// A client that doesn't read what it's sent until told to, as a stalled device's Host link.
    fn connect_stalled(socket: &Path) -> Self {
        Self {
            stream: UnixStream::connect(socket).unwrap(),
            frames: None,
            next_id: 0,
            replica: None,
            events: Vec::new(),
        }
    }

    fn start_reading(&mut self) {
        let (sender, receiver) = mpsc::channel();
        let mut stream = self.stream.try_clone().unwrap();
        std::thread::spawn(move || {
            while let Ok(Some((kind, payload))) = protocol::read_frame(&mut stream) {
                let frame = match kind {
                    protocol::JSON => Frame::Json(serde_json::from_slice(&payload).unwrap()),
                    protocol::SNAPSHOT => Frame::Snapshot(payload),
                    protocol::OUTPUT => Frame::Output(payload),
                    _ => continue,
                };
                if sender.send(frame).is_err() {
                    break;
                }
            }
        });
        self.frames = Some(receiver);
    }

    fn send(&mut self, method: &str, args: Value) -> u64 {
        self.next_id += 1;
        let request = json!({"id": self.next_id, "method": method, "args": args});
        protocol::write_frame(
            &mut self.stream,
            protocol::JSON,
            &serde_json::to_vec(&request).unwrap(),
        )
        .unwrap();
        self.next_id
    }

    fn request(&mut self, method: &str, args: Value) -> Value {
        let id = self.send(method, args);
        let deadline = Instant::now() + WAIT;
        loop {
            match self.next(deadline) {
                Some(Frame::Json(message)) if message["id"] == json!(id) => return message,
                Some(frame) => self.take(frame),
                None => panic!("no answer to {method}"),
            }
        }
    }

    fn next(&self, deadline: Instant) -> Option<Frame> {
        let timeout = deadline.saturating_duration_since(Instant::now());
        self.frames.as_ref().unwrap().recv_timeout(timeout).ok()
    }

    /// Applies a frame: output to the replica, events to the list.
    fn take(&mut self, frame: Frame) {
        match frame {
            Frame::Json(message) if message.get("type").is_some() => self.events.push(message),
            Frame::Output(bytes) => {
                if let Some(replica) = &mut self.replica {
                    replica.write(&bytes);
                }
            }
            Frame::Json(_) | Frame::Snapshot(_) => {}
        }
    }

    /// Attaches, restoring a replica from the snapshot that follows the answer.
    fn attach(&mut self) -> Value {
        let answer = self.request("attach", json!({}));
        self.restore(answer["result"]["snapshot_bytes"].as_u64().unwrap() as usize);
        answer
    }

    fn restore(&mut self, len: usize) {
        let mut snapshot = Vec::new();
        let deadline = Instant::now() + WAIT;
        while snapshot.len() < len {
            match self.next(deadline) {
                Some(Frame::Snapshot(bytes)) => snapshot.extend(bytes),
                Some(frame) => self.take(frame),
                None => panic!("the snapshot stopped at {} of {len} bytes", snapshot.len()),
            }
        }
        self.replica = Some(Terminal::restore(&snapshot).unwrap());
    }

    fn type_(&mut self, text: &str) {
        protocol::write_frame(&mut self.stream, protocol::INPUT, text.as_bytes()).unwrap();
    }

    fn screen(&self) -> String {
        self.replica
            .as_ref()
            .unwrap()
            .format(Format::Text, Formatting::TRIMMED)
            .unwrap()
    }

    /// Reads frames until `done` holds, or panics after a while.
    fn until(&mut self, what: &str, done: impl Fn(&Self) -> bool) {
        let deadline = Instant::now() + WAIT;
        while !done(self) {
            match self.next(deadline) {
                Some(frame) => self.take(frame),
                None => panic!(
                    "waited for {what}; screen:\n{}\nevents: {:?}",
                    self.screen_or_none(),
                    self.events
                ),
            }
            // Everything already queued, before formatting the screen again.
            while let Some(frame) = self
                .frames
                .as_ref()
                .and_then(|frames| frames.try_recv().ok())
            {
                self.take(frame);
            }
        }
    }

    fn screen_or_none(&self) -> String {
        self.replica
            .as_ref()
            .map_or_else(String::new, |_| self.screen())
    }

    fn event(&self, kind: &str) -> Option<&Value> {
        self.events.iter().find(|event| event["type"] == kind)
    }
}

#[test]
fn hello_names_the_protocol_codec_and_terminal() {
    let holder = serve();
    let mut client = holder.connect();
    let hello = client.request("hello", json!({}))["result"].clone();
    assert_eq!(hello["protocol"], 1);
    assert_eq!(
        hello["holder"]["codec"],
        weave_holder::vt::codec().unwrap().as_str()
    );
    let terminal = &hello["terminal"];
    assert_eq!(terminal["id"], "t1");
    assert_eq!(terminal["label"], "dev server");
    assert_eq!(terminal["scope"], "/src/weave");
    assert_eq!(terminal["opened_from"], "thread-1");
    assert_eq!(terminal["size"], json!({"cols": 80, "rows": 24}));
    assert_eq!(holder.record["id"], "t1");
    assert_eq!(holder.record["codec"], hello["holder"]["codec"]);
}

#[test]
fn a_replica_follows_the_shell_and_matches_the_holder() {
    let holder = serve();
    let mut client = holder.connect();
    client.attach();
    client.type_("echo marker-$((6*7))\r");
    client.until("the echo", |client| client.screen().contains("marker-42"));
    let held = client.request("format", json!({"format": "text", "trim": true}));
    assert!(
        held["result"]["content"]
            .as_str()
            .unwrap()
            .contains("marker-42")
    );
    assert_eq!(
        client.request("nonsense", json!({}))["error"]["code"],
        "method_not_found"
    );
}

#[test]
fn what_the_output_does_reaches_subscribers_as_events() {
    let holder = serve();
    let mut client = holder.connect();
    client.attach();
    client.type_("printf '\\033]0;title-x\\007\\033]7501;state=working:id=job\\007'\r");
    client.until("the title and status", |client| {
        client.event("title_changed").is_some() && client.event("program_status_changed").is_some()
    });
    assert_eq!(
        client.event("title_changed").unwrap()["payload"]["title"],
        "title-x"
    );
    assert_eq!(
        client.event("program_status_changed").unwrap()["payload"]["record"],
        json!({"id": "job", "state": "working"})
    );
    let records = client.request("program_status", json!({}));
    assert_eq!(
        records["result"]["records"],
        json!([{"id": "job", "state": "working"}])
    );
}

#[test]
fn a_resize_reaches_the_program() {
    let holder = serve();
    let mut client = holder.connect();
    client.attach();
    let answer = client.request("resize", json!({"cols": 100, "rows": 30}));
    assert_eq!(answer["result"], json!({"cols": 100, "rows": 30}));
    client.type_("stty size\r");
    client.until("stty's answer", |client| client.screen().contains("30 100"));
    assert!(client.event("size_changed").is_some());
}

#[test]
fn the_program_inherits_no_descriptors_but_its_terminal() {
    let holder = serve();
    let mut client = holder.connect();
    client.attach();
    // What the shell inherited past its terminal, as a child shell finds it: an interactive shell
    // opens its own (dash keeps its terminal at 10), and `ls /dev/fd` lists its own too.
    client.type_(
        "sh -c 'echo fds:$(for fd in 3 4 5 6 7 8 9 10 11 12; do [ -e /dev/fd/$fd ] && printf \" %s\" $fd; done) end'\r",
    );
    let listed = |screen: &str| {
        screen
            .lines()
            .filter_map(|line| line.find("fds:").map(|at| line[at..].to_string()))
            .find(|line| line.ends_with("end"))
    };
    client.until("the list", |client| listed(&client.screen()).is_some());
    assert_eq!(listed(&client.screen()).as_deref(), Some("fds: end"));
}

#[test]
fn a_client_that_falls_behind_is_resynchronized() {
    let holder = serve();
    let socket = holder.socket();
    let mut stalled = Client::connect_stalled(&socket);
    stalled.send("attach", json!({}));
    let mut reading = Client::connect(&socket);
    reading.attach();
    reading.type_("head -c 6000000 /dev/zero | tr '\\000' x; echo; echo flood-$((1+1))\r");
    reading.until("the end of the flood", |client| {
        client.screen().contains("flood-2")
    });

    stalled.start_reading();
    let deadline = Instant::now() + WAIT;
    let mut resynced = false;
    while let Some(frame) = stalled.next(deadline) {
        if let Frame::Json(message) = &frame
            && message["type"] == "resync"
        {
            resynced = true;
            stalled.restore(message["payload"]["snapshot_bytes"].as_u64().unwrap() as usize);
            break;
        }
    }
    assert!(resynced, "the stalled client got no resync");
    stalled.until("the restored screen", |client| {
        client.screen().contains("flood-2")
    });
}

#[test]
fn the_holder_ends_with_its_program() {
    let mut holder = serve();
    let mut client = holder.connect();
    client.attach();
    client.type_("exit\r");
    client.until("the exit", |client| client.event("child_exited").is_some());
    assert!(holder.wait().success());
    let terminals = holder.dir.path().join("terminals");
    assert!(!terminals.join("t1.sock").exists());
    assert!(!terminals.join("t1.json").exists());
}

#[test]
fn a_command_ends_the_holder_with_its_exit_code() {
    let mut holder = serve_command("/bin/sh", env, &["sh", "-c", "sleep 1; exit 3"]);
    let mut client = holder.connect();
    client.attach();
    client.until("the exit", |client| client.event("child_exited").is_some());
    assert_eq!(
        client.event("child_exited").unwrap()["payload"],
        json!({"exit_code": 3, "error": "exited with 3"})
    );
    assert!(holder.wait().success());
    let terminals = holder.dir.path().join("terminals");
    assert!(!terminals.join("t1.sock").exists());
    assert!(!terminals.join("t1.json").exists());
}

#[test]
fn close_hangs_the_program_up() {
    let mut holder = serve();
    let mut client = holder.connect();
    client.attach();
    client.request("close", json!({}));
    client.until("the exit", |client| client.event("child_exited").is_some());
    let code = client.event("child_exited").unwrap()["payload"]["exit_code"]
        .as_i64()
        .unwrap();
    assert_ne!(code, 0);
    assert!(holder.wait().success());
}

#[test]
fn the_env_file_is_the_programs_environment_and_goes() {
    let holder = serve_with("/bin/sh", |home| {
        let mut env = env(home);
        env.insert("WEAVE_TEST_VAR".into(), "from-the-host".into());
        env
    });
    assert!(!holder.dir.path().join("t1.env.json").exists());
    let mut client = holder.connect();
    client.attach();
    client.type_("echo var=$WEAVE_TEST_VAR term=$TERM program=$TERM_PROGRAM\r");
    client.until("the echo", |client| {
        client
            .screen()
            .contains("var=from-the-host term=xterm-ghostty program=weave")
    });
}

#[test]
fn a_second_holder_with_the_same_id_is_refused() {
    let holder = serve();
    let env = env(holder.dir.path());
    let output = std::process::Command::new(HOLDER)
        .arg("serve")
        .args(args(holder.dir.path(), "t1", "/bin/sh", &env))
        .output()
        .unwrap();
    assert!(!output.status.success());
    let answer: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        answer["error"]
            .as_str()
            .unwrap()
            .contains("already answers"),
        "{answer}"
    );
}

#[test]
fn spawn_starts_a_holder_in_a_session_of_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let env = env(dir.path());
    let output = std::process::Command::new(HOLDER)
        .arg("spawn")
        .args(args(dir.path(), "s1", "/bin/sh", &env))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let record: Value = serde_json::from_slice(&output.stdout).unwrap();
    let pid = record["pid"].as_i64().unwrap() as libc::pid_t;
    // A session of its own, whose leader has gone, so nothing of the caller's ends it.
    let session = unsafe { libc::getsid(pid) };
    assert_ne!(session, unsafe { libc::getsid(0) });
    assert_ne!(unsafe { libc::kill(session, 0) }, 0);
    let mut client = Client::connect(Path::new(record["socket"].as_str().unwrap()));
    client.attach();
    client.request("close", json!({}));
    client.until("the exit", |client| client.event("child_exited").is_some());
    let deadline = Instant::now() + WAIT;
    while unsafe { libc::kill(pid, 0) } == 0 {
        assert!(Instant::now() < deadline, "the holder outlived its program");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn zsh_reports_its_commands_and_directory_through_ghosttys_integration() {
    let Some(zsh) = ["/bin/zsh", "/usr/bin/zsh"]
        .into_iter()
        .find(|zsh| Path::new(zsh).exists())
    else {
        eprintln!("skipped: no zsh");
        return;
    };
    // An empty ZDOTDIR of the test's own, which Ghostty's integration restores, so none of the
    // person's zsh configuration runs.
    let holder = serve_with(zsh, |home| {
        let zdotdir = home.join("zdotdir");
        std::fs::create_dir_all(&zdotdir).unwrap();
        let mut env = env(home);
        env.insert("ZDOTDIR".into(), zdotdir.display().to_string());
        env
    });
    let mut client = holder.connect();
    client.attach();
    client.type_("false\r");
    client.until("the failed command", |client| {
        client
            .events
            .iter()
            .any(|event| event["type"] == "command_changed" && event["payload"]["exit_code"] == 1)
    });
    assert!(client.event("pwd_changed").is_some(), "{:?}", client.events);
    let describe = client.request("describe", json!({}));
    assert_eq!(describe["result"]["integration"], "zsh");
}

#[test]
fn a_client_of_another_codec_restores_from_vt() {
    let holder = serve();
    let mut client = holder.connect();
    client.attach();
    client.type_("echo before-$((2*21))\r");
    client.until("the echo", |client| client.screen().contains("before-42"));

    let mut other = holder.connect();
    let answer = other.request("attach", json!({"restore": "vt"}));
    assert_eq!(answer["result"]["restore"], "vt");
    let len = answer["result"]["snapshot_bytes"].as_u64().unwrap() as usize;
    let mut vt = Vec::new();
    let deadline = Instant::now() + WAIT;
    while vt.len() < len {
        match other.next(deadline) {
            Some(Frame::Snapshot(bytes)) => vt.extend(bytes),
            Some(frame) => other.take(frame),
            None => panic!("the restore stopped at {} of {len} bytes", vt.len()),
        }
    }
    // A fresh terminal of the holder's size, as a client of another codec makes one.
    let mut replica = Terminal::new(80, 24).unwrap();
    replica.write(&vt);
    other.replica = Some(replica);
    assert!(other.screen().contains("before-42"), "{}", other.screen());
    other.type_("echo after-$((2*22))\r");
    other.until("live output after the restore", |client| {
        client.screen().contains("after-44")
    });

    let visible = client.request("format", json!({"format": "text", "trim": true}));
    assert!(
        visible["result"]["content"]
            .as_str()
            .unwrap()
            .contains("after-44")
    );
}
