#[allow(dead_code, unused_imports)] // CCS/1 TODO:#164 wires engine into the commands
mod engine;
pub mod model;
#[allow(dead_code)] // CCS/1 TODO:#164 commands use Organizer apply/undo/rules/folders
mod watch;

use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
};

use model::{JournalEntry, Planned, Rule, WatchedFolder, ACTIVITY_EVENT};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, WindowEvent,
};
use watch::{autostart, Organizer};

// ponytail: command stubs; engine (card 2) and storage (card 5) fill them in.
#[tauri::command]
fn list_rules() -> Vec<Rule> {
    Vec::new()
}

#[tauri::command]
fn save_rules(rules: Vec<Rule>) -> Result<(), String> {
    let _ = rules;
    Ok(())
}

#[tauri::command]
fn list_folders() -> Vec<WatchedFolder> {
    Vec::new()
}

#[tauri::command]
fn save_folders(folders: Vec<WatchedFolder>) -> Result<(), String> {
    let _ = folders;
    Ok(())
}

/// Dry run of one rule (saved or still in the editor) over its folders.
#[tauri::command]
fn preview(rule: Rule) -> Result<Vec<Planned>, String> {
    let _ = rule;
    Ok(Vec::new())
}

/// Carries out the planned moves as one run; returns what was journalled.
#[tauri::command]
fn apply(planned: Vec<Planned>) -> Result<Vec<JournalEntry>, String> {
    let _ = planned;
    Ok(Vec::new())
}

#[tauri::command]
fn activity() -> Result<Vec<JournalEntry>, String> {
    Ok(Vec::new())
}

#[tauri::command]
fn undo(run: String) -> Result<(), String> {
    let _ = run;
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .ok_or("APPDATA is unavailable")?
                .join("FolderPilot");
            let handle = app.handle().clone();
            let org = Arc::new(Organizer::new(root.join("journal.jsonl"), move |done| {
                let _ = handle.emit(ACTIVITY_EVENT, done);
            })?);
            app.manage(org.clone());
            watch::spawn(org)?;
            if !std::env::args().any(|arg| arg == autostart::ARG) {
                show_main(app.handle());
            }

            let open = MenuItem::with_id(app, "open", "Open FolderPilot", true, None::<&str>)?;
            let pause = CheckMenuItem::with_id(app, "pause", "Pause all", true, false, None::<&str>)?;
            let start = CheckMenuItem::with_id(app, "autostart", "Start with Windows", true, autostart::enabled(), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pause, &start, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("missing default window icon")?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("FolderPilot")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "pause" => {
                        let org = app.state::<Arc<Organizer>>();
                        let paused = !org.paused.load(Ordering::Relaxed);
                        org.paused.store(paused, Ordering::Relaxed);
                        let _ = pause.set_checked(paused);
                    }
                    "autostart" => {
                        if let Err(error) = autostart::set(!autostart::enabled()) {
                            eprintln!("folderpilot: autostart: {error}");
                        }
                        let _ = start.set_checked(autostart::enabled());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_rules,
            save_rules,
            list_folders,
            save_folders,
            preview,
            apply,
            activity,
            undo
        ])
        .run(tauri::generate_context!())
        .expect("error while running FolderPilot");
}
