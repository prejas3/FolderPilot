//! CCS/1 M:engine | PURPOSE:pure rules logic, no watcher | DEP:model,chrono,glob,kamadak-exif
//! FLOW:plan(folder, rules, produced) -> Planned[] -> run::apply -> journal.jsonl; run::undo(run) replays a run backwards
//! RULE:first matching rule wins, top->bottom; non-recursive; files FolderPilot already placed (journal `to`) are never touched again
//! WHY(produced):stops loops (a rename rule re-matching its own output) and re-moving files right after an undo restored them.
mod run;

pub use run::{apply, load_journal, produced, undo, Applied, Undone};

use crate::model::{Planned, Rule, Then, When};
use chrono::{DateTime, Datelike, Local, NaiveDate};
use glob::{MatchOptions, Pattern};
use std::{
    collections::HashSet,
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// Downloads and Office lock files still being written.
const IN_PROGRESS: [&str; 6] = ["crdownload", "part", "partial", "download", "opdownload", "tmp"];
/// Image types that may carry EXIF DateTimeOriginal.
const EXIF_EXT: [&str; 8] = ["jpg", "jpeg", "heic", "heif", "tif", "tiff", "png", "webp"];

/// Planned moves for one folder. `rules` are taken as given (callers pass the enabled ones; preview passes one draft).
pub fn plan(folder: &Path, rules: &[Rule], produced: &HashSet<String>) -> io::Result<Vec<Planned>> {
    let rules: Vec<&Rule> = rules
        .iter()
        .filter(|rule| rule.folders.is_empty() || rule.folders.iter().any(|f| key(f) == key(folder)))
        .collect();
    let mut entries: Vec<_> = fs::read_dir(folder)?.filter_map(Result::ok).collect();
    entries.sort_by_key(|entry| entry.file_name()); // stable {counter}
    let now = SystemTime::now();
    let mut counters = vec![0; rules.len()];
    let mut taken = HashSet::new();
    let mut planned = Vec::new();
    for entry in entries {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || hidden(&meta) || in_progress(&path) || produced.contains(&key(&path)) {
            continue;
        }
        let Some(i) = rules.iter().position(|rule| matches(&path, &meta, &rule.when, now)) else {
            continue;
        };
        counters[i] += 1;
        let to = target(&rules[i].then, folder, &path, counters[i]);
        if key(&to) == key(&path) {
            continue;
        }
        let to = (1..)
            .map(|n| numbered(&to, n))
            .find(|candidate| !candidate.exists() && taken.insert(key(candidate)))
            .expect("unbounded");
        planned.push(Planned { from: path, to, rule: rules[i].id.clone() });
    }
    Ok(planned)
}

pub fn matches(path: &Path, meta: &fs::Metadata, when: &When, now: SystemTime) -> bool {
    let ext = ext_of(path);
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let glob = MatchOptions { case_sensitive: false, ..MatchOptions::new() };
    (when.ext.is_empty() || when.ext.iter().any(|e| e.eq_ignore_ascii_case(&ext)))
        && when
            .name_glob
            .as_deref()
            .filter(|g| !g.is_empty())
            .is_none_or(|g| Pattern::new(g).is_ok_and(|p| p.matches_with(&name, glob)))
        && when.older_than_days.is_none_or(|days| {
            meta.modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .is_some_and(|age| age >= Duration::from_secs(u64::from(days) * 86_400))
        })
        && when.min_size.is_none_or(|size| meta.len() > size)
        && when.max_size.is_none_or(|size| meta.len() < size)
}

/// Fills {name} (stem) {ext} {year} {month} {day} {counter}; unknown tokens stay as typed.
pub fn render(template: &str, path: &Path, counter: usize) -> String {
    let date = file_date(path);
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('}') else { break };
        let token = &rest[open + 1..open + close];
        match token {
            "name" => out.push_str(&stem),
            "ext" => out.push_str(&ext_of(path)),
            "year" => out.push_str(&format!("{:04}", date.year())),
            "month" => out.push_str(&format!("{:02}", date.month())),
            "day" => out.push_str(&format!("{:02}", date.day())),
            "counter" => out.push_str(&counter.to_string()),
            _ => out.push_str(&rest[open..=open + close]),
        }
        rest = &rest[open + close + 1..];
    }
    out + rest
}

/// MoveTo: folder template ("~" = home, relative = inside the watched folder) + same file name.
/// Rename: same folder; extension kept unless the template has {ext}.
pub fn target(then: &Then, folder: &Path, path: &Path, counter: usize) -> PathBuf {
    match then {
        Then::MoveTo(template) => expand(&render(template, path, counter), folder).join(path.file_name().unwrap_or_default()),
        Then::Rename(template) => {
            let mut name: String = render(template, path, counter)
                .chars()
                .map(|c| if "\\/:*?\"<>|".contains(c) { '-' } else { c })
                .collect();
            let ext = path.extension().unwrap_or_default().to_string_lossy();
            if !template.contains("{ext}") && !ext.is_empty() {
                name = format!("{}.{ext}", name.trim_end());
            }
            path.with_file_name(name.trim())
        }
    }
}

