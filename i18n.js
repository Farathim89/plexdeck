// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// PlexDeck's own languages (Plex's parts follow your Plex language instead).
//
// The English text is the key, gettext-style: locales/sv.json maps
// "Settings" → "Inställningar". Anything a language file doesn't have stays
// English, so a half-done translation still works. {name} in a text is filled
// in from the values given to t(). How to add a language: see README.
// ===========================================================================

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "locales");
let lang = "en";
let dict = {};

// Every language file there is: [{ code, name }], English first.
function languages() {
  const list = [{ code: "en", name: "English" }];
  try {
    for (const f of fs.readdirSync(DIR).sort()) {
      const m = /^([a-z]{2}(?:-[A-Z]{2})?)\.json$/.exec(f);
      if (!m || m[1] === "en") continue;
      const d = read(m[1]);
      list.push({ code: m[1], name: d._name || m[1] });
    }
  } catch {}
  return list;
}
function read(code) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), "utf8")); } catch { return {}; }
}
// "" = follow Windows: the first of Windows' languages we have (sv-SE → sv), else English.
function pick(setting, systemLanguages = []) {
  const have = new Set(languages().map((l) => l.code));
  if (setting && have.has(setting)) return setting;
  for (const l of systemLanguages) {
    if (have.has(l)) return l;
    const base = String(l).split("-")[0];
    if (have.has(base)) return base;
  }
  return "en";
}
function use(setting, systemLanguages) {
  lang = pick(setting, systemLanguages);
  dict = lang === "en" ? {} : read(lang);
  return lang;
}
function fill(text, vars) {
  return vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : String(text);
}
const t = (key, vars) => fill(dict[key] || key, vars);

module.exports = { languages, use, t, current: () => ({ lang, dict }) };
