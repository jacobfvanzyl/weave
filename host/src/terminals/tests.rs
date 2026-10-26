use pretty_assertions::assert_eq;
use serde_json::json;

use super::*;

#[test]
fn a_terminal_is_what_its_owner_describes() {
    let terminal = describe(&json!({
        "id": "t1",
        "scope": "/src/weave",
        "label": "dev server",
        "opened_from": "s-1",
        "pid": 42,
        "title": "vim",
        "pwd": "kitty-shell-cwd://mac/src/weave/app",
        "process": {"foreground": {"pid": 43, "name": "vim"}},
        "size": {"cols": 100, "rows": 30},
        "command": {"running": true, "command": "vim"},
        "program_status": [{"id": "build", "state": "working", "progress": 40}],
        "started_at": 1_760_180_000_000u64,
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(terminal).unwrap(),
        json!({
            "id": "t1",
            "scope": "/src/weave",
            "label": "dev server",
            "openedFrom": "s-1",
            "title": "vim",
            "pwd": "/src/weave/app",
            "process": {"foreground": {"pid": 43, "name": "vim"}},
            "size": {"cols": 100, "rows": 30},
            "command": {"running": true, "command": "vim"},
            "programStatus": [{"id": "build", "state": "working", "progress": 40}],
            "startedAt": 1_760_180_000_000u64,
        })
    );
}

#[test]
fn what_weave_adds_to_rexs_model_may_be_missing() {
    let terminal = describe(&json!({
        "id": "block:01a1",
        "scope": "/src/weave",
        "title": "",
        "size": {"cols": 80, "rows": 24},
    }))
    .unwrap();
    assert_eq!(terminal.opened_from, None);
    assert_eq!(terminal.command, None);
    assert_eq!(terminal.title, None);
    assert!(terminal.program_status.is_empty());
}

#[test]
fn the_directory_a_shell_reports_becomes_a_path() {
    assert_eq!(
        pwd_path("file://mac.local/Users/me/My%20Project"),
        Some(PathBuf::from("/Users/me/My Project"))
    );
    assert_eq!(
        pwd_path("kitty-shell-cwd://mac/Users/me/My Project"),
        Some(PathBuf::from("/Users/me/My Project"))
    );
    assert_eq!(pwd_path("file:///tmp"), Some(PathBuf::from("/tmp")));
    assert_eq!(pwd_path("/not/a/url"), None);
}

#[test]
fn ids_name_sockets_safely() {
    let id = new_id();
    assert_eq!(id.len(), 17);
    assert!(id.bytes().all(|byte| byte.is_ascii_alphanumeric()));
    assert_ne!(id, new_id());
}
