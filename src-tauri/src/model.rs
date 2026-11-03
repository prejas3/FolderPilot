//! Contract between engine, storage and UI. Serialised as-is over Tauri IPC and in rules.json / journal.jsonl.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Emitted with a `Vec<JournalEntry>` after every applied run (watcher or manual).
pub const ACTIVITY_EVENT: &str = "activity";
/// Emitted (no payload) when the tray changes something the Settings page shows; the UI reads `get_settings` again.
pub const SETTINGS_EVENT: &str = "settings";

/// Settings page state. lang "en"|"pl" (saved choice, else Windows UI language); theme "system"|"light"|"dark".
/// lang and theme persist in rules.json; autostart is the HKCU Run value; paused is the tray's "Pause all" (not saved).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Settings {
    pub lang: String,
    pub theme: String,
    pub autostart: bool,
    pub paused: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    /// Watched folders this rule applies to; empty = all of them.
    pub folders: Vec<PathBuf>,
    pub when: When,
    pub then: Then,
}

/// All set conditions must hold; unset ones are ignored.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct When {
    /// Lower-case, without the dot ("pdf"); empty = any extension.
    pub ext: Vec<String>,
    pub name_glob: Option<String>,
    pub older_than_days: Option<u32>,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
}

/// Templates take {name} {ext} {year} {month} {day} {counter}; date = EXIF for images, else modified time.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Then {
    /// Target folder; "~" is the user's home.
    MoveTo(String),
    /// New file name, same folder; {name} is the stem and the extension is kept unless the template has {ext}.
    Rename(String),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WatchedFolder {
    pub path: PathBuf,
    pub paused: bool,
}

/// One move/rename a run would do; `to` already has name clashes resolved (" (2)").
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Planned {
    pub from: PathBuf,
    pub to: PathBuf,
    /// Rule id.
    pub rule: String,
}

/// One line of journal.jsonl; undo replays a run's entries backwards.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct JournalEntry {
    pub run: String,
    pub from: PathBuf,
    pub to: PathBuf,
    /// Unix seconds.
    pub at: u64,
    pub rule: String,
    /// Bytes when moved; undo skips a file whose size changed since.
    #[serde(default)]
    pub size: u64,
    /// Modified time when moved, unix nanoseconds; undo also skips a file whose time changed. 0 = unknown.
    #[serde(default)]
    pub modified: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rule_json_shape() {
        let rule = Rule {
            id: "pdf".into(),
            name: "PDFs".into(),
            enabled: true,
            folders: vec![],
            when: When { ext: vec!["pdf".into()], ..Default::default() },
            then: Then::MoveTo("~/Documents/PDF".into()),
        };
        let value = serde_json::to_value(&rule).unwrap();
        assert_eq!(value["then"], json!({ "move_to": "~/Documents/PDF" }));
        assert_eq!(value["when"]["older_than_days"], json!(null));
        let partial: When = serde_json::from_value(json!({ "ext": ["jpg"] })).unwrap();
        assert_eq!(partial.min_size, None);
        assert_eq!(serde_json::from_value::<Rule>(value).unwrap(), rule);
    }
}
