//! The Mac's menu bar: the standard App, Edit, View and Window menus, which the web view needs
//! for copying, pasting and undoing, and between them a menu for each group of the app's
//! commands (WVE-203). The page says what its commands are (`set_menu`): their names, titles and
//! keys are its table's (`src/app/commands.ts`), so the menu bar, a hardware keyboard elsewhere
//! and the palette all run the same ones. Choosing one, or pressing its key, sends its name to
//! the page as a `menu` event.

use std::collections::HashSet;
use std::sync::Mutex;
use std::sync::PoisonError;

use serde::Deserialize;
use tauri::AppHandle;
use tauri::Emitter as _;
use tauri::Manager as _;
use tauri::Runtime;
use tauri::menu::AboutMetadata;
use tauri::menu::Menu;
use tauri::menu::MenuEvent;
use tauri::menu::MenuItemBuilder;
use tauri::menu::PredefinedMenuItem;
use tauri::menu::Submenu;
use tauri::menu::SubmenuBuilder;

/// A menu of the page's commands.
#[derive(Clone, Debug, Deserialize)]
pub struct Group {
    pub title: String,
    pub items: Vec<Item>,
}

/// One of the page's commands: its name, what the menu calls it, and its key.
#[derive(Clone, Debug, Deserialize)]
pub struct Item {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub accelerator: Option<String>,
}

/// The names of the commands the menu bar lists, which are the only ones it sends the page.
#[derive(Default)]
pub struct Commands(Mutex<HashSet<String>>);

/// The menu bar before the page has said its commands.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    with_groups(app, &[])
}

/// The menu bar with the page's commands, a menu for each group that has some.
pub fn with_groups<R: Runtime>(app: &AppHandle<R>, groups: &[Group]) -> tauri::Result<Menu<R>> {
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
    // No Close Window: ⌘W closes the Block with the keyboard, as the page's command says.
    let window = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, Some("Zoom"))?)
        .build()?;
    let mut commands: Vec<Submenu<R>> = Vec::new();
    for group in groups.iter().filter(|group| !group.items.is_empty()) {
        let mut menu = SubmenuBuilder::new(app, &group.title);
        for item in &group.items {
            let mut entry = MenuItemBuilder::with_id(&item.id, &item.title);
            if let Some(accelerator) = &item.accelerator {
                entry = entry.accelerator(accelerator);
            }
            menu = menu.item(&entry.build(app)?);
        }
        commands.push(menu.build()?);
    }
    let menu = Menu::with_items(app, &[&weave, &edit])?;
    for submenu in &commands {
        menu.append(submenu)?;
    }
    menu.append(&view)?;
    menu.append(&window)?;
    Ok(menu)
}

/// Lists the page's commands in the menu bar, in place of those it listed before.
pub fn set<R: Runtime>(app: &AppHandle<R>, groups: &[Group]) -> tauri::Result<()> {
    let menu = with_groups(app, groups)?;
    app.set_menu(menu)?;
    let names = groups
        .iter()
        .flat_map(|group| group.items.iter().map(|item| item.id.clone()))
        .collect();
    *app.state::<Commands>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner) = names;
    Ok(())
}

/// One of the page's commands was chosen: the page hears its name.
pub fn chosen<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    let known = app
        .state::<Commands>()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .contains(id);
    if known {
        let _ = app.emit_to("main", "menu", id);
    }
}
