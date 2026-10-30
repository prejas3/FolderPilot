//! CCS/1 M:engine/run | PURPOSE:carry out planned moves, journal them, undo a run
//! !RULE:never overwrite; never delete user data except the source after a size-verified cross-volume copy
//! STATE:journal.jsonl, one JournalEntry per line, appended after every single move (a crash keeps what was done undoable)
//! !RULE:no unjournalled move: journal opened before the first move; a failed write moves that file back and aborts the run
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
    apply_to(planned, &mut open_journal(journal)?)
}

fn apply_to(planned: &[Planned], log: &mut impl Write) -> io::Result<Applied> {
    let mut applied = Applied { run: run_id(), ..Default::default() };
    for p in planned {
        match journalled_move(&p.from, &p.to, &applied.run, &p.rule, log)? {
            Ok(entry) => applied.done.push(entry),
            Err(error) => applied.failed.push((p.from.clone(), error.to_string())),
        }
    }
    Ok(applied)
}

/// Moves a run's files back, newest first, journalled as run "undo-<run>". Skips files gone or changed since.
pub fn undo(run: &str, journal: &Path) -> io::Result<Undone> {
    let entries = load_journal(journal)?;
    undo_to(run, &entries, &mut open_journal(journal)?)
}

fn undo_to(run: &str, entries: &[JournalEntry], log: &mut impl Write) -> io::Result<Undone> {
    let mut undone = Undone { run: format!("undo-{run}"), ..Default::default() };
    for e in entries.iter().filter(|e| e.run == run).rev() {
        let skip = match fs::metadata(&e.to) {
            Err(_) => Some("no longer there".to_string()),
            // modified 0 = entry from before it was journalled: size only.
            Ok(meta) if meta.len() != e.size || (e.modified != 0 && modified(&meta) != e.modified) => {
                Some("changed since it was moved".to_string())
            }
            Ok(_) => None,
        };
        if let Some(reason) = skip {
            undone.skipped.push((e.to.clone(), reason));
            continue;
        }
        match journalled_move(&e.to, &e.from, &undone.run, &e.rule, log)? {
            Ok(entry) => undone.restored.push(entry),
            Err(error) => undone.skipped.push((e.to.clone(), error.to_string())),
        }
    }
    Ok(undone)
}

/// Outer Err aborts the run (journal broken, file moved back); inner Err = this file left where it was.
fn journalled_move(from: &Path, to: &Path, run: &str, rule: &str, log: &mut impl Write) -> io::Result<io::Result<JournalEntry>> {
    let (to, size, modified) = match move_file(from, to) {
        Ok(moved) => moved,
        Err(error) => return Ok(Err(error)),
    };
    let entry = JournalEntry { run: run.into(), from: from.into(), to, at: now(), rule: rule.into(), size, modified };
    let written = serde_json::to_string(&entry)
        .map_err(io::Error::from)
        .and_then(|line| writeln!(log, "{line}"))
        .and_then(|()| log.flush());
    if let Err(error) = written {
        let back = match move_file(&entry.to, from) {
            Ok((back, ..)) => format!("moved back to {}", back.display()),
            Err(stuck) => format!("left at {} ({stuck})", entry.to.display()),
        };
        return Err(io::Error::other(format!("journal write failed ({error}); file {back}")));
    }
    Ok(Ok(entry))
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

fn open_journal(journal: &Path) -> io::Result<fs::File> {
    if let Some(dir) = journal.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::OpenOptions::new().create(true).append(true).open(journal)
}

fn modified(meta: &fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos() as u64)
}

/// Moves to `to`, or "name (2)", "name (3)"… if taken by then. Returns where it landed, its size and modified time.
fn move_file(from: &Path, to: &Path) -> io::Result<(PathBuf, u64, u64)> {
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
            Ok(()) => {
                let landed = fs::metadata(&candidate).unwrap_or(meta); // FAT may round the copied mtime
                return Ok((candidate, landed.len(), modified(&landed)));
            }
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
/// Source can't be removed (locked) -> our copy is removed instead, so no unjournalled duplicate stays.
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
            fs::remove_file(from).inspect_err(|_| {
                let _ = fs::remove_file(to);
            })
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

    struct BrokenJournal;
    impl Write for BrokenJournal {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("disk full"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn journal_failure_leaves_no_unjournalled_move() {
        let t = Temp::new();
        let from = t.file("in/a.pdf", b"a");
        let planned = [Planned { from: from.clone(), to: t.0.join("out/a.pdf"), rule: "r".into() }];
        // Journal unusable from the start (path is a folder): nothing moves.
        let folder_journal = t.0.join("in");
        assert!(apply(&planned, &folder_journal).is_err());
        assert!(from.exists());
        // Journal breaks mid-run: the moved file goes back and the run aborts.
        let error = apply_to(&planned, &mut BrokenJournal).unwrap_err();
        assert!(error.to_string().contains("moved back"), "{error}");
        assert_eq!(read(&from), "a");
        assert!(!t.0.join("out/a.pdf").exists());
        // Same for undo.
        let journal = t.0.join("journal.jsonl");
        let run = apply(&planned, &journal).unwrap();
        assert!(undo_to(&run.run, &load_journal(&journal).unwrap(), &mut BrokenJournal).is_err());
        assert_eq!(read(&t.0.join("out/a.pdf")), "a");
        assert!(!from.exists());
    }

    #[test]
    fn undo_skips_same_size_edit() {
        let t = Temp::new();
        let journal = t.0.join("journal.jsonl");
        let from = t.file("in/a.txt", b"abc");
        let planned = [Planned { from: from.clone(), to: t.0.join("out/a.txt"), rule: "r".into() }];
        let run = apply(&planned, &journal).unwrap();
        let moved = &run.done[0].to;
        fs::write(moved, b"xyz").unwrap();
        let later = UNIX_EPOCH + std::time::Duration::from_nanos(run.done[0].modified) + std::time::Duration::from_secs(60);
        fs::File::options().write(true).open(moved).unwrap().set_modified(later).unwrap();
        let undone = undo(&run.run, &journal).unwrap();
        assert_eq!(undone.skipped.len(), 1, "{undone:?}");
        assert_eq!(read(moved), "xyz");
        assert!(!from.exists());
    }

    /// A locked source (no delete sharing) must not leave a second copy behind.
    #[cfg(windows)]
    #[test]
    fn cross_volume_copy_keeps_only_source_when_source_is_locked() {
        use std::os::windows::fs::OpenOptionsExt;
        let t = Temp::new();
        let from = t.file("a.bin", b"data");
        let meta = fs::metadata(&from).unwrap();
        let lock = fs::OpenOptions::new().read(true).share_mode(1).open(&from).unwrap(); // FILE_SHARE_READ only
        let to = t.0.join("b.bin");
        assert!(copy_across(&from, &to, &meta).is_err());
        drop(lock);
        assert!(!to.exists());
        assert_eq!(read(&from), "data");
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
