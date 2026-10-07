// SPDX-License-Identifier: GPL-3.0-or-later
// ---------------------------------------------------------------------------
// PRELOAD — runs before every page.
//  * Local pages (title bar, settings): get the desktop bridge.
//  * Plex pages: auto-skip intros/credits after a delay, arrow-key and game
//    controller navigation with an orange focus ring, mouse back/forward.
// Nothing here is exposed to Plex's own scripts.
// ---------------------------------------------------------------------------

const { contextBridge, ipcRenderer } = require("electron");

// ---- reading a game controller ----------------------------------------------
// "standard" mapping (Xbox, and PS4/PS5 when Windows reports them properly):
//   0 Cross/A, 1 Circle/B, 4 L1, 5 R1, 6 L2, 7 R2, 8 Share/Back, 9 Options/Start, 12-15 D-pad.
// A DualShock 4 / DualSense that arrives as a raw DirectInput device instead:
//   0 Square, 1 Cross, 2 Circle, 3 Triangle, 4 L1, 5 R1, 6 L2, 7 R2, 8 Share, 9 Options,
//   and the D-pad is a "hat" on axis 9 (-1 = up, then clockwise in steps of 2/7; >1 = released).
const STANDARD = { 0: "A", 1: "B", 3: "Y", 4: "L1", 5: "R1", 6: "L2", 7: "R2", 8: "Back", 9: "Start",
                   12: "Up", 13: "Down", 14: "Left", 15: "Right" };
const DS4_RAW = { 1: "A", 2: "B", 3: "Y", 4: "L1", 5: "R1", 6: "L2", 7: "R2", 8: "Back", 9: "Start" };
const HAT = [["Up"], ["Up", "Right"], ["Right"], ["Down", "Right"], ["Down"], ["Down", "Left"], ["Left"], ["Up", "Left"]];
const isSony = (pad) => /054c|sony|wireless controller|dualshock|dualsense/i.test(pad.id);

function padLayout(pad) {
  if (pad.mapping === "standard") return "standard";
  return isSony(pad) ? "ds4-raw" : "standard";
}
function padButtons(pad) {
  const out = new Set();
  const layout = padLayout(pad);
  const map = layout === "ds4-raw" ? DS4_RAW : STANDARD;
  for (const [i, name] of Object.entries(map)) {
    const b = pad.buttons[i];
    if (b && (b.pressed || b.value > 0.6)) out.add(name);
  }
  if (layout === "ds4-raw" && pad.axes.length > 9) {
    const v = pad.axes[9];
    if (v >= -1.05 && v <= 1.05) for (const d of HAT[Math.round((v + 1) / (2 / 7)) % 8]) out.add(d);
  }
  const [ax = 0, ay = 0] = pad.axes;
  if (ax < -0.6) out.add("Left"); else if (ax > 0.6) out.add("Right");
  if (ay < -0.6) out.add("Up"); else if (ay > 0.6) out.add("Down");
  return out;
}
// What the settings tester shows.
function padState() {
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  return pads.map((p) => ({
    id: p.id, mapping: p.mapping || "(none)", layout: padLayout(p),
    pressed: [...padButtons(p)],
    rawButtons: p.buttons.map((b, i) => (b.pressed || b.value > 0.5 ? i : -1)).filter((i) => i >= 0),
    axes: p.axes.map((a) => Math.round(a * 100) / 100),
  }));
}

if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("ppDesktop", {
    // title bar
    showMenu: (index, x, y) => ipcRenderer.invoke("titlebar:menu", { index, x, y }),
    getTitle: () => ipcRenderer.invoke("titlebar:get-title"),
    onTitle: (cb) => ipcRenderer.on("titlebar:title", (_e, t) => cb(t)),
    onFocus: (cb) => ipcRenderer.on("titlebar:focus", (_e, f) => cb(f)),
    toggleSettings: () => ipcRenderer.send("titlebar:settings"),
    nav: (dir) => ipcRenderer.send("titlebar:nav", dir),
    // settings overlay
    getSettings: () => ipcRenderer.invoke("settings:get"),
    setSetting: (key, value) => ipcRenderer.send("settings:set", { key, value }),
    onSettings: (cb) => ipcRenderer.on("settings:changed", (_e, s) => cb(s)),
    close: () => ipcRenderer.send("settings:close"),
    openPlexSettings: () => ipcRenderer.send("settings:plex"),
    exportSettings: () => ipcRenderer.invoke("settings:export"),
    importSettings: () => ipcRenderer.invoke("settings:import"),
    padState,
    // PC / TV switch in the title bar
    setMode: (m) => ipcRenderer.send("titlebar:set-mode", m),
    onMode: (cb) => ipcRenderer.on("titlebar:mode", (_e, m) => cb(m)),
    onUpdate: (cb) => ipcRenderer.on("titlebar:update", (_e, u) => cb(u)),
    openUpdate: () => ipcRenderer.send("titlebar:open-update"),
    // TV mode (tv.html)
    tvSession: (force) => ipcRenderer.invoke("tv:session", { force: !!force }),
    tvApi: (path, params) => ipcRenderer.invoke("tv:api", { path, params }),
    tvApiPut: (path, params) => ipcRenderer.invoke("tv:api", { path, params, method: "PUT" }),
    tvApiSend: (method, path, params) => ipcRenderer.invoke("tv:api", { path, params, method }),
    tvWatchlist: () => ipcRenderer.invoke("tv:watchlist"),
    tvProvider: (url) => ipcRenderer.invoke("tv:provider", url),
    tvLyrics: (streamId) => ipcRenderer.invoke("tv:lyrics", String(streamId)),
    tvPlayProvider: (hash) => ipcRenderer.send("tv:play-provider", hash),
    // native player (mpv)
    nativeAvailable: () => ipcRenderer.invoke("native:available"),
    nativePlay: (item) => ipcRenderer.send("native:play", item),
    onNativeFailed: (cb) => ipcRenderer.on("native:failed", (_e, item) => cb(item)),
    nativeCmd: (command) => ipcRenderer.invoke("native:cmd", command),
    onNative: (cb) => ipcRenderer.on("native:event", (_e, m) => cb(m)),
    onNativeItem: (cb) => ipcRenderer.on("native:item", (_e, item) => cb(item)),
    nativeClose: (changed) => ipcRenderer.send("native:close", changed),
    nativeFallback: (item) => ipcRenderer.send("native:fallback", item),
    nativeFps: (fps) => ipcRenderer.send("native:fps", fps),
    nativePrefs: () => ipcRenderer.invoke("native:prefs"),
    nativeMini: (on) => ipcRenderer.send("native:mini", !!on),
    nativeMiniSize: () => ipcRenderer.send("native:mini-size"),
    nativeMiniDrag: (dx, dy) => ipcRenderer.send("native:mini-drag", { dx, dy }),
    nativeMiniDrop: () => ipcRenderer.send("native:mini-drop"),
    tvHomeUsers: () => ipcRenderer.invoke("tv:home-users"),
    tvSwitchUser: (uuid, pin) => ipcRenderer.invoke("tv:switch-user", { uuid, pin }),
    tvPlay: (item) => ipcRenderer.send("tv:play", item),
    tvOpenPc: (hash) => ipcRenderer.send("tv:open-pc", hash || ""),
    tvSettings: () => ipcRenderer.send("tv:settings"),
    openTracks: (key) => ipcRenderer.send("tracks:open", key || ""),
    tvMouseUsed: () => ipcRenderer.send("tv:mouse-used"),
    onTv: (name, cb) => {
      if (["tv:shown", "tv:refresh", "tv:overlay", "tv:prefs"].includes(name)) ipcRenderer.on(name, (_e, v) => cb(v));
    },
  });
} else if (/^https?:$/.test(location.protocol) && window.top === window) {
  plexExtras();
}

