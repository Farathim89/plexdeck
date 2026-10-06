// SPDX-License-Identifier: GPL-3.0-or-later
// Audio & subtitle tool window (PC mode and TV mode). Works with mouse, keyboard
// and controller: Up/Down pick a field, Left/Right change it, A/Enter opens the list.
const desktop = window.ppDesktop;
const $ = (id) => document.getElementById(id);
const mc = (r) => (r && r.MediaContainer) || {};
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const startKey = new URLSearchParams(location.search).get("key");

// Fields, top to bottom. options: [{ label, value }]
const F = {
  library: { label: "Library", options: [], index: 0 },
  title: { label: "Show / movie", options: [], index: 0 },
  scope: { label: "Apply to", options: [], index: 0 },
  audio: { label: "Audio track", options: [{ label: "No change", value: null }], index: 0 },
  subs: { label: "Subtitles", options: [{ label: "No change", value: null }], index: 0 },
};
const ORDER = ["library", "title", "scope", "audio", "subs"];
let focus = 0;                       // 0..4 fields, 5 = Apply
let busy = false;
const val = (k) => { const f = F[k]; return f.options[f.index] ? f.options[f.index].value : null; };

function draw() {
  $("fields").innerHTML = ORDER.map((k, i) => {
    const f = F[k];
    const off = !f.options.length || (k === "scope" && f.options.length < 2);
    const cur = f.options[f.index];
    return `<div class="field ${focus === i ? "focus" : ""} ${off ? "off" : ""}" data-k="${k}" data-i="${i}">
      <span class="label">${esc(f.label)}</span>
      <button type="button" class="arrow" data-d="-1" tabindex="-1">◀</button>
      <div class="value">${esc(cur ? cur.label : "—")}</div>
      <button type="button" class="arrow" data-d="1" tabindex="-1">▶</button></div>`;
  }).join("");
  $("apply").classList.toggle("focus", focus === ORDER.length);
  $("apply").disabled = busy;
}
$("fields").addEventListener("click", (e) => {
  const row = e.target.closest(".field");
  if (!row) return;
  focus = Number(row.dataset.i);
  const arrow = e.target.closest(".arrow");
  if (arrow) change(row.dataset.k, Number(arrow.dataset.d));
  else if (e.target.closest(".value")) openPicker(row.dataset.k);
  draw();
});

function change(k, d) {
  const f = F[k];
  if (!f.options.length) return;
  const next = (f.index + d + f.options.length) % f.options.length;
  if (next === f.index) return;
  f.index = next;
  draw();
  onChanged(k);
}
async function onChanged(k) {
  if (k === "library") await loadTitles();
  if (k === "library" || k === "title") await loadScopes();
  if (k === "library" || k === "title" || k === "scope") await loadTracks();
}

