// CCS/1 #164 isolated real-app E2E: `npm run tauri build`, then `node scripts/e2e-auto.mjs [exe]`. Exit 0 = all passed. Everything (APPDATA, WebView2 data, Inbox, destinations) lives in one test tree.
// Drives the real release exe through WebView2's DevTools port: DOM clicks on the real UI, checks on disk.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXE = process.argv[2] ?? fileURLToPath(new URL("../src-tauri/target/release/folderpilot.exe", import.meta.url));
const ROOT = path.join(os.tmpdir(), `FolderPilot-Test-${Date.now()}`);
const P = (...p) => path.join(ROOT, ...p);
const PORT = 9333;
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); }
}

// ---------- tree ----------
const inbox = P("Inbox");
for (const d of ["Inbox", "AppData", "WebView2", "Documents/PDF", "Pictures", "Archive"]) fs.mkdirSync(P(d), { recursive: true });
const ascii = (s) => Buffer.from(s, "ascii");
function jpeg(date) { // minimal JPEG, EXIF DateTimeOriginal = date
  const tiff = Buffer.concat([Buffer.from([0x49,0x49,0x2a,0,8,0,0,0, 1,0,0x69,0x87,4,0,1,0,0,0,26,0,0,0,0,0,0,0, 1,0,0x03,0x90,2,0,20,0,0,0,44,0,0,0,0,0,0,0]), ascii(date), Buffer.from([0])]);
  const app1 = Buffer.concat([ascii("Exif"), Buffer.from([0, 0]), tiff]);
  const len = app1.length + 2;
  return Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe1,len >> 8,len & 0xff]), app1, Buffer.from([0xff,0xd9])]);
}
const DAY = 86400000;
function put(name, data, daysOld = 0) {
  const f = path.join(inbox, name);
  fs.writeFileSync(f, data);
  if (daysOld) { const t = new Date(Date.now() - daysOld * DAY); fs.utimesSync(f, t, t); }
}
put("invoice-0412.pdf", "");
put("contract.pdf", "");
put("old-statement.pdf", "", 200);
put("IMG_1001.jpg", jpeg("2019:07:04 10:00:00"));
put("IMG_1002.jpg", jpeg("2023:12:24 18:30:00"));
put("screenshot.png", "", 40);
put("report.docx", "");
put("old-notes.txt", "", 120);
put("old-backup.zip", "", 150);
put("setup.zip", "");
put("notes.txt", "");
put("partial.pdf.crdownload", "");
fs.writeFileSync(P("Documents/PDF/contract.pdf"), "already here"); // clash -> "contract (2).pdf", original untouched
fs.mkdirSync(P("AppData/FolderPilot"), { recursive: true });
// ponytail: folder seeded in rules.json; "Add folder" opens the native OS dialog, which DevTools can't drive.
fs.writeFileSync(P("AppData/FolderPilot/rules.json"), JSON.stringify({ rules: [], folders: [{ path: inbox, paused: false }] }));

