// CCS/1 i18n check (npm run check:i18n), copied from Clickloom 0.3.1. Lesson from Netlume 0.2.1: the language switch shipped broken.
// 1 SHAPE: src/i18n.ts en/pl have the same keys at every depth, same function arity, no empty text
// 2 STRAY: no user-facing text outside i18n.ts in src/*.ts|html, nor outside tr()/tr!() in src-tauri/src (tests excluded)
// ESCAPE: `i18n-ok` comment on the line, `i18n-ok-start`…`i18n-ok-end` region, or `i18n-ok-file` in the file
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const problems = [];

// ---- 1 Shape (Node 24 loads the .ts file with type stripping)
const { dictionaries } = await import(pathToFileURL(join(root, "src/i18n.ts")).href);
let count = 0;
function compare(en, pl, path) {
  for (const key of new Set([...Object.keys(en), ...Object.keys(pl)])) {
    const at = path ? `${path}.${key}` : key;
    const a = en[key], b = pl[key];
    if (a === undefined) { problems.push(`PL key without EN: ${at}`); continue; }
    if (b === undefined) { problems.push(`EN key without PL: ${at}`); continue; }
    if (typeof a !== typeof b) problems.push(`Different kinds of value: ${at}`);
    else if (typeof a === "object") compare(a, b, at);
    else if (typeof a === "function") {
      count++;
      if (a.length !== b.length) problems.push(`Different arguments: ${at}`);
      const args = Array.from({ length: a.length }, (_, i) => (i ? 2 : "x"));
      if (!String(b(...args)).trim()) problems.push(`Empty PL text: ${at}`);
    } else {
      count++;
      if (!String(a).trim() || !String(b).trim()) problems.push(`Empty text: ${at}`);
    }
  }
}
compare(dictionaries.en, dictionaries.pl, "");

// ---- 2 Stray text
const KEY_NAMES = /^(Escape|Enter|Tab|Arrow(Up|Down|Left|Right)|Home|End|Shift|Control|Alt|Meta|Delete|Backspace)$/;
const files = (dir, ext) => readdirSync(join(root, dir), { recursive: true }).filter((f) => ext.test(f)).map((f) => join(dir, f));

/** String literals with their line numbers; comments and template expressions skipped. */
function literals(text, rust) {
  const out = [];
  let i = 0, line = 1;
  const push = (value, at) => out.push({ value, line: at });
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const end = text.indexOf("*/", i + 2); line += text.slice(i, end).split("\n").length - 1; i = end + 2; continue; }
    if (rust && c === "'" ) { // char literal or lifetime: skip a char literal only
      const m = /^'(\\.|[^\\'])'/.exec(text.slice(i, i + 6));
      i += m ? m[0].length : 1; continue;
    }
    if (c === '"' || (!rust && (c === "'" || c === "`"))) {
      const at = line; let value = ""; i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") { value += text[i + 1] === "n" ? " " : text[i + 1]; i += 2; continue; }
        if (c === "`" && text[i] === "$" && text[i + 1] === "{") {
          let depth = 1; i += 2;
          while (i < text.length && depth) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; else if (text[i] === "\n") line++; i++; }
          value += " ";
          continue;
        }
        if (text[i] === "\n") line++;
        value += text[i++];
      }
      i++; push(value, at); continue;
    }
    i++;
  }
  return out;
}

function prose(value) {
  if (/[^\x00-\x7F]/.test(value) && /\p{L}/u.test(value.replace(/[A-Za-z]/g, ""))) return true; // non-ASCII letters (Polish)
  const v = value.trim();
  if (KEY_NAMES.test(v)) return false;
  if (/[A-Z][a-z]+/.test(v) && (/\s/.test(v) || /^[A-Z][a-z]{2,}[.!?…]?$/.test(v))) return true;
  return /[a-z]{2,} [a-z]{2,} [a-z]{2,}/.test(v) && /[.,:;!?'’]/.test(v); // a lowercase sentence
}

function allowed(lines, at) {
  let open = false;
  for (let i = 0; i < at; i++) {
    if (lines[i].includes("i18n-ok-start")) open = true;
    if (lines[i].includes("i18n-ok-end")) open = false;
  }
  return open || /i18n-ok(?!-)/.test(lines[at - 1] ?? "");
}

const scan = (file, rust) => {
  let text = readFileSync(join(root, file), "utf8");
  if (text.includes("i18n-ok-file")) return;
  if (rust) {
    const test = text.search(/\r?\n#\[cfg\(test\)\]\r?\n(pub(\(crate\))? )?mod /);
    if (test >= 0) text = text.slice(0, test);
  }
  const lines = text.split("\n");
  for (const { value, line } of literals(text, rust)) {
    if (!prose(value) || allowed(lines, line)) continue;
    if (rust) {
      const near = lines.slice(Math.max(0, line - 4), line).join("\n");
      if (/\btr!?\(/.test(near) || /eprintln!|expect\(|#\[/.test(lines[line - 1])) continue;
    }
    problems.push(`Text outside the dictionaries: ${file}:${line}: ${value.trim()}`);
  }
};
for (const file of files("src", /\.ts$/)) if (!/(^|[\\/])(i18n|mock)\.ts$/.test(file)) scan(file, false);
for (const file of files("src-tauri/src", /\.rs$/)) if (!file.endsWith("i18n.rs")) scan(file, true);
for (const file of ["index.html"]) {
  const text = readFileSync(join(root, file), "utf8");
  for (const m of text.matchAll(/>([^<>]*\p{L}[^<>]*)</gu)) if (m[1].trim() !== "FolderPilot") problems.push(`Text in ${file}: ${m[1].trim()}`);
}

if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
console.log(`i18n ok: ${count} strings in PL and EN with the same shape, no stray text in src/ or src-tauri/src`);
