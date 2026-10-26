// SPDX-License-Identifier: GPL-3.0-or-later
// PlexDeck settings overlay: every control has data-key = the setting it changes.
const desktop = window.ppDesktop;   // tr(): PlexDeck's language, from i18n-dom.js
let settings = {};

function suffix(key, v) {
  if (key === "textSize") return `${Math.round(v)}%`;
  if (key === "defaultVolume") return `${Math.round(v)}%`;
  return v === 0 ? tr("at once") : tr("{n} s", { n: v });
}

// Languages: "Automatic" (like Windows) plus every language file the app has.
function renderLanguages() {
  const sel = document.getElementById("language");
  if (sel.options.length || !settings.languages) return;
  sel.append(new Option(tr("Automatic (like Windows)"), ""));
  for (const l of settings.languages) sel.append(new Option(l.name, l.code));
}

function render() {
  renderLanguages();
  for (const el of document.querySelectorAll("[data-key]")) {
    const key = el.dataset.key;
    const v = settings[key];
    if (el.type === "checkbox") el.checked = !!v;
    else if (el.type === "radio") el.checked = el.value === v;
    else if (el.type === "range") {
      const scaled = el.dataset.scale ? Math.round(v * Number(el.dataset.scale)) : v;
      el.value = scaled;
      el.nextElementSibling.textContent = suffix(key, scaled);
    } else if (document.activeElement !== el) el.value = v == null ? "" : String(v);
  }
  renderThemes();
  renderKeys();
  const sw = document.querySelector('[data-key="startWithWindows"]');
  sw.disabled = !settings.packaged;
  document.getElementById("swNote").textContent = settings.packaged ? tr("(in the tray, ready to play)") : tr("(installed app only)");
  document.getElementById("version").textContent = settings.version || "";
  document.getElementById("engine").textContent = `Electron ${settings.electron} · Chromium ${settings.chrome}`;
  document.getElementById("imported").hidden = !settings.importedOldSettings;
}

// One swatch per theme; picking one applies it at once (no reload, playback keeps going).
function renderThemes() {
  const box = document.getElementById("themes");
  if (!box.childElementCount) {
    for (const t of settings.themes || []) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      b.dataset.id = t.id;
      const mini = document.createElement("span");
      mini.className = "mini";
      const bar = document.createElement("i");
      bar.style.background = t.title;
      const page = document.createElement("b");
      page.style.background = t.page;
      page.style.setProperty("--acc", t.accent);
      mini.append(bar, page);
      b.append(mini, document.createTextNode(t.label));
      b.addEventListener("click", () => { settings.theme = t.id; desktop.setSetting("theme", t.id); renderThemes(); });
      box.append(b);
    }
  }
  for (const b of box.children) b.classList.toggle("active", b.dataset.id === settings.theme);
}

// TV mode's key bindings (keys-core.js; TV mode has the same list: Settings → Key Bindings).
// + waits for the next key (10 s), × takes a key away, ↺ puts back an action's default keys.
let keyWait = null;   // { id, timer }
const keysStatus = document.getElementById("keysStatus");
const keysSay = (t) => { keysStatus.textContent = t; keysStatus.hidden = !t; };
const setKeys = (saved) => { settings.tvKeys = saved; desktop.setSetting("tvKeys", saved); renderKeys(); };
function renderKeys() {
  const box = document.getElementById("tvKeys");
  const saved = settings.tvKeys || {};
  box.textContent = "";
  for (const a of TvKeys.ACTIONS) {
    const row = box.insertRow(), name = row.insertCell(), cell = row.insertCell();
    name.textContent = tr(a.label);
    const pad = document.createElement("small");
    pad.textContent = tr("Controller: {button}", { button: tr(a.pad) });
    name.append(pad);
    for (const k of TvKeys.keysFor(saved, a.id)) {
      const chip = document.createElement("span"), x = document.createElement("button");
      chip.className = "kchip";
      chip.textContent = TvKeys.label(k);
      x.type = "button"; x.textContent = "×"; x.title = tr("Take away {key}", { key: TvKeys.label(k) });
      x.addEventListener("click", () => setKeys(TvKeys.unbind(settings.tvKeys || {}, a.id, k)));
      chip.append(x);
      cell.append(chip);
    }
    const add = document.createElement("button"), def = document.createElement("button");
    add.type = def.type = "button";
    add.className = def.className = "kbtn";
    add.textContent = keyWait && keyWait.id === a.id ? tr("Press a key…") : "+";
    if (keyWait && keyWait.id === a.id) add.classList.add("wait");
    add.title = tr("Add a key");
    add.addEventListener("click", () => {
      clearTimeout(keyWait && keyWait.timer);
      keyWait = { id: a.id, timer: setTimeout(() => { keyWait = null; renderKeys(); }, 10000) };
      keysSay(""); renderKeys();
    });
    def.textContent = "↺"; def.title = tr("Default keys");
    def.addEventListener("click", () => { if (confirm(tr("Put back the default keys for {action}?", { action: tr(a.label) }))) setKeys(TvKeys.defaults(settings.tvKeys || {}, a.id)); });
    cell.append(add, def);
  }
}
// The key you press for "+" (before the settings window's own keys: Esc here is a key like any other)
document.addEventListener("keydown", (e) => {
  if (!keyWait || TvKeys.IGNORE.includes(e.key)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.ctrlKey || e.altKey || e.metaKey) { keysSay(tr("Keys with Ctrl, Alt or Windows can't be used")); return; }
  const { id, timer } = keyWait;
  clearTimeout(timer); keyWait = null;
  const k = TvKeys.name(e.key), a = TvKeys.ACTIONS.find((x) => x.id === id);
  if (TvKeys.RESERVED.includes(k)) { keysSay(tr("{key} is PlexDeck's own key", { key: TvKeys.label(k) })); renderKeys(); return; }
  const { saved, was } = TvKeys.bind(settings.tvKeys || {}, id, k);
  setKeys(saved);
  keysSay(was ? tr("{key}: {action} (was {before})", { key: TvKeys.label(k), action: tr(a.label), before: tr(was.label) }) : tr("{key}: {action}", { key: TvKeys.label(k), action: tr(a.label) }));
}, true);
document.getElementById("keysReset").addEventListener("click", () => {
  if (confirm(tr("Put back the default keys for everything?"))) { setKeys({}); keysSay(tr("Key bindings reset")); }
});

