//! The Mac's menu bar: the standard App, Edit, View and Window menus, which the web view needs
//! for copying, pasting and undoing, and a Thread menu whose items the page acts on. Choosing
//! one of those sends its id to the page as a `menu` event; WVE-203's command registry takes
//! them over.

use tauri::AppHandle;
use tauri::Emitter as _;
use tauri::Runtime;
use tauri::menu::AboutMetadata;
use tauri::menu::Menu;
use tauri::menu::MenuEvent;
use tauri::menu::MenuItemBuilder;
use tauri::menu::PredefinedMenuItem;
use tauri::menu::SubmenuBuilder;

/// The Thread menu's items: their ids, which the page knows, titles and shortcuts.
const COMMANDS: [(&str, &str, &str); 4] = [
    ("thread.new", "New Thread", "CmdOrCtrl+N"),
    ("thread.next", "Next Thread", "CmdOrCtrl+Shift+]"),
    ("thread.previous", "Previous Thread", "CmdOrCtrl+Shift+["),
    ("composer.focus", "Focus Composer", "CmdOrCtrl+L"),
];

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = AboutMetadata {
        name: Some("Weave".to_owned()),
        version: Some(env!("CARGO_PKG_VERSION").to_owned()),
        ..AboutMetadata::default()
    };
    let weave = SubmenuBuilder::new(app, "Weave")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About Weave"),
            Some(about),
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let mut thread = SubmenuBuilder::new(app, "Thread");
    for (id, title, shortcut) in COMMANDS {
        thread = thread.item(
            &MenuItemBuilder::with_id(id, title)
                .accelerator(shortcut)
                .build(app)?,
        );
    }
    let thread = thread.build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&PredefinedMenuItem::fullscreen(app, None)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    Menu::with_items(app, &[&weave, &thread, &edit, &view, &window])
}

/// A Thread menu item was chosen: the page hears its id.
pub fn chosen<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if COMMANDS.iter().any(|(command, _, _)| *command == id) {
        let _ = app.emit_to("main", "menu", id);
    }
}