// ---- loading -----------------------------------------------------------------------
async function loadLibraries(selectId) {
  const dirs = (mc(await desktop.tvApi("/library/sections")).Directory || []).filter((d) => d.type === "show" || d.type === "movie");
  F.library.options = dirs.map((d) => ({ label: d.title, value: { key: d.key, type: d.type } }));
  F.library.index = Math.max(0, F.library.options.findIndex((o) => String(o.value.key) === String(selectId)));
}
async function loadTitles(selectKey) {
  const lib = val("library");
  F.title.options = []; draw();
  if (!lib) return;
  status("Loading titles…");
  const items = mc(await desktop.tvApi(`/library/sections/${lib.key}/all`, { sort: "titleSort" })).Metadata || [];
  F.title.options = items.map((m) => ({ label: m.year ? `${m.title} (${m.year})` : m.title, value: { key: m.ratingKey, type: m.type, title: m.title } }));
  F.title.index = Math.max(0, F.title.options.findIndex((o) => String(o.value.key) === String(selectKey)));
  status(`${items.length} titles`);
  draw();
}
let episodeScope = null;   // when the tool was opened on one episode
async function loadScopes(selectKey) {
  const t = val("title");
  F.scope.options = [];
  if (!t) return draw();
  if (t.type === "movie") {
    F.scope.options = [{ label: "This movie", value: { type: "movie", key: t.key } }];
  } else {
    const seasons = mc(await desktop.tvApi(`/library/metadata/${t.key}/children`)).Metadata || [];
    F.scope.options = [
      ...(episodeScope && episodeScope.show === t.key ? [{ label: `This episode only (${episodeScope.label})`, value: { type: "episode", key: episodeScope.key } }] : []),
      { label: "The whole show (all seasons)", value: { type: "show", key: t.key } },
      ...seasons.filter((s) => s.type === "season").map((s) => ({ label: s.title, value: { type: "season", key: s.ratingKey } })),
    ];
  }
  F.scope.index = Math.max(0, F.scope.options.findIndex((o) => String(o.value.key) === String(selectKey)));
  draw();
}
async function loadTracks() {
  const scope = val("scope");
  F.audio.options = [{ label: "No change", value: null }];
  F.subs.options = [{ label: "No change", value: null }, { label: "Off (no subtitles)", value: "off" }];
  F.audio.index = F.subs.index = 0;
  $("preview").textContent = "—";
  draw();
  if (!scope) return;
  status("Reading the tracks…");
  const sampleKey = await Tracks.sample(scope);
  if (!sampleKey) { status("No episodes here."); return; }
  const s = await Tracks.streams(sampleKey);
  const meta = (mc(await desktop.tvApi(`/library/metadata/${sampleKey}`)).Metadata || [])[0];
  $("sampleName").textContent = meta ? (meta.type === "episode" ? `${meta.grandparentTitle} S${meta.parentIndex}·E${meta.index}` : meta.title) : "this title";
  F.audio.options.push(...s.audio.map((a) => ({ label: Tracks.audioLabel(a), value: a })));
  F.subs.options.push(...s.subtitle.map((x) => ({ label: Tracks.subLabel(x), value: x })));
  const lines = ["<b>Audio</b>", ...(s.audio.length ? s.audio.map((a, i) => `${i + 1}. ${esc(Tracks.audioLabel(a))}${a.default ? '<span class="tag">default</span>' : ""}`) : ["None"]),
    "<b>Subtitles</b>", ...(s.subtitle.length ? s.subtitle.map((x, i) => `${i + 1}. ${esc(Tracks.subLabel(x))}${x.forced ? '<span class="tag">FORCED</span>' : ""}${x.sdh ? '<span class="tag">SDH</span>' : ""}`) : ["None"])];
  $("preview").innerHTML = lines.join("<br>");
  status("");
  draw();
}

// ---- apply -------------------------------------------------------------------------
async function apply() {
  const audio = val("audio"), sub = val("subs"), scope = val("scope");
  if (busy || !scope) return;
  if (!audio && !sub) return status("Choose an audio and/or subtitle track first.");
  busy = true; draw();
  $("bar").hidden = false; $("barFill").style.width = "0%";
  status("Applying…");
  try {
    const r = await Tracks.apply(scope, audio, sub, (d, t) => {
      $("barFill").style.width = `${Math.round((d / t) * 100)}%`;
      status(`Applying… ${d} / ${t}`);
    });
    await loadTracks();   // show the new ✓ marks
    status(`Done — updated ${r.changed} of ${r.total}. Plex now plays these with your chosen tracks.`);
  } catch {
    status("Something went wrong talking to your Plex server.");
  } finally {
    busy = false; draw();
    setTimeout(() => { $("bar").hidden = true; }, 1500);
  }
}
$("apply").addEventListener("click", apply);
function status(t) { $("status").textContent = t || ""; }

