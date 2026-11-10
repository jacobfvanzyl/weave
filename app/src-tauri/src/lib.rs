//! The weave app on the Mac (ADR 0032, WVE-204): the React app the iPad and iPhone run, in a
//! Tauri window. Its core ([`core`]) reaches this Mac's Host over its socket and every other
//! Host through the Dispatcher this computer is paired with, and relays each connection to the
//! page ([`relay`]), and passes each terminal's stream to a WebSocket the page opens itself
//! ([`terminals`]). The shell adds the menu bar and its shortcuts, which the page acts on
//! ([`menu`]), notifications, and `weave://` links.

mod check;
pub mod core;
mod menu;
pub mod relay;
pub mod terminals;

use std::sync::Arc;

use tauri::Manager as _;
use tauri::WebviewUrl;
use tauri::WebviewWindowBuilder;
use tauri::ipc::Channel;
use tauri::webview::NewWindowResponse;
use tauri::webview::PageLoadEvent;
use weave_host_protocol::hello::ClientInfo;

use crate::core::Core;
use crate::core::Failure;
use crate::core::LocalHost;
use crate::core::OpenedDispatcher;
use crate::core::Pairing;
use crate::relay::Incoming;
use crate::relay::Sink;

/// What the app calls itself to the Host and the Dispatcher.
fn client() -> ClientInfo {
    ClientInfo {
        name: "weave-app".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    }
}

/// The page's channel as where a connection's messages go.
fn sink(channel: Channel<Incoming>) -> Sink {
    Box::new(move |incoming| channel.send(incoming).is_ok())
}

type State<'a> = tauri::State<'a, Arc<Core>>;

#[tauri::command]
fn pairing(core: State<'_>) -> Result<Option<Pairing>, Failure> {
    core.pairing()
}

#[tauri::command]
fn forget_pairing(core: State<'_>) -> Result<(), Failure> {
    core.forget()
}

#[tauri::command]
async fn local_host(core: State<'_>) -> Result<Option<LocalHost>, Failure> {
    Ok(core.local_host().await)
}

#[tauri::command]
async fn open_local(core: State<'_>, channel: Channel<Incoming>) -> Result<u64, Failure> {
    core.open_local(sink(channel)).await
}

#[tauri::command]
async fn open_host(
    core: State<'_>,
    host: String,
    channel: Channel<Incoming>,
) -> Result<u64, Failure> {
    core.open_host(&host, sink(channel)).await
}

#[tauri::command]
async fn open_dispatcher(
    core: State<'_>,
    channel: Channel<Incoming>,
) -> Result<OpenedDispatcher, Failure> {
    core.open_dispatcher(sink(channel)).await
}

#[tauri::command]
async fn pair_dispatcher(
    core: State<'_>,
    url: String,
    code: String,
    name: String,
    channel: Channel<Incoming>,
) -> Result<OpenedDispatcher, Failure> {
    core.pair(&url, &code, &name, sink(channel)).await
}

/// Messages the page sends on connection `id`, in order: those it sent while the last call was
/// on its way come together.
#[tauri::command]
fn relay_send(core: State<'_>, id: u64, texts: Vec<String>) -> Result<(), String> {
    texts
        .into_iter()
        .try_for_each(|text| core.relay().send(id, text))
}

#[tauri::command]
fn relay_close(core: State<'_>, id: u64) {
    core.relay().close(id);
}

/// Where the page opens a WebSocket for a terminal's stream: this Mac's Host's, or with `host`
/// that Host's, through the Dispatcher.
#[tauri::command]
fn terminal_stream(core: State<'_>, host: Option<String>) -> Result<String, Failure> {
    core.offer_terminal_stream(host.as_deref())
}

/// Puts `text` on the Mac's clipboard, for a program in a terminal that wrote to it (OSC 52) or
/// an agent's call: the web view lets a page write only while the person is clicking or typing
/// in it, and neither of those waits for that.
#[tauri::command]
async fn clipboard_write(text: String) -> Result<(), String> {
    use tokio::io::AsyncWriteExt as _;
    let mut copy = tokio::process::Command::new("/usr/bin/pbcopy")
        // It reads its input in the locale's encoding.
        .env("LC_CTYPE", "UTF-8")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("pbcopy: {error}"))?;
    let mut input = copy.stdin.take().ok_or("pbcopy took no input")?;
    input
        .write_all(text.as_bytes())
        .await
        .map_err(|error| format!("pbcopy: {error}"))?;
    drop(input);
    let status = copy
        .wait()
        .await
        .map_err(|error| format!("pbcopy: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("pbcopy ended with {status}"))
    }
}

