//! The weave app on the Mac (ADR 0032, WVE-204): the React app the iPad and iPhone run, in a
//! Tauri window. Its core ([`core`]) reaches this Mac's Host over its socket and every other
//! Host through the Dispatcher this computer is paired with, and relays each connection to the
//! page ([`relay`]). The shell adds the menu bar and its shortcuts, which the page acts on
//! ([`menu`]), notifications, and `weave://` links.

pub mod core;
mod menu;
pub mod relay;

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
    let core = Arc::new(Core::new(client(), core::local_socket()));
    let relay = Arc::clone(core.relay());
    let built = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(core)
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
            set_menu,
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
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
                        relay.close_all();
                    }
                })
                .build()?;
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
