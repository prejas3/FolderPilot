import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, target, type JournalEntry, type Planned, type Rule, type Settings, type Theme, type WatchedFolder, type When } from "./api";
import { lang, setLang, systemLang, t, type Lang } from "./i18n";
import { icon, type IconName } from "./icons";
import { menu, select, tooltips } from "./sj-ui.js";
import appIcon from "../src-tauri/icons/icon.svg";
import "./sj-ui.css";
import "./style.css";

// CCS/1 M:ui | SJ Utility UI pattern B (side nav: Folders, Rules, Preview, Activity | Settings, About)
// FLOW:state -> render() -> head/body innerHTML; clicks via [data-act] delegation; selects mounted into [data-select] slots
// RULE:sj-ui controls only (no native select/checkbox/title=/alert); InfoBar (.bars, kept across renders) instead of toasts
// RULE:every string from i18n.ts; data-act/data-field/data-tip are the E2E hooks (scripts/e2e-auto.mjs)

type Page = "folders" | "rules" | "editor" | "preview" | "activity" | "settings" | "about";
type CondKey = keyof When;

const SITE = "https://szymonjankiewicz.com";
const REPO = "https://github.com/prejas3/FolderPilot";
const AUTHOR = "Szymon Jankiewicz"; // i18n-ok: a name
const APP = "FolderPilot"; // i18n-ok: the app name

let page: Page = "rules";
let rules: Rule[] = [];
let folders: WatchedFolder[] = [];
let draft: Rule | null = null;
let planned: Planned[] | null = null;
let previewOf = "all";
let journal: JournalEntry[] = [];
let extRow = false;
let settings: Settings = { lang, theme: (stored("theme") as Theme) ?? "system", autostart: false, paused: false };
let version = "";

let nav: HTMLElement;
let content: HTMLElement;
let headEl: HTMLElement;
let bars: HTMLElement;
let body: HTMLElement;
/** Select controls built by the page render, mounted into their [data-select] slot. */
let selects: Record<string, () => HTMLElement> = {};