pub fn expand(dir: &str, folder: &Path) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    match dir.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => home.join(rest.trim_start_matches(['/', '\\'])),
        _ => folder.join(dir), // join keeps absolute `dir` as is
    }
}

/// "a.pdf" n=2 -> "a (2).pdf"; n=1 is the path itself.
pub fn numbered(path: &Path, n: usize) -> PathBuf {
    if n == 1 {
        return path.to_path_buf();
    }
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    match path.extension() {
        Some(ext) => path.with_file_name(format!("{stem} ({n}).{}", ext.to_string_lossy())),
        None => path.with_file_name(format!("{stem} ({n})")),
    }
}

/// Comparable path: Windows paths are case-insensitive and take either slash.
pub fn key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn ext_of(path: &Path) -> String {
    path.extension().unwrap_or_default().to_string_lossy().into_owned()
}

fn in_progress(path: &Path) -> bool {
    let name = path.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
    name.starts_with("~$") || IN_PROGRESS.iter().any(|ext| ext_of(path).eq_ignore_ascii_case(ext))
}

/// desktop.ini, thumbs.db and other hidden/system files.
fn hidden(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x6 != 0 // HIDDEN | SYSTEM
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

/// EXIF DateTimeOriginal for images, else the local modified date.
fn file_date(path: &Path) -> NaiveDate {
    exif_date(path).unwrap_or_else(|| {
        let modified = fs::metadata(path).and_then(|m| m.modified()).unwrap_or_else(|_| SystemTime::now());
        DateTime::<Local>::from(modified).date_naive()
    })
}

fn exif_date(path: &Path) -> Option<NaiveDate> {
    if !EXIF_EXT.iter().any(|ext| ext_of(path).eq_ignore_ascii_case(ext)) {
        return None;
    }
    let mut file = io::BufReader::new(fs::File::open(path).ok()?);
    let exif = exif::Reader::new().read_from_container(&mut file).ok()?;
    let field = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)?;
    let exif::Value::Ascii(values) = &field.value else { return None };
    let text = std::str::from_utf8(values.first()?).ok()?;
    NaiveDate::parse_from_str(text.get(..10)?, "%Y:%m:%d").ok()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::model::When;
    use chrono::TimeZone;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Temp dir removed on drop; tests never touch real user folders.
    pub struct Temp(pub PathBuf);
    impl Temp {
        pub fn new() -> Self {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "folderpilot-test-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&dir).unwrap();
            Temp(dir)
        }
        pub fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, bytes).unwrap();
            path
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    pub fn rule(id: &str, when: When, then: Then) -> Rule {
        Rule { id: id.into(), name: id.into(), enabled: true, folders: vec![], when, then }
    }

    fn set_modified(path: &Path, time: SystemTime) {
        fs::File::options().write(true).open(path).unwrap().set_modified(time).unwrap();
    }

    fn local(y: i32, m: u32, d: u32) -> SystemTime {
        Local.with_ymd_and_hms(y, m, d, 12, 0, 0).unwrap().into()
    }

    fn check(path: &Path, when: &When) -> bool {
        matches(path, &fs::metadata(path).unwrap(), when, SystemTime::now())
    }

    #[test]
    fn each_condition() {
        let t = Temp::new();
        let pdf = t.file("Invoice-04.PDF", &[0; 2048]);
        assert!(check(&pdf, &When { ext: vec!["pdf".into()], ..Default::default() }));
        assert!(!check(&pdf, &When { ext: vec!["docx".into()], ..Default::default() }));
        assert!(check(&pdf, &When { name_glob: Some("*invoice*".into()), ..Default::default() }));
        assert!(!check(&pdf, &When { name_glob: Some("receipt*".into()), ..Default::default() }));
        assert!(check(&pdf, &When { min_size: Some(1024), max_size: Some(4096), ..Default::default() }));
        assert!(!check(&pdf, &When { min_size: Some(2048), ..Default::default() }));
        assert!(!check(&pdf, &When { max_size: Some(2048), ..Default::default() }));
        let older = When { older_than_days: Some(90), ..Default::default() };
        assert!(!check(&pdf, &older));
        set_modified(&pdf, SystemTime::now() - Duration::from_secs(91 * 86_400));
        assert!(check(&pdf, &older));
        let all = When { ext: vec!["pdf".into()], name_glob: Some("invoice*".into()), older_than_days: Some(90), ..Default::default() };
        assert!(check(&pdf, &all));
    }

    #[test]
    fn tokens_and_targets() {
        let t = Temp::new();
        let file = t.file("report.txt", b"x");
        set_modified(&file, local(2021, 3, 4));
        assert_eq!(render("{year}/{month}/{day} {name}.{ext} #{counter} {nope}", &file, 3), "2021/03/04 report.txt #3 {nope}");
        let folder = &t.0;
        assert_eq!(target(&Then::Rename("{year}-{month}-{day} {name}".into()), folder, &file, 1), folder.join("2021-03-04 report.txt"));
        assert_eq!(target(&Then::Rename("{name}.bak.{ext}".into()), folder, &file, 1), folder.join("report.bak.txt"));
        assert_eq!(target(&Then::Rename("a/b:{name}".into()), folder, &file, 1), folder.join("a-b-report.txt"));
        assert_eq!(target(&Then::MoveTo("Sorted/{year}".into()), folder, &file, 1), folder.join("Sorted/2021/report.txt"));
        let home = dirs::home_dir().unwrap();
        assert_eq!(target(&Then::MoveTo("~/Documents/PDF".into()), folder, &file, 1), home.join("Documents/PDF/report.txt"));
        let abs = folder.join("Archive");
        assert_eq!(target(&Then::MoveTo(abs.to_string_lossy().into()), Path::new("C:/other"), &file, 1), abs.join("report.txt"));
    }

    /// Minimal JPEG: SOI, APP1 "Exif" with IFD0 -> ExifIFD -> DateTimeOriginal, EOI.
    fn jpeg_with_exif(date: &str) -> Vec<u8> {
        let mut tiff = b"II\x2a\x00\x08\x00\x00\x00".to_vec();
        tiff.extend([1, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]); // IFD0: ExifIFD at 26
        tiff.extend([1, 0, 0x03, 0x90, 2, 0, 20, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0]); // DateTimeOriginal, 20 bytes at 44
        tiff.extend(date.as_bytes());
        tiff.push(0);
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(tiff);
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE1];
        jpeg.extend(((app1.len() + 2) as u16).to_be_bytes());
        jpeg.extend(app1);
        jpeg.extend([0xFF, 0xD9]);
        jpeg
    }

    #[test]
    fn exif_date_then_modified_fallback() {
        let t = Temp::new();
        let photo = t.file("IMG_1.jpg", &jpeg_with_exif("2019:07:04 10:00:00"));
        let plain = t.file("IMG_2.jpg", b"not really a jpeg");
        for path in [&photo, &plain] {
            set_modified(path, local(2021, 3, 4));
        }
        assert_eq!(render("{year}-{month}-{day}", &photo, 1), "2019-07-04");
        assert_eq!(render("{year}-{month}-{day}", &plain, 1), "2021-03-04");
    }

    #[test]
    fn plan_order_skips_and_clashes() {
        let t = Temp::new();
        let inbox = t.0.join("in");
        for name in ["a.pdf", "b.pdf", "c.jpg", "d.crdownload", "~$e.docx", "f.part", "g.txt"] {
            t.file(&format!("in/{name}"), b"x");
        }
        t.file("Docs/a.pdf", b"already here");
        let rules = [
            rule("pdf", When { ext: vec!["pdf".into()], ..Default::default() }, Then::MoveTo("../Docs".into())),
            rule("any", When::default(), Then::MoveTo("../Other".into())),
            rule("elsewhere", When::default(), Then::MoveTo("../Never".into())),
        ];
        let mut rules = rules.to_vec();
        rules[2].folders = vec![t.0.join("somewhere-else")];
        rules.swap(1, 2); // a rule for another folder must not shadow "any"
        let planned = plan(&inbox, &rules, &HashSet::new()).unwrap();
        let got: Vec<_> = planned
            .iter()
            .map(|p| (p.from.file_name().unwrap().to_string_lossy().into_owned(), p.to.strip_prefix(&inbox).unwrap().to_string_lossy().replace('\\', "/"), p.rule.as_str()))
            .collect();
        assert_eq!(
            got,
            [
                ("a.pdf".into(), "../Docs/a (2).pdf".into(), "pdf"),
                ("b.pdf".into(), "../Docs/b.pdf".into(), "pdf"),
                ("c.jpg".into(), "../Other/c.jpg".into(), "any"),
                ("g.txt".into(), "../Other/g.txt".into(), "any"),
            ]
        );
    }

    #[test]
    fn rename_clash_within_one_plan_and_no_op_rename() {
        let t = Temp::new();
        t.file("x.pdf", b"1");
        t.file("y.pdf", b"2");
        t.file("doc.txt", b"3");
        let rules = [rule("r", When::default(), Then::Rename("doc".into()))];
        let mut to: Vec<_> = plan(&t.0, &rules, &HashSet::new()).unwrap().into_iter().map(|p| p.to).collect();
        to.sort();
        // doc.txt renames to itself: skipped, not "doc (2).txt".
        assert_eq!(to, [t.0.join("doc (2).pdf"), t.0.join("doc.pdf")]);
    }
}
