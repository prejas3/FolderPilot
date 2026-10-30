import { api, target, type JournalEntry, type Planned, type Rule, type WatchedFolder, type When } from "./api";
import "./style.css";

// CCS/1 M:ui | FLOW:state -> render() -> innerHTML; clicks via [data-act] delegation | RULE:custom controls only (switch, menu popover, segmented, chips, overlay scrollbar)

type View = "folders" | "rules" | "editor" | "preview" | "activity";

let view: View = "rules";
let rules: Rule[] = [];
let folders: WatchedFolder[] = [];
let draft: Rule | null = null;
let planned: Planned[] | null = null;
let previewOf = "all";
let journal: JournalEntry[] = [];
let hint = read("hint") !== "off";
let extRow = false;

const app = document.querySelector<HTMLElement>("#app")!;

const icon = (d: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const icons = {
  folder: icon('<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z"/>'),
  rules: icon('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  preview: icon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.5"/>'),
  activity: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  grip: icon('<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="3"/>'),
  edit: icon('<path d="M4 20h4L19 9l-4-4L4 16Z"/>'),
  trash: icon('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13"/>'),
  x: icon('<path d="M6 6l12 12M18 6 6 18"/>'),
  undo: icon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>'),
  info: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>'),
  chevron: icon('<path d="m7 10 5 5 5-5"/>'),
  arrow: icon('<path d="M5 12h14M13 6l6 6-6 6"/>'),
};

const starters: { label: string; rule: () => Rule }[] = [
  { label: "PDFs to Documents", rule: () => blank("PDFs to Documents", { ext: ["pdf"] }, { move_to: "~/Documents/PDF" }) },
  { label: "Photos by date", rule: () => blank("Photos by date", { ext: ["jpg", "jpeg", "png", "heic"] }, { move_to: "~/Pictures/{year}/{month}" }) },
  { label: "Rename with date", rule: () => blank("Rename with date", { ext: ["pdf", "docx"] }, { rename: "{year}-{month}-{day} {name}" }) },
  { label: "Archive older than 90 days", rule: () => blank("Archive old files", { older_than_days: 90 }, { move_to: "D:/Archive/{year}" }) },
];

function blank(name = "", when: Partial<When> = {}, then: Rule["then"] = { move_to: "" }): Rule {
  return {
    id: crypto.randomUUID(),
    name,
    enabled: false,
    folders: [],
    when: { ext: [], name_glob: null, older_than_days: null, min_size: null, max_size: null, ...when },
    then,
  };
}

// ---------- render ----------

function render() {
  const nav = (v: View, label: string, ic: string) =>
    `<button class="nav" data-act="go" data-v="${v}" aria-label="${label}" ${view === v || (v === "rules" && view === "editor") ? 'aria-current="page"' : ""}>${ic}<span>${label}</span></button>`;
  const scroller = app.querySelector(".scroll");
  const top = scroller?.scrollTop ?? 0;
  app.innerHTML = `
    <nav class="side">
      <div class="brand">${logo()}<span>FolderPilot</span></div>
      ${nav("folders", "Folders", icons.folder)}
      ${nav("rules", "Rules", icons.rules)}
      ${nav("preview", "Preview", icons.preview)}
      ${nav("activity", "Activity", icons.activity)}
    </nav>
    <main class="main"><div class="scroll"><div class="page">${page()}</div></div><div class="thumb"></div></main>`;
  for (const el of app.querySelectorAll<HTMLElement>("[data-anchor]")) {
    el.style.setProperty(el.matches("[popover]") ? "position-anchor" : "anchor-name", `--${el.dataset.anchor}`);
  }
  if (view === "editor" && previousView === "editor") app.querySelector(".scroll")!.scrollTop = top;
  previousView = view;
  scrollbar();
}
let previousView: View = view;

function page() {
  switch (view) {
    case "folders": return foldersPage();
    case "rules": return rulesPage();
    case "editor": return editorPage(draft!);
    case "preview": return previewPage();
    case "activity": return activityPage();
  }
}

const head = (title: string, action = "") => `<header class="head"><h1>${title}</h1>${action}</header>`;

function foldersPage() {
  const list = folders.length
    ? `<ul class="list">${folders.map((f, i) => `
        <li class="card row">
          <span class="ic">${icons.folder}</span>
          <span class="grow"><span class="name">${esc(tail(f.path, 1))}</span>
            <span class="sub" title="${esc(f.path)}">${f.paused ? "Paused" : "Watching"} – ${esc(f.path)}</span></span>
          ${toggle(!f.paused, "folder-pause", i, `Watch ${f.path}`)}
          <button class="icon-btn" data-act="folder-remove" data-i="${i}" aria-label="Stop watching ${esc(f.path)}">${icons.trash}</button>
        </li>`).join("")}</ul>`
    : empty("No folders yet", "Pick a folder like Downloads and FolderPilot will keep it tidy.");
  return head("Folders", `<button class="primary" data-act="folder-add">${icons.plus}<span>Add folder</span></button>`) + list;
}

function rulesPage() {
  const tip = hint
    ? `<p class="hint">${icons.info}<span>Rules run top to bottom and the first match wins. Drag to reorder.</span>
         <button class="icon-btn" data-act="hint-off" aria-label="Hide tip">${icons.x}</button></p>`
    : "";
  const list = rules.length
    ? `<ul class="list">${rules.map((r, i) => `
        <li class="card rule" draggable="true" data-i="${i}">
          <button class="grip" data-act="noop" data-i="${i}" aria-label="Move ${esc(r.name)}; use arrow keys">${icons.grip}</button>
          ${toggle(r.enabled, "rule-toggle", i, `Enable ${r.name}`)}
          <span class="grow">
            <span class="name">${esc(r.name || "Untitled rule")}</span>
            <span class="sub">${esc(whenText(r))}</span>
            <span class="then">${icons.arrow}<span>${esc(thenText(r))}</span></span>
          </span>
          <button class="icon-btn" data-act="rule-edit" data-i="${i}" aria-label="Edit ${esc(r.name)}">${icons.edit}</button>
          <button class="icon-btn" data-act="rule-delete" data-i="${i}" aria-label="Delete ${esc(r.name)}">${icons.trash}</button>
        </li>`).join("")}</ul>`
    : `${empty("No rules yet", "Start from an example or write your own.")}
       <div class="starters">${starters.map((s, i) => `<button class="starter" data-act="starter" data-i="${i}">${esc(s.label)}</button>`).join("")}</div>`;
  const newMenu = menu("new-rule", `${icons.plus}<span>New rule</span>`, "primary", [
    ["blank", "", "Blank rule"],
    ...starters.map((s, i) => ["starter", String(i), s.label] as [string, string, string]),
  ]);
  return head("Rules", newMenu) + tip + list;
}

function editorPage(r: Rule) {
  const isMove = "move_to" in r.then;
  const template = isMove ? (r.then as { move_to: string }).move_to : (r.then as { rename: string }).rename;
  const w = r.when;
  const conds: string[] = [];
  if (extRow) conds.push(cond("ext", "is a", field("ext", w.ext.join(", "), "pdf, docx"), "file type"));
  if (w.name_glob !== null) conds.push(cond("name_glob", "has a name matching", field("name_glob", w.name_glob, "*invoice*")));
  if (w.older_than_days !== null) conds.push(cond("older_than_days", "is older than", field("older_than_days", String(w.older_than_days), "90", "num"), "days"));
  if (w.min_size !== null) conds.push(cond("min_size", "is bigger than", field("min_size", mb(w.min_size), "10", "num"), "MB"));
  if (w.max_size !== null) conds.push(cond("max_size", "is smaller than", field("max_size", mb(w.max_size), "1", "num"), "MB"));
  const add = menu("add-cond", `${icons.plus}<span>Add condition</span>`, "ghost", ([
    ["ext", "File type"], ["name_glob", "Name matches"], ["older_than_days", "Older than"], ["min_size", "Bigger than"], ["max_size", "Smaller than"],
  ] as const).filter(([k]) => (k === "ext" ? !extRow : w[k] === null)).map(([k, label]) => ["cond-add", k, label]));
  if (!conds.length) conds.push(`<div class="line"><span class="word">is any file</span></div>`);
  const sample = sampleFile(r);
  return `
    ${head(rules.some((x) => x.id === r.id) ? "Edit rule" : "New rule")}
    <section class="sentence">
      <label class="name-field"><span>Name</span>
        <input class="input" data-field="name" value="${esc(r.name)}" placeholder="PDFs to Documents" autocomplete="off"></label>
      <div class="line"><span class="word">When a file in</span>
        <span class="chips">${chip("All folders", !r.folders.length, "folder-all", "")}
          ${folders.map((f) => chip(tail(f.path, 1), r.folders.includes(f.path), "folder-chip", f.path)).join("")}</span></div>
      ${conds.join('<div class="and">and</div>')}
      <div class="line">${add}</div>
      <div class="line then-line">
        <div class="seg" role="radiogroup" aria-label="Action">
          <button role="radio" aria-checked="${isMove}" data-act="then" data-k="move_to">Move to</button>
          <button role="radio" aria-checked="${!isMove}" data-act="then" data-k="rename">Rename to</button>
        </div>
        <input class="input grow" data-field="template" value="${esc(template)}" placeholder="${isMove ? "~/Documents/PDF" : "{year}-{month}-{day} {name}"}" autocomplete="off" spellcheck="false">
      </div>
      <div class="tokens" aria-label="Insert into ${isMove ? "folder" : "name"}">
        ${["name", "ext", "year", "month", "day", "counter"].map((t) => `<button class="token" data-act="token" data-k="${t}">{${t}}</button>`).join("")}
      </div>
      <p class="example" aria-live="polite"><span class="file">${esc(sample)}</span>${icons.arrow}<span class="dest">${esc(template ? short(target(r, "~/Downloads", sample)) : "…")}</span></p>
    </section>
    <footer class="actions">
      <button class="ghost" data-act="cancel">Cancel</button>
      <button class="ghost" data-act="try">Preview</button>
      <button class="primary" data-act="save" ${template.trim() ? "" : "disabled"}>Save rule</button>
    </footer>`;
}

function cond(key: string, label: string, input: string, unit = "") {
  return `<div class="line cond" data-k="${key}"><span class="word">${label}</span>${input}${unit ? `<span class="word">${unit}</span>` : ""}
    <button class="icon-btn" data-act="cond-remove" data-k="${key}" aria-label="Remove condition">${icons.x}</button></div>`;
}

function field(key: string, value: string, placeholder: string, kind = "") {
  const num = kind === "num" ? ' inputmode="numeric" class="input num"' : ' class="input"';
  return `<input${num} data-field="${key}" value="${esc(value)}" placeholder="${placeholder}" autocomplete="off" spellcheck="false">`;
}

function previewPage() {
  const options: [string, string, string][] = [["preview-of", "all", "All enabled rules"], ...rules.map((r) => ["preview-of", r.id, r.name || "Untitled rule"] as [string, string, string])];
  if (draft && !rules.some((r) => r.id === draft!.id)) options.push(["preview-of", draft.id, `${draft.name || "Untitled rule"} (unsaved)`]);
  const current = options.find((o) => o[1] === previewOf)?.[2] ?? "All enabled rules";
  const picker = menu("preview-pick", `<span>${esc(current)}</span>${icons.chevron}`, "select", options);
  const body = planned === null
    ? empty("Nothing previewed yet", "Pick rules and run a preview. Nothing moves until you apply.")
    : planned.length
      ? `<ul class="list moves">${planned.map((p) => move(p)).join("")}</ul>
         <footer class="actions"><span class="sub">${planned.length} ${planned.length === 1 ? "file" : "files"} would move</span>
           <button class="primary" data-act="apply">Apply</button></footer>`
      : empty("No files match", "These rules would not touch anything right now.");
  return head("Preview", `<div class="head-tools">${picker}<button class="primary" data-act="run-preview">Run preview</button></div>`) + body;
}

function activityPage() {
  const runs = new Map<string, JournalEntry[]>();
  for (const e of [...journal].reverse()) runs.set(e.run, [...(runs.get(e.run) ?? []), e]);
  // Engine journals an undo as run "undo-<run>": it gets no button, and its run shows as undone.
  const files = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
  const body = runs.size
    ? `<ul class="list">${[...runs].map(([run, entries]) => `
        <li class="card run">
          <div class="run-head">
            <span class="grow"><span class="name">${when(entries[0].at)}</span>
              <span class="sub">${run.startsWith("undo-") ? `Undo: ${files(entries.length)} moved back` : `${files(entries.length)} moved`}</span></span>
            ${run.startsWith("undo-") ? "" : runs.has(`undo-${run}`)
              ? `<span class="sub">Undone</span>`
              : `<button class="ghost" data-act="undo" data-k="${esc(run)}">${icons.undo}<span>Undo</span></button>`}
          </div>
          <ul class="moves">${entries.map((p) => move(p)).join("")}</ul>
        </li>`).join("")}</ul>`
    : empty("No activity yet", "Moves and renames show up here, and every run can be undone.");
  return head("Activity") + body;
}

const move = (p: { from: string; to: string }) =>
  `<li class="move"><span class="file" title="${esc(p.from)}">${esc(tail(p.from, 2))}</span>${icons.arrow}<span class="dest" title="${esc(p.to)}">${esc(tail(p.to, 3))}</span></li>`;

const empty = (title: string, text: string) => `<div class="empty"><p class="name">${title}</p><p class="sub">${text}</p></div>`;

const toggle = (on: boolean, act: string, i: number, label: string) =>
  `<button class="switch" role="switch" aria-checked="${on}" data-act="${act}" data-i="${i}" aria-label="${esc(label)}"></button>`;

const chip = (label: string, on: boolean, act: string, k: string) =>
  `<button class="chip" aria-pressed="${on}" data-act="${act}" data-k="${esc(k)}" title="${esc(k)}">${esc(label)}</button>`;

function menu(id: string, label: string, cls: string, items: [string, string, string][]) {
  return `<button class="${cls}" popovertarget="m-${id}" data-anchor="m-${id}">${label}</button>
    <div class="menu" popover id="m-${id}" data-anchor="m-${id}" role="menu">
      ${items.map(([act, k, text]) => `<button role="menuitem" data-act="${act}" data-k="${esc(k)}">${esc(text)}</button>`).join("")}
    </div>`;
}

function logo() {
  return `<svg viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="var(--logo-bg)"/><path d="M96 160h120l32 40h168v192H96Z" fill="var(--accent)"/><path d="M200 296h96l-32-32m32 32-32 32" stroke="var(--logo-bg)" stroke-width="28" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

// ---------- text ----------

function whenText(r: Rule) {
  const w = r.when;
  const parts = [
    w.ext.length && `Type is ${w.ext.join(", ")}`,
    w.name_glob && `Name matches "${w.name_glob}"`,
    w.older_than_days !== null && `Older than ${w.older_than_days} days`,
    w.min_size !== null && `Bigger than ${mb(w.min_size)} MB`,
    w.max_size !== null && `Smaller than ${mb(w.max_size)} MB`,
  ].filter(Boolean);
  const where = r.folders.length ? ` in ${r.folders.map(short).join(", ")}` : "";
  return (parts.length ? parts.join(" and ") : "Any file") + where;
}

const thenText = (r: Rule) => ("move_to" in r.then ? `Move to ${short(r.then.move_to) || "…"}` : `Rename to ${r.then.rename || "…"}`);

function sampleFile(r: Rule) {
  const ext = r.when.ext[0] ?? "pdf";
  const stem = ["jpg", "jpeg", "png", "heic"].includes(ext) ? "IMG_2041" : ext === "pdf" ? "invoice" : "report";
  return `${stem}.${ext}`;
}

/** Last `n` path segments ("…/Documents/PDF/a.pdf"); full path goes in a title. */
const tail = (p: string, n: number) => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > n ? `…/${parts.slice(-n).join("/")}` : parts.join("/");
};
const short = (p: string) => p.replace(/^~[\\/]?/, "").replace(/\\/g, "/");
const mb = (bytes: number) => String(+(bytes / 1048576).toFixed(2));
const when = (at: number) =>
  new Date(at * 1000).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// ---------- actions ----------

async function load() {
  [rules, folders, journal] = await Promise.all([api.listRules(), api.listFolders(), api.activity()]);
  render();
}

async function saveRules() {
  await api.saveRules(rules);
  render();
}

async function saveFolders() {
  await api.saveFolders(folders);
  render();
}

function openEditor(r: Rule) {
  draft = structuredClone(r);
  const w = r.when;
  extRow = w.ext.length > 0 || (w.name_glob ?? w.older_than_days ?? w.min_size ?? w.max_size) === null;
  view = "editor";
  render();
  app.querySelector<HTMLInputElement>('[data-field="name"]')?.focus();
}

const actions: Record<string, (el: HTMLElement) => unknown> = {
  go: (el) => { view = el.dataset.v as View; render(); if (view === "activity") refreshActivity(); },
  "folder-add": async () => {
    const path = await api.pickFolder();
    if (path && !folders.some((f) => f.path === path)) { folders.push({ path, paused: false }); await saveFolders(); }
  },
  "folder-pause": (el) => { const f = folders[+el.dataset.i!]; f.paused = !f.paused; return saveFolders(); },
  "folder-remove": (el) => { folders.splice(+el.dataset.i!, 1); return saveFolders(); },
  "hint-off": () => { hint = false; try { localStorage.setItem("hint", "off"); } catch {} render(); },
  "rule-toggle": (el) => { const r = rules[+el.dataset.i!]; r.enabled = !r.enabled; return saveRules(); },
  "rule-edit": (el) => openEditor(rules[+el.dataset.i!]),
  "rule-delete": (el) => { rules.splice(+el.dataset.i!, 1); return saveRules(); },
  blank: () => openEditor(blank()),
  starter: (el) => openEditor(starters[+(el.dataset.i ?? el.dataset.k)!].rule()),
  "folder-all": () => { draft!.folders = []; render(); },
  "folder-chip": (el) => {
    const path = el.dataset.k!;
    draft!.folders = draft!.folders.includes(path) ? draft!.folders.filter((p) => p !== path) : [...draft!.folders, path];
    render();
  },
  "cond-add": (el) => {
    const k = el.dataset.k as keyof When;
    if (k === "ext") extRow = true; else (draft!.when[k] as number | string | null) = k === "name_glob" ? "" : 0;
    render();
    app.querySelector<HTMLInputElement>(`[data-field="${k}"]`)?.focus();
  },
  "cond-remove": (el) => {
    const k = el.dataset.k as keyof When;
    if (k === "ext") { extRow = false; draft!.when.ext = []; } else (draft!.when[k] as null) = null;
    render();
  },
  then: (el) => {
    const old = Object.values(draft!.then)[0] as string;
    draft!.then = el.dataset.k === "move_to" ? { move_to: old } : { rename: old };
    render();
  },
  token: (el) => {
    const input = app.querySelector<HTMLInputElement>('[data-field="template"]')!;
    const at = input.selectionStart ?? input.value.length;
    input.setRangeText(`{${el.dataset.k}}`, at, input.selectionEnd ?? at, "end");
    setTemplate(input.value);
    render();
    const again = app.querySelector<HTMLInputElement>('[data-field="template"]')!;
    again.focus();
    again.setSelectionRange(at + el.dataset.k!.length + 2, at + el.dataset.k!.length + 2);
  },
  cancel: () => { draft = null; view = "rules"; render(); },
  save: () => {
    const i = rules.findIndex((r) => r.id === draft!.id);
    // New rules start off: preview first, then switch on (plan: SAFETY).
    if (i >= 0) rules[i] = draft!; else rules.push(draft!);
    draft = null;
    view = "rules";
    return saveRules();
  },
  try: () => { previewOf = draft!.id; view = "preview"; return runPreview(); },
  "preview-of": (el) => { previewOf = el.dataset.k!; planned = null; render(); },
  "run-preview": () => runPreview(),
  // Partly done is still done: show Activity, then say which files were left.
  apply: async () => {
    const error = await api.apply(planned!).then(() => null, (e) => e);
    planned = null;
    view = "activity";
    await refreshActivity();
    if (error) toast(String(error));
  },
  undo: (el) => api.undo(el.dataset.k!).finally(refreshActivity),
};

async function runPreview() {
  const pool = previewOf === "all" ? rules.filter((r) => r.enabled) : [...rules, ...(draft ? [draft] : [])].filter((r) => r.id === previewOf);
  const seen = new Set<string>();
  planned = [];
  // ponytail: first match wins across rules by dropping files an earlier rule already planned.
  for (const rule of pool) {
    for (const p of await api.preview(rule)) if (!seen.has(p.from)) { seen.add(p.from); planned.push(p); }
  }
  render();
}

async function refreshActivity() {
  journal = await api.activity();
  render();
}

function setTemplate(value: string) {
  draft!.then = "move_to" in draft!.then ? { move_to: value } : { rename: value };
}

app.addEventListener("click", async (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el) return;
  el.closest<HTMLElement>("[popover]")?.hidePopover();
  try {
    await actions[el.dataset.act!]?.(el);
  } catch (error) {
    toast(String(error));
  }
});

app.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  const key = input.dataset.field;
  if (!draft || !key) return;
  const w = draft.when;
  const num = Number(input.value.replace(",", "."));
  if (key === "name") draft.name = input.value;
  else if (key === "template") setTemplate(input.value);
  else if (key === "ext") w.ext = input.value.split(/[\s,;]+/).map((e) => e.replace(/^\./, "").toLowerCase()).filter(Boolean);
  else if (key === "name_glob") w.name_glob = input.value;
  else if (key === "older_than_days") w.older_than_days = Math.max(0, Math.floor(num) || 0);
  else if (key === "min_size" || key === "max_size") w[key] = Math.round((num || 0) * 1048576);
  // Live bits only, so the caret stays put.
  const sample = sampleFile(draft);
  const template = Object.values(draft.then)[0] as string;
  app.querySelector(".example .file")!.textContent = sample;
  app.querySelector(".example .dest")!.textContent = template ? short(target(draft, "~/Downloads", sample)) : "…";
  app.querySelector<HTMLButtonElement>('[data-act="save"]')!.disabled = !template.trim();
});

// Drag to reorder rules; arrow keys on the grip do the same from the keyboard.
let dragging = -1;
app.addEventListener("dragstart", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".rule");
  if (!li) return;
  dragging = +li.dataset.i!;
  li.classList.add("dragging");
  e.dataTransfer!.effectAllowed = "move";
});
app.addEventListener("dragover", (e) => {
  if (dragging < 0 || !(e.target as HTMLElement).closest(".rule")) return;
  e.preventDefault();
});
app.addEventListener("drop", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".rule");
  if (!li || dragging < 0) return;
  e.preventDefault();
  moveRule(dragging, +li.dataset.i!);
});
app.addEventListener("dragend", () => { dragging = -1; app.querySelector(".dragging")?.classList.remove("dragging"); });
app.addEventListener("keydown", (e) => {
  const grip = (e.target as HTMLElement).closest<HTMLElement>(".grip");
  if (!grip || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault();
  const from = +grip.dataset.i!;
  const to = Math.min(rules.length - 1, Math.max(0, from + (e.key === "ArrowUp" ? -1 : 1)));
  if (moveRule(from, to)) app.querySelector<HTMLElement>(`.grip[data-i="${to}"]`)?.focus();
});

function moveRule(from: number, to: number) {
  if (from === to) return false;
  rules.splice(to, 0, ...rules.splice(from, 1));
  render();
  api.saveRules(rules).catch((error) => toast(String(error)));
  return true;
}

// Overlay scrollbar: the native one is hidden (scrollbar-width: none); this thumb mirrors it and can be dragged.
function scrollbar() {
  const scroll = app.querySelector<HTMLElement>(".scroll")!;
  const thumb = app.querySelector<HTMLElement>(".thumb")!;
  const update = () => {
    const { scrollHeight: total, clientHeight: seen, scrollTop: top } = scroll;
    thumb.hidden = total <= seen + 1;
    const size = Math.max(32, (seen * seen) / total);
    thumb.style.height = `${size}px`;
    thumb.style.translate = `0 ${(top / (total - seen || 1)) * (seen - size)}px`;
  };
  scroll.addEventListener("scroll", update, { passive: true });
  new ResizeObserver(update).observe(scroll.firstElementChild!);
  thumb.onpointerdown = (e) => {
    const startY = e.clientY;
    const startTop = scroll.scrollTop;
    thumb.setPointerCapture(e.pointerId);
    thumb.onpointermove = (m) => {
      const ratio = (scroll.scrollHeight - scroll.clientHeight) / (scroll.clientHeight - thumb.offsetHeight || 1);
      scroll.scrollTop = startTop + (m.clientY - startY) * ratio;
    };
    thumb.onpointerup = () => { thumb.onpointermove = null; };
  };
  update();
}

function toast(text: string) {
  const el = Object.assign(document.createElement("div"), { className: "toast", role: "alert", textContent: text });
  document.body.append(el);
  setTimeout(() => el.remove(), 4000);
}

window.addEventListener("resize", () => app.querySelector(".scroll")?.dispatchEvent(new Event("scroll")));
void api.onActivity(() => void refreshActivity());
void load();
