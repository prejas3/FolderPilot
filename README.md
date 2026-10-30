# FolderPilot

Open-source automatic file organiser for Windows. Pick folders to watch, write simple rules, and FolderPilot moves or renames files for you.

- **Rules**: match by extension, name pattern, age or size; then move to a folder or rename, using `{name} {ext} {year} {month} {day} {counter}`.
- **Safe**: never deletes or overwrites (clashes get ` (2)`), skips files still downloading, previews before a rule goes live, and every run can be undone.
- **Quiet**: lives in the tray, no admin rights needed.

Status: early development.

## Develop

```sh
npm install
npm run tauri dev
cargo test --manifest-path src-tauri/Cargo.toml
```

## Licence

MIT, see [LICENSE](LICENSE).
