import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

// CCS/1 M:api | PURPOSE:typed bridge to src-tauri/src/model.rs commands (src-tauri/src/lib.rs)

export type When = {
  ext: string[];
  name_glob: string | null;
  older_than_days: number | null;
  min_size: number | null;
  max_size: number | null;
};
export type Then = { move_to: string } | { rename: string };
export type Rule = { id: string; name: string; enabled: boolean; folders: string[]; when: When; then: Then };
export type WatchedFolder = { path: string; paused: boolean };
export type Planned = { from: string; to: string; rule: string };
export type JournalEntry = { run: string; from: string; to: string; at: number; rule: string; size?: number; modified?: number };

export const api = {
  listRules: () => invoke<Rule[]>("list_rules"),
  saveRules: (rules: Rule[]) => invoke<void>("save_rules", { rules }),
  listFolders: () => invoke<WatchedFolder[]>("list_folders"),
  saveFolders: (folders: WatchedFolder[]) => invoke<void>("save_folders", { folders }),
  preview: (rule: Rule) => invoke<Planned[]>("preview", { rule }),
  apply: (planned: Planned[]) => invoke<JournalEntry[]>("apply", { planned }),
  activity: () => invoke<JournalEntry[]>("activity"),
  undo: (run: string) => invoke<void>("undo", { run }),
  pickFolder: async () => (await open({ directory: true })) as string | null,
  onActivity: (fn: () => void) => listen("activity", fn),
};

/** {name}=stem, {ext} without dot; date tokens from `date` (engine: EXIF for images, else modified). */
export function fill(template: string, stem: string, ext: string, date = new Date()) {
  const tokens: Record<string, string> = {
    name: stem,
    ext,
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(date.getDate()).padStart(2, "0"),
    counter: "1",
  };
  return template.replace(/\{(\w+)\}/g, (all, key) => tokens[key] ?? all);
}

/** Where `file` (in `folder`) ends up; rename keeps the extension unless the template has {ext}. */
export function target(rule: Rule, folder: string, file: string) {
  const dot = file.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot + 1)] : [file, ""];
  if ("move_to" in rule.then) return `${fill(rule.then.move_to, stem, ext)}/${file}`;
  const name = fill(rule.then.rename, stem, ext);
  return `${folder}/${rule.then.rename.includes("{ext}") || !ext ? name : `${name}.${ext}`}`;
}