// ---- the full list (picker) ---------------------------------------------------------
let picking = null, pickFocus = 0, pickShown = [];
function openPicker(k) {
  const f = F[k];
  if (!f.options.length) return;
  picking = k;
  $("filter").value = "";
  $("picker").hidden = false;
  renderPicker(f.index);
  $("filter").focus();
}
function renderPicker(focusOriginal) {
  const f = F[picking];
  const q = $("filter").value.trim().toLowerCase();
  pickShown = f.options.map((o, i) => ({ o, i })).filter(({ o }) => !q || o.label.toLowerCase().includes(q));
  if (focusOriginal != null) pickFocus = Math.max(0, pickShown.findIndex((x) => x.i === focusOriginal));
  pickFocus = Math.min(pickFocus, Math.max(0, pickShown.length - 1));
  $("pickList").innerHTML = pickShown.map(({ o, i }, n) =>
    `<div class="opt ${n === pickFocus ? "focus" : ""} ${i === f.index ? "current" : ""}" data-n="${n}">${esc(o.label)}</div>`).join("");
  const el = $("pickList").children[pickFocus];
  if (el) el.scrollIntoView({ block: "nearest" });
}
function choose(n) {
  const x = pickShown[n];
  const k = picking;
  closePicker();
  if (!x || F[k].index === x.i) return;
  F[k].index = x.i;
  draw();
  onChanged(k);
}
function closePicker() { picking = null; $("picker").hidden = true; }
$("filter").addEventListener("input", () => { pickFocus = 0; renderPicker(); });
$("pickList").addEventListener("click", (e) => { const o = e.target.closest(".opt"); if (o) choose(Number(o.dataset.n)); });
$("picker").addEventListener("click", (e) => { if (e.target === $("picker")) closePicker(); });

// ---- keys / controller ---------------------------------------------------------------
function act(a) {
  if (picking) {
    if (a === "Up") { pickFocus = Math.max(0, pickFocus - 1); renderPicker(); }
    else if (a === "Down") { pickFocus = Math.min(pickShown.length - 1, pickFocus + 1); renderPicker(); }
    else if (a === "OK") choose(pickFocus);
    else if (a === "Back") closePicker();
    return;
  }
  if (a === "Up") focus = Math.max(0, focus - 1);
  else if (a === "Down") focus = Math.min(ORDER.length, focus + 1);
  else if (a === "Left" && focus < ORDER.length) return change(ORDER[focus], -1);
  else if (a === "Right" && focus < ORDER.length) return change(ORDER[focus], 1);
  else if (a === "OK") return focus === ORDER.length ? apply() : openPicker(ORDER[focus]);
  else if (a === "Back") return desktop.close();
  draw();
}
const KEYS = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Enter: "OK", Escape: "Back" };
document.addEventListener("keydown", (e) => {
  const a = KEYS[e.key];
  if (!a) return;
  // In the filter box, left/right move the cursor.
  if (picking && (a === "Left" || a === "Right")) return;
  e.preventDefault();
  act(a);
});
let held = new Set(["B", "Start", "A"]);   // ignore the press that opened the tool
function padLoop() {
  const down = new Set(desktop.padState().flatMap((p) => p.pressed));
  for (const n of down) if (!held.has(n)) {
    act(n === "A" ? "OK" : n === "B" || n === "Back" ? "Back" : n);
  }
  held = down;
  requestAnimationFrame(padLoop);
}
requestAnimationFrame(padLoop);
$("close").addEventListener("click", () => desktop.close());
$("backdrop").addEventListener("click", () => desktop.close());

// ---- start: on the item the tool was opened for ------------------------------------------
(async () => {
  draw();
  const s = await desktop.tvSession();
  if (!s || !s.ok) { status("Sign in to Plex first."); return; }
  let libId = null, titleKey = null, scopeKey = null;
  if (startKey) {
    const m = (mc(await desktop.tvApi(`/library/metadata/${startKey}`)).Metadata || [])[0];
    if (m) {
      libId = m.librarySectionID;
      if (m.type === "episode") {
        titleKey = m.grandparentRatingKey; scopeKey = m.parentRatingKey;
        episodeScope = { key: m.ratingKey, show: String(m.grandparentRatingKey), label: `S${m.parentIndex}·E${m.index}` };
      } else if (m.type === "season") { titleKey = m.parentRatingKey; scopeKey = m.ratingKey; }
      else { titleKey = m.ratingKey; scopeKey = m.type === "show" ? m.ratingKey : null; }
      focus = 3;   // straight to the audio track
    }
  }
  await loadLibraries(libId);
  await loadTitles(titleKey);
  await loadScopes(scopeKey);
  await loadTracks();
})();