const fwd = (p) => p.replace(/\\/g, "/");
const dest = [fwd(P("Documents/PDF")), fwd(P("Pictures")) + "/{year}/{month}", null, fwd(P("Archive")) + "/{year}"];
const ym = (daysOld) => { const d = new Date(Date.now() - daysOld * DAY); return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")]; };
const [y0, m0, d0] = ym(0);
const expected = { // from (Inbox name) -> to (relative to ROOT)
  "invoice-0412.pdf": "Documents/PDF/invoice-0412.pdf",
  "contract.pdf": "Documents/PDF/contract (2).pdf",
  "old-statement.pdf": "Documents/PDF/old-statement.pdf",
  "IMG_1001.jpg": "Pictures/2019/07/IMG_1001.jpg",
  "IMG_1002.jpg": "Pictures/2023/12/IMG_1002.jpg",
  "screenshot.png": `Pictures/${ym(40)[0]}/${ym(40)[1]}/screenshot.png`,
  "report.docx": `Inbox/${y0}-${m0}-${d0} report.docx`,
  "old-notes.txt": `Archive/${ym(120)[0]}/old-notes.txt`,
  "old-backup.zip": `Archive/${ym(150)[0]}/old-backup.zip`,
};
const stays = ["setup.zip", "notes.txt", "partial.pdf.crdownload"];

// ---------- app + DevTools ----------
let proc;
async function launch() {
  proc = spawn(EXE, [], {
    env: { ...process.env, APPDATA: P("AppData"), WEBVIEW2_USER_DATA_FOLDER: P("WebView2"), WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
  });
  const target = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch { return null; }
  }, 20000);
  if (!target) throw new Error("no DevTools target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const waiting = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(m.data); waiting.get(msg.id)?.(msg); waiting.delete(msg.id); };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const js = async (expr) => {
    const res = await send("Runtime.evaluate", { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(JSON.stringify(res.result.exceptionDetails));
    return res.result?.result?.value;
  };
  const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(P(name), Buffer.from(r.result.data, "base64")); };
  await until(() => js(`return !!document.querySelector(".nav")`));
  return { js, shot, ws };
}
async function stop() {
  proc.kill();
  await until(async () => { try { await fetch(`http://127.0.0.1:${PORT}/json/list`); return false; } catch { return true; } }, 10000);
}
const click = (sel) => `const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error("missing " + ${JSON.stringify(sel)}); el.click();`;
const exists = (rel) => fs.existsSync(P(rel));
const config = () => JSON.parse(fs.readFileSync(P("AppData/FolderPilot/rules.json"), "utf8"));

try {
  let { js, shot, ws } = await launch();
  check("app starts with seeded folder", await until(async () => { await js(click('[data-act="go"][data-v="folders"]')); return js(`return document.querySelector(".page").textContent.includes("Inbox")`); }));

  // ponytail: no signal for "start rescan done" when nothing matches; wait it out (QUIET 2 s + STABLE 1 s + margin)
  // so it can't race the rules switched on below (a person takes longer than this anyway).
  await sleep(5000);
  // 4 starters in order, destinations pointed into the test tree
  for (let i = 0; i < 4; i++) {
    await js(click('[data-act="go"][data-v="rules"]'));
    await js(click(`[data-act="starter"][data-k="${i}"]`) );
    await until(() => js(`return !!document.querySelector('[data-field="template"]')`));
    if (dest[i]) await js(`const t = document.querySelector('[data-field="template"]'); t.value = ${JSON.stringify(dest[i])}; t.dispatchEvent(new Event("input", { bubbles: true }));`);
    await js(click('[data-act="save"]'));
    await until(() => js(`return document.querySelectorAll(".rule").length === ${i + 1}`));
  }
  const saved = config();
  check("4 starters saved, off by default", saved.rules.length === 4 && saved.rules.every((r) => !r.enabled), saved.rules.map((r) => r.name).join(" | "));
  for (let i = 0; i < 4; i++) {
    await js(click(`[data-act="rule-toggle"][data-i="${i}"]`));
    await until(() => js(`return document.querySelector('[data-act="rule-toggle"][data-i="${i}"]').getAttribute("aria-checked") === "true"`));
  }
  check("all 4 switched on and saved", await until(() => config().rules.every((r) => r.enabled), 5000));
  await js(click('[data-act="hint-off"]')).catch(() => {});
  await shot("01-rules.png");

  // preview
  await js(click('[data-act="go"][data-v="preview"]'));
  await js(click('[data-act="run-preview"]'));
  await until(() => js(`return !!document.querySelector('[data-act="apply"]')`));
  const plan = await js(`return [...document.querySelectorAll(".moves .move")].map(m => [m.querySelector(".file").title, m.querySelector(".dest").title])`);
  const planMap = Object.fromEntries(plan.map(([f, t]) => [path.basename(f), path.relative(ROOT, t).replace(/\\/g, "/")]));
  const planOk = Object.keys(expected).length === plan.length && Object.entries(expected).every(([f, t]) => planMap[f] === t);
  check("preview lists exactly the expected moves", planOk, planOk ? `${plan.length} moves` : JSON.stringify(planMap));
  check("preview moves nothing", Object.keys(expected).every((f) => exists(`Inbox/${f}`)));
  await shot("02-preview.png");

  // apply
  await js(click('[data-act="apply"]'));
  await until(() => js(`return !!document.querySelector('[data-act="undo"]')`));
  const placed = Object.entries(expected).filter(([f, t]) => !exists(t) || exists(`Inbox/${f}`));
  check("apply puts every file where expected", !placed.length, placed.map(([f]) => f).join(", "));
  check("unmatched / in-progress files stay", stays.every((f) => exists(`Inbox/${f}`)));
  check("clash: existing contract.pdf untouched", fs.readFileSync(P("Documents/PDF/contract.pdf"), "utf8") === "already here");
  await shot("03-activity.png");
  await sleep(5000); // watcher quiet+stable is 3 s: give it a chance to (wrongly) touch our output
  const stable = Object.values(expected).every(exists) && !fs.readdirSync(inbox).some((n) => n.startsWith(`${y0}-${m0}-${d0} ${y0}`));
  check("watcher leaves applied output alone (no re-rename)", stable, fs.readdirSync(inbox).join(", "));

  // undo
  await js(click('[data-act="undo"]'));
  await until(() => js(`return [...document.querySelectorAll(".run .sub")].some(s => s.textContent === "Undone")`));
  const back = Object.entries(expected).filter(([f, t]) => !exists(`Inbox/${f}`) || exists(t));
  check("undo brings every file back", !back.length, back.map(([f]) => f).join(", "));
  await sleep(5000);
  check("watcher leaves undone files where undo put them", Object.keys(expected).every((f) => exists(`Inbox/${f}`)));
  await shot("04-undone.png");

  // watcher
  const t0 = Date.now();
  fs.writeFileSync(path.join(inbox, "dropped.pdf"), "%PDF-1.4 dropped");
  const moved = await until(() => exists("Documents/PDF/dropped.pdf") && !exists("Inbox/dropped.pdf"), 20000);
  check("watcher moves a newly dropped PDF", moved, `${((Date.now() - t0) / 1000).toFixed(1)} s`);

  // restart
  ws.close();
  await stop();
  ({ js, shot, ws } = await launch());
  await js(click('[data-act="go"][data-v="rules"]'));
  const after = await until(() => js(`return [...document.querySelectorAll('.rule')].map(r => r.querySelector('.name').textContent + (r.querySelector('.switch').getAttribute('aria-checked') === 'true' ? ' on' : ' off'))`), 5000);
  check("rules survive restart (UI)", after?.length === 4 && after.every((s) => s.endsWith(" on")), (after ?? []).join(" | "));
  await js(click('[data-act="go"][data-v="folders"]'));
  check("folder survives restart (UI)", await js(`return document.querySelector(".page").textContent.includes(${JSON.stringify(inbox)})`));
  await js(click('[data-act="go"][data-v="rules"]'));
  await sleep(300);
  await shot("05-rules-after-restart.png");
  // Undo's restored files stay protected after a restart too (produced set rebuilt from the journal).
  await sleep(6000);
  check("start rescan leaves undone files alone", Object.keys(expected).every((f) => exists(`Inbox/${f}`)));
  ws.close();
  await stop();
} catch (error) {
  check("driver", false, String(error?.stack ?? error));
  proc?.kill();
}
fs.writeFileSync(P("results.json"), JSON.stringify(results, null, 2));
console.log(`\nROOT ${ROOT}\n${results.filter((r) => r.ok).length}/${results.length} passed`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
