CCS/1
P:FolderPilot
PURPOSE:open-source automatic file organiser (Windows first); watches chosen folders, applies rules
DEP:Tauri2,Rust,vanilla TS+Vite
RULE:ponytail; minimal code, files, dependencies
RULE:comments/notes/summaries in CCS
RULE:targeted tests; rules engine gets real unit tests (matching, templates, clashes, undo); one full run at card end
!RULE:tests touch only temp dirs, never real user folders
RULE:UI=custom controls; no default browser/OS controls
RULE:contract=src-tauri/src/model.rs plus its Tauri commands/events (src-tauri/src/lib.rs)
RULE:engine owns src-tauri/src/engine; UI owns src
RULE:contract changes only on its owning card and are recorded on that card
!SEC:never delete or overwrite user files; name clash -> " (2)"; every move/rename journalled (undo per run)
SEC:no admin; autostart=HKCU Run
STATE:%APPDATA%/FolderPilot/rules.json,journal.jsonl
DEC:dev server port 1430 (1420 is often taken by other Tauri dev servers)
RULE:no push by agents; Szymon pushes once per version