function plexExtras() {
  let prefs = {};

  // A real mouse click on an element, sent by the app (Plex's player buttons and
  // Skip Intro ignore clicks made by a script). Off-screen elements get a plain click.
  let ignoreMouseUntil = 0;
  function realClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) { el.click(); return; }
    ignoreMouseUntil = Date.now() + 700;   // our own click mustn't count as "you used the mouse"
    ipcRenderer.send("plex:click", { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  }
  ipcRenderer.invoke("plex:prefs").then((p) => { if (p) prefs = p; }).catch(() => {});
  ipcRenderer.on("plex:prefs", (_e, p) => { prefs = p || {}; });

  // ---- the paintbrush in Plex's top bar: theme and text size ----------------------
  const BRUSH_ID = "ppd-looks-btn", PANEL_ID = "ppd-looks-panel";
  const LOOKS_CSS = `
    #${BRUSH_ID} svg { width: 24px; height: 24px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
    #${PANEL_ID} { position: fixed; z-index: 2147482000; width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 90px); overflow-y: auto;
      background: var(--color-background-modal, #1c1c1c); border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
      box-shadow: 0 14px 40px rgba(0,0,0,.6); padding: 16px 18px 18px; font-family: inherit; color: #fff; }
    #${PANEL_ID} h3 { margin: 14px 0 10px; font-size: 14px; font-weight: 600; }
    #${PANEL_ID} h3:first-child { margin-top: 0; }
    #${PANEL_ID} .g { display: grid; grid-template-columns: repeat(auto-fill, minmax(116px, 1fr)); gap: 12px; }
    #${PANEL_ID} button { background: none; border: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; text-align: left; }
    #${PANEL_ID} .pv { position: relative; height: 66px; border-radius: 7px; overflow: hidden; outline: 1px solid rgba(255,255,255,.12); transition: transform .12s; }
    #${PANEL_ID} .pv i { position: absolute; left: 0; right: 0; top: 0; height: 12px; }
    #${PANEL_ID} .pv b { position: absolute; left: 8px; bottom: 9px; width: 55%; height: 6px; border-radius: 3px; }
    #${PANEL_ID} .pv u { position: absolute; right: 8px; bottom: 8px; width: 20px; height: 26px; border-radius: 3px; background: rgba(255,255,255,.18); }
    #${PANEL_ID} .t:hover .pv { transform: translateY(-1px); outline-color: rgba(255,255,255,.4); }
    #${PANEL_ID} .t.on .pv { outline: 2px solid #fff; outline-offset: 1px; }
    #${PANEL_ID} .t span { display: block; margin-top: 6px; font-size: 12.5px; color: rgba(255,255,255,.82); }
    #${PANEL_ID} .t.on span { color: #fff; font-weight: 600; }
    #${PANEL_ID} .sz { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
    #${PANEL_ID} .s { border: 1px solid rgba(255,255,255,.16); border-radius: 7px; padding: 10px 0 8px; text-align: center !important; }
    #${PANEL_ID} .s b { display: block; line-height: 1; }
    #${PANEL_ID} .s span { display: block; margin-top: 6px; font-size: 11.5px; color: rgba(255,255,255,.75); }
    #${PANEL_ID} .s:hover { background: rgba(255,255,255,.07); }
    #${PANEL_ID} .s.on { border: 2px solid #fff; }
    #${PANEL_ID} .more { margin-top: 14px; font-size: 13px; color: rgba(255,255,255,.7); text-decoration: underline; }
  `;
  let looks = null;
  const esc2 = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  function renderLooks(p) {
    p.innerHTML = `<h3>Theme</h3><div class="g">${looks.themes.map((t) =>
      `<button class="t ${t.id === looks.theme ? "on" : ""}" data-k="theme" data-id="${t.id}">
        <div class="pv" style="background:${t.page}"><i style="background:${t.title}"></i><b style="background:${t.accent}"></b><u></u></div>
        <span>${esc2(t.label)}</span></button>`).join("")}</div>
      <h3>Text size</h3><div class="sz">${looks.sizes.map((z) =>
      `<button class="s ${Math.abs(z.f - looks.textSize) < 0.001 ? "on" : ""}" data-k="text" data-id="${z.f}">
        <b style="font-size:${Math.round(13 * z.f)}px">Aa</b><span>${z.percent}%</span></button>`).join("")}</div>
      <button class="more" data-k="settings">More in PlexDeck settings…</button>`;
  }
  function placeLooks(p) {
    const b = document.getElementById(BRUSH_ID);
    if (!b) return;
    const r = b.getBoundingClientRect();
    p.style.top = `${Math.round(r.bottom + 8)}px`;
    p.style.right = `${Math.max(12, Math.round(innerWidth - r.right - 40))}px`;
  }
  function closeLooks() { const p = document.getElementById(PANEL_ID); if (p) p.remove(); }
  async function toggleLooks() {
    if (document.getElementById(PANEL_ID)) return closeLooks();
    looks = await ipcRenderer.invoke("plex:looks");
    if (!looks) return;
    const p = document.createElement("div");
    p.id = PANEL_ID;
    renderLooks(p);
    p.addEventListener("click", async (e) => {
      const t = e.target.closest("button[data-k]");
      if (!t) return;
      if (t.dataset.k === "settings") { closeLooks(); ipcRenderer.send("plex:open-settings"); return; }
      looks = await ipcRenderer.invoke("plex:set-look", { kind: t.dataset.k, id: t.dataset.id }) || looks;
      renderLooks(p);
    });
    document.body.appendChild(p);
    placeLooks(p);
  }
  document.addEventListener("mousedown", (e) => {
    const p = document.getElementById(PANEL_ID);
    if (p && !p.contains(e.target) && !e.target.closest("#" + BRUSH_ID)) closeLooks();
  }, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLooks(); }, true);
  addEventListener("resize", () => { const p = document.getElementById(PANEL_ID); if (p) placeLooks(p); });
  // Put the button in Plex's top bar, left of the Activity / cast icons, styled like them.
  setInterval(() => {
    if (document.getElementById(BRUSH_ID)) return;
    const ref = document.querySelector('button[aria-label="Activity"]') || document.querySelector('button[aria-label="Select Player"]');
    if (!ref || !ref.parentElement) return;
    if (!document.getElementById("ppd-looks-css")) {
      const st = document.createElement("style"); st.id = "ppd-looks-css"; st.textContent = LOOKS_CSS; document.head.appendChild(st);
    }
    const like = document.querySelector('button[aria-label="Select Player"]') || ref;
    const b = document.createElement("button");
    b.id = BRUSH_ID;
    b.type = "button";
    b.className = like.className;
    b.setAttribute("aria-label", "Theme & text size");
    b.title = "Theme & text size";
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="M18.4 2.6a2 2 0 012.9 2.9L13 13.8l-2.8-2.8z"/><path d="M10.2 11a3.4 3.4 0 00-4.8 0C4 12.4 4.8 14.3 3 16.4c2.9.9 6.3 1 7.9-.6a3.4 3.4 0 00-.7-4.8z"/></svg>';
    b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); toggleLooks(); });
    // Into the row of top-bar icons, just before the icon (group) we found.
    let slot = ref;
    while (slot.parentElement && slot.parentElement.children.length < 3) slot = slot.parentElement;
    if (slot.parentElement) slot.parentElement.insertBefore(b, slot);
  }, 1000);

  // ---- loading screen: tell the app once Plex shows its menu or posters --------
  const readyTimer = setInterval(() => {
    if (document.querySelector('[class*="SourceSidebarLink"], [class*="MetadataPosterCard"], [class*="VirtualHubScroller"], input[type="password"], input[name="email"]')) {
      clearInterval(readyTimer);
      ipcRenderer.send("plex:ready");
    }
  }, 250);

  // ---- TV mode hands over playback ---------------------------------------------
  // TV mode opened an item here and wants it played: press Play / Resume, and
  // answer Plex's "Resume Playback" question.
  const inPlayerNow = () => {
    const app = document.getElementById("plex");
    return !!(app && app.classList.contains("show-video-player"));
  };
  ipcRenderer.on("plex:autoplay", (_e, { resume } = {}) => {
    const started = Date.now();
    let pressedPlay = false;
    const timer = setInterval(() => {
      if (Date.now() - started > 20000) return clearInterval(timer);
      const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
      const label = (b) => (b.getAttribute("aria-label") || b.textContent || "").trim();
      // "Resume Playback" box: resume, or start over.
      const choice = buttons.find((b) => (resume ? /^resume from/i : /^(start from the beginning|play from (the )?start)/i).test(label(b)));
      if (choice) { realClick(choice); clearInterval(timer); return; }
      if (inPlayerNow() && document.querySelector("video")) { clearInterval(timer); return; }
      if (!pressedPlay && /details|provider/.test(location.hash)) {
        const play = buttons.find((b) => /^(resume|play|watch|watch live|watch now|tune in)$/i.test(label(b)));
        if (play) { pressedPlay = true; realClick(play); }
      }
    }, 300);
  });
  // ---- PC mode: your server's videos go to the native player (mpv) -------------------
  // When Plex's player starts, we ask your server which item and where (its list of
  // what's playing), close Plex's player and continue in mpv at the same spot.
  // Live TV and Plex's online catalogue stay in Plex's player.
  let handing = false, skipOnce = false, handedOver = false;
  ipcRenderer.on("plex:native-failed", () => { skipOnce = true; });   // mpv couldn't: let Plex play it
  async function serverToken() {
    try {
      const users = JSON.parse(localStorage.getItem("users") || "{}").users || [];
      return users[0] && users[0].authToken;
    } catch { return null; }
  }
  async function handOver() {
    if (handing || !inPlayerNow() || /\/provider\//.test(location.hash)) return;
    if (!(await ipcRenderer.invoke("native:pc-enabled").catch(() => false))) return;
    if (skipOnce) { skipOnce = false; return; }
    handing = true;
    const v = document.querySelector("video");
    if (v) v.muted = true;   // no sound blip while we switch
    try {
      const clientId = localStorage.getItem("clientID");
      const m = /\/server\/([0-9a-f]+)/.exec(location.hash) || [];
      let found = null;
      for (let i = 0; i < 12 && !found; i++) {
        await new Promise((r) => setTimeout(r, 500));
        found = await ipcRenderer.invoke("plex:my-session", { clientId, machineId: m[1] || null }).catch(() => null);
      }
      if (!found) { if (v) v.muted = false; return; }
      const at = (v && v.currentTime > 1 ? v.currentTime : found.offset / 1000) || 0;
      if (v) v.pause();
      handedOver = true;   // once per playback
      ipcRenderer.send("native:play-from-pc", { key: found.key, at });
      // Close Plex's player: show its controls, press Close; again until it's gone.
      for (let i = 0; i < 10 && inPlayerNow(); i++) {
        wakeControls();
        await new Promise((r) => setTimeout(r, 400));
        const close = [...document.querySelectorAll('button[aria-label="Close Player"]')].find(visible);
        if (close) realClick(close);
        await new Promise((r) => setTimeout(r, 600));
      }
    } finally {
      setTimeout(() => { handing = false; }, 3000);
    }
  }
  setInterval(() => {
    if (!inPlayerNow()) { handedOver = false; return; }
    if (document.querySelector("video") && !handing && !handedOver) handOver();
  }, 700);

  // Tell the app when the video player closes (TV mode then comes back).
  let hadPlayer = false, goneSince = 0;
  setInterval(() => {
    if (inPlayerNow()) { hadPlayer = true; goneSince = 0; return; }
    if (!hadPlayer) return;
    if (!goneSince) goneSince = Date.now();
    if (Date.now() - goneSince > 1200) { hadPlayer = false; goneSince = 0; ipcRenderer.send("plex:player-closed"); }
  }, 400);

  // ---- mouse back / forward side buttons ----------------------------------
  window.addEventListener("mouseup", (e) => {
    if (e.button === 3 || e.button === 4) {
      e.preventDefault();
      ipcRenderer.send("plex:nav", e.button === 3 ? -1 : 1);
    }
  }, true);

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };

  // ---- theme accent for Plex's older styles ---------------------------------
  // Newer parts of Plex use colour variables (main.js overrides those); older
  // ones hard-code Plex orange. Copy each such rule with the orange swapped for
  // the theme's accent (--ppd-accent, which is Plex orange in the Plex theme).
  // Older parts of Plex (the Edit window, ⋯ menus, settings…) hard-code their
  // own greys and golds instead. Golds become the theme's accent; greys used
  // for backgrounds and borders are mixed toward the theme's background tone
  // (--ppd-surface / --ppd-surface-amt; 0% in the Plex theme = unchanged).
  const COLOUR = /#[0-9a-f]{6}\b|#[0-9a-f]{3}\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+%?\s*)?\)/gi;
  function parse(c) {
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (m) { let h = m[1]; if (h.length === 3) h = h.split("").map((x) => x + x).join(""); return { rgb: [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)), a: null }; }
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+%?)\s*)?\)$/i.exec(c);
    return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] ?? null } : null;
  }
  // What a colour should become, or null to leave it alone.
  function themed(c, prop) {
    const x = parse(c);
    if (!x) return null;
    const [r, g, b] = x.rgb;
    const alpha = x.a != null ? ` / ${x.a}` : "";
    const lum = (r + g + b) / 3, spread = Math.max(r, g, b) - Math.min(r, g, b);
    // Plex orange and its golds (Save buttons, selected tabs, hover shades).
    const gold = r > 170 && g > 95 && g < 215 && b < 70 && r - b > 140;
    if (gold) {
      const shade = lum < 125 ? " 82%, black" : lum > 160 ? " 88%, white" : " 100%, transparent";
      // --ppd-keep is 100% in the Plex theme: the original shade, exactly.
      return `rgb(from color-mix(in srgb, rgb(${r} ${g} ${b}) var(--ppd-keep, 100%), color-mix(in srgb, var(--ppd-accent, #e5a00d)${shade})) r g b${alpha})`;
    }
    // Dark greys as backgrounds / borders (text colours stay as they are).
    if (!/^(background|border|outline|box-shadow)/.test(prop)) return null;
    if (spread < 16 && lum >= 10 && lum <= 100) {
      return `rgb(from color-mix(in srgb, rgb(${r} ${g} ${b}), var(--ppd-surface, #000) var(--ppd-surface-amt, 0%)) r g b${alpha})`;
    }
    return null;
  }
  const done = new WeakSet();
  // Rewrite Plex's own rules in place: their order and priority stay exactly as
  // Plex has them (a copied rule would win over Plex's later overrides).
  function recolourSheets() {
    const walk = (rules) => {
      for (const r of rules) {
        if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }   // @media etc.
        if (!r.style) continue;
        for (const prop of [...r.style]) {
          if (prop.startsWith("--")) continue;   // Plex's theme variables are handled in main.js
          const v = r.style.getPropertyValue(prop);
          if (v.includes("--ppd-")) continue;    // done already
          let changed = false;
          const nv = v.replace(COLOUR, (m) => { const t = themed(m, prop); if (t) { changed = true; return t; } return m; });
          if (changed) r.style.setProperty(prop, nv, r.style.getPropertyPriority(prop));
        }
      }
    };
    for (const sh of document.styleSheets) {
      if (done.has(sh)) continue;
      let rules;
      try { rules = sh.cssRules; } catch { continue; }   // another site's stylesheet
      done.add(sh);
      walk(rules);
    }
  }
  setInterval(() => {
    const posters = document.querySelectorAll(".edit-metadata-modal .media-poster-image");
    if (!posters.length) return;
    // One tile shape per grid (the most common one), every picture fitted inside it.
    const shapes = new Map();
    posters.forEach((i) => { if (i.naturalWidth) { const k = (i.naturalWidth / i.naturalHeight).toFixed(2); shapes.set(k, (shapes.get(k) || 0) + 1); } });
    const ratio = Number([...shapes].sort((a, b) => b[1] - a[1])[0]?.[0] || 0);
    if (!ratio) return;
    // Same width for every tile (Plex's usual tile width), height from the shape.
    const w = 150, h = Math.round(w / ratio);
    posters.forEach((i) => {
      const box = i.parentElement;
      if (box.dataset.ppdH === String(h)) return;
      box.dataset.ppdH = String(h);
      box.style.setProperty("width", `${w}px`, "important");
      box.style.setProperty("height", `${h}px`, "important");
      i.style.setProperty("width", "100%", "important");
      i.style.setProperty("height", "100%", "important");
      i.style.setProperty("object-fit", "contain", "important");
    });
  }, 500);
  let recolourTimer = null;
  const scheduleRecolour = () => { clearTimeout(recolourTimer); recolourTimer = setTimeout(recolourSheets, 300); };
  window.addEventListener("DOMContentLoaded", () => {
    scheduleRecolour();
    // Plex loads more styles as you browse; a <link> is only readable once loaded.
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (n.nodeName === "LINK") n.addEventListener("load", scheduleRecolour, { once: true });
        if (n.nodeName === "STYLE") scheduleRecolour();
      }
    }).observe(document.head, { childList: true });
    window.addEventListener("load", scheduleRecolour);
  });

  // ---- search: a magnifier icon that opens into the search field -----------
  // Click it (or Ctrl+F) to open; it closes again when you click away with it empty.
  // Marked with a data attribute: Plex's re-renders would wipe an added class.
  const SEARCH = '[class*="UniversalSearch-searchInputContainer"]';
  const SEARCH_CSS = `
    [data-ppd-search] > div:first-child { transition: width .2s ease, background-color .2s ease; }
    [data-ppd-search="closed"] > div:first-child {
      width: 36px !important; min-width: 36px !important; height: 36px !important; padding: 0 !important;
      border-radius: 50% !important; justify-content: center !important; cursor: pointer;
      background-color: transparent !important; }
    [data-ppd-search="closed"] > div:first-child:hover { background-color: rgba(255,255,255,.1) !important; }
    [data-ppd-search="closed"] > div:first-child > span {
      margin: 0 !important; padding: 0 !important; width: 36px !important; display: flex !important; justify-content: center; }
    [data-ppd-search="closed"] > div:first-child > span svg { width: 20px !important; height: 20px !important; }
    [data-ppd-search="closed"] input, [data-ppd-search="closed"] > div:first-child > button {
      opacity: 0 !important; width: 0 !important; min-width: 0 !important; padding: 0 !important; pointer-events: none; }
    [data-ppd-search="open"] > div:first-child:focus-within { box-shadow: 0 0 0 1px var(--ppd-accent, #e5a00d); }
  `;
  const searchBox = () => document.querySelector(SEARCH);
  const searchInput = () => { const b = searchBox(); return b && b.querySelector("input"); };
  function openSearch() {
    const box = searchBox(), input = searchInput();
    if (!box || !input) return;
    box.dataset.ppdSearch = "open";
    input.focus();
    input.select();
  }
  function ensureSearch() {
    const box = searchBox(), input = searchInput();
    if (!box || !input || box.dataset.ppdSearch) return;
    if (!document.getElementById("ppd-search-css")) {
      const st = document.createElement("style");
      st.id = "ppd-search-css";
      st.textContent = SEARCH_CSS;
      document.head.appendChild(st);
    }
    box.dataset.ppdSearch = input.value || document.activeElement === input ? "open" : "closed";
    box.addEventListener("mousedown", (e) => {
      if (box.dataset.ppdSearch === "open") return;
      e.preventDefault();
      openSearch();
    });
    input.addEventListener("focus", () => { box.dataset.ppdSearch = "open"; });
    input.addEventListener("blur", () => setTimeout(() => {
      if (document.activeElement !== input && !input.value) box.dataset.ppdSearch = "closed";
    }, 250));
  }
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f" && searchBox()) {
      e.preventDefault();
      openSearch();
    }
  }, true);
  let searchTimer = null;
  window.addEventListener("DOMContentLoaded", () => {
    new MutationObserver(() => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(ensureSearch, 150);
    }).observe(document.body, { childList: true, subtree: true });
    ensureSearch();
  });

  // ---- auto-skip intros / credits after a delay ---------------------------
  // Plex shows a "Skip Intro" / "Skip Credits" button; we press it once it has
  // been on screen for the chosen number of seconds.
  const seenAt = new WeakMap();
  setInterval(() => {
    if (!prefs.autoSkipIntro && !prefs.autoSkipCredits) return;
    for (const btn of document.querySelectorAll("button")) {
      const m = /^\s*skip\s+(intro|credits)\s*$/i.exec(btn.textContent || "");
      if (!m || !visible(btn)) { seenAt.delete(btn); continue; }
      const intro = m[1].toLowerCase() === "intro";
      if (!(intro ? prefs.autoSkipIntro : prefs.autoSkipCredits)) continue;
      const delay = Math.max(0, Number(intro ? prefs.skipIntroDelay : prefs.skipCreditsDelay) || 0) * 1000;
      if (!seenAt.has(btn)) seenAt.set(btn, Date.now());
      if (Date.now() - seenAt.get(btn) >= delay && !btn.dataset.ppdSkipped) {
        btn.dataset.ppdSkipped = "1";
        realClick(btn);
      }
    }
  }, 400);

  // ---- 10-foot navigation: arrow keys and game controllers ----------------
  // Outside the player, arrows/D-pad move an orange focus ring to the nearest
  // item in that direction. In the player they're Plex's own shortcuts
  // (seek / volume), so they're passed through.
  const FOCUSABLE = 'a[href], button, [role="button"], [role="link"], [role="menuitem"], [tabindex]:not([tabindex="-1"]), input, select, textarea';
  let ringEl = null;

  // The full-size video player is on screen: a big <video>, Plex's player box
  // filling the window, or anything in full screen.
  const big = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height > innerWidth * innerHeight * 0.5; };
  function playerActive() {
    // A dialog on top (e.g. "Resume Playback" while the player loads) comes first.
    if (openDialog()) return false;
    if (document.fullscreenElement) return true;
    for (const v of document.querySelectorAll("video")) if (big(v) && visible(v)) return true;
    for (const el of document.querySelectorAll('[class*="FullPlayer"], [class*="fullPlayer"], [class*="VideoPlayer"], [class*="PlayerContainer"]')) {
      if (big(el) && visible(el)) return true;
    }
    return false;
  }
  // ---- the player, TV style -----------------------------------------------
  // Watching: the controls are hidden and the buttons do the TV-app things
  // (A play/pause, ←/→ skip, B close). Up/Down shows the controls and the ring
  // moves between their buttons; they stay up while you use them.
  const PLAYER = '[class*="PlayerContainer-container"]';
  const playerRoot = () => document.querySelector(PLAYER);
  let playerControls = false;     // the controls are up and the ring is in them
  let lastPlayerInput = 0;
  const playerButton = (re) => { const root = playerRoot(); return root && [...root.querySelectorAll("button[aria-label]")].find((b) => re.test(b.getAttribute("aria-label"))); };
  // Plex shows its controls when the mouse moves over the player: pretend it did.
  function wakeControls() {
    const root = document.querySelector('[class*="Player-fullPlayerContainer"]') || playerRoot();
    if (!root) return;
    const r = root.getBoundingClientRect();
    const opts = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    root.dispatchEvent(new MouseEvent("mousemove", opts));
    root.dispatchEvent(new MouseEvent("mouseover", opts));
  }
  function showPlayerControls() {
    playerControls = true;
    lastPlayerInput = Date.now();
    wakeControls();
    setTimeout(() => { const pp = playerButton(/^(pause|play)$/i); if (pp) setRing(pp, { scroll: false }); }, 300);
  }
  function hidePlayerControls() { playerControls = false; ringEl = null; }
  setInterval(() => {
    if (!playerControls) return;
    if (!playerActive() || Date.now() - lastPlayerInput > 6000) { hidePlayerControls(); return; }
    wakeControls();
  }, 900);
  const visibleSkip = () => [...document.querySelectorAll("button")].find((b) => /^\s*skip\s+(intro|credits|ad)s?\s*$/i.test(b.textContent || "") && visible(b));
  function playerPress(name) {
    lastPlayerInput = Date.now();
    if (playerControls) {
      wakeControls();
      switch (name) {
        case "Up": case "Left": case "Right": move(name); break;
        case "Down": { const before = ringEl; move("Down"); if (ringEl === before) hidePlayerControls(); break; }
        case "A": activate(); break;
        case "B": hidePlayerControls(); break;
        case "Start": { const b = playerButton(/^settings$/i); if (b) realClick(b); break; }
      }
      return;
    }
    const click = (re) => {
      const b = playerButton(re);
      if (!b) return;
      wakeControls();
      setTimeout(() => realClick(b), 350);   // once the control bar has slid in
    };
    switch (name) {
      case "A": { const skip = visibleSkip(); if (skip) realClick(skip); else click(/^(pause|play)$/i); break; }
      case "Left": case "L2": click(/^skip back/i); break;
      case "Right": case "R2": click(/^skip forward/i); break;
      case "Up": case "Down": showPlayerControls(); break;
      case "B": closePlayer(); break;
      case "L1": click(/^previous$/i); break;
      case "R1": click(/^next$/i); break;
      case "Y": showPlayerControls(); break;
      case "Start": { showPlayerControls(); click(/^settings$/i); break; }
    }
  }

  // Plex's own dropdown menus handle arrows themselves.
  const openPopup = () => [...document.querySelectorAll('[role="menu"], [role="listbox"]')].some(visible);
  // While a dialog is open, navigation stays inside it (the last one = on top).
  const openDialog = () => [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="Modal-modal"], [class*="ModalContent"]')]
    .filter((d) => visible(d) && d.querySelector(FOCUSABLE)).pop() || null;
  const editable = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  // ---- the ring (TV-style focus) ---------------------------------------------
  // It's our own overlay that follows the item (Plex re-renders its elements and
  // would wipe a class we added). Plex also swaps elements for new copies all the
  // time, so we remember *which* item the ring is on (its link / label and where
  // it was) and find it again, instead of losing it and jumping back to the start.
  let navMode = false;            // the controller / arrow keys are in use
  let ringBox = null;
  let lastSig = null, lastRect = null;
  const pageMemory = new Map();   // page → the item the ring was on there (for Back)
  // The whole address: libraries differ only by their ?source=… number.
  const pageKey = () => location.hash || location.pathname;
  let lastPage = pageKey();

  const labelOf = (el) => (el.getAttribute("aria-label") || el.textContent || "").trim();
  const sigOf = (el) => el.getAttribute("href") || labelOf(el).slice(0, 80);
  const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
  function nearest(list, rect) {
    if (!rect) return list[0] || null;
    const [x, y] = centre(rect);
    let best = null, bestD = Infinity;
    for (const el of list) {
      const [ex, ey] = centre(el.getBoundingClientRect());
      const d = (ex - x) ** 2 + (ey - y) ** 2;
      if (d < bestD) { bestD = d; best = el; }
    }
    return best;
  }
  const findBySig = (all, sig, rect) => nearest(all.filter((el) => sigOf(el) === sig), rect);

  // Mouse moved / clicked: back to mouse mode (ring and TV cursor-hiding off).
  function setNavMode(on) {
    if (navMode === on) return;
    navMode = on;
    document.documentElement.classList.toggle("ppd-tv", on);
    if (on) foldMenuForTv(); else restoreMenuForMouse();
    if (!on && ringBox) ringBox.style.display = "none";
    if (on) startDrawing();
  }
  let mouseStart = null;
  window.addEventListener("mousemove", (e) => {
    if (!navMode || !e.isTrusted || Date.now() < ignoreMouseUntil) return;
    if (!mouseStart) { mouseStart = [e.screenX, e.screenY]; return; }
    if (Math.abs(e.screenX - mouseStart[0]) + Math.abs(e.screenY - mouseStart[1]) > 12) { mouseStart = null; setNavMode(false); }
  }, true);
  window.addEventListener("mousedown", () => { if (Date.now() >= ignoreMouseUntil) setNavMode(false); }, true);

  let drawing = false;
  // Whether a video is playing, checked a few times a second (not every frame).
  let watchingCache = false;
  setInterval(() => { watchingCache = playerActive(); }, 250);
  function drawRing() {
    if (!navMode) { drawing = false; return; }
    drawing = true;
    if (!ringBox || !ringBox.isConnected) {
      ringBox = document.createElement("div");
      ringBox.className = "ppd-focus";
      ringBox.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;display:none;";
      document.documentElement.appendChild(ringBox);
    }
    const el = ringEl && ringEl.isConnected ? ringEl : null;
    // Hidden while a video plays; it comes back on the same item afterwards.
    if (!el || (watchingCache && !playerControls)) ringBox.style.display = "none";
    else {
      const r = el.getBoundingClientRect();
      lastRect = r;
      Object.assign(ringBox.style, {
        display: "block", left: `${r.left - 4}px`, top: `${r.top - 4}px`,
        width: `${r.width + 8}px`, height: `${r.height + 8}px`,
      });
    }
    requestAnimationFrame(drawRing);
  }
  const startDrawing = () => { if (!drawing) requestAnimationFrame(drawRing); };

  function setRing(el, { scroll = true, dir = null } = {}) {
    ringEl = el;
    if (!el) return;
    lastSig = sigOf(el);
    lastRect = el.getBoundingClientRect();
    if (!inSidebar(el)) pageMemory.set(pageKey(), { sig: lastSig, rect: lastRect });   // menu spots aren't page spots
    const hub = hubOf(el);
    if (hub) rowMemory.set(hubKey(hub), lastSig);
    el.focus({ preventScroll: true });
    // Up/down keeps the row you're on in the middle of the screen, like the TV apps.
    if (scroll) el.scrollIntoView({ block: dir === "Up" || dir === "Down" ? "center" : "nearest", inline: "nearest", behavior: "smooth" });
    startDrawing();
  }

  // Is the element really showable? Not see-through (Plex hides the hover buttons
  // on posters with opacity 0) and not cut off by a box that hides its overflow.
  function shown(el) {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let opacity = 1;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      opacity *= Number(cs.opacity);
      if (opacity < 0.05) return false;
      const clipX = /hidden|clip/.test(cs.overflowX), clipY = /hidden|clip/.test(cs.overflowY);
      if (clipX || clipY) {
        const pr = p.getBoundingClientRect();
        if (clipX && (cx < pr.left || cx > pr.right)) return false;
        if (clipY && (cy < pr.top || cy > pr.bottom)) return false;
      }
    }
    return true;
  }
  // Inside the visible part of every scrolling box around it (rows scroll sideways).
  function inView(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cx > innerWidth) return false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.scrollWidth <= p.clientWidth + 1) continue;
      if (!/auto|scroll/.test(getComputedStyle(p).overflowX)) continue;
      const pr = p.getBoundingClientRect();
      if (cx < pr.left || cx > pr.right) return false;
    }
    return true;
  }

  const ACTIONS_LABEL = /^(actions|more|more actions|more options)$/i;
  // The ⋮ / ⋯ menu of the item the ring is on (it sits in the same card or row).
  function openActions() {
    let p = ringEl && ringEl.isConnected ? ringEl : null;
    for (let k = 0; p && k < 5; k++, p = p.parentElement) {
      const btn = [...p.querySelectorAll("button[aria-label]")].find((b) => ACTIONS_LABEL.test(b.getAttribute("aria-label")));
      if (btn) { btn.click(); return; }
    }
  }

  function candidates() {
    const raw = [];
    const dialog = openDialog();
    const inPlayerUi = playerControls && playerActive() && playerRoot();
    const onlyMenu = menuMode && !dialog && !inPlayerUi;
    const scope = dialog || (inPlayerUi ? playerRoot() : document);
    const margin = innerHeight * 1.5;   // rows further away than this can't be the next stop
    for (const el of scope.querySelectorAll(FOCUSABLE)) {
      if (onlyMenu && !inSidebar(el)) continue;
      // Row titles ("Recently Added in …") aren't stops on the TV app either.
      if (el.closest('[class*="VirtualHubScroller-hubHeader"]')) continue;
      const q = el.getBoundingClientRect();
      if (q.bottom < -margin || q.top > innerHeight + margin || q.width === 0) continue;
      if (el.disabled || el.closest("[aria-hidden='true']")) continue;
      if (el.closest("[data-ppd-search='closed']") && el.tagName !== "INPUT") continue;
      // Plex's ⋮ / ⋯ buttons only show on hover; Triangle/Y opens them instead (see openActions).
      if (!dialog && !inPlayerUi && ACTIONS_LABEL.test(el.getAttribute("aria-label") || "")) continue;
      // In the player only what's actually on screen (the hidden bars slide off it).
      if (inPlayerUi) { const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight) continue; }
      if (shown(el)) raw.push({ el, r: el.getBoundingClientRect() });
    }
    // A poster and the title link just under it are one stop: drop the small title
    // when a bigger item of the same width sits right above it.
    // Two items stacked in the same spot are one stop too (keep the first).
    const same = (a, b) => Math.abs(a.left - b.left) < 4 && Math.abs(a.top - b.top) < 4
      && Math.abs(a.width - b.width) < 4 && Math.abs(a.height - b.height) < 4;
    const unique = raw.filter((c, i) => !raw.slice(0, i).some((o) => same(o.r, c.r)));
    // Text lines under a poster (title, episode name, "S3 · E15") are part of that
    // poster, like on the TV app: no separate stops.
    return unique.filter(({ r }) => !(r.height < 48 && raw.some((o) => o.r.height > 90
      && r.left >= o.r.left - 6 && r.left < o.r.right - 4
      && r.top - o.r.bottom > -4 && r.top - o.r.bottom < 130))).map((c) => c.el);
  }

  // Keep the ring on its item while Plex re-renders, and place it when a new page
  // opens (Play/Resume on a show, or back where you were).
  let landingTries = 0;
  setInterval(() => {
    if (!navMode || overlayOpen) return;
    const dlg = openDialog();
    if (dlg && !(ringEl && dlg.contains(ringEl))) {
      // Land on the first real option, not the dialog's ✕.
      const items = candidates();
      const first = items.find((el) => !/close/i.test(`${el.getAttribute("aria-label") || ""} ${el.className}`)) || items[0];
      if (first) setRing(first, { scroll: false });
      return;
    }
    if (playerActive()) return;
    if (pageKey() !== lastPage) {
      lastPage = pageKey();
      if (menuMode) {
        // A library loaded live behind the menu: keep the ring on its menu entry.
        const items = sidebarItems();
        const el = (lastSig && findBySig(items, lastSig, lastRect)) || currentMenuItem(items);
        if (el) setRing(el, { scroll: false });
        return;
      }
      ringEl = null; landingTries = 15;
    }
    if (menuMode) {
      if (!(ringEl && ringEl.isConnected && inSidebar(ringEl))) {
        const items = sidebarItems();
        const el = (lastSig && findBySig(items, lastSig, lastRect)) || currentMenuItem(items);
        if (el) setRing(el, { scroll: false });
      }
      return;
    }
    if (ringEl && ringEl.isConnected && shown(ringEl)) return;
    const all = candidates();
    if (!all.length) return;
    if (landingTries > 0) {
      // The new page is still loading: wait until it has something to land on.
      landingTries--;
      const el = landingItem(all);
      // Wait for the posters (up to ~3 s) rather than settling on the page title.
      const settled = el && (pageMemory.has(pageKey()) || el.getBoundingClientRect().height > 90 || landingTries < 1);
      if (settled) { landingTries = 0; setRing(el, { scroll: true }); }
      return;
    }
    const el = currentItem(all);
    if (el) setRing(el, { scroll: false });
  }, 200);

  // Overlap of two ranges (0 = touching / apart).
  const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

  // ---- the side menu, TV style (like Plex on the Shield / Fire TV) ---------
  // With the controller the menu is Plex's thin icon rail. Left past the first
  // item of a row opens it (with names) and the ring moves into it; Up/Down stay
  // in the menu; Cross/A opens that library, Right or Circle/B go back to where
  // you were. Plex's own ☰ button switches the menu between full and icon rail.
  const SIDEBAR = '[class*="SourceSidebar"]';
  const inSidebar = (el) => !!(el && el.closest && el.closest(SIDEBAR));
  const menuToggle = () => document.querySelector('button[aria-label="Collapse"], button[aria-label="Expand"]');
  const sidebarOpen = () => { const t = menuToggle(); return !!t && t.getAttribute("aria-label") === "Collapse"; };
  let menuMode = false;          // the ring is in the side menu
  let startedInMenu = false;     // the first press after the app starts goes to the menu
  let userHadMenuOpen = null;    // how the menu was before controller mode folded it
  let contentMemory = null;      // where the ring was in the page before entering the menu
  function setSidebar(open) {
    const t = menuToggle();
    if (t && sidebarOpen() !== open) t.click();
  }
  function foldMenuForTv() {
    if (userHadMenuOpen === null) userHadMenuOpen = sidebarOpen();
    if (!menuMode) setSidebar(false);
  }
  function restoreMenuForMouse() {
    menuMode = false;
    if (userHadMenuOpen !== null) setSidebar(userHadMenuOpen);
    userHadMenuOpen = null;
  }
  const sidebarItems = () => candidates().filter(inSidebar);
  // The menu entry for the page you're on (else the first one).
  function currentMenuItem(items) {
    const here = location.hash;
    const source = (here.match(/[?&]source=([^&]+)/) || [])[1];
    const isHome = /^#?!?\/?$/.test(here);
    return items.find((el) => el.getAttribute("aria-current") === "page")
      || items.find((el) => el.getAttribute("href") === here)
      || (source && items.find((el) => (el.getAttribute("href") || "").match(new RegExp(`[?&]source=${source}(&|$)`))))
      || (isHome && items.find((el) => el.getAttribute("href") === "#"))
      || items.find((el) => /selected|active/i.test(String(el.className)))
      || items[0];
  }
  // Open a menu entry by its link (no click: once the menu folds, a click at that
  // spot would hit whatever slid in under it).
  function openMenuEntry(el) {
    const href = el && el.getAttribute("href");
    if (href && href.startsWith("#")) { if (location.hash !== href) location.hash = href; return true; }
    if (href) { el.click(); return true; }
    return false;
  }
  // Moving through the menu loads each library behind it, like the TV apps
  // (after a short pause, so quickly passing an entry doesn't load it).
  let liveTimer = null;
  function liveOpen(el) {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (menuMode && ringEl === el) openMenuEntry(el); }, 350);
  }
  let menuStartedOn = null;      // the page shown when the menu opened

  function enterMenu(fromEl) {
    contentMemory = fromEl ? { sig: sigOf(fromEl), rect: fromEl.getBoundingClientRect() } : null;
    menuStartedOn = pageKey();
    menuMode = true;
    setSidebar(true);
    const items = sidebarItems();
    if (items.length) setRing(currentMenuItem(items), { dir: "Left", scroll: false });
  }
  function leaveMenu(toContent = true) {
    clearTimeout(liveTimer);
    menuMode = false;
    setSidebar(false);
    if (!toContent) return;
    // Same page as before: back where you were. A new library: its first poster.
    const all = candidates().filter((el) => !inSidebar(el));
    const samePage = pageKey() === menuStartedOn;
    const el = (samePage && contentMemory && findBySig(all, contentMemory.sig, contentMemory.rect)) || landingItem(all);
    if (el) setRing(el, { dir: "Right", scroll: false });
    else landingTries = 15;   // still loading: the watchdog places the ring when it's there
  }

  // ---- rows, TV style ---------------------------------------------------------
  // Plex's rows ("Continue Watching", "Recently Added…") are hubs. Like the TV
  // app, each row remembers where you were in it; going down/up lands there (or
  // on its first poster the first time).
  const HUB = '[class*="VirtualHubScroller-hub-"]';
  const hubOf = (el) => (el && el.closest ? el.closest(HUB) : null);
  function hubKey(hub) {
    const title = hub.querySelector("h1, h2, h3, h4, [class*='Title'], a");
    return pageKey() + "|" + (title ? title.textContent.trim().slice(0, 60) : [...document.querySelectorAll(HUB)].indexOf(hub));
  }
  const rowMemory = new Map();   // page|row title → the item the ring was on
  function rowLanding(hub, all) {
    const inRow = all.filter((el) => hubOf(el) === hub);
    const mem = rowMemory.get(hubKey(hub));
    const remembered = mem && inRow.find((el) => sigOf(el) === mem);
    if (remembered) return remembered;
    const visibleNow = inRow.filter(inView);
    visibleNow.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return visibleNow[0] || inRow[0] || null;
  }
  // The page's scrolling box (what moves the rows up and down).
  function pageScroller(from) {
    for (let p = from && from.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
    }
    return document.scrollingElement;
  }
  const firstHub = () => document.querySelector(HUB);
  const atTopRow = (cur) => { const h = hubOf(cur); return !h || (h === firstHub() && pageScroller(cur).scrollTop < 40); };
  // Back, step 1: jump to the top row (where you were in it).
  function backToTopRow(cur) {
    const sc = pageScroller(cur);
    sc.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => {
      const hub = firstHub();
      const el = hub && rowLanding(hub, candidates().filter((x) => !inSidebar(x)));
      if (el) setRing(el, { scroll: false });
    }, 450);
  }

  // The first poster/card on screen (like Plex's TV apps), else any item.
  function firstItem(all) {
    let list = all.filter((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.height > 90 && inView(el); });
    if (!list.length) list = all.filter((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight && inView(el); });
    list.sort((p, q) => { const a = p.getBoundingClientRect(), b = q.getBoundingClientRect(); return (a.top - b.top) || (a.left - b.left); });
    return list[0] || all[0] || null;
  }
  // Where the ring goes on arriving at a page: back where you were (after Back),
  // else Play / Resume on a show or movie page, else the first poster.
  const PRIMARY = /^(resume|play|play next|continue|watch now|start)\b/i;
  function landingItem(all) {
    const mem = pageMemory.get(pageKey());
    if (mem) { const el = findBySig(all, mem.sig, mem.rect); if (el) return el; }
    if (/details|metadata/i.test(pageKey())) {
      const play = all.find((el) => PRIMARY.test(labelOf(el)) && inView(el));
      if (play) return play;
    }
    return firstItem(all);
  }
  // The item the ring is on: the same element, or Plex's fresh copy of it, or
  // whatever now sits where it was.
  function currentItem(all) {
    if (ringEl && ringEl.isConnected && all.includes(ringEl)) return ringEl;
    if (pageKey() !== lastPage) return null;
    if (lastSig) { const el = findBySig(all, lastSig, lastRect); if (el) return el; }
    return lastRect ? nearest(all.filter(inView), lastRect) : null;
  }

  function move(dir, retry = false) {
    const all = candidates();
    if (!all.length) return;
    const wasHidden = !navMode;
    setNavMode(true);
    if (!startedInMenu && !openDialog() && !playerActive() && menuToggle() && !/details|metadata/i.test(pageKey())) {
      startedInMenu = true;
      return enterMenu(null);                        // first press after start: the side menu
    }
    startedInMenu = true;
    let cur = currentItem(all);
    if (pageKey() !== lastPage && !menuMode) { lastPage = pageKey(); cur = null; }
    if (!cur) return setRing(menuMode ? currentMenuItem(sidebarItems()) : landingItem(all), { dir });
    if (wasHidden) return setRing(cur, { dir });      // first press just shows where you are
    if (!playerControls && (menuMode || inSidebar(cur))) {
      if (dir === "Right") return leaveMenu();
      if (dir === "Left") return;
      const items = sidebarItems();
      const i = items.indexOf(cur);
      const next = items[i + (dir === "Down" ? 1 : -1)];
      if (next) { setRing(next, { dir }); liveOpen(next); }
      return;
    }
    const c = cur.getBoundingClientRect();
    const horizontal = dir === "Left" || dir === "Right";
    let best = null, bestScore = Infinity;
    for (const el of all) {
      if (el === cur || el.contains(cur) || cur.contains(el)) continue;
      const r = el.getBoundingClientRect();
      let gap;                                   // distance in the direction of travel
      if (dir === "Left") gap = c.left - r.right;
      else if (dir === "Right") gap = r.left - c.right;
      else if (dir === "Up") gap = c.top - r.bottom;
      else gap = r.top - c.bottom;
      if (gap < -Math.min(c.width, c.height, r.width, r.height) / 2) continue;   // not in that direction
      // Sideways offset: 0 when they line up (same row for ←/→, same column for ↑/↓).
      const shared = horizontal ? overlap(c.top, c.bottom, r.top, r.bottom) : overlap(c.left, c.right, r.left, r.right);
      const offset = shared > 0 ? 0 : horizontal
        ? Math.min(Math.abs(r.top - c.bottom), Math.abs(c.top - r.bottom))
        : Math.min(Math.abs(r.left - c.right), Math.abs(c.left - r.right));
      let score = Math.max(0, gap) + offset * 3;
      // Up/down lands on what you can see, not on a card scrolled out of its row.
      if (!horizontal && !inView(el)) score += 5000;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (dir === "Left" && !playerControls && !openDialog() && (!best || inSidebar(best)) && menuToggle()) return enterMenu(cur);
    if (best && inSidebar(best)) best = null;   // up/down never wander into the menu
    // Changing rows: the TV app goes to where you were in that row (or its start).
    if (best && !horizontal && hubOf(best) && hubOf(best) !== hubOf(cur)) best = rowLanding(hubOf(best), all) || best;
    if (best) return setRing(best, { dir });
    // Nothing that way yet: Plex only builds rows (and cards in a row) as you scroll,
    // so scroll the page (or the row) on and try again once the new ones exist.
    if (!retry && !playerControls && scrollToward(cur, dir)) setTimeout(() => move(dir, true), 350);
  }

  // Scroll the nearest box around `el` that can scroll in that direction.
  function scrollToward(el, dir) {
    const horizontal = dir === "Left" || dir === "Right";
    const sign = dir === "Left" || dir === "Up" ? -1 : 1;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      const canScroll = horizontal
        ? /auto|scroll/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1
        : (/auto|scroll/.test(cs.overflowY) || p === document.scrollingElement) && p.scrollHeight > p.clientHeight + 1;
      if (!canScroll) continue;
      const before = horizontal ? p.scrollLeft : p.scrollTop;
      const step = (horizontal ? p.clientWidth : p.clientHeight) * 0.6 * sign;
      p.scrollBy({ left: horizontal ? step : 0, top: horizontal ? 0 : step });
      if ((horizontal ? p.scrollLeft : p.scrollTop) !== before) return true;
    }
    return false;
  }

  function activate() {
    setNavMode(true);
    const el = currentItem(candidates()) || document.activeElement;
    if (menuMode && inSidebar(el)) {
      clearTimeout(liveTimer);
      const href = el.getAttribute("href");
      const changing = href && href.startsWith("#") && location.hash !== href;
      openMenuEntry(el);
      if (changing) { menuMode = false; setSidebar(false); landingTries = 15; }   // land when it has loaded
      else leaveMenu();
      return;
    }
    if (el && el !== document.body) realClick(el);
  }

  const ARROWS = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
  window.addEventListener("keydown", (e) => {
    if (!prefs.keyboardNav || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!e.isTrusted) return;
    const dir = ARROWS[e.key];
    if (dir) {
      // An empty search field lets the arrows move on; with text they move in its results.
      const emptySearch = e.target === searchInput() && !e.target.value;
      if (playerActive() || openPopup() || (editable(e.target) && !emptySearch)) return;
      e.preventDefault();
      e.stopPropagation();
      move(dir);
    } else if (e.key === "Enter" && navMode && ringEl && ringEl.isConnected && !editable(e.target) && !playerActive()) {
      // Many Plex buttons only react to a real mouse click, not to Enter.
      e.preventDefault();
      e.stopPropagation();
      activate();
    }
  }, true);

  // ---- game controllers (standard mapping: PS4/PS5/Xbox) -------------------
  //  D-pad / left stick: move (or seek / volume in the player)
  //  Cross/A: open · Circle/B: back / close · Options/Start: PlexDeck settings
  //  Share/Back: back · L1/R1: back / forward page · L2/R2: rewind / fast-forward
  const sendKey = (k) => ipcRenderer.send("plex:key", k);
  const held = new Map();   // button → next repeat time
  const REPEAT_FIRST = 380, REPEAT_NEXT = 110;

  function press(name) {
    const inPlayer = playerActive();
    if (inPlayer && openPopup()) {
      // Plex's own menus in the player (settings, subtitles…) take the arrow keys.
      const keys = { Up: "Up", Down: "Down", Left: "Left", Right: "Right", A: "Enter", B: "Escape" };
      if (keys[name]) sendKey(keys[name]);
      return;
    }
    if (inPlayer && !overlayOpen && !openDialog()) { setNavMode(true); return playerPress(name); }
    switch (name) {
      case "Up": case "Down": case "Left": case "Right":
        if (inPlayer || openPopup()) sendKey(name); else move(name);
        break;
      case "A":
        if (inPlayer) sendKey("Space"); else if (openPopup() && !ringEl) sendKey("Enter"); else activate();
        break;
      case "B":
        if (menuMode) {
          // Like the TV app: Back in the menu goes to Home; on Home it stays put.
          const items = sidebarItems();
          const home = items.find((el) => el.getAttribute("href") === "#") || items.find((el) => /^home$/i.test(labelOf(el)));
          if (home && ringEl !== home) { setRing(home, { scroll: false }); openMenuEntry(home); }
          break;
        }
        else if (inPlayer) closePlayer();
        else if (openPopup() || openDialog()) sendKey("Escape");
        // Like the TV apps: on Home / a library / Watchlist… Back opens the side menu;
        // on a show, season or movie page it goes back a page.
        else if (!/details|metadata/i.test(pageKey()) && menuToggle()) {
          // Like the TV app: first back to the top row, then into the menu.
          const cur = currentItem(candidates());
          if (cur && !atTopRow(cur)) backToTopRow(cur);
          else enterMenu(cur);
        }
        else ipcRenderer.send("plex:nav", -1);
        break;
      case "Y":
        if (!inPlayer) openActions();
        break;
      case "Back": case "L1": ipcRenderer.send("plex:nav", -1); break;
      case "R1": ipcRenderer.send("plex:nav", 1); break;
      case "L2": if (inPlayer) sendKey("Left"); break;
      case "R2": if (inPlayer) sendKey("Right"); break;
      case "Start": ipcRenderer.send("plex:open-settings"); break;
    }
  }
  const REPEATS = new Set(["Up", "Down", "Left", "Right", "L2", "R2"]);

  // Leaving the player, like Back on Plex's TV apps: stop playback and return to
  // the page you started from. (Plex Web's own Esc only shrinks the player into
  // the bar at the bottom and keeps playing.)
  const findButton = (re) => [...document.querySelectorAll('button, [role="button"]')].find((b) =>
    re.test(b.getAttribute("aria-label") || b.getAttribute("title") || ""));
  const STOP = /^(close player|stop( playback)?)$/i;
  function closePlayer() {
    hidePlayerControls();
    const stop = findButton(STOP);
    if (stop) { wakeControls(); setTimeout(() => realClick(stop), 350); return; }
    // The full-size player hides its Stop button: shrink it first, then stop from the bar.
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    sendKey("Escape");
    setTimeout(() => { const s2 = findButton(STOP); if (s2) realClick(s2); }, 450);
  }

  // While PlexDeck settings are open on top, the controller belongs to them.
  let overlayOpen = false;
  ipcRenderer.on("plex:overlay", (_e, open) => { overlayOpen = !!open; });

  let polling = false;
  function poll() {
    if (!prefs.controller) { polling = false; return; }
    const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
    if (!pads.length) { polling = false; return; }
    const now = performance.now();
    const down = new Set();
    for (const pad of pads) for (const name of padButtons(pad)) down.add(name);
    if (overlayOpen) { held.clear(); for (const n of down) held.set(n, Infinity); requestAnimationFrame(poll); return; }
    if (down.size && !held.size) ipcRenderer.send("plex:pad-used");
    for (const name of down) {
      if (!held.has(name)) { held.set(name, now + REPEAT_FIRST); press(name); }
      else if (REPEATS.has(name) && now >= held.get(name)) { held.set(name, now + REPEAT_NEXT); press(name); }
    }
    for (const name of [...held.keys()]) if (!down.has(name)) held.delete(name);
    requestAnimationFrame(poll);
  }
  function startPolling() {
    if (polling || !prefs.controller) return;
    polling = true;
    requestAnimationFrame(poll);
  }
  window.addEventListener("gamepadconnected", startPolling);
  // A pad that was already connected shows up after its first button press.
  setInterval(() => {
    if (!polling && prefs.controller && navigator.getGamepads && [...navigator.getGamepads()].some(Boolean)) startPolling();
  }, 1000);
}
