//! CCS/1 M:engine/run | PURPOSE:carry out planned moves, journal them, undo a run
//! !RULE:never overwrite; never delete user data except the source after a size-verified cross-volume copy
//! STATE:journal.jsonl, one JournalEntry per line, appended after every single move (a crash keeps what was done undoable)
use super::{key, numbered};
use crate::model::{JournalEntry, Planned};
use std::{
    collections::HashSet,
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU32, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Default)]
pub struct Applied {
    pub run: String,
    pub done: Vec<JournalEntry>,
    /// Source path and why it was left alone.
    pub failed: Vec<(PathBuf, String)>,
}

#[derive(Debug, Default)]
pub struct Undone {
    pub run: String,
    pub restored: Vec<JournalEntry>,
    /// Moved file's path and why it was not moved back.
    pub skipped: Vec<(PathBuf, String)>,
}

pub fn apply(planned: &[Planned], journal: &Path) -> io::Result<Applied> {
    let mut applied = Applied { run: run_id(), ..Default::default() };
    for p in planned {
        match move_file(&p.from, &p.to) {
            Ok((to, size)) => {
                let entry = JournalEntry { run: applied.run.clone(), from: p.from.clone(), to, at: now(), rule: p.rule.clone(), size };
                append(journal, &entry)?;
                applied.done.push(entry);
            }
            Err(error) => applied.failed.push((p.from.clone(), error.to_string())),
        }
    }
    Ok(applied)
}

/// Moves a run's files back, newest first, journalled as run "undo-<run>". Skips files gone or changed since.
pub fn undo(run: &str, journal: &Path) -> io::Result<Undone> {
    let entries = load_journal(journal)?;
    let mut undone = Undone { run: format!("undo-{run}"), ..Default::default() };
    for e in entries.iter().filter(|e| e.run == run).rev() {
        let skip = match fs::metadata(&e.to) {
            Err(_) => Some("no longer there".to_string()),
            Ok(meta) if meta.len() != e.size => Some("changed since it was moved".to_string()),
            Ok(_) => None,
        };
        if let Some(reason) = skip {
            undone.skipped.push((e.to.clone(), reason));
            continue;
        }
        match move_file(&e.to, &e.from) {
            Ok((to, size)) => {
                let entry = JournalEntry { run: undone.run.clone(), from: e.to.clone(), to, at: now(), rule: e.rule.clone(), size };
                append(journal, &entry)?;
                undone.restored.push(entry);
            }
            Err(error) => undone.skipped.push((e.to.clone(), error.to_string())),
        }
    }
    Ok(undone)
}

pub fn load_journal(journal: &Path) -> io::Result<Vec<JournalEntry>> {
    match fs::File::open(journal) {
        Ok(file) => Ok(io::BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .filter_map(|line| serde_json::from_str(&line).ok())
            .collect()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error),
    }
}

/// Every path FolderPilot has put a file at (incl. undo restores), as `key`s for `plan`.
pub fn produced(entries: &[JournalEntry]) -> HashSet<String> {
    entries.iter().map(|e| key(&e.to)).collect()
}

fn append(journal: &Path, entry: &JournalEntry) -> io::Result<()> {
    if let Some(dir) = journal.parent() {
        fs::create_dir_all(dir)?;
    }
    let mut file = fs::OpenOptions::new().create(true).append(true).open(journal)?;
    writeln!(file, "{}", serde_json::to_string(entry)?)
}

