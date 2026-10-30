//! CCS/1 M:watch | PURPOSE:run rules by themselves: folder events + rescans | DEP:engine,notify
//! FLOW:notify event -> pending (2 s quiet, then size stable 1 s and not locked) -> plan+apply that folder's ready files -> on_run(entries)
//! FLOW:a folder starts being watched (app start, folder added, pause lifted) -> all its files queued as pending; again every hour (age rules)
//! !RULE:every automatic run goes through pending readiness (quiet/stable/unlocked), rescans included
//! RULE:global pause or folder.paused -> no watch, no runs; checked again under the run lock right before planning;
//!   set_paused/set_folders take the same lock, so once they return no run of the old state is still moving files
//! RULE:one run at a time (produced lock held across plan+apply)
//! RULE:no loops: files FolderPilot placed (journal `to`) are never planned again (engine::plan produced set)
use crate::{
    engine::{self, Applied, Undone},
    model::{JournalEntry, Planned, Rule, WatchedFolder},
};
use notify::{EventKind, RecursiveMode, Watcher};
use std::{
    collections::{HashMap, HashSet},
    fs, io,
    path::{Path, PathBuf},
    sync::{atomic::AtomicBool, atomic::Ordering, mpsc, Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

const QUIET: Duration = Duration::from_secs(2);
const STABLE: Duration = Duration::from_secs(1);
const TICK: Duration = Duration::from_millis(250);
const RESCAN: Duration = Duration::from_secs(3600);

type OnRun = Box<dyn Fn(&[JournalEntry]) + Send + Sync>;

pub struct Organizer {
    pub rules: Mutex<Vec<Rule>>,
    folders: Mutex<Vec<WatchedFolder>>,
    /// Tray "Pause all".
    paused: AtomicBool,
    pub journal: PathBuf,
    produced: Mutex<HashSet<String>>,
    on_run: OnRun,
}

impl Organizer {
    pub fn new(journal: PathBuf, on_run: impl Fn(&[JournalEntry]) + Send + Sync + 'static) -> io::Result<Self> {
        Ok(Self {
            rules: Mutex::default(),
            folders: Mutex::default(),
            paused: AtomicBool::new(false),
            produced: Mutex::new(engine::produced(&engine::load_journal(&journal)?)),
            journal,
            on_run: Box::new(on_run),
        })
    }

    pub fn set_paused(&self, paused: bool) {
        let _run = lock(&self.produced);
        self.paused.store(paused, Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::Relaxed)
    }

    pub fn set_folders(&self, folders: Vec<WatchedFolder>) {
        let _run = lock(&self.produced);
        *lock(&self.folders) = folders;
    }

    pub fn folders(&self) -> Vec<WatchedFolder> {
        lock(&self.folders).clone()
    }

    /// Plans enabled rules over `folder` and applies them; `only` limits it to those files (keys).
    /// Nothing runs unless the folder is watched and unpaused at this moment.
    pub fn run_folder(&self, folder: &Path, only: Option<&HashSet<String>>) -> io::Result<Applied> {
        let rules: Vec<Rule> = lock(&self.rules).iter().filter(|rule| rule.enabled).cloned().collect();
        let produced = lock(&self.produced);
        if !self.active().iter().any(|active| engine::key(active) == engine::key(folder)) {
            return Ok(Applied::default());
        }
        let planned: Vec<_> = engine::plan(folder, &rules, &produced)?
            .into_iter()
            .filter(|p| only.is_none_or(|only| only.contains(&engine::key(&p.from))) && !locked(&p.from))
            .collect();
        if planned.is_empty() {
            return Ok(Applied::default());
        }
        let applied = engine::apply(&planned, &self.journal)?;
        self.record(produced, &applied.done);
        Ok(applied)
    }

    /// Dry run of one rule over every watched folder it applies to (paused ones too); missing folders are skipped.
    pub fn preview(&self, rule: &Rule) -> io::Result<Vec<Planned>> {
        let produced = lock(&self.produced);
        let mut planned = Vec::new();
        for folder in self.folders() {
            match engine::plan(&folder.path, std::slice::from_ref(rule), &produced) {
                Ok(more) => planned.extend(more),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(planned)
    }

    /// Preview's Apply.
    pub fn apply(&self, planned: &[Planned]) -> io::Result<Applied> {
        let produced = lock(&self.produced);
        let applied = engine::apply(planned, &self.journal)?;
        self.record(produced, &applied.done);
        Ok(applied)
    }

    /// Restored files join the produced set, so the watcher leaves them where undo put them.
    pub fn undo(&self, run: &str) -> io::Result<Undone> {
        let produced = lock(&self.produced);
        let undone = engine::undo(run, &self.journal)?;
        self.record(produced, &undone.restored);
        Ok(undone)
    }

    fn record(&self, mut produced: MutexGuard<'_, HashSet<String>>, done: &[JournalEntry]) {
        produced.extend(done.iter().map(|e| engine::key(&e.to)));
        drop(produced);
        if !done.is_empty() {
            (self.on_run)(done);
        }
    }

    /// Watched, unpaused folders; none while paused.
    fn active(&self) -> HashSet<PathBuf> {
        if self.paused.load(Ordering::Relaxed) {
            return HashSet::new();
        }
        lock(&self.folders).iter().filter(|f| !f.paused).map(|f| f.path.clone()).collect()
    }

    fn run_logged(&self, folder: &Path, only: Option<&HashSet<String>>) {
        match self.run_folder(folder, only) {
            Ok(applied) => {
                for (path, error) in applied.failed {
                    eprintln!("folderpilot: left {}: {error}", path.display());
                }
            }
            Err(error) => eprintln!("folderpilot: {}: {error}", folder.display()),
        }
    }
}

/// Watcher thread for the app's lifetime.
pub fn spawn(org: Arc<Organizer>) -> notify::Result<()> {
    let (tx, rx) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(tx)?;
    thread::spawn(move || {
        let mut watched: HashSet<PathBuf> = HashSet::new();
        let mut pending = HashMap::new();
        let mut rescan_at = Instant::now() + RESCAN;
        loop {
            let active = org.active();
            for folder in watched.iter().filter(|folder| !active.contains(*folder)) {
                let _ = watcher.unwatch(folder);
            }
            watched.retain(|folder| active.contains(folder));
            let added: Vec<PathBuf> = active.difference(&watched).cloned().collect();
            for folder in added {
                if watcher.watch(&folder, RecursiveMode::NonRecursive).is_ok() {
                    enqueue(&folder, &mut pending, Instant::now());
                    watched.insert(folder);
                }
            }
            let mut events: Vec<_> = rx.recv_timeout(TICK).into_iter().collect();
            events.extend(rx.try_iter());
            let now = Instant::now();
            for event in events.into_iter().flatten() {
                if matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_)) {
                    for path in event.paths {
                        pending.insert(path, Pending { due: now + QUIET, size: None });
                    }
                }
            }
            if watched.is_empty() {
                pending.clear();
                continue;
            }
            if now >= rescan_at {
                rescan_at = now + RESCAN;
                for folder in &watched {
                    enqueue(folder, &mut pending, now);
                }
            }
            let mut by_folder: HashMap<PathBuf, HashSet<String>> = HashMap::new();
            for path in take_ready(&mut pending, now) {
                if let Some(folder) = path.parent().filter(|parent| watched.iter().any(|w| engine::key(w) == engine::key(parent))) {
                    by_folder.entry(folder.to_path_buf()).or_default().insert(engine::key(&path));
                }
            }
            for (folder, files) in by_folder {
                org.run_logged(&folder, Some(&files));
            }
        }
    });
    Ok(())
}

/// Rescan: every file of `folder` becomes pending (kept as is if already pending), checked from `due`.
fn enqueue(folder: &Path, pending: &mut HashMap<PathBuf, Pending>, due: Instant) {
    for entry in fs::read_dir(folder).into_iter().flatten().flatten() {
        pending.entry(entry.path()).or_insert(Pending { due, size: None });
    }
}

pub struct Pending {
    due: Instant,
    /// Size at the last check; None until the first one.
    size: Option<u64>,
}

/// Files quiet for QUIET, then unchanged in size across STABLE and not open elsewhere. Gone files are dropped.
pub fn take_ready(pending: &mut HashMap<PathBuf, Pending>, now: Instant) -> Vec<PathBuf> {
    let mut ready = Vec::new();
    pending.retain(|path, p| {
        if now < p.due {
            return true;
        }
        let Some(meta) = fs::metadata(path).ok().filter(|meta| meta.is_file()) else { return false };
        if p.size != Some(meta.len()) || locked(path) {
            *p = Pending { due: now + STABLE, size: Some(meta.len()) };
            return true;
        }
        ready.push(path.clone());
        false
    });
    ready
}

/// Open by another process (browser still writing, Office): exclusive open fails.
fn locked(path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        fs::OpenOptions::new().read(true).share_mode(0).open(path).is_err()
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// HKCU Run value: per user, no admin. Starts hidden in the tray.
pub mod autostart {
    pub const ARG: &str = "--autostart";
    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE: &str = "FolderPilot";

    pub fn enabled() -> bool {
        reg(&["query", KEY, "/v", VALUE]).unwrap_or(false)
    }

    pub fn set(on: bool) -> Result<(), String> {
        let ok = if on {
            let exe = std::env::current_exe().map_err(|error| error.to_string())?;
            reg(&["add", KEY, "/v", VALUE, "/t", "REG_SZ", "/d", &format!("\"{}\" {ARG}", exe.display()), "/f"])
        } else {
            reg(&["delete", KEY, "/v", VALUE, "/f"])
        };
        match ok {
            Ok(true) => Ok(()),
            Ok(false) => Err("reg.exe failed".into()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn reg(args: &[&str]) -> std::io::Result<bool> {
        let mut command = std::process::Command::new("reg");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        Ok(command.args(args).output()?.status.success())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        engine::tests::{rule, Temp},
        model::{Then, When},
    };

    fn pdf_rule(to: &Path) -> Rule {
        rule("pdf", When { ext: vec!["pdf".into()], ..Default::default() }, Then::MoveTo(to.to_string_lossy().into()))
    }

    #[test]
    fn waits_for_quiet_then_stable_size_then_unlocked() {
        let t = Temp::new();
        let file = t.file("a.pdf", b"12");
        let t0 = Instant::now();
        let mut pending = HashMap::from([(file.clone(), Pending { due: t0 + QUIET, size: None })]);
        let at = |secs: f32| t0 + Duration::from_secs_f32(secs);
        assert!(take_ready(&mut pending, at(1.0)).is_empty()); // not quiet yet
        assert!(take_ready(&mut pending, at(2.0)).is_empty()); // first size reading
        fs::write(&file, b"1234").unwrap(); // still growing
        assert!(take_ready(&mut pending, at(3.0)).is_empty());
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let _writer = fs::OpenOptions::new().read(true).share_mode(7).open(&file).unwrap();
            assert!(take_ready(&mut pending, at(4.0)).is_empty()); // same size but open elsewhere
        }
        assert_eq!(take_ready(&mut pending, at(5.0)), std::slice::from_ref(&file));
        assert!(pending.is_empty());
        // A file gone before it settled is dropped.
        pending.insert(t.0.join("gone.pdf"), Pending { due: t0, size: None });
        assert!(take_ready(&mut pending, at(9.0)).is_empty() && pending.is_empty());
    }

    #[test]
    fn two_watched_folders_do_not_ping_pong() {
        let t = Temp::new();
        let (a, b) = (t.0.join("a"), t.0.join("b"));
        t.file("a/x.pdf", b"x");
        fs::create_dir_all(&b).unwrap();
        let org = Organizer::new(t.0.join("journal.jsonl"), |_| {}).unwrap();
        let mut to_b = pdf_rule(&b);
        to_b.folders = vec![a.clone()];
        let mut to_a = pdf_rule(&a);
        to_a.folders = vec![b.clone()];
        *lock(&org.rules) = vec![to_b, to_a];
        org.set_folders([&a, &b].map(|path| WatchedFolder { path: path.clone(), paused: false }).to_vec());
        assert_eq!(org.run_folder(&a, None).unwrap().done.len(), 1);
        assert!(org.run_folder(&b, None).unwrap().done.is_empty());
        assert!(b.join("x.pdf").exists());
        // Same after a restart (produced set rebuilt from the journal).
        let again = Organizer::new(t.0.join("journal.jsonl"), |_| {}).unwrap();
        *lock(&again.rules) = lock(&org.rules).clone();
        again.set_folders(org.folders());
        assert!(again.run_folder(&b, None).unwrap().done.is_empty());
    }

    #[test]
    fn rescan_waits_for_growing_file() {
        let t = Temp::new();
        let file = t.file("big.pdf", b"12");
        let t0 = Instant::now();
        let mut pending = HashMap::new();
        enqueue(&t.0, &mut pending, t0);
        assert!(take_ready(&mut pending, t0).is_empty()); // first size reading
        fs::write(&file, b"1234").unwrap();
        assert!(take_ready(&mut pending, t0 + STABLE).is_empty()); // grew
        assert_eq!(take_ready(&mut pending, t0 + STABLE * 2), std::slice::from_ref(&file));
    }

    #[test]
    fn nothing_moves_once_paused() {
        let t = Temp::new();
        let (inbox, docs) = (t.0.join("in"), t.0.join("docs"));
        let file = t.file("in/a.pdf", b"x");
        let org = Organizer::new(t.0.join("journal.jsonl"), |_| {}).unwrap();
        *lock(&org.rules) = vec![pdf_rule(&docs)];
        let watched = |paused| vec![WatchedFolder { path: inbox.clone(), paused }];
        org.set_folders(watched(false));
        // A run queued before the pause (ready file, rescan) finds it paused when it starts.
        org.set_paused(true);
        assert!(org.run_folder(&inbox, None).unwrap().done.is_empty());
        org.set_paused(false);
        org.set_folders(watched(true));
        assert!(org.run_folder(&inbox, None).unwrap().done.is_empty());
        org.set_folders(vec![]);
        assert!(org.run_folder(&inbox, None).unwrap().done.is_empty());
        assert!(file.exists());
        org.set_folders(watched(false));
        assert_eq!(org.run_folder(&inbox, None).unwrap().done.len(), 1);
    }

    /// DONE check: a PDF dropped into a watched folder moves by itself within ~5 s.
    #[test]
    fn dropped_pdf_moves_by_itself() {
        let t = Temp::new();
        let (inbox, docs) = (t.0.join("in"), t.0.join("docs"));
        fs::create_dir_all(&inbox).unwrap();
        let (tx, rx) = mpsc::channel();
        let org = Arc::new(Organizer::new(t.0.join("journal.jsonl"), move |done| tx.send(done.len()).unwrap()).unwrap());
        *lock(&org.rules) = vec![pdf_rule(&docs)];
        org.set_folders(vec![WatchedFolder { path: inbox.clone(), paused: false }]);
        // The start rescan moving this one shows the watch is live, so the next file goes through events + debounce.
        t.file("in/already-there.pdf", b"%PDF");
        spawn(org.clone()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(15)).unwrap(), 1);
        let dropped = Instant::now();
        t.file("in/report.pdf", b"%PDF-1.7");
        t.file("in/notes.txt", b"stays");
        assert_eq!(rx.recv_timeout(Duration::from_secs(15)).unwrap(), 1);
        let took = dropped.elapsed();
        println!("moved after {took:?}");
        assert!(docs.join("report.pdf").exists() && !inbox.join("report.pdf").exists());
        assert!(inbox.join("notes.txt").exists());
        assert!(took >= QUIET + STABLE && took < Duration::from_secs(6), "{took:?}");
        // Paused: a new PDF stays.
        org.set_paused(true);
        t.file("in/later.pdf", b"%PDF");
        assert!(rx.recv_timeout(QUIET + STABLE * 3).is_err());
        assert!(inbox.join("later.pdf").exists());
    }
}
