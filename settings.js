// SPDX-License-Identifier: GPL-3.0-or-later
// PlexDeck settings overlay: every control has data-key = the setting it changes.
const desktop = window.ppDesktop;
let settings = {};

function suffix(key, v) {
  if (key === "textSize") return `${Math.round(v)}%`;
  if (key === "defaultVolume") return `${Math.round(v)}%`;
  return v === 0 ? "at once" : `${v} s`;
}

function render() {
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
  const sw = document.querySelector('[data-key="startWithWindows"]');
  sw.disabled = !settings.packaged;
  document.getElementById("swNote").textContent = settings.packaged ? "(in the tray, ready to play)" : "(installed app only)";
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