const starters: { key: keyof typeof t.starters; rule: (name: string) => Rule }[] = [
  { key: "pdf", rule: (n) => blank(n, { ext: ["pdf"] }, { move_to: "~/Documents/PDF" }) },
  { key: "photos", rule: (n) => blank(n, { ext: ["jpg", "jpeg", "png", "heic"] }, { move_to: "~/Pictures/{year}/{month}" }) },
  { key: "rename", rule: (n) => blank(n, { ext: ["pdf", "docx"] }, { rename: "{year}-{month}-{day} {name}" }) },
  { key: "archive", rule: (n) => blank(n, { older_than_days: 90 }, { move_to: "D:/Archive/{year}" }) },
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

// ---------- markup helpers (sj-ui.css components) ----------

type Attrs = Record<string, string | number | boolean | undefined>;
const attrs = (a: Attrs = {}) =>
  Object.entries(a).filter(([, v]) => v !== undefined && v !== false).map(([k, v]) => (v === true ? ` ${k}` : ` ${k}="${esc(String(v))}"`)).join("");

function btn(label: string, act: string, o: { cls?: string; ic?: IconName; tip?: string; a?: Attrs } = {}) {
  const tip = o.tip ? { "data-tip": o.tip, "aria-label": o.tip } : {};
  return `<button type="button" class="${o.cls ?? "btn"}" data-act="${act}"${attrs({ ...tip, ...o.a })}>${o.ic ? icon(o.ic) : ""}${label ? `<span>${esc(label)}</span>` : ""}</button>`;
}
const iconBtn = (ic: IconName, tip: string, act: string, a: Attrs = {}, cls = "") => btn("", act, { cls: `btn subtle square ${cls}`.trim(), ic, tip, a });

/** Toggle; `state` shows On/Off before the track (settings cards only). */
const toggle = (on: boolean, label: string, act: string, a: Attrs = {}, state = false) =>
  `<button type="button" class="toggle" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="${act}"${attrs(a)}>${state ? `<span>${on ? t.on : t.off}</span>` : ""}<i></i></button>`;

const check = (on: boolean, label: string, act: string, a: Attrs = {}) =>
  `<button type="button" class="check" role="checkbox" aria-checked="${on}" data-act="${act}"${attrs(a)}><i>${icon("check")}</i><span>${esc(label)}</span></button>`;

const field = (key: string, value: string, label: string, o: { placeholder?: string; cls?: string; suffix?: string; tip?: string } = {}) =>
  `<label class="field ${o.cls ?? ""}"${attrs({ "data-tip": o.tip })}><input data-field="${key}"${attrs({ value, "aria-label": label, placeholder: o.placeholder })} autocomplete="off" spellcheck="false">${o.suffix ? `<span class="suffix">${esc(o.suffix)}</span>` : ""}</label>`;

const card = (ic: IconName | null, title: string, text: string, controls: string, cls = "") =>
  `<div class="card ${cls}">${ic ? icon(ic) : ""}<div class="card-text"><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ""}</div><div class="card-ctl">${controls}</div></div>`;

const group = (title: string, items: string) =>
  `<section class="group"${attrs({ "aria-label": title || undefined })}>${title ? `<h2 class="group-title">${esc(title)}</h2>` : ""}${items}</section>`;

const empty = (text: string) => `<p class="empty t-2">${esc(text)}</p>`;

function slot(id: string, make: () => HTMLElement) {
  selects[id] = make;
  return `<span data-select="${id}"></span>`;
}

// ---------- shell ----------

function build() {
  document.documentElement.lang = lang;
  const item = (p: Page, ic: IconName) =>
    `<button type="button" class="nav-item" data-act="go" data-v="${p}" aria-label="${esc(t[p as keyof typeof t] as string)}">${icon(ic).replace('class="icon"', 'class="icon off"')}${icon(`${ic}On` as IconName).replace('class="icon"', 'class="icon on"')}<span>${esc(t[p as keyof typeof t] as string)}</span></button>`;
  document.body.innerHTML = `
    <nav class="nav" aria-label="${esc(t.nav)}">
      ${iconBtn("menu", t.nav, "nav-menu", { "aria-expanded": "false" }, "menu-btn")}
      ${item("folders", "folder")}${item("rules", "rules")}${item("preview", "preview")}${item("activity", "activity")}
      <div class="nav-spacer"></div>
      ${item("settings", "settings")}${item("about", "about")}
    </nav>
    <main class="content"><div class="page"><header class="page-head"></header><div class="bars"></div><div class="body"></div></div></main>`;
  nav = document.querySelector(".nav")!;
  content = document.querySelector(".content")!;
  headEl = content.querySelector(".page-head")!;
  bars = content.querySelector(".bars")!;
  body = content.querySelector(".body")!;
  navTips();
  render();
}

const compact = matchMedia("(width < 640px)");
compact.addEventListener("change", navTips);
function navTips() {
  nav?.querySelectorAll<HTMLElement>(".nav-item").forEach((b) => {
    if (compact.matches) b.dataset.tip = b.getAttribute("aria-label") ?? "";
    else delete b.dataset.tip;
  });
}

function render() {
  if (!body) return;
  const focus = focusKey(document.activeElement);
  const current = page === "editor" ? "rules" : page;
  nav.querySelectorAll(".nav-item").forEach((b) => b.removeAttribute("aria-current"));
  nav.querySelector(`[data-v="${current}"]`)?.setAttribute("aria-current", "page");
  selects = {};
  const [title, lede, actions, html] = pages[page]();
  headEl.innerHTML = `<div><h1 class="t-title">${esc(title)}</h1>${lede ? `<p class="t-2 lede">${esc(lede)}</p>` : ""}</div>${actions ? `<div class="head-actions">${actions}</div>` : ""}`;
  body.innerHTML = html;
  for (const el of content.querySelectorAll<HTMLElement>("[data-select]")) el.replaceWith(selects[el.dataset.select!]());
  pausedBar();
  if (focus) content.querySelector<HTMLElement>(focus)?.focus();
}

/** A selector that finds the same control after a re-render, so keyboard focus stays put. */
function focusKey(el: Element | null) {
  if (!(el instanceof HTMLElement) || !content?.contains(el)) return "";
  const keys = ["data-act", "data-i", "data-k", "data-field", "aria-label"].filter((k) => el.hasAttribute(k));
  return keys.length ? keys.map((k) => `[${k}="${CSS.escape(el.getAttribute(k)!)}"]`).join("") : "";
}

function setPage(next: Page) {
  if (next !== page) bars.replaceChildren();
  page = next;
  store("page", next === "editor" ? "rules" : next);
  nav.classList.remove("open");
  render();
  content.scrollTop = 0;
  if (next === "activity") void refreshActivity();
}

// ---------- pages: [title, lede, head actions, body] ----------

const pages: Record<Page, () => [string, string, string, string]> = {
  folders: () => {
    const list = folders.length
      ? group("", folders.map((f, i) => card("folder", tail(f.path, 1), f.path,
          toggle(!f.paused, t.watch(f.path), "folder-pause", { "data-i": i }, true) +
          iconBtn("delete", t.stopWatching(f.path), "folder-remove", { "data-i": i }))).join(""))
      : empty(t.foldersEmpty);
    return [t.folders, t.foldersLede, btn(t.addFolder, "folder-add", { cls: "btn accent", ic: "add" }), list];
  },
  rules: () => {
    const list = rules.length
      ? `<ul class="rules">${rules.map((r, i) => `
          <li class="card rule" draggable="true" data-i="${i}">
            ${iconBtn("drag", t.reorder(r.name || t.untitled), "noop", { "data-i": i }, "grip")}
            <div class="card-text">
              <h3 class="name">${esc(r.name || t.untitled)}</h3>
              <p>${esc(whenText(r))}</p>
              <p class="then">${icon("arrow")}<span>${esc(thenText(r))}</span></p>
            </div>
            <div class="card-ctl">
              ${toggle(r.enabled, t.enable(r.name || t.untitled), "rule-toggle", { "data-i": i })}
              ${iconBtn("edit", t.edit(r.name || t.untitled), "rule-edit", { "data-i": i })}
              ${iconBtn("delete", t.remove(r.name || t.untitled), "rule-delete", { "data-i": i })}
            </div>
          </li>`).join("")}</ul>`
      : empty(t.rulesEmpty);
    return [t.rules, t.rulesLede, btn(t.newRule, "new-rule", { cls: "btn accent", ic: "add", a: { "aria-haspopup": "menu" } }), list];
  },
  editor: () => editorPage(draft!),
  preview: () => {
    const options: [string, string][] = [["all", t.allEnabled], ...rules.map((r) => [r.id, r.name || t.untitled] as [string, string])];
    if (draft && !rules.some((r) => r.id === draft!.id)) options.push([draft.id, t.unsaved(draft.name || t.untitled)]);
    if (!options.some(([v]) => v === previewOf)) previewOf = "all";
    const picker = slot("preview-of", () => select({
      options: options.map(([value, label]) => ({ value, label })), value: previewOf, label: t.previewOf,
      onChange: (v: string) => { previewOf = v; planned = null; render(); },
    }));
    const has = !!planned?.length;
    const html = planned === null
      ? empty(t.previewEmpty)
      : planned.length
        ? `${group("", `<ul class="moves card">${planned.map(move).join("")}</ul>`)}
           <footer class="foot"><span class="t-2">${esc(t.wouldMove(planned.length))}</span>${btn(t.apply, "apply", { cls: "btn accent" })}</footer>`
        : empty(t.noMatches);
    return [t.preview, t.previewLede, picker + btn(t.runPreview, "run-preview", { cls: has ? "btn" : "btn accent" }), html];
  },
  activity: () => {
    const runs = new Map<string, JournalEntry[]>();
    for (const e of [...journal].reverse()) runs.set(e.run, [...(runs.get(e.run) ?? []), e]);
    // Engine journals an undo as run "undo-<run>": it gets no button, and its run shows as undone.
    const html = runs.size
      ? `<div class="runs">${[...runs].map(([run, entries]) => {
          const isUndo = run.startsWith("undo-");
          const undone = runs.has(`undo-${run}`);
          const side = isUndo ? "" : undone ? `<span class="t-2">${esc(t.undone)}</span>` : btn(t.undo, "undo", { ic: "undo", a: { "data-k": run } });
          return `<section class="card run"${attrs({ "data-undone": undone })}>
            <div class="run-head"><div class="card-text"><h3 class="num">${esc(when(entries[0].at))}</h3>
              <p>${esc(isUndo ? t.movedBack(entries.length) : t.moved(entries.length))}</p></div>${side}</div>
            <ul class="moves">${entries.map(move).join("")}</ul></section>`;
        }).join("")}</div>`
      : empty(t.activityEmpty);
    return [t.activity, t.activityLede, "", html];
  },
  settings: () => {
    const langSel = slot("lang", () => select({
      options: [{ value: "pl", label: "Polski" }, { value: "en", label: "English" }], // i18n-ok: language names
      value: lang, label: t.language, onChange: (v: string) => void changeLang(v as Lang),
    }));
    const themeSel = slot("theme", () => select({
      options: (["system", "light", "dark"] as Theme[]).map((v) => ({ value: v, label: t.themes[v] })),
      value: settings.theme, label: t.theme,
      onChange: (v: string) => { settings.theme = v as Theme; store("theme", v); applyTheme(); void api.setTheme(settings.theme).catch(fail(t.saveFailed)); },
    }));
    return [t.settings, "", "", [
      group(t.general,
        card("power", t.startWithWindows, t.startText, toggle(settings.autostart, t.startWithWindows, "autostart", {}, true)) +
        card("language", t.language, t.languageText, langSel) +
        card("theme", t.theme, t.themeText, themeSel)),
      group(APP,
        card("pauseAll", t.pauseAll, t.pauseText, toggle(settings.paused, t.pauseAll, "pause-all", {}, true))),
      group(t.advanced,
        card("folderOpen", t.dataFolder, t.dataFolderText, btn(t.openFolder, "open", { a: { "data-k": "data" } }))),
    ].join("")];
  },
  about: () => {
    const link = (ic: IconName, title: string, url: string) =>
      `<button type="button" class="card" data-act="open" data-k="${esc(url)}">${icon(ic)}<span class="card-text"><span>${esc(title)}</span><p>${esc(url.replace("https://", ""))}</p></span>${icon("open")}</button>`;
    return ["", "", "", `
      <div class="about-head"><img src="${appIcon}" width="48" height="48" alt="">
        <div><h1 class="t-subtitle">${APP}</h1><p class="t-caption t-2">${esc(version ? t.version(version) : "")}</p></div></div>
      <p class="t-2">${esc(t.aboutText)}</p>
      <p><button type="button" class="link" data-act="open" data-k="${SITE}">${AUTHOR}</button></p>
      ${group("", link("globe", t.projectPage, `${SITE}/p/folderpilot`) + link("code", t.source, REPO) + link("bug", t.issues, `${REPO}/issues`) + link("document", t.licence, `${REPO}/blob/main/LICENSE`))}`];
  },
};

function editorPage(r: Rule): [string, string, string, string] {
  const isMove = "move_to" in r.then;
  const template = Object.values(r.then)[0] as string;
  const w = r.when;
  const conds: string[] = [];
  const cond = (key: CondKey, input: string) =>
    `<div class="cond" data-k="${key}"><span class="cond-label">${esc(t.conds[key])}</span>${input}${iconBtn("dismiss", t.removeCondition, "cond-remove", { "data-k": key })}</div>`;
  if (extRow) conds.push(cond("ext", field("ext", w.ext.join(", "), t.conds.ext, { placeholder: "pdf, docx", cls: "grow" })));
  if (w.name_glob !== null) conds.push(cond("name_glob", field("name_glob", w.name_glob, t.conds.name_glob, { placeholder: "*invoice*", cls: "grow", tip: t.globHint })));
  if (w.older_than_days !== null) conds.push(cond("older_than_days", field("older_than_days", String(w.older_than_days), t.conds.older_than_days, { placeholder: "90", cls: "number", suffix: t.days })));
  if (w.min_size !== null) conds.push(cond("min_size", field("min_size", mb(w.min_size), t.conds.min_size, { placeholder: "10", cls: "number", suffix: t.mb })));
  if (w.max_size !== null) conds.push(cond("max_size", field("max_size", mb(w.max_size), t.conds.max_size, { placeholder: "1", cls: "number", suffix: t.mb })));
  const canAdd = (Object.keys(t.condMenu) as CondKey[]).some((k) => (k === "ext" ? !extRow : w[k] === null));
  const action = slot("action", () => select({
    options: (["move_to", "rename"] as const).map((k) => ({ value: k, label: t.actions[k] })), value: isMove ? "move_to" : "rename", label: t.then,
    onChange: (v: string) => { draft!.then = v === "move_to" ? { move_to: template } : { rename: template }; render(); },
  }));
  const sample = sampleFile(r);
  const html = `
    ${group(t.name, `<div class="card form">${field("name", r.name, t.name, { placeholder: t.starters.pdf })}</div>`)}
    ${group(t.whenIn, `<div class="card form">
      <div class="checks">${check(!r.folders.length, t.allFolders, "folder-all")}
        ${folders.map((f) => check(r.folders.includes(f.path), tail(f.path, 1), "folder-check", { "data-k": f.path, "data-tip": f.path })).join("")}</div>
      ${conds.length ? `<div class="conds">${conds.join("")}</div>` : `<p class="t-2">${esc(t.anyFile)}</p>`}
      ${canAdd ? `<div>${btn(t.addCondition, "add-cond", { cls: "btn subtle", ic: "add", a: { "aria-haspopup": "menu" } })}</div>` : ""}
    </div>`)}
    ${group(t.then, `<div class="card form">
      <div class="then-row">${action}${field("template", template, isMove ? t.folderField : t.nameField, { placeholder: isMove ? "~/Documents/PDF" : "{year}-{month}-{day} {name}", cls: "grow" })}</div>
      <div class="tokens" role="group" aria-label="${esc(isMove ? t.tokensFolder : t.tokensName)}">
        ${["name", "ext", "year", "month", "day", "counter"].map((k) => btn(`{${k}}`, "token", { cls: "btn subtle token", a: { "data-k": k } })).join("")}</div>
      <p class="example" aria-live="polite" aria-label="${esc(t.example)}"><span class="file">${esc(sample)}</span>${icon("arrow")}<span class="dest">${esc(template ? short(target(r, "~/Downloads", sample)) : "…")}</span></p>
    </div>`)}
    <footer class="foot">${btn(t.cancel, "cancel")}${btn(t.tryIt, "try")}${btn(t.saveRule, "save", { cls: "btn accent", a: { disabled: !template.trim() } })}</footer>`;
  return [rules.some((x) => x.id === r.id) ? t.editTitle : t.newTitle, "", "", html];
}

const move = (p: { from: string; to: string }) =>
  `<li class="move"><span class="file" data-tip="${esc(p.from)}">${esc(tail(p.from, 2))}</span>${icon("arrow")}<span class="dest" data-tip="${esc(p.to)}">${esc(tail(p.to, 3))}</span></li>`;

// ---------- text ----------

function whenText(r: Rule) {
  const w = r.when;
  const parts = [
    w.ext.length && t.typeIs(w.ext.join(", ")),
    w.name_glob && t.nameIs(w.name_glob),
    w.older_than_days !== null && t.olderIs(w.older_than_days),
    w.min_size !== null && t.biggerIs(mb(w.min_size)),
    w.max_size !== null && t.smallerIs(mb(w.max_size)),
  ].filter(Boolean);
  const where = r.folders.length ? t.inFolders(r.folders.map((p) => tail(p, 1)).join(", ")) : "";
  return (parts.length ? parts.join(t.and) : t.anyFile) + where;
}

const thenText = (r: Rule) => ("move_to" in r.then ? t.moveTo(short(r.then.move_to) || "…") : t.renameTo(r.then.rename || "…"));

function sampleFile(r: Rule) {
  const ext = r.when.ext[0] ?? "pdf";
  const stem = ["jpg", "jpeg", "png", "heic"].includes(ext) ? "IMG_2041" : ext === "pdf" ? "invoice" : "report"; // i18n-ok: sample file names
  return `${stem}.${ext}`;
}

/** Last `n` path segments ("…/Documents/PDF/a.pdf"); the full path goes in a tooltip. */
const tail = (p: string, n: number) => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > n ? `…/${parts.slice(-n).join("/")}` : parts.join("/");
};
const short = (p: string) => p.replace(/^~[\\/]?/, "").replace(/\\/g, "/");
const mb = (bytes: number) => String(+(bytes / 1048576).toFixed(2));
const when = (at: number) =>
  new Date(at * 1000).toLocaleString(lang === "pl" ? "pl-PL" : "en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function esc(s: string) {
  return s.replace(/[&<>\x22\x27]/g, (c) => `&#${c.charCodeAt(0)};`); // \x22\x27 = quotes, kept out of the i18n scanner
}

