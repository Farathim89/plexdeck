// SPDX-License-Identifier: GPL-3.0-or-later
// Collects every text PlexDeck shows (see i18n.js) into locales/template.json and
// tells you, per language file, what's missing and what isn't used any more.
//   node scripts/i18n-extract.js
// The keys must be exactly what the app looks up: HTML text (whitespace squeezed),
// title / placeholder / aria-label, the inner HTML of data-i18n elements, and the
// first argument of tr("…") / N_("…") in the scripts.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const LOCALES = path.join(ROOT, "locales");
const HTML = ["settings.html", "tv.html", "tracks.html", "titlebar.html", "loading.html"];
const JS = ["main.js", "preload.js", "settings.js", "titlebar.js", "tracks.js", "tracks-core.js", "tv.js", "tv-player.js", "tv-music.js", "tv-main.js", "mpv-main.js"];

const keys = new Map();   // key → first place it was seen
const add = (k, where) => { if (k && /[A-Za-z]/.test(k) && !keys.has(k)) keys.set(k, where); };
const squeeze = (s) => s.replace(/\s+/g, " ").trim();
const decode = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[e]);

for (const file of HTML) {
  let s = fs.readFileSync(path.join(ROOT, file), "utf8");
  const title = /<title>([\s\S]*?)<\/title>/.exec(s);
  if (title) add(squeeze(decode(title[1])), file);
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.slice(s.indexOf("<body"));
  s = s.replace(/<(script|style)\b[\s\S]*?<\/\1>/g, "");
  // whole elements first (their inner HTML is the key), then take them out
  s = s.replace(/<(\w+)\b([^>]*\bdata-i18n\b[^>]*)>([\s\S]*?)<\/\1>/g, (_m, _tag, _attrs, inner) => { add(squeeze(inner), file); return "<x>"; });
  for (const m of s.matchAll(/\b(title|placeholder|aria-label)="([^"]*)"/g)) add(squeeze(decode(m[2])), file);
  for (const m of s.matchAll(/>([^<>]+)</g)) add(squeeze(decode(m[1])), file);
}

const STRING = /\b(?:tr|N_)\(\s*("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\$]|\\.)*`)/g;
for (const file of JS) {
  const s = fs.readFileSync(path.join(ROOT, file), "utf8");
  for (const m of s.matchAll(STRING)) {
    const lit = m[1];
    const body = lit.slice(1, -1).replace(/\\(.)/g, (_x, c) => ({ n: "\n", t: "\t" })[c] || c);
    add(body, file);
  }
}

const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b));
fs.mkdirSync(LOCALES, { recursive: true });
fs.writeFileSync(path.join(LOCALES, "template.json"),
  JSON.stringify(Object.fromEntries([["_name", "Name of the language, in that language"], ...sorted.map((k) => [k, ""])]), null, 2) + "\n");
console.log(`${sorted.length} texts → locales/template.json`);

for (const f of fs.readdirSync(LOCALES).filter((x) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(x))) {
  const d = JSON.parse(fs.readFileSync(path.join(LOCALES, f), "utf8"));
  const missing = sorted.filter((k) => !d[k]);
  const unused = Object.keys(d).filter((k) => k !== "_name" && !keys.has(k));
  console.log(`${f}: ${sorted.length - missing.length}/${sorted.length} translated` +
    (missing.length ? `, missing ${missing.length}` : "") + (unused.length ? `, ${unused.length} not used any more` : ""));
  if (process.argv.includes("--verbose")) {
    for (const k of missing) console.log(`  missing: ${k}`);
    for (const k of unused) console.log(`  unused:  ${k}`);
  }
}
