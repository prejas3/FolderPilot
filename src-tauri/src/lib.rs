mod engine;
pub mod model;
mod watch;

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

use model::{JournalEntry, Planned, Rule, WatchedFolder, ACTIVITY_EVENT};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager, State, WindowEvent,
};
use watch::{autostart, Organizer};

// CCS/1 M:commands | IO:UI <-> Organizer | STATE:%APPDATA%/FolderPilot/rules.json {rules, folders} + journal.jsonl
struct App {
    org: Arc<Organizer>,
    config: PathBuf,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Config {
    rules: Vec<Rule>,
    folders: Vec<WatchedFolder>,
}

/// Missing = first start. Unreadable = kept aside as rules.json.bad (never lost), start empty.
fn load_config(path: &Path) -> Config {
    let Ok(text) = fs::read_to_string(path) else { return Config::default() };
    serde_json::from_str(&text).unwrap_or_else(|error| {
        eprintln!("folderpilot: {}: {error}", path.display());
        let _ = fs::rename(path, path.with_extension("json.bad"));
        Config::default()
    })
}

/// Write-then-rename, so a crash mid-write leaves the old file whole.
fn save_config(app: &App) -> Result<(), String> {
    let config = Config { rules: app.org.rules.lock().map_err(|e| e.to_string())?.clone(), folders: app.org.folders() };
    let write = || -> io::Result<()> {
        let tmp = app.config.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(&config)?)?;
        fs::rename(tmp, &app.config)
    };
    write().map_err(|error| error.to_string())
}

#[tauri::command]
fn list_rules(app: State<'_, App>) -> Result<Vec<Rule>, String> {
    Ok(app.org.rules.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
fn save_rules(rules: Vec<Rule>, app: State<'_, App>) -> Result<(), String> {
    *app.org.rules.lock().map_err(|e| e.to_string())? = rules;
    save_config(&app)
}

#[tauri::command]
fn list_folders(app: State<'_, App>) -> Vec<WatchedFolder> {
    app.org.folders()
}

#[tauri::command]
fn save_folders(folders: Vec<WatchedFolder>, app: State<'_, App>) -> Result<(), String> {
    app.org.set_folders(folders);
    save_config(&app)
}

/// Dry run of one rule (saved or still in the editor) over the watched folders it applies to.
#[tauri::command]
fn preview(rule: Rule, app: State<'_, App>) -> Result<Vec<Planned>, String> {
    app.org.preview(&rule).map_err(|error| error.to_string())
}

/// Carries out the planned moves as one run. Files left alone come back as an error after the rest moved.
#[tauri::command]
fn apply(planned: Vec<Planned>, app: State<'_, App>) -> Result<Vec<JournalEntry>, String> {
    let applied = app.org.apply(&planned).map_err(|error| error.to_string())?;
    match left(&applied.failed) {
        Some(why) => Err(format!("Moved {}, left {}", applied.done.len(), why)),
        None => Ok(applied.done),
    }
}

#[tauri::command]
fn activity(app: State<'_, App>) -> Result<Vec<JournalEntry>, String> {
    engine::load_journal(&app.org.journal).map_err(|error| error.to_string())
}

#[tauri::command]
fn undo(run: String, app: State<'_, App>) -> Result<(), String> {
    let undone = app.org.undo(&run).map_err(|error| error.to_string())?;
    match left(&undone.skipped) {
        Some(why) => Err(format!("Moved back {}, left {}", undone.restored.len(), why)),
        None => Ok(()),
    }
}

/// "2: a.pdf (no longer there), b.pdf (…)".
fn left(files: &[(PathBuf, String)]) -> Option<String> {
    (!files.is_empty()).then(|| {
        let list: Vec<String> = files
            .iter()
            .map(|(path, why)| format!("{} ({why})", path.file_name().unwrap_or_default().to_string_lossy()))
            .collect();
        format!("{}: {}", files.len(), list.join(", "))
    })
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
            fs::create_dir_all(&root)?;
            let handle = app.handle().clone();
            let org = Arc::new(Organizer::new(root.join("journal.jsonl"), move |done| {
                let _ = handle.emit(ACTIVITY_EVENT, done);
            })?);
            let config = root.join("rules.json");
            let saved = load_config(&config);
            *org.rules.lock().map_err(|e| e.to_string())? = saved.rules;
            org.set_folders(saved.folders);
            app.manage(App { org: org.clone(), config });
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
                        let org = &app.state::<App>().org;
                        let paused = !org.is_paused();
                        org.set_paused(paused);
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

#[cfg(test)]
mod tests {
    use super::*;
    use engine::tests::{rule, Temp};
    use model::{Then, When};

    #[test]
    fn rules_and_folders_survive_restart() {
        let t = Temp::new();
        let app = App { org: Arc::new(Organizer::new(t.0.join("journal.jsonl"), |_| {}).unwrap()), config: t.0.join("rules.json") };
        *app.org.rules.lock().unwrap() = vec![rule("pdf", When { ext: vec!["pdf".into()], ..Default::default() }, Then::MoveTo("~/Documents/PDF".into()))];
        app.org.set_folders(vec![WatchedFolder { path: t.0.join("in"), paused: true }]);
        save_config(&app).unwrap();
        let loaded = load_config(&app.config);
        assert_eq!(loaded.rules, *app.org.rules.lock().unwrap());
        assert_eq!(loaded.folders, app.org.folders());
        assert!(!t.0.join("rules.json.tmp").exists());
    }

    #[test]
    fn unreadable_config_is_kept_aside() {
        let t = Temp::new();
        let config = t.file("rules.json", b"{ not json");
        assert!(load_config(&config).rules.is_empty());
        assert_eq!(fs::read(t.0.join("rules.json.bad")).unwrap(), b"{ not json");
        assert!(load_config(&t.0.join("missing.json")).folders.is_empty());
    }
}