function stored(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

// ---------- InfoBar ----------

type Kind = "ok" | "warn" | "err" | "info";
/** InfoBar (spec 6), the stand-in for toasts. With `id` it replaces that bar and has no ×. */
function say(kind: Kind, title: string, text = "", o: { id?: string; action?: [string, () => void] } = {}) {
  if (o.id) bars.querySelector(`#${o.id}`)?.remove();
  const bar = document.createElement("div");
  bar.className = `infobar ${kind}`;
  bar.setAttribute("role", kind === "err" ? "alert" : "status");
  if (o.id) bar.id = o.id;
  bar.innerHTML = `${icon(kind === "info" ? "info" : kind)}<p class="infobar-text"><b>${esc(title)}</b><span>${esc(text)}</span></p>`;
  if (o.action) {
    const [label, run] = o.action;
    const b = Object.assign(document.createElement("button"), { type: "button", className: "btn", textContent: label });
    b.addEventListener("click", () => { if (!o.id) bar.remove(); run(); });
    bar.append(b);
  }
  if (!o.id) {
    bar.insertAdjacentHTML("beforeend", iconBtn("dismiss", t.dismiss, "noop"));
    bar.lastElementChild!.addEventListener("click", () => bar.remove());
  }
  bars.append(bar);
  // Keep the stack short: the oldest closable bars go first.
  const closable = [...bars.children].filter((el) => !el.id);
  closable.slice(0, Math.max(0, closable.length - 3)).forEach((el) => el.remove());
}

const fail = (title: string) => (error: unknown) => say("err", title, String(error));

function pausedBar() {
  const show = settings.paused && (page === "folders" || page === "rules");
  if (!show) bars.querySelector("#paused")?.remove();
  else if (!bars.querySelector("#paused")) say("warn", t.pausedTitle, t.pausedText, { id: "paused", action: [t.resume, () => void setPaused(false)] });
}

// ---------- actions ----------

async function load() {
  try {
    [rules, folders, journal] = await Promise.all([api.listRules(), api.listFolders(), api.activity()]);
  } catch (error) {
    fail(t.loadFailed)(error);
  }
  render();
}

const saveRules = () => api.saveRules(rules).then(render, (e) => { render(); fail(t.saveFailed)(e); });
const saveFolders = () => api.saveFolders(folders).then(render, (e) => { render(); fail(t.saveFailed)(e); });

function openEditor(r: Rule) {
  draft = structuredClone(r);
  const w = r.when;
  extRow = w.ext.length > 0 || (w.name_glob ?? w.older_than_days ?? w.min_size ?? w.max_size) === null;
  setPage("editor");
  content.querySelector<HTMLInputElement>('[data-field="name"]')?.focus();
}

async function setPaused(on: boolean) {
  await api.setPaused(on).catch(fail(t.saveFailed));
  settings.paused = on;
  render();
}

const actions: Record<string, (el: HTMLElement) => unknown> = {
  go: (el) => setPage(el.dataset.v as Page),
  "nav-menu": (el) => el.setAttribute("aria-expanded", String(nav.classList.toggle("open"))),
  "folder-add": async () => {
    const path = await api.pickFolder();
    if (path && !folders.some((f) => f.path === path)) { folders.push({ path, paused: false }); await saveFolders(); }
  },
  "folder-pause": (el) => { const f = folders[+el.dataset.i!]; f.paused = !f.paused; return saveFolders(); },
  "folder-remove": (el) => {
    const i = +el.dataset.i!;
    const [gone] = folders.splice(i, 1);
    say("info", t.stoppedWatching(tail(gone.path, 1)), "", { action: [t.undo, () => { folders.splice(i, 0, gone); void saveFolders(); }] });
    return saveFolders();
  },
  "rule-toggle": (el) => { const r = rules[+el.dataset.i!]; r.enabled = !r.enabled; return saveRules(); },
  "rule-edit": (el) => openEditor(rules[+el.dataset.i!]),
  "rule-delete": (el) => {
    const i = +el.dataset.i!;
    const [gone] = rules.splice(i, 1);
    say("info", t.deleted(gone.name || t.untitled), "", { action: [t.undo, () => { rules.splice(i, 0, gone); void saveRules(); }] });
    return saveRules();
  },
  "new-rule": (el) => menu(el, [
    { label: t.blankRule, run: () => openEditor(blank()) },
    ...starters.map((s) => ({ label: t.starters[s.key], run: () => openEditor(s.rule(t.starters[s.key])) })),
  ], t.newRule),
  "folder-all": () => { draft!.folders = []; render(); },
  "folder-check": (el) => {
    const path = el.dataset.k!;
    draft!.folders = draft!.folders.includes(path) ? draft!.folders.filter((p) => p !== path) : [...draft!.folders, path];
    render();
  },
  "add-cond": (el) => menu(el, (Object.keys(t.condMenu) as CondKey[])
    .filter((k) => (k === "ext" ? !extRow : draft!.when[k] === null))
    .map((k) => ({ label: t.condMenu[k], run: () => addCond(k) })), t.addCondition),
  "cond-remove": (el) => {
    const k = el.dataset.k as CondKey;
    if (k === "ext") { extRow = false; draft!.when.ext = []; } else (draft!.when[k] as null) = null;
    render();
    content.querySelector<HTMLElement>('[data-act="add-cond"]')?.focus();
  },
  token: (el) => {
    const input = content.querySelector<HTMLInputElement>('[data-field="template"]')!;
    const at = input.selectionStart ?? input.value.length;
    const text = `{${el.dataset.k}}`;
    input.setRangeText(text, at, input.selectionEnd ?? at, "end");
    setTemplate(input.value);
    render();
    const again = content.querySelector<HTMLInputElement>('[data-field="template"]')!;
    again.focus();
    again.setSelectionRange(at + text.length, at + text.length);
  },
  cancel: () => { draft = null; setPage("rules"); },
  save: () => {
    const i = rules.findIndex((r) => r.id === draft!.id);
    // New rules start off: preview first, then switch on (plan: SAFETY).
    if (i >= 0) rules[i] = draft!; else rules.push(draft!);
    draft = null;
    setPage("rules");
    return saveRules();
  },
  try: () => { previewOf = draft!.id; planned = null; setPage("preview"); return runPreview(); },
  "run-preview": () => runPreview(),
  // Partly done is still done: show Activity, then say which files were left.
  apply: async () => {
    const error = await api.apply(planned!).then(() => null, (e) => e);
    planned = null;
    setPage("activity");
    await refreshActivity();
    if (error) say("warn", t.applyFailed, String(error));
  },
  undo: (el) => api.undo(el.dataset.k!).catch((e) => say("warn", t.undoFailed, String(e))).finally(refreshActivity),
  autostart: async () => {
    await api.setAutostart(!settings.autostart).catch(fail(t.saveFailed));
    await refreshSettings();
  },
  "pause-all": () => setPaused(!settings.paused),
  open: (el) => api.openExternal(el.dataset.k!).catch(fail(t.openFailed)),
};

function addCond(k: CondKey) {
  if (k === "ext") extRow = true; else (draft!.when[k] as number | string | null) = k === "name_glob" ? "" : 0;
  render();
  content.querySelector<HTMLInputElement>(`[data-field="${k}"]`)?.focus();
}

async function runPreview() {
  const pool = previewOf === "all" ? rules.filter((r) => r.enabled) : [...rules, ...(draft ? [draft] : [])].filter((r) => r.id === previewOf);
  const seen = new Set<string>();
  const next: Planned[] = [];
  try {
    // ponytail: first match wins across rules by dropping files an earlier rule already planned.
    for (const rule of pool) {
      for (const p of await api.preview(rule)) if (!seen.has(p.from)) { seen.add(p.from); next.push(p); }
    }
    planned = next;
  } catch (error) {
    fail(t.previewFailed)(error);
  }
  render();
}

async function refreshActivity() {
  journal = await api.activity().catch((e) => { fail(t.loadFailed)(e); return journal; });
  if (page === "activity") render();
}

async function refreshSettings() {
  const next = await api.getSettings().catch(() => null);
  if (next) settings = { ...next, theme: settings.theme };
  render();
}

function setTemplate(value: string) {
  draft!.then = "move_to" in draft!.then ? { move_to: value } : { rename: value };
}

async function changeLang(next: Lang) {
  setLang(next);
  settings.lang = next;
  store("lang", next);
  build();
  await api.setLanguage(next).catch(fail(t.saveFailed));
  content.querySelector<HTMLElement>(`[aria-label="${CSS.escape(t.language)}"]`)?.focus();
}

function applyTheme() {
  if (settings.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  void getCurrentWindow().setTheme(settings.theme === "system" ? null : settings.theme).catch(() => {});
}

// ---------- events ----------

document.addEventListener("click", async (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el || !document.body.contains(el) || el.closest(".infobar")) return;
  try {
    await actions[el.dataset.act!]?.(el);
  } catch (error) {
    fail(t.actionFailed)(error);
  }
});

document.addEventListener("input", (event) => {
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
  content.querySelector(".example .file")!.textContent = sample;
  content.querySelector(".example .dest")!.textContent = template ? short(target(draft, "~/Downloads", sample)) : "…";
  content.querySelector<HTMLButtonElement>('[data-act="save"]')!.disabled = !template.trim();
});

// Drag to reorder rules; arrow keys on the grip do the same from the keyboard.
let dragging = -1;
document.addEventListener("dragstart", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".rule");
  if (!li) return;
  dragging = +li.dataset.i!;
  li.classList.add("dragging");
  e.dataTransfer!.effectAllowed = "move";
});
document.addEventListener("dragover", (e) => {
  if (dragging < 0 || !(e.target as HTMLElement).closest(".rule")) return;
  e.preventDefault();
});
document.addEventListener("drop", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>(".rule");
  if (!li || dragging < 0) return;
  e.preventDefault();
  moveRule(dragging, +li.dataset.i!);
});
document.addEventListener("dragend", () => { dragging = -1; content.querySelector(".dragging")?.classList.remove("dragging"); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && nav.classList.contains("open")) { nav.classList.remove("open"); return; }
  const grip = (e.target as HTMLElement).closest<HTMLElement>(".grip");
  if (!grip || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  e.preventDefault();
  const from = +grip.dataset.i!;
  const to = Math.min(rules.length - 1, Math.max(0, from + (e.key === "ArrowUp" ? -1 : 1)));
  if (moveRule(from, to)) content.querySelector<HTMLElement>(`.grip[data-i="${to}"]`)?.focus();
});