/// What the terminal check's script asked of the page, when the app was started for one
/// ([`check`]).
#[tauri::command]
fn terminal_check_poll(check: tauri::State<'_, Option<check::Check>>) -> Option<String> {
    check.as_ref()?.poll()
}

/// What the page measured or drew, for the terminal check's script.
#[tauri::command]
fn terminal_check_report(
    check: tauri::State<'_, Option<check::Check>>,
    report: check::Report,
) -> Result<(), String> {
    check
        .as_ref()
        .ok_or("the app wasn't started for a terminal check")?
        .report(&report)
}

/// Lists the page's commands in the menu bar, with their keys (`src/mac/shell.ts`).
#[tauri::command]
fn set_menu(app: tauri::AppHandle, groups: Vec<menu::Group>) -> Result<(), String> {
    menu::set(&app, &groups).map_err(|error| error.to_string())
}

/// Whether the page may go to `url` itself: only its own pages, the built app's or, during
/// development, Vite's on this computer.
fn own_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" | "about" => true,
        "http" | "https" => {
            tauri::is_dev() && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
        }
        _ => false,
    }
}

/// Opens a link the page asked for in the browser, or the app it's for: agent text never
/// navigates the app's own window.
fn open_elsewhere(url: &tauri::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto")
        && let Err(error) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>)
    {
        tracing::warn!(%error, %url, "couldn't open a link");
    }
}

pub fn run() {
    let core = Arc::new(Core::new(client(), core::local_socket()).in_development(tauri::is_dev()));
    let (listening, reloading) = (Arc::clone(&core), Arc::clone(&core));
    // Started by the terminal check, the window is one terminal instead of the app.
    let check = check::Check::from_env();
    let checking = check.is_some();
    let page = check.as_ref().map_or_else(
        || "index.html".to_owned(),
        |check| format!("index.html?terminal-check={}", check.terminal),
    );
    let built = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(core)
        .manage(check)
        .manage(menu::Commands::default())
        .menu(menu::build)
        .on_menu_event(menu::chosen)
        // Closing the window hides it, as a Mac app's main window does: the app stays to
        // notify, and the Dock icon brings it back. Quitting quits.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            pairing,
            forget_pairing,
            local_host,
            open_local,
            open_host,
            open_dispatcher,
            pair_dispatcher,
            relay_send,
            relay_close,
            terminal_stream,
            clipboard_write,
            terminal_check_poll,
            terminal_check_report,
            set_menu,
        ])
        .setup(move |app| {
            // Terminals' streams, on a loopback port of the app's own: without it the app
            // still runs, and its terminals say why they don't draw.
            tauri::async_runtime::block_on(async {
                if let Err(error) = terminals::listen(&listening) {
                    tracing::warn!(%error, "couldn't listen for terminals' streams");
                }
            });
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App(page.into()))
                .title("Weave")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .on_navigation(|url| {
                    if own_page(url) {
                        return true;
                    }
                    open_elsewhere(url);
                    false
                })
                .on_new_window(|url, _| {
                    open_elsewhere(&url);
                    NewWindowResponse::Deny
                })
                // A page that loads again starts its connections afresh: the old ones go.
                .on_page_load(move |_, payload| {
                    if payload.event() == PageLoadEvent::Started {
                        reloading.relay().close_all();
                        reloading.streams().close_all();
                    }
                })
                .build()?;
            // A check measures what's drawn, and a covered window draws nothing: in front.
            if checking {
                let _ = window.set_focus();
            }
            Ok(())
        })
        .build(tauri::generate_context!());
    match built {
        Ok(app) => app.run(|app, event| {
            // Clicking the Dock icon with no window open shows the window again.
            if let tauri::RunEvent::Reopen { .. } = event
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }),
        Err(error) => {
            eprintln!("weave: couldn't start the app: {error}");
            std::process::exit(1);
        }
    }
}
