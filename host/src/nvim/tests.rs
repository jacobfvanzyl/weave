//! Against a real Neovim, `nvim --headless --listen`, when one of at least [`OLDEST`] is on
//! PATH; skipped, not failed, otherwise. And against a fake, for what a real one can't show.

use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use pretty_assertions::assert_eq;
use tokio::io::AsyncReadExt as _;
use tokio::io::AsyncWriteExt as _;

use super::*;

/// `nvim`'s version, from `nvim --version`'s first line, `NVIM v0.12.6`.
fn installed() -> Option<(i64, i64)> {
    let output = std::process::Command::new("nvim")
        .arg("--version")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.lines().next()?.strip_prefix("NVIM v")?;
    let mut parts = version.split(['.', '-']);
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

/// A headless Neovim listening in a directory of its own, with three files there.
struct Nvim {
    dir: tempfile::TempDir,
    socket: PathBuf,
    _child: tokio::process::Child,
    rpc: Rpc,
}

impl Nvim {
    /// One, or none when there's no Neovim new enough to test against.
    async fn start(test: &str) -> Option<Self> {
        match installed() {
            Some(version) if version >= OLDEST => {}
            found => {
                eprintln!(
                    "skipped {test}: needs nvim {}.{} or later on PATH, found {found:?}",
                    OLDEST.0, OLDEST.1
                );
                return None;
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("n.sock");
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "héllo wörld\nsecond\n").unwrap();
        // A name `:edit` would read as a command, an alternate file and a variable.
        std::fs::write(dir.path().join("x | echo %$HOME.txt"), "odd\n").unwrap();
        let child = tokio::process::Command::new("nvim")
            .args(["--clean", "--headless", "-n", "--listen"])
            .arg(&socket)
            .current_dir(dir.path())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !listening(&socket).await {
            assert!(std::time::Instant::now() < deadline, "nvim didn't listen");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let rpc = Rpc::connect(&socket, Duration::from_secs(5)).await.unwrap();
        Some(Self {
            dir,
            socket,
            _child: child,
            rpc,
        })
    }

    /// A file of the directory's, by its path with symlinks resolved, as Neovim names it.
    fn path(&self, name: &str) -> PathBuf {
        self.dir.path().join(name).canonicalize().unwrap()
    }

    async fn command(&mut self, command: &str) {
        self.rpc
            .call("nvim_command", vec![Value::str(command)])
            .await
            .unwrap();
    }

    /// Keys as typed, then waits for Neovim to have taken them: until `done` holds of its state.
    async fn keys(&mut self, keys: &str, done: impl Fn(&State) -> bool) -> State {
        self.rpc
            .call("nvim_input", vec![Value::str(keys)])
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let now = state(&self.socket).await.unwrap();
            if done(&now) {
                return now;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "{keys:?} left {now:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn lua(&mut self, code: &str) -> Value {
        self.rpc
            .call(
                "nvim_exec_lua",
                vec![Value::str(code), Value::Array(Vec::new())],
            )
            .await
            .unwrap()
    }

    async fn open(
        &self,
        path: &Path,
        line: Option<u64>,
        column: Option<u64>,
    ) -> Result<Opened, NvimError> {
        open(&self.socket, &Open { path, line, column }).await
    }
}

fn at(line: u64, column: u64) -> Position {
    Position {
        line,
        column: Some(column),
    }
}

#[tokio::test]
async fn a_file_opens_at_a_place_and_the_state_reads_it_back() {
    let Some(mut nvim) = Nvim::start("a_file_opens_at_a_place_and_the_state_reads_it_back").await
    else {
        return;
    };
    let a = nvim.path("a.txt");
    let opened = nvim.open(&a, Some(2), Some(3)).await.unwrap();
    assert_eq!(
        opened,
        Opened {
            path: a.display().to_string(),
            line: 2,
            column: 3,
            split: false,
        }
    );
    let now = state(&nvim.socket).await.unwrap();
    assert_eq!(
        now,
        State {
            path: Some(a.display().to_string()),
            buffer_type: String::new(),
            filetype: "text".to_owned(),
            modified: false,
            mode: "Normal".to_owned(),
            cursor: at(2, 3),
            selection: None,
        }
    );

    // Columns are characters, not bytes.
    let b = nvim.path("b.txt");
    let opened = nvim.open(&b, Some(1), Some(9)).await.unwrap();
    assert_eq!((opened.line, opened.column), (1, 9));
    let line = nvim
        .rpc
        .call("nvim_get_current_line", vec![])
        .await
        .unwrap();
    let col = nvim
        .rpc
        .call("nvim_win_get_cursor", vec![Value::Int(0)])
        .await
        .unwrap();
    assert_eq!(line, Value::str("héllo wörld"));
    // The 9th character, "r", follows the 10 bytes of "héllo wö".
    assert_eq!(col, Value::Array(vec![Value::Int(1), Value::Int(10)]));

    // Past the end it stops at the last line and character; without a line, the cursor stays.
    let opened = nvim.open(&a, Some(99), Some(99)).await.unwrap();
    assert_eq!((opened.line, opened.column), (3, 5));
    let opened = nvim.open(&b, None, None).await.unwrap();
    assert_eq!((opened.line, opened.column), (1, 9));

    // A name is a name, never a command line.
    let odd = nvim.path("x | echo %$HOME.txt");
    let opened = nvim.open(&odd, Some(1), None).await.unwrap();
    assert_eq!(opened.path, odd.display().to_string());
    let lines = nvim
        .rpc
        .call(
            "nvim_buf_get_lines",
            vec![
                Value::Int(0),
                Value::Int(0),
                Value::Int(-1),
                Value::Bool(true),
            ],
        )
        .await
        .unwrap();
    assert_eq!(lines, Value::Array(vec![Value::str("odd")]));

    // The jumplist keeps where the person was.
    let back = nvim
        .keys("<C-o>", |now| {
            now.path.as_deref() != Some(&*odd.display().to_string())
        })
        .await;
    assert_eq!(back.path, Some(b.display().to_string()));
}

#[tokio::test]
async fn a_live_selection_reads_in_each_visual_mode_and_none_outside_them() {
    let Some(mut nvim) =
        Nvim::start("a_live_selection_reads_in_each_visual_mode_and_none_outside_them").await
    else {
        return;
    };
    let a = nvim.path("a.txt");
    nvim.open(&a, Some(1), Some(1)).await.unwrap();

    let chars = nvim
        .keys("lvjl", |now| {
            now.cursor == at(2, 3) && now.selection.is_some()
        })
        .await;
    assert_eq!(chars.mode, "Visual");
    assert_eq!(
        chars.selection,
        Some(Selection {
            kind: "characters".to_owned(),
            start: at(1, 2),
            end: at(2, 3),
            text: vec!["ne".to_owned(), "two".to_owned()],
        })
    );

    // Opening a file while the person selects is refused, and leaves the selection as it is.
    let b = nvim.path("b.txt");
    match nvim.open(&b, None, None).await {
        Err(NvimError::Busy(mode)) => assert_eq!(mode, "Visual"),
        other => panic!("refused in Visual mode, not {other:?}"),
    }
    assert_eq!(state(&nvim.socket).await.unwrap(), chars);

    // Backwards, linewise.
    let lines = nvim
        .keys("<Esc>G0Vk", |now| {
            now.mode == "Visual Line" && now.cursor == at(2, 1)
        })
        .await;
    assert_eq!(
        lines.selection,
        Some(Selection {
            kind: "lines".to_owned(),
            start: Position {
                line: 2,
                column: None
            },
            end: Position {
                line: 3,
                column: None
            },
            text: vec!["two".to_owned(), "three".to_owned()],
        })
    );

    let block = nvim
        .keys("<Esc>gg0l<C-v>jl", |now| {
            now.mode == "Visual Block" && now.cursor == at(2, 3)
        })
        .await;
    assert_eq!(
        block.selection,
        Some(Selection {
            kind: "block".to_owned(),
            start: at(1, 2),
            end: at(2, 3),
            text: vec!["ne".to_owned(), "wo".to_owned()],
        })
    );

    // Out of Visual mode, the '< and '> marks are set, but nothing is selected.
    let normal = nvim.keys("<Esc>", |now| now.mode == "Normal").await;
    assert_eq!(normal.selection, None);
    let marks = nvim.lua("return vim.fn.getpos(\"'<\")[2]").await;
    assert_eq!(marks, Value::Int(1));
}

#[tokio::test]
async fn a_modified_buffer_is_never_let_go_of() {
    let Some(mut nvim) = Nvim::start("a_modified_buffer_is_never_let_go_of").await else {
        return;
    };
    let a = nvim.path("a.txt");
    let b = nvim.path("b.txt");
    nvim.open(&a, Some(1), None).await.unwrap();
    nvim.keys("Achanged<Esc>", |now| now.modified && now.mode == "Normal")
        .await;

    // With 'hidden' off, `:edit` would fail with E37: the file opens in a split instead.
    nvim.command("set nohidden").await;
    let opened = nvim.open(&b, Some(2), None).await.unwrap();
    assert!(opened.split);
    assert_eq!(opened.path, b.display().to_string());
    let windows = nvim.lua("return #vim.api.nvim_tabpage_list_wins(0)").await;
    assert_eq!(windows, Value::Int(2));
    let kept = nvim
        .lua(&format!(
            "local b = vim.fn.bufnr({:?}) return {{vim.bo[b].modified, vim.fn.bufwinnr(b) > 0}}",
            a.display().to_string()
        ))
        .await;
    assert_eq!(
        kept,
        Value::Array(vec![Value::Bool(true), Value::Bool(true)])
    );

    // A file shown in a window already is the window used.
    let opened = nvim.open(&a, Some(1), None).await.unwrap();
    assert!(!opened.split);
    let windows = nvim.lua("return #vim.api.nvim_tabpage_list_wins(0)").await;
    assert_eq!(windows, Value::Int(2));
    let now = state(&nvim.socket).await.unwrap();
    assert_eq!(now.path, Some(a.display().to_string()));
    assert!(now.modified);

    // With 'hidden' on, Neovim's default, it's hidden in its window, its changes kept.
    nvim.command("only | set hidden").await;
    let opened = nvim.open(&b, None, None).await.unwrap();
    assert!(!opened.split);
    let kept = nvim
        .lua(&format!(
            "local b = vim.fn.bufnr({:?}) return {{vim.bo[b].modified, vim.api.nvim_buf_is_loaded(b)}}",
            a.display().to_string()
        ))
        .await;
    assert_eq!(
        kept,
        Value::Array(vec![Value::Bool(true), Value::Bool(true)])
    );
}

#[tokio::test]
async fn nothing_opens_while_the_person_types_or_answers_a_prompt() {
    let Some(mut nvim) =
        Nvim::start("nothing_opens_while_the_person_types_or_answers_a_prompt").await
    else {
        return;
    };
    let a = nvim.path("a.txt");
    nvim.open(&a, Some(1), None).await.unwrap();
    nvim.keys("i", |now| now.mode == "Insert").await;
    match nvim.open(&nvim.path("b.txt"), None, None).await {
        Err(NvimError::Busy(mode)) => assert_eq!(mode, "Insert"),
        other => panic!("refused in Insert mode, not {other:?}"),
    }
    let now = state(&nvim.socket).await.unwrap();
    assert_eq!(
        (now.mode.as_str(), now.path),
        ("Insert", Some(a.display().to_string()))
    );

    // At a prompt of input()'s, Neovim is in Command-line mode, and still answers.
    nvim.keys("<Esc>:call input('? ')<CR>", |now| {
        now.mode == "Command-line"
    })
    .await;
    match nvim.open(&nvim.path("b.txt"), None, None).await {
        Err(NvimError::Busy(mode)) => assert_eq!(mode, "Command-line"),
        other => panic!("refused in Command-line mode, not {other:?}"),
    }

    // Waiting for the rest of a command, as after the `g` of `gg`, Neovim says it's blocked,
    // so neither tool's script is sent.
    nvim.rpc
        .call("nvim_input", vec![Value::str("<Esc><Esc>g")])
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        match state(&nvim.socket).await {
            Err(NvimError::Waiting(_)) => break,
            other => {
                assert!(std::time::Instant::now() < deadline, "{other:?}");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
    assert!(matches!(
        nvim.open(&a, None, None).await,
        Err(NvimError::Waiting(_))
    ));
    // The command ends, and Neovim answers again.
    nvim.keys("<Esc>", |now| now.mode == "Normal").await;
}

/// A Neovim that says it's `version` and fails anything else.
async fn fake(dir: &Path, version: (i64, i64, i64)) -> PathBuf {
    let path = dir.join("old.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut read = Vec::new();
        loop {
            let mut chunk = [0; 1024];
            let len = stream.read(&mut chunk).await.unwrap();
            if len == 0 {
                return;
            }
            read.extend_from_slice(&chunk[..len]);
            while let Some((request, len)) = msgpack::decode(&read).unwrap() {
                read.drain(..len);
                let parts = request.as_array().unwrap();
                let result = Value::Array(vec![
                    Value::Int(1),
                    Value::map([(
                        "version",
                        Value::map([
                            ("major", Value::Int(version.0)),
                            ("minor", Value::Int(version.1)),
                            ("patch", Value::Int(version.2)),
                        ]),
                    )]),
                ]);
                let response =
                    Value::Array(vec![Value::Int(1), parts[1].clone(), Value::Nil, result]);
                let mut bytes = Vec::new();
                msgpack::encode(&response, &mut bytes);
                stream.write_all(&bytes).await.unwrap();
            }
        }
    });
    path
}

#[tokio::test]
async fn an_older_neovim_is_refused_by_its_version() {
    let dir = tempfile::tempdir().unwrap();
    let socket = fake(dir.path(), (0, 9, 5)).await;
    match state(&socket).await {
        Err(error @ NvimError::TooOld(_)) => assert_eq!(
            error.to_string(),
            "is version 0.9.5, and these tools need Neovim 0.10 or later"
        ),
        other => panic!("too old, not {other:?}"),
    }
}

#[test]
fn a_terminals_socket_is_its_id_in_the_directory_unless_thats_too_long() {
    let dir = Path::new("/Users/someone/.local/state/weave/daemon/nvim");
    assert_eq!(
        socket(dir, "t0123456789abcdef"),
        Some(dir.join("t0123456789abcdef.sock"))
    );
    let deep = PathBuf::from(format!("/{}", "d".repeat(120)));
    assert_eq!(socket(&deep, "t0123456789abcdef"), None);
}

#[test]
fn sockets_go_with_their_terminals() {
    let dir = tempfile::tempdir().unwrap();
    prepare(dir.path()).unwrap();
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(dir.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }
    for id in ["t1", "t2", "t3"] {
        std::fs::write(dir.path().join(format!("{id}.sock")), "").unwrap();
    }
    forget(dir.path(), "t1");
    sweep(dir.path(), &["t2".to_owned()]);
    let mut left: Vec<String> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    left.sort();
    assert_eq!(left, ["t2.sock"]);
}

#[test]
fn modes_have_their_names() {
    assert_eq!(mode_name("n"), "Normal");
    assert_eq!(mode_name("\u{16}"), "Visual Block");
    assert_eq!(mode_name("niI"), "Insert (one Normal mode command)");
    assert_eq!(mode_name("ix"), "Insert");
    assert_eq!(mode_name("Rv"), "Replace");
    assert_eq!(mode_name("no\u{16}"), "Operator-pending");
    assert_eq!(mode_name("zz"), "the mode \"zz\"");
}