function moveRule(from: number, to: number) {
  if (from === to) return false;
  rules.splice(to, 0, ...rules.splice(from, 1));
  render();
  api.saveRules(rules).catch(fail(t.saveFailed));
  return true;
}

// ---------- boot ----------

async function boot() {
  setLang((stored("lang") as Lang | null) ?? systemLang());
  page = (stored("page") as Page | null) ?? "rules";
  if (!(page in pages) || page === "editor") page = "rules";
  tooltips();
  applyTheme();
  void (navigator as any).userAgentData?.getHighEntropyValues(["platformVersion"]).then((ua: { platformVersion: string }) => {
    document.documentElement.classList.toggle("mica", parseInt(ua.platformVersion) >= 13); // Windows 11
  });
  build();
  // The saved choice lives in rules.json so the tray reads it too; localStorage only avoids a flash.
  const saved = await api.getSettings().catch(() => null);
  if (saved) {
    const theme = saved.theme;
    settings = saved;
    if (theme !== stored("theme")) { store("theme", theme); applyTheme(); }
    if (saved.lang !== lang) { setLang(saved.lang); store("lang", saved.lang); build(); }
  }
  void getVersion().then((v) => { version = v; if (page === "about") render(); }).catch(() => {});
  void api.onActivity(() => void refreshActivity());
  void api.onSettings(() => void refreshSettings());
  await load();
}

void boot();