function save(el) {
  const key = el.dataset.key;
  let value;
  if (el.type === "checkbox") value = el.checked;
  else if (el.type === "radio") { if (!el.checked) return; value = el.value; }
  else if (el.type === "range") {
    value = Number(el.value) / (el.dataset.scale ? Number(el.dataset.scale) : 1);
    el.nextElementSibling.textContent = suffix(key, Number(el.value));
  } else value = el.dataset.number ? Number(el.value) : el.value.trim();
  // "192.168.1.10" → "http://192.168.1.10:32400"
  if (key === "serverUrl" && value) {
    if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
    if (!/:\d+/.test(value.replace(/^https?:\/\//i, ""))) value = value.replace(/\/+$/, "") + ":32400";
    el.value = value;
  }
  settings[key] = value;
  desktop.setSetting(key, value);
}

for (const el of document.querySelectorAll("[data-key]")) {
  // Text fields save when you leave them (or press Enter), everything else at once.
  if (el.type === "text") {
    el.addEventListener("change", () => save(el));
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") el.blur(); });
  } else if (el.type === "range") {
    el.addEventListener("input", () => { el.nextElementSibling.textContent = suffix(el.dataset.key, Number(el.value)); });
    el.addEventListener("change", () => save(el));
  } else {
    el.addEventListener("change", () => save(el));
  }
}

document.querySelectorAll("nav button").forEach((btn) => btn.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".pane").forEach((p) => p.classList.toggle("active", p.id === btn.dataset.pane));
}));
document.querySelectorAll('[data-action="plex"]').forEach((b) => b.addEventListener("click", () => desktop.openPlexSettings()));
// Settings backup: the app shows the file dialogs (and asks before importing).
const backupStatus = document.getElementById("backupStatus");
for (const [action, call] of [["export", () => desktop.exportSettings()], ["import", () => desktop.importSettings()]]) {
  document.querySelector(`[data-action="${action}"]`).addEventListener("click", async () => {
    const msg = await call().catch(() => tr("Something went wrong."));
    if (!msg) return;   // cancelled
    backupStatus.textContent = msg;
    backupStatus.hidden = false;
  });
}
document.getElementById("close").addEventListener("click", () => desktop.close());
document.getElementById("backdrop").addEventListener("click", () => desktop.close());
document.addEventListener("keydown", (e) => { if (e.key === "Escape") desktop.close(); });

// Controller: live test readout, and Circle/B or Options/Start closes the settings.
const padBox = document.getElementById("padtest");
let padWasDown = new Set(["B", "Start"]);   // ignore the press that opened the settings
function escapeHtml(t) { return String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]); }
function padLoop() {
  const pads = desktop.padState();
  const down = new Set(pads.flatMap((p) => p.pressed));
  for (const n of ["B", "Start"]) if (down.has(n) && !padWasDown.has(n)) desktop.close();
  padWasDown = down;
  if (pads.length) {
    padBox.innerHTML = pads.map((p) =>
      `<b>${escapeHtml(p.id)}</b>\nmapping: ${escapeHtml(p.mapping)} → read as: ${p.layout}\n` +
      `pressed: ${p.pressed.length ? `<b>${p.pressed.join(", ")}</b>` : "—"}\n` +
      `raw buttons: ${p.rawButtons.join(", ") || "—"}\naxes: ${p.axes.join("  ")}`).join("\n\n");
  }
  requestAnimationFrame(padLoop);
}
requestAnimationFrame(padLoop);

desktop.getSettings().then((s) => { settings = s || {}; render(); });
desktop.onSettings((s) => { settings = s || settings; render(); });
