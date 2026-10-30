import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

// CCS/1 M:api | PURPOSE:typed bridge to src-tauri/src/model.rs commands | DEC:in-memory mock outside Tauri (plain browser at :1430) for UI work and screenshots

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
export type JournalEntry = { run: string; from: string; to: string; at: number; rule: string; size?: number };

const tauri = "__TAURI_INTERNALS__" in window;

export const api = {
  listRules: () => call<Rule[]>("list_rules"),
  saveRules: (rules: Rule[]) => call<void>("save_rules", { rules }),
  listFolders: () => call<WatchedFolder[]>("list_folders"),
  saveFolders: (folders: WatchedFolder[]) => call<void>("save_folders", { folders }),
  preview: (rule: Rule) => call<Planned[]>("preview", { rule }),
  apply: (planned: Planned[]) => call<JournalEntry[]>("apply", { planned }),
  activity: () => call<JournalEntry[]>("activity"),
  undo: (run: string) => call<void>("undo", { run }),
  pickFolder: async () =>
    tauri ? ((await open({ directory: true })) as string | null) : mockFolders[mock.folders.length % mockFolders.length],
  onActivity: (fn: () => void) => (tauri ? listen("activity", fn) : undefined),
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

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return tauri ? invoke<T>(cmd, args) : (mockCall(cmd, args ?? {}) as T);
}

// ponytail: mock only fakes ext matching; real matching is the engine's (#161).
const mockFolders = ["~/Downloads", "~/Desktop", "D:/Scans"];
const mockFiles = ["invoice-0412.pdf", "IMG_2041.jpg", "setup.exe", "notes.txt", "contract.pdf", "IMG_2042.jpg"];
const mock = {
  rules: [] as Rule[],
  folders: [{ path: "~/Downloads", paused: false }, { path: "~/Desktop", paused: true }] as WatchedFolder[],
  journal: [
    { run: "r1", from: "~/Downloads/statement.pdf", to: "~/Documents/PDF/statement.pdf", at: 1761810000, rule: "" },
    { run: "r1", from: "~/Downloads/receipt.pdf", to: "~/Documents/PDF/receipt.pdf", at: 1761810000, rule: "" },
    { run: "r2", from: "~/Downloads/IMG_1990.jpg", to: "~/Pictures/2026/10/IMG_1990.jpg", at: 1761830000, rule: "" },
  ] as JournalEntry[],
};

function mockCall(cmd: string, args: Record<string, any>): unknown {
  switch (cmd) {
    case "list_rules": return structuredClone(mock.rules);
    case "save_rules": mock.rules = structuredClone(args.rules); return;
    case "list_folders": return structuredClone(mock.folders);
    case "save_folders": mock.folders = structuredClone(args.folders); return;
    case "preview": {
      const rule = args.rule as Rule;
      const folders = rule.folders.length ? rule.folders : mock.folders.map((f) => f.path);
      return folders.flatMap((folder) =>
        mockFiles
          .filter((file) => !rule.when.ext.length || rule.when.ext.includes(file.split(".").pop()!))
          .map((file) => ({ from: `${folder}/${file}`, to: target(rule, folder, file), rule: rule.id })),
      );
    }
    case "apply": {
      const run = crypto.randomUUID();
      const at = Math.floor(Date.now() / 1000);
      const entries = (args.planned as Planned[]).map((p) => ({ run, at, ...p }));
      mock.journal.push(...entries);
      return entries;
    }
    case "activity": return structuredClone(mock.journal);
    case "undo": mock.journal = mock.journal.filter((e) => e.run !== args.run); return;
  }
}