/// Moves to `to`, or "name (2)", "name (3)"… if taken by then. Returns where it landed and its size.
fn move_file(from: &Path, to: &Path) -> io::Result<(PathBuf, u64)> {
    let meta = fs::metadata(from)?;
    if !meta.is_file() {
        return Err(io::Error::other("not a file"));
    }
    if let Some(dir) = to.parent() {
        fs::create_dir_all(dir)?;
    }
    for n in 1.. {
        let candidate = numbered(to, n);
        let result = match rename_new(from, &candidate) {
            Err(error) if crosses_volumes(&error) => copy_across(from, &candidate, &meta),
            result => result,
        };
        match result {
            Ok(()) => return Ok((candidate, meta.len())),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    unreachable!()
}

/// Rename that fails with AlreadyExists instead of replacing (std::fs::rename replaces on Windows).
#[cfg(windows)]
fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(Some(0)).collect::<Vec<u16>>();
    // Flags 0: no MOVEFILE_REPLACE_EXISTING, no MOVEFILE_COPY_ALLOWED (we copy across volumes ourselves, verified).
    if unsafe { MoveFileExW(wide(from).as_ptr(), wide(to).as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

// ponytail: exists-check then rename leaves a small race off Windows; renameat2(RENAME_NOREPLACE) closes it when macOS/Linux ship.
#[cfg(not(windows))]
fn rename_new(from: &Path, to: &Path) -> io::Result<()> {
    if to.exists() {
        return Err(io::ErrorKind::AlreadyExists.into());
    }
    fs::rename(from, to)
}

fn crosses_volumes(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::CrossesDevices || (cfg!(windows) && error.raw_os_error() == Some(17)) // ERROR_NOT_SAME_DEVICE
}

/// Copy into a new file (never over one), keep modified time, check size, then remove the source.
fn copy_across(from: &Path, to: &Path, meta: &fs::Metadata) -> io::Result<()> {
    let mut source = fs::File::open(from)?;
    let mut target = fs::OpenOptions::new().write(true).create_new(true).open(to)?;
    let copied = io::copy(&mut source, &mut target).and_then(|copied| {
        target.set_modified(meta.modified()?)?;
        target.sync_all()?;
        Ok(copied)
    });
    drop(target);
    match copied {
        Ok(copied) if copied == meta.len() && fs::metadata(to)?.len() == meta.len() => {
            drop(source);
            fs::remove_file(from)
        }
        other => {
            let _ = fs::remove_file(to); // our own partial copy, never user data
            other.and(Err(io::Error::other("copy size mismatch")))
        }
    }
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn run_id() -> String {
    static N: AtomicU32 = AtomicU32::new(0);
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    format!("{millis}-{}", N.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::super::{plan, tests::{rule, Temp}};
    use super::*;
    use crate::model::{Then, When};

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    #[test]
    fn apply_never_overwrites_and_journals() {
        let t = Temp::new();
        let journal = t.0.join("journal.jsonl");
        let from = t.file("in/a.pdf", b"new");
        t.file("out/a.pdf", b"old");
        // Planned before out/a.pdf existed: apply still must not replace it.
        let planned = [Planned { from: from.clone(), to: t.0.join("out/a.pdf"), rule: "r".into() }];
        let applied = apply(&planned, &journal).unwrap();
        assert!(applied.failed.is_empty());
        assert_eq!(read(&t.0.join("out/a.pdf")), "old");
        assert_eq!(read(&t.0.join("out/a (2).pdf")), "new");
        assert!(!from.exists());
        let journalled = load_journal(&journal).unwrap();
        assert_eq!(journalled, applied.done);
        assert_eq!(journalled[0].size, 3);
        // A vanished source fails alone, nothing journalled for it.
        let gone = [Planned { from: t.0.join("in/gone.pdf"), to: t.0.join("out/gone.pdf"), rule: "r".into() }];
        assert_eq!(apply(&gone, &journal).unwrap().failed.len(), 1);
        assert_eq!(load_journal(&journal).unwrap().len(), 1);
    }

    #[test]
    fn undo_across_runs() {
        let t = Temp::new();
        let journal = t.0.join("journal.jsonl");
        let inbox = t.0.join("in");
        t.file("in/a.pdf", b"a");
        t.file("in/b.pdf", b"bb");
        t.file("in/c.pdf", b"ccc");
        let pdfs = [rule("pdf", When { ext: vec!["pdf".into()], ..Default::default() }, Then::MoveTo("../Docs".into()))];
        let run1 = apply(&plan(&inbox, &pdfs, &HashSet::new()).unwrap(), &journal).unwrap();
        assert_eq!(run1.done.len(), 3);
        // Run 2 renames Docs/a.pdf on, and the user edits Docs/b.pdf.
        let docs = t.0.join("Docs");
        let rename = [rule("ren", When { name_glob: Some("a*".into()), ..Default::default() }, Then::Rename("{name}-x".into()))];
        let run2 = apply(&plan(&docs, &rename, &HashSet::new()).unwrap(), &journal).unwrap();
        assert_eq!(run2.done[0].to, docs.join("a-x.pdf"));
        fs::write(docs.join("b.pdf"), b"edited").unwrap();
        t.file("in/c.pdf", b"a new c"); // original spot taken again

        let undone = undo(&run1.run, &journal).unwrap();
        let skipped: HashSet<_> = undone.skipped.iter().map(|(p, _)| p.file_name().unwrap().to_owned()).collect();
        assert_eq!(skipped, HashSet::from(["a.pdf".into(), "b.pdf".into()])); // gone, changed
        assert_eq!(undone.restored.len(), 1);
        assert_eq!(read(&inbox.join("c (2).pdf")), "ccc");
        assert_eq!(read(&inbox.join("c.pdf")), "a new c");

        // Undoing run 2 brings a-x.pdf back to Docs/a.pdf.
        assert_eq!(undo(&run2.run, &journal).unwrap().restored.len(), 1);
        assert_eq!(read(&docs.join("a.pdf")), "a");

        // Restored files are not picked up again; the new c.pdf (never placed by us) is.
        let produced = produced(&load_journal(&journal).unwrap());
        let again: Vec<_> = plan(&inbox, &pdfs, &produced).unwrap().into_iter().map(|p| p.from).collect();
        assert_eq!(again, [inbox.join("c.pdf")]);
    }

    #[test]
    fn rename_rule_does_not_loop() {
        let t = Temp::new();
        let journal = t.0.join("journal.jsonl");
        let inbox = t.0.join("in");
        t.file("in/report.pdf", b"x");
        let rules = [rule("r", When::default(), Then::Rename("{year} {name}".into()))];
        assert_eq!(apply(&plan(&inbox, &rules, &HashSet::new()).unwrap(), &journal).unwrap().done.len(), 1);
        let again = plan(&inbox, &rules, &produced(&load_journal(&journal).unwrap())).unwrap();
        assert!(again.is_empty(), "{again:?}");
    }

    #[test]
    fn cross_volume_copy_is_verified_and_never_overwrites() {
        let t = Temp::new();
        let from = t.file("a.bin", &[7; 70_000]);
        let meta = fs::metadata(&from).unwrap();
        let taken = t.file("b.bin", b"keep");
        assert_eq!(copy_across(&from, &taken, &meta).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(read(&taken), "keep");
        assert!(from.exists());
        let to = t.0.join("c.bin");
        copy_across(&from, &to, &meta).unwrap();
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), vec![7; 70_000]);
        assert_eq!(fs::metadata(&to).unwrap().modified().unwrap(), meta.modified().unwrap());
    }
}
