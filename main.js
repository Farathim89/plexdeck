// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// PlexDeck — an unofficial Windows desktop app for Plex.
//
// Runs the official Plex web app (everything Plex has: Home hubs, the Plex
// player, Discover, Watchlist, Live TV, free Movies & TV…) with a dark custom
// title bar and the desktop extras of the older PlexPlayer: auto-skip with a
// delay, text size and font, Windows-contrast-proof colours, arrow-key / game
// controller navigation, remembered window, mouse back/forward buttons.
//
// Layout: the window shows our title bar (titlebar.html). Plex runs in a
// WebContentsView under it; desktop settings open as an overlay view on top.
// ===========================================================================

const {
  app, BrowserWindow, WebContentsView, Menu, Tray, ipcMain, shell, dialog, screen, session, webContents,
  net, Notification,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { DEFAULTS, fromOldConfig } = require("./migrate");
const i18n = require("./i18n");
const tr = i18n.t;
const N_ = (s) => s;   // marks a text that is translated later, where it is shown
const tv = require("./tv-main");
const mpv = require("./mpv-main");

// Settings folder: next to the .exe for the portable build (plexdeck-data), %APPDATA%\PlexDeck when installed.
// Versions before 5.0 were called PlexPlayer: carry their settings over once (the
// sign-in lives in "Local State" / "Local Storage" / "Network", so copy all but caches).
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR;
  const oldDir = path.join(dir, "plexplayer-data"), newDir = path.join(dir, "plexdeck-data");
  try { if (!fs.existsSync(newDir) && fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir); } catch {}
  app.setPath("userData", newDir);
} else {
  const newDir = app.getPath("userData");
  const oldDir = path.join(app.getPath("appData"), "PlexPlayer");
  if (!fs.existsSync(path.join(newDir, "config.json")) && fs.existsSync(path.join(oldDir, "config.json"))) {
    try { fs.cpSync(oldDir, newDir, { recursive: true, filter: (src) => src === oldDir || !/cache|^blob_storage$/i.test(path.basename(src)) }); } catch {}
  }
}

// Only one copy at a time — launching it again focuses the open one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const APP_ID = "com.farathim.plexplayer";
app.setAppUserModelId(APP_ID);

// Look like plain Chrome: some sign-in pages (Google) refuse "embedded" browsers.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s*Electron\/\S+/, "")
  .replace(new RegExp(`\\s*${app.getName()}\\/\\S+`), "");

// Started by Windows at sign-in ("Start with Windows") → go straight to the tray.
const startHidden = process.argv.includes("--hidden");

const ICON = path.join(__dirname, "build", "icon.ico");
const PRELOAD = path.join(__dirname, "preload.js");
const TITLE_H = 36;
const PLEX_BG = "#1f1f1f";
const APP_URL = "https://app.plex.tv/desktop/";

// ---- Themes ----------------------------------------------------------------
// Plex Web takes its colours from CSS variables on .react-chroma-dark (accent,
// dialogs, menus). A theme overrides those, colours our title bar, and lays a
// tint over Plex's page background (the blur that follows the artwork).
// `solid` = a plain background instead of the artwork blur.
const THEMES = {
  plex:      { label: N_("Plex"),      title: "#141414", fg: "#e5e5e5", hover: "#2c2c2c", accent: "#e5a00d", surface: ["#000000", 0] },
  midnight:  { label: N_("Midnight"),  title: "#0e1420", fg: "#e3e8f2", hover: "#263045", accent: "#5aa9ff",
               tint: "rgba(14, 30, 64, 0.55)", modal: "#141b2a", menu: "#1a2233", surface: ["#0b1a3a", 45] },
  oled:      { label: N_("OLED black"), title: "#000000", fg: "#e5e5e5", hover: "#1f1f1f", accent: "#e5a00d",
               solid: "#000000", modal: "#0d0d0d", menu: "#141414", surface: ["#000000", 55] },
  forest:    { label: N_("Forest"),    title: "#0f1612", fg: "#e2ebe4", hover: "#26342b", accent: "#74d68a",
               tint: "rgba(14, 44, 26, 0.55)", modal: "#141c17", menu: "#1c2620", surface: ["#0b2a18", 45] },
  mocha:     { label: N_("Mocha"),     title: "#15110e", fg: "#eee5dd", hover: "#322822", accent: "#e6a85c",
               tint: "rgba(48, 28, 14, 0.45)", modal: "#1c1714", menu: "#2a221d", surface: ["#2a170a", 40] },
  amethyst:  { label: N_("Amethyst"),  title: "#141220", fg: "#e9e5f5", hover: "#2f2a45", accent: "#b58cff",
               tint: "rgba(40, 22, 72, 0.55)", modal: "#1b1828", menu: "#27233a", surface: ["#1d1038", 45] },
  crimson:   { label: N_("Crimson"),   title: "#180d0f", fg: "#f2e4e6", hover: "#3a2226", accent: "#ff5c6c",
               tint: "rgba(70, 12, 22, 0.5)", modal: "#1f1214", menu: "#2b191c", surface: ["#2e0a12", 45] },
  // Easier to see: pure black, white text, yellow highlights.
  highcontrast: { label: N_("High contrast"), title: "#000000", fg: "#ffffff", hover: "#3a3a3a", accent: "#ffd400",
               solid: "#000000", modal: "#000000", menu: "#000000", contrastText: true, surface: ["#000000", 75] },
};
const themeId = () => (THEMES[config.theme] ? config.theme : "plex");
const theme = () => THEMES[themeId()];

// Lighter version of a #rrggbb colour (Plex's hover/focus accent).
function lighten(hex, amount = 0.15) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * amount);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}

function themeCss() {
  const t = theme();
  const vars = {
    "brand-accent": t.accent, "static-yellow": t.accent, "text-accent": t.accent,
    "background-accent": t.accent, "background-accent-focus": lighten(t.accent),
  };
  if (t.modal) Object.assign(vars, { "background-modal": t.modal, "overlay-background": t.modal });
  if (t.menu) vars.menu = t.menu;
  if (t.contrastText) Object.assign(vars, { "text-default": "#ffffff", "text-muted": "#e6e6e6" });
  const parts = [
    `html:root { --ppd-accent: ${t.accent}; --tb-bg: ${t.title}; --tb-fg: ${t.fg}; --tb-hover: ${t.hover}; --plex: ${t.accent}; ` +
      `--ppd-surface: ${(t.surface || ["#000000", 0])[0]}; --ppd-surface-amt: ${(t.surface || ["#000000", 0])[1]}%; ` +
      `--ppd-keep: ${themeId() === "plex" ? 100 : 0}%; }`,
  ];
  if (themeId() === "plex") return parts.join("\n");
  parts.push(`html body.react-chroma-dark, .react-chroma-dark {${Object.entries(vars).map(([k, v]) => ` --color-${k}: ${v} !important;`).join("")} }`);
  const bgBox = '[class*="FullPageBackground-backgroundContainer"]';
  if (t.solid) parts.push(`${bgBox} { background: ${t.solid} !important; } ${bgBox} > * { opacity: 0 !important; }`);
  else if (t.tint) parts.push(`${bgBox}::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: ${t.tint}; }`);
  return parts.join("\n");
}

let win = null;
let view = null;          // Plex
let settingsView = null;  // our desktop settings overlay
let splashView = null;    // the loading screen while Plex starts
let tray = null;
let isQuitting = false;   // true once really quitting (not just hiding to the tray)
let config = {};
let lastNavAt = 0;
let htmlFullScreen = false;

// ---- small JSON file helpers ----------------------------------------------
const dataFile = (name) => path.join(app.getPath("userData"), name);
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Could not save", file, err.message);
  }
}

// First start: import the older PlexPlayer's settings (see migrate.js).
function loadConfig() {
  const saved = readJson(dataFile("config.json"), null);
  if (saved) {
    // Settings added later: take them from the old PlexPlayer once, if it had them.
    const old = fromOldConfig();
    const added = Object.fromEntries(Object.entries(old).filter(([k]) => !(k in saved) && k in DEFAULTS));
    const cfg = { ...DEFAULTS, ...added, ...saved };
    if (Object.keys(added).length) writeJson(dataFile("config.json"), cfg);
    return cfg;
  }
  const imported = fromOldConfig();
  const cfg = { ...DEFAULTS, ...imported, importedOldSettings: Object.keys(imported).length > 0 };
  writeJson(dataFile("config.json"), cfg);
  return cfg;
}
function setSetting(key, value) {
  if (!(key in DEFAULTS)) return;
  config = { ...config, [key]: value };
  writeJson(dataFile("config.json"), config);
  onSettingChanged(key);
}

// PlexDeck's language: the setting, else Windows' language (see i18n.js).
function useLanguage() { i18n.use(config.language, app.getPreferredSystemLanguages()); }
ipcMain.on("i18n:get", (e) => { e.returnValue = i18n.current(); });
ipcMain.handle("i18n:languages", () => i18n.languages());

// ---- remember window size / position --------------------------------------
function loadWindowState() {
  const s = readJson(dataFile("window-state.json"), {});
  const onScreen = Number.isFinite(s.x) && Number.isFinite(s.y) && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return s.x >= a.x - 40 && s.y >= a.y - 40 && s.x < a.x + a.width - 120 && s.y < a.y + a.height - 120;
  });
  const area = (onScreen ? screen.getDisplayNearestPoint({ x: s.x, y: s.y }) : screen.getPrimaryDisplay()).workArea;
  const width = Math.min(s.width || 1280, Math.round(area.width * (s.width ? 1 : 0.85)));
  const height = Math.min(s.height || 760, Math.round(area.height * (s.height ? 1 : 0.85)));
  const state = { width, height, maximized: s.maximized ?? config.startMaximized };
  if (onScreen) {
    state.x = Math.min(Math.max(s.x, area.x), area.x + area.width - width);
    state.y = Math.min(Math.max(s.y, area.y), area.y + area.height - height);
  }
  return state;
}
function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  writeJson(dataFile("window-state.json"), { ...win.getNormalBounds(), maximized: win.isMaximized() });
}

// ---- where Plex lives ------------------------------------------------------
// app.plex.tv = everything Plex has. Your server's /web = just your server (works offline / on the LAN).
function plexUrl() {
  if (config.source === "server" && config.serverUrl) return `${config.serverUrl.replace(/\/+$/, "")}/web/index.html`;
  return APP_URL;
}
function serverOrigin() {
  try { return config.serverUrl ? new URL(config.serverUrl).origin : null; } catch { return null; }
}
// Pages that stay inside the app: Plex itself, plex.tv sign-in, and your server.
function isPlexUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    return /(^|\.)plex\.tv$/i.test(u.hostname) || /\.plex\.direct$/i.test(u.hostname) || u.origin === serverOrigin();
  } catch { return false; }
}
// "Sign in with Google / Apple / Facebook" pop-ups run inside the app.
const AUTH_HOSTS = /(^|\.)(accounts\.google\.com|appleid\.apple\.com|facebook\.com)$/i;
const isAuthUrl = (url) => { try { return AUTH_HOSTS.test(new URL(url).hostname); } catch { return false; } };

function openExternal(url) {
  if (/^(https?|mailto):/i.test(String(url))) shell.openExternal(url);
}
const wc = () => view.webContents;

function goHome() { wc().loadURL(plexUrl()); }
function navigate(direction, contents) {
  const now = Date.now();
  if (now - lastNavAt < 350) return;   // side buttons can arrive twice (mouse event + app-command)
  lastNavAt = now;
  const h = (contents || wc()).navigationHistory;
  if (direction < 0 && h.canGoBack()) h.goBack();
  if (direction > 0 && h.canGoForward()) h.goForward();
}
// Plex's own settings (quality, subtitles, audio language, auto-play next…).
function openPlexSettings() {
  closeSettings();
  const base = plexUrl().replace(/#.*$/, "");
  wc().loadURL(`${base}#!/settings/web/general`);
}

// ---- page styles -----------------------------------------------------------
// With a Windows Contrast Theme on, Windows swaps every colour for the theme's
// (the volume and seek sliders vanish). "Plex colours" opts the page out of that.
const NO_FORCED_COLORS_CSS = ":root, *, *::before, *::after { forced-color-adjust: none !important; }";
// The orange ring that arrow keys / a controller move around (see preload.js).
const FOCUS_CSS = `
  .ppd-focus { box-sizing: border-box; border: 3px solid var(--ppd-accent, #e5a00d); border-radius: 8px;
               box-shadow: 0 0 0 4px color-mix(in srgb, var(--ppd-accent, #e5a00d) 25%, transparent),
                           0 0 18px color-mix(in srgb, var(--ppd-accent, #e5a00d) 35%, transparent);
               transition: left .12s ease-out, top .12s ease-out, width .12s ease-out, height .12s ease-out; }
  /* Plex's older form controls: dropdowns and text fields that match the theme (and are
     easier on the eyes than plain white-outlined boxes and bright grey fields). */
  select:not([multiple]) {
    appearance: none !important; -webkit-appearance: none !important;
    background-color: color-mix(in srgb, #2a2a2a, var(--ppd-surface, #000) var(--ppd-surface-amt, 0%)) !important;
    background-image: linear-gradient(45deg, transparent 50%, #bdbdbd 50%), linear-gradient(135deg, #bdbdbd 50%, transparent 50%) !important;
    background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50% !important;
    background-size: 5px 5px, 5px 5px !important; background-repeat: no-repeat !important;
    color: #eee !important; border: 1px solid rgba(255,255,255,.16) !important; border-radius: 5px !important;
    padding: 5px 32px 5px 10px !important; font-size: 15px !important; line-height: 1.4 !important; min-height: 34px; }
  select:not([multiple]):hover { border-color: rgba(255,255,255,.32) !important; }
  select:focus { border-color: var(--ppd-accent, #e5a00d) !important; outline: none !important; }
  select option { background: #1d1d1d; color: #eee; }
  input[type="checkbox"], input[type="radio"] { accent-color: var(--ppd-accent, #e5a00d); }
  .form-control, input.form-control, textarea.form-control, .selectize-input {
    background-color: rgba(255,255,255,.08) !important; color: #eee !important;
    border: 1px solid rgba(255,255,255,.12) !important; box-shadow: none !important; }
  .form-control:focus, .selectize-input.focus { background-color: rgba(255,255,255,.12) !important; border-color: var(--ppd-accent, #e5a00d) !important; }
  .form-control[disabled], .form-control[readonly] { background-color: rgba(255,255,255,.04) !important; color: #bbb !important; }
  /* Controller / arrow-key mode: no mouse pointer (it comes back when you move the mouse). */
  html.ppd-tv, html.ppd-tv * { cursor: none !important; }
`;
// Our own pages (title bar, settings) only take the theme colours.
function pageCss(local) {
  let css = themeCss();
  if (config.plexColours) css += NO_FORCED_COLORS_CSS;
  if (local) return css;
  css += FOCUS_CSS;
  if (config.fontFamily) {
    const f = String(config.fontFamily).replace(/["\\;{}]/g, "");
    css += `body, body * { font-family: "${f}", "Segoe UI", sans-serif !important; }`;
  }
  return css;
}
// One update at a time per page, so quick theme switches can't leave old styles behind.
const cssKeys = new WeakMap();
const cssQueues = new WeakMap();
function applyPageCss(contents) {
  const next = (cssQueues.get(contents) || Promise.resolve()).then(() => applyPageCssNow(contents)).catch(() => {});
  cssQueues.set(contents, next);
  return next;
}
async function applyPageCssNow(contents) {
  if (contents.isDestroyed()) return;
  const old = cssKeys.get(contents);
  if (old) { cssKeys.delete(contents); await contents.removeInsertedCSS(old).catch(() => {}); }
  const key = await contents.insertCSS(pageCss(contents.getURL().startsWith("file:"))).catch(() => null);
  if (key) cssKeys.set(contents, key);
}
// Windows' min/max/close buttons and the window backdrop follow the theme.
function applyWindowColors() {
  const t = theme();
  if (!win || win.isDestroyed()) return;
  win.setTitleBarOverlay({ color: t.title, symbolColor: t.fg, height: TITLE_H });
  win.setBackgroundColor(t.title);
}
function applyZoom(contents) {
  if (!contents.isDestroyed() && isPlexUrl(contents.getURL())) contents.setZoomFactor(Number(config.textSize) || 1);
}
function zoom(step) {
  const next = step === 0 ? 1 : (Number(config.textSize) || 1) + step * 0.1;
  setSetting("textSize", Math.round(Math.max(0.7, Math.min(2, next)) * 100) / 100);
}

// What changes when a setting does — everything applies live.
function prefsForPage() {
  const p = {};
  for (const k of ["autoSkipIntro", "skipIntroDelay", "autoSkipCredits", "skipCreditsDelay", "keyboardNav", "controller"]) p[k] = config[k];
  return p;
}
function onSettingChanged(key) {
  const all = webContents.getAllWebContents().filter((c) => !c.isDestroyed());
  if (key === "language") {
    useLanguage();
    // Our own pages start again in the new language (not the player's controls while
    // something plays); Plex's pages get the texts for what we draw on them.
    all.forEach((c) => {
      const url = c.getURL();
      if (url.startsWith("file:") && !/[?&]osd=1/.test(url)) c.reload();
      else c.send("i18n:changed", i18n.current());
    });
    updateTrayTooltip();
    sendUpdateToTitleBar();
  }
  if (key === "textSize") all.forEach(applyZoom);
  if (key === "plexColours" || key === "fontFamily" || key === "theme") all.forEach(applyPageCss);
  if (key === "theme") applyWindowColors();
  if (key === "startWithWindows") registerStartWithWindows(config.startWithWindows);
  if (key in prefsForPage()) all.forEach((c) => c.send("plex:prefs", prefsForPage()));
  if (key === "source" || key === "serverUrl") goHome();
  if (settingsView) settingsView.webContents.send("settings:changed", publicSettings());
  if (tv.view()) tv.view().webContents.send("tv:prefs", publicSettings());
}

// ---- keyboard shortcuts (work whether the title bar, Plex or settings has focus)
function toggleFullScreen() { win.setFullScreen(!win.isFullScreen()); }

// ---- Start with Windows ----------------------------------------------------
// Points at the real .exe (for the portable build the portable file itself, not
// its unpacked copy), quoted because the path has spaces.
const loginItem = () => ({
  path: `"${process.env.PORTABLE_EXECUTABLE_FILE || process.execPath}"`,
  args: ["--hidden"],
});
function registerStartWithWindows(on) {
  if (!app.isPackaged) return;   // only the built app, not the development copy
  app.setLoginItemSettings({ openAtLogin: on, ...loginItem() });
}
// Re-register at every start, so the entry follows the .exe if it moved (update, portable copy).
function refreshStartWithWindows() {
  if (!app.isPackaged) return;
  if (config.startWithWindows !== app.getLoginItemSettings(loginItem()).openAtLogin) registerStartWithWindows(config.startWithWindows);
}

// ---- system tray: keep music playing with the window closed ---------------
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// The media element Plex is playing (music, video, Live TV) and what Windows is told about it.
const FIND_MEDIA = `const m = [...document.querySelectorAll('video, audio')].filter((x) => x.currentSrc || x.srcObject)
  .sort((a, b) => (a.paused - b.paused) || (b.currentTime - a.currentTime))[0];`;
async function playerState() {
  if (mpv.isOpen()) return mpv.state();   // the native player
  if (!view || wc().isDestroyed()) return { active: false };
  try {
    return await wc().executeJavaScript(`(() => { ${FIND_MEDIA}
      if (!m) return { active: false };
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      return { active: true, playing: !m.paused, title: md ? md.title : '', artist: md ? (md.artist || md.album || '') : '' };
    })()`);
  } catch {
    return { active: false };
  }
}
function playerCommand(cmd) {
  const calls = {
    toggle: "m.paused ? m.play() : m.pause()",
    back: "m.currentTime = Math.max(0, m.currentTime - 10)",
    forward: "m.currentTime = Math.min(m.duration || Infinity, m.currentTime + 30)",
  };
  if (!calls[cmd] || !view) return;
  if (mpv.isOpen()) { mpv.command(cmd); setTimeout(updateTrayTooltip, 300); return; }
  wc().executeJavaScript(`(() => { ${FIND_MEDIA} if (m) { ${calls[cmd]}; } })()`).catch(() => {});
  setTimeout(updateTrayTooltip, 300);
}
async function updateTrayTooltip() {
  if (!tray || tray.isDestroyed()) return;
  const s = await playerState();
  let tip = "PlexDeck";
  if (s.active && s.title) tip += `\n${s.playing ? "▶" : "❚❚"} ${s.title}${s.artist ? " — " + s.artist : ""}`;
  tray.setToolTip(tip.slice(0, 127));   // Windows' tooltip limit
}
async function showTrayMenu() {
  const s = await playerState();
  const items = [];
  if (s.active) {
    if (s.title) items.push({ label: (s.title + (s.artist ? " — " + s.artist : "")).slice(0, 60), enabled: false });
    items.push(
      { label: s.playing ? tr("Pause") : tr("Play"), click: () => playerCommand("toggle") },
      { label: tr("Back 10 seconds"), click: () => playerCommand("back") },
      { label: tr("Forward 30 seconds"), click: () => playerCommand("forward") },
      { type: "separator" },
    );
  } else {
    items.push({ label: tr("Nothing playing"), enabled: false }, { type: "separator" });
  }
  items.push(
    { label: tr("Show PlexDeck"), click: showWindow },
    { label: tr("PlexDeck settings…"), click: () => { showWindow(); openSettings(); } },
    { type: "separator" },
    { label: tr("Quit"), click: () => app.quit() },
  );
  tray.popUpContextMenu(Menu.buildFromTemplate(items));
}
function createTray() {
  tray = new Tray(ICON);
  tray.setToolTip("PlexDeck");
  tray.on("click", showWindow);
  tray.on("right-click", showTrayMenu);
  setInterval(updateTrayTooltip, 5000);   // keep "now playing" in the tooltip current
}
function toggleDevTools() {
  const c = settingsView ? settingsView.webContents : wc();
  if (c.isDevToolsOpened()) c.closeDevTools(); else c.openDevTools({ mode: "detach" });
}
function onShortcut(event, input) {
  if (input.type !== "keyDown") return;
  const key = input.key;
  const ctrl = input.control || input.meta;
  let action = null;
  if (key === "F5") action = () => wc().reload();
  else if (key === "F11") action = toggleFullScreen;
  else if (key === "F10") action = () => tv.setMode(tv.mode() === "tv" ? "pc" : "tv");
  else if (input.alt && !ctrl && key === "ArrowLeft") action = () => navigate(-1);
  else if (input.alt && !ctrl && key === "ArrowRight") action = () => navigate(1);
  else if (input.alt && !ctrl && key === "Home") action = goHome;
  else if (ctrl && !input.alt && key === ",") action = () => (settingsView ? closeSettings() : openSettings());
  else if (ctrl && input.shift && key.toLowerCase() === "i") action = toggleDevTools;
  else if (ctrl && !input.alt && (key === "=" || key === "+")) action = () => zoom(1);
  else if (ctrl && !input.alt && (key === "-" || key === "_")) action = () => zoom(-1);
  else if (ctrl && !input.alt && key === "0") action = () => zoom(0);
  if (action) { event.preventDefault(); action(); }
}

// ---- the window ------------------------------------------------------------
const fullScreen = () => win.isFullScreen() || htmlFullScreen;
function layout() {
  if (!win || !view) return;
  const { width, height } = win.getContentBounds();
  const top = fullScreen() ? 0 : TITLE_H;
  const bounds = { x: 0, y: top, width, height: Math.max(0, height - top) };
  view.setBounds(bounds);
  if (tv.view()) tv.view().setBounds(bounds);
  if (settingsView) settingsView.setBounds(bounds);
  if (splashView) splashView.setBounds(bounds);
}
// Keep the settings panel and the loading screen above TV mode.
function raiseOverlays() {
  if (settingsView) win.contentView.addChildView(settingsView);
  if (splashView) win.contentView.addChildView(splashView);
}
// Resolves once Plex Web has loaded (TV mode needs its sign-in).
let plexReadyResolve;
const plexReady = new Promise((r) => { plexReadyResolve = r; });

// ---- loading screen (like Plex's own) --------------------------------------
// Covers Plex until it has drawn its menu or posters, then fades away.
function showSplash() {
  splashView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashView.setBackgroundColor(theme().title);
  win.contentView.addChildView(splashView);
  layout();
  splashView.webContents.loadFile(path.join(__dirname, "loading.html"));
  setTimeout(hideSplash, 15000);   // never block the app
}
function hideSplash() {
  if (!splashView) return;
  const v = splashView;
  splashView = null;
  v.webContents.executeJavaScript("document.body.classList.add('done')").catch(() => {});
  setTimeout(() => {
    try { win.contentView.removeChildView(v); v.webContents.close(); } catch {}
    if (!settingsView) wc().focus();
  }, 350);
}

function createWindow() {
  const state = loadWindowState();
  const webPreferences = { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true };

  win = new BrowserWindow({
    x: state.x, y: state.y, width: state.width, height: state.height,
    minWidth: 800, minHeight: 560,
    title: "PlexDeck",
    icon: ICON,
    backgroundColor: theme().title,
    show: false,
    // No Windows frame: we draw the title bar; Windows draws min/max/close in our colours.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: theme().title, symbolColor: theme().fg, height: TITLE_H },
    webPreferences,
  });
  if (state.maximized) win.maximize();
  win.on("page-title-updated", (e) => e.preventDefault());
  win.webContents.on("will-navigate", (e) => e.preventDefault());   // the title bar never navigates
  win.webContents.on("before-input-event", onShortcut);
  win.loadFile(path.join(__dirname, "titlebar.html"));
  win.once("ready-to-show", () => {
    if (startHidden) return;   // started with Windows → stay in the tray
    win.show();
    wc().focus();
  });
  // ✕ hides to the tray (music keeps playing) unless you're quitting or turned it off.
  win.on("close", (e) => {
    saveWindowState();
    if (isQuitting || !config.closeToTray || !tray) return;
    e.preventDefault();
    if (win.isFullScreen()) win.setFullScreen(false);
    win.hide();
    if (!config.trayHintShown) {
      tray.displayBalloon({
        iconType: "info",
        title: tr("PlexDeck is still running"),
        content: tr("It's in the tray, so music keeps playing. Right-click the icon for controls or Quit."),
      });
      config = { ...config, trayHintShown: true };
      writeJson(dataFile("config.json"), config);
    }
  });
  win.on("focus", () => {
    win.webContents.send("titlebar:focus", true);
    (settingsView ? settingsView.webContents : (tv.mode() === "tv" && tv.view() ? tv.view().webContents : wc())).focus();
  });
  win.on("blur", () => win.webContents.send("titlebar:focus", false));

  // Plex, under the title bar. backgroundThrottling off: music keeps playing
  // smoothly and progress keeps syncing while the window is minimised.
  view = new WebContentsView({ webPreferences: { ...webPreferences, backgroundThrottling: false } });
  view.setBackgroundColor(PLEX_BG);
  win.contentView.addChildView(view);
  layout();
  for (const ev of ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) win.on(ev, layout);

  const contents = view.webContents;
  contents.on("before-input-event", onShortcut);
  contents.on("page-title-updated", (_e, title) => {
    const t = title && title !== "Plex" ? `${title} — PlexDeck` : "PlexDeck";
    win.setTitle(t);
    win.webContents.send("titlebar:title", t);
  });

  // The Plex player's full-screen button: hide our title bar and fill the screen.
  contents.on("enter-html-full-screen", () => {
    htmlFullScreen = true;
    if (!win.isFullScreen()) win.setFullScreen(true);
    layout();
  });
  contents.on("leave-html-full-screen", () => {
    htmlFullScreen = false;
    if (win.isFullScreen()) win.setFullScreen(false);
    layout();
  });

  guardLinks(contents);

  contents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;   // -3 = aborted (normal)
    hideSplash();
    const html = `<body style="background:${PLEX_BG};color:#ddd;font:15px Segoe UI;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center"><h2 style="color:#e5a00d">${tr("Can't reach Plex")}</h2>
      <p>${String(desc).replace(/[<>&]/g, "")} (${code})</p><p>${String(url).replace(/[<>&]/g, "")}</p>
      <p>${tr("Check your internet connection, then press <b>F5</b> to try again.")}</p></div></body>`;
    contents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });

  win.on("app-command", (_e, cmd) => {
    if (cmd === "browser-backward") navigate(-1);
    if (cmd === "browser-forward") navigate(1);
  });

  if (!app.isPackaged) contents.on("did-navigate", (_e, url) => console.log("[nav]", url));
  showSplash();
  contents.loadURL(plexUrl());
}

// Plex, plex.tv sign-in and your server stay in the app; other links open in your browser.
// Pop-ups only open right after a click or key press, like in Chrome (Plex's sign-in
// page otherwise opens a Google sign-in window on its own).
function guardLinks(contents) {
  let lastInputAt = 0;
  contents.on("input-event", (_e, input) => {
    if (/^(mouseDown|mouseUp|keyDown|rawKeyDown|char|gestureTap)$/.test(input.type)) lastInputAt = Date.now();
  });
  contents.on("will-navigate", (e, url) => {
    if (!isPlexUrl(url) && !isAuthUrl(url)) { e.preventDefault(); openExternal(url); }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (Date.now() - lastInputAt > 3000) return { action: "deny" };
    if (isPlexUrl(url) || isAuthUrl(url) || url === "about:blank") {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          icon: ICON, backgroundColor: PLEX_BG, autoHideMenuBar: true, parent: win, width: 520, height: 720,
          webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
        },
      };
    }
    openExternal(url);
    return { action: "deny" };
  });
}

// ---- desktop settings overlay ---------------------------------------------
function publicSettings() {
  return {
    ...Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, config[k]])),
    importedOldSettings: !!config.importedOldSettings,
    // For the theme swatches: title bar, page and accent colour of each.
    themes: Object.entries(THEMES).map(([id, t]) => ({
      id, label: tr(t.label), title: t.title, accent: t.accent, page: t.solid || t.modal || PLEX_BG,
    })),
    languages: i18n.languages(),
    packaged: app.isPackaged,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  };
}
// Audio & subtitle tool, starting on the show / movie you're looking at if there is one.
async function openTrackTool(key) {
  if (!key && tv.mode() !== "tv") {
    try {
      const hash = await wc().executeJavaScript("location.hash");
      const m = /key=%2Flibrary%2Fmetadata%2F(\d+)/i.exec(hash) || /\/library\/metadata\/(\d+)/.exec(decodeURIComponent(hash));
      if (m) key = m[1];
    } catch {}
  }
  openSettings("tracks.html", key ? { key: String(key) } : {});
}
ipcMain.on("tracks:open", (e, key) => {
  if (tv.view() && e.sender === tv.view().webContents) openTrackTool(/^\d+$/.test(String(key)) ? String(key) : null);
});

// The overlay shows our settings, or another of our tool pages (audio & subtitle tool).
function openSettings(page = "settings.html", query = {}) {
  if (typeof page !== "string") page = "settings.html";
  if (settingsView || !win) return;
  settingsView = new WebContentsView({
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  settingsView.setBackgroundColor("#00000000");   // the page draws its own dimmed backdrop
  win.contentView.addChildView(settingsView);
  layout();
  settingsView.webContents.on("before-input-event", onShortcut);
  settingsView.webContents.on("will-navigate", (e) => e.preventDefault());
  settingsView.webContents.loadFile(path.join(__dirname, page), { query });
  settingsView.webContents.once("did-finish-load", () => settingsView && settingsView.webContents.focus());
  wc().send("plex:overlay", true);
  if (tv.view()) tv.view().webContents.send("tv:overlay", true);
}
function closeSettings() {
  if (!settingsView) return;
  win.contentView.removeChildView(settingsView);
  settingsView.webContents.close();
  settingsView = null;
  wc().send("plex:overlay", false);
  if (tv.view()) tv.view().webContents.send("tv:overlay", false);
  if (tv.mode() === "tv" && tv.view()) tv.view().webContents.focus(); else wc().focus();
}

// ---- settings backup ----------------------------------------------------------
// Export / import PlexDeck's own settings as a .json file. Never in the file: where your
// server is (the Plex sign-in and profile tokens aren't settings, so they never are either).
const NOT_EXPORTED = new Set(["source", "serverUrl"]);
const SETTING_NAMES = {
  autoSkipIntro: N_("Skip intros automatically"), skipIntroDelay: N_("Intro skip delay"), autoSkipCredits: N_("Skip credits automatically"),
  skipCreditsDelay: N_("Credits skip delay"), textSize: N_("Text size"), fontFamily: N_("Font"), plexColours: N_("Plex colours"),
  keyboardNav: N_("Arrow-key navigation"), controller: N_("Game controller"), startMaximized: N_("Start maximised"), theme: N_("Theme"),
  closeToTray: N_("Keep running in the tray"), startWithWindows: N_("Start with Windows"), startMode: N_("Start in"), autoMode: N_("Switch mode by itself"),
  pcPlayerEngine: N_("PC mode player"), playerEngine: N_("TV mode player"), hdr: N_("HDR"), passthrough: N_("Surround passthrough"),
  matchRefresh: N_("Match refresh rate"), defaultVolume: N_("Volume"), hwDecode: N_("Hardware decoding"), subSize: N_("Subtitle size"),
  subColor: N_("Subtitle colour"), subPosition: N_("Subtitle position"), subBackground: N_("Subtitle background"),
  preferredAudioLang: N_("Audio language"), autoSubtitles: N_("Subtitles on by themselves"), preferredSubtitleLang: N_("Subtitle language"),
  preferNonSdh: N_("Prefer subtitles without SDH"), themeMusic: N_("Theme music"), screensaver: N_("Screensaver"), language: N_("Language"),
  musicVisualiser: N_("Music visualiser"),
};
const showValue = (k, v) => (k === "theme" && THEMES[v] ? tr(THEMES[v].label) : typeof v === "boolean" ? (v ? tr("on") : tr("off")) : v === "" ? tr("(default)") : String(v));
async function exportSettings() {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: tr("Export PlexDeck settings"), defaultPath: path.join(app.getPath("documents"), "PlexDeck settings.json"),
    filters: [{ name: tr("PlexDeck settings"), extensions: ["json"] }],
  });
  if (canceled || !filePath) return null;
  const settings = Object.fromEntries(Object.keys(DEFAULTS).filter((k) => !NOT_EXPORTED.has(k)).map((k) => [k, config[k]]));
  try {
    fs.writeFileSync(filePath, JSON.stringify({ app: "PlexDeck", version: app.getVersion(), exported: new Date().toISOString(), settings }, null, 2));
    return tr("Saved to {file}", { file: filePath });
  } catch (err) {
    return tr("Couldn't save: {error}", { error: err.message });
  }
}
async function importSettings() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: tr("Import PlexDeck settings"), defaultPath: app.getPath("documents"), properties: ["openFile"],
    filters: [{ name: tr("PlexDeck settings"), extensions: ["json"] }],
  });
  if (canceled || !filePaths || !filePaths[0]) return null;
  const data = readJson(filePaths[0], null);
  if (!data || data.app !== "PlexDeck" || !data.settings || typeof data.settings !== "object") return tr("That file isn't a PlexDeck settings file.");
  // Only known settings of the right kind, and only the ones that change something.
  const changes = Object.entries(data.settings).filter(([k, v]) =>
    k in DEFAULTS && !NOT_EXPORTED.has(k) && typeof v === typeof DEFAULTS[k] && v !== config[k] && (k !== "theme" || THEMES[v]));
  if (!changes.length) return tr("Nothing to change: these are the settings you already have.");
  const lines = changes.map(([k, v]) => `${SETTING_NAMES[k] ? tr(SETTING_NAMES[k]) : k}: ${showValue(k, config[k])} → ${showValue(k, v)}`);
  const { response } = await dialog.showMessageBox(win, {
    type: "question", title: tr("Import settings"), message: changes.length === 1 ? tr("Change 1 setting?") : tr("Change {n} settings?", { n: changes.length }),
    detail: lines.slice(0, 20).join("\n") + (lines.length > 20 ? "\n" + tr("…and {n} more", { n: lines.length - 20 }) : ""),
    buttons: [tr("Import"), tr("Cancel")], defaultId: 0, cancelId: 1,
  });
  if (response !== 0) return null;
  for (const [k, v] of changes) setSetting(k, v);
  return changes.length === 1 ? tr("Imported 1 setting.") : tr("Imported {n} settings.", { n: changes.length });
}
ipcMain.handle("settings:export", (e) => (fromLocalPage(e) ? exportSettings() : null));
ipcMain.handle("settings:import", (e) => (fromLocalPage(e) ? importSettings() : null));

const REPO_URL = "https://github.com/Farathim89/plexdeck";

// ---- update check -------------------------------------------------------------
// Asks GitHub for the newest release. If it's newer: an "Update x.y.z" pill in the
// title bar and a Windows notification (once per version). Automatic checks can be
// turned off; Help → Check for updates… always works.
const RELEASES_API = "https://api.github.com/repos/Farathim89/plexdeck/releases/latest";
let latestRelease = null;   // { version, url } when GitHub has a newer version
const autoUpdateCheck = () => config.updateCheck !== false;
// The installed app updates itself (download, then install on restart or quit). The portable
// .exe can't replace itself, so it opens the download page instead.
const canSelfUpdate = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
let updateState = "idle";  // "idle" | "downloading" | "ready"
let updatePercent = 0;
let updater = null;
function getUpdater() {
  if (updater) return updater;
  updater = require("electron-updater").autoUpdater;
  updater.autoDownload = false;          // never without asking
  updater.autoInstallOnAppQuit = true;   // downloaded but not restarted yet: installs when you quit
  updater.on("error", () => {});         // handled where we call it
  updater.on("download-progress", (p) => {
    const pct = Math.floor(p.percent || 0);
    if (pct !== updatePercent) { updatePercent = pct; sendUpdateToTitleBar(); }
  });
  return updater;
}
async function downloadUpdate() {
  if (updateState !== "idle") return;
  updateState = "downloading"; updatePercent = 0;
  sendUpdateToTitleBar();
  try {
    const u = getUpdater();
    const found = await u.checkForUpdates();
    if (!found || !found.updateInfo || !isNewer(found.updateInfo.version, app.getVersion())) throw new Error("no update");
    const v = found.updateInfo.version;
    if (!latestRelease || latestRelease.version !== v) latestRelease = { version: v, url: `${REPO_URL}/releases/tag/v${v}` };
    await u.downloadUpdate();
    updateState = "ready";
    sendUpdateToTitleBar();
    askToRestart();
  } catch {
    updateState = "idle";
    sendUpdateToTitleBar();
    const { response } = await dialog.showMessageBox(win, {
      type: "warning", title: tr("Update"), message: tr("Couldn't download the update"),
      detail: tr("You can download it from GitHub instead."), buttons: [tr("Open download page"), tr("Close")], defaultId: 0, cancelId: 1,
    });
    if (response === 0) openUpdatePage();
  }
}
async function askToRestart() {
  const v = latestRelease ? latestRelease.version : "";
  const { response } = await dialog.showMessageBox(win, {
    type: "info", title: tr("Update ready"), message: tr("PlexDeck {version} is ready to install", { version: v }),
    detail: tr("Restart now to finish. Watching something? Choose Later: it installs when you quit PlexDeck."),
    buttons: [tr("Restart now"), tr("Later")], defaultId: 0, cancelId: 1,
  });
  if (response === 0) restartToUpdate();
}
function restartToUpdate() {
  if (updateState !== "ready") return;
  isQuitting = true;
  saveWindowState();
  setImmediate(() => getUpdater().quitAndInstall(true, true));   // quiet install, then start again
}
// Clicked the title-bar pill, the notification, or "Check for updates…".
async function onUpdateClick() {
  if (updateState === "ready") return restartToUpdate();
  if (updateState === "downloading") return;
  if (!canSelfUpdate) return openUpdatePage();
  const v = latestRelease ? latestRelease.version : "";
  const { response } = await dialog.showMessageBox(win, {
    type: "info", title: tr("Update available"), message: tr("PlexDeck {version} is available", { version: v }),
    detail: tr("You have {current}. It downloads in the background, then asks before restarting.", { current: app.getVersion() }),
    buttons: [tr("Download & install"), tr("What's new"), tr("Later")], defaultId: 0, cancelId: 2,
  });
  if (response === 0) downloadUpdate();
  if (response === 1) openUpdatePage();
}
function isNewer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
function updatePill() {
  const v = latestRelease ? latestRelease.version : "";
  if (updateState === "downloading") return { label: tr("Downloading {percent}%", { percent: updatePercent }), tip: tr("Downloading PlexDeck {version}…", { version: v }) };
  if (updateState === "ready") return { label: tr("Restart to update"), tip: tr("PlexDeck {version} is downloaded. Click to restart and install it.", { version: v }) };
  if (!latestRelease) return null;
  return {
    label: tr("Update {version}", { version: v }),
    tip: canSelfUpdate ? tr("PlexDeck {version} is out (you have {current}). Click to install it.", { version: v, current: app.getVersion() })
      : tr("PlexDeck {version} is out (you have {current}). Click to download it.", { version: v, current: app.getVersion() }),
  };
}
function sendUpdateToTitleBar() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send("titlebar:update", updatePill());
}
const openUpdatePage = () => openExternal(latestRelease ? latestRelease.url : `${REPO_URL}/releases/latest`);
async function checkForUpdates(manual) {
  try {
    const res = await net.fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
    const version = String(rel.tag_name || "").replace(/^v/i, "");
    if (version && isNewer(version, app.getVersion())) {
      latestRelease = { version, url: rel.html_url || `${REPO_URL}/releases/latest` };
      sendUpdateToTitleBar();
      if (manual) {
        if (canSelfUpdate || updateState !== "idle") onUpdateClick();
        else {
          const { response } = await dialog.showMessageBox(win, {
            type: "info", title: tr("Update available"), message: tr("PlexDeck {version} is available", { version }),
            detail: tr("You have {current}. Download the new version from GitHub?", { current: app.getVersion() }),
            buttons: [tr("Download"), tr("Later")], defaultId: 0, cancelId: 1,
          });
          if (response === 0) openUpdatePage();
        }
      } else if (config.updateNotified !== version && Notification.isSupported()) {
        config = { ...config, updateNotified: version };
        writeJson(dataFile("config.json"), config);
        const n = new Notification({ title: tr("PlexDeck update available"), body: tr("Version {version} is out (you have {current}).", { version, current: app.getVersion() }), icon: ICON });
        n.on("click", () => { showWindow(); onUpdateClick(); });
        n.show();
      }
    } else if (updateState === "idle") {
      latestRelease = null;
      sendUpdateToTitleBar();
      if (manual) dialog.showMessageBox(win, { type: "info", title: tr("Up to date"), message: tr("PlexDeck is up to date"), detail: tr("You have the newest version, {current}.", { current: app.getVersion() }), buttons: [tr("OK")] });
    }
  } catch {
    if (manual) dialog.showMessageBox(win, { type: "warning", title: tr("Couldn't check"), message: tr("Couldn't check for updates"), detail: tr("GitHub couldn't be reached. Check your internet connection and try again."), buttons: [tr("OK")] });
  }
}
function startUpdateChecks() {
  setTimeout(() => { if (autoUpdateCheck()) checkForUpdates(false); }, 10000);
  setInterval(() => { if (autoUpdateCheck()) checkForUpdates(false); }, 12 * 60 * 60 * 1000);
}
ipcMain.on("titlebar:open-update", (e) => { if (fromLocalPage(e)) onUpdateClick(); });
async function showAbout() {
  const { response } = await dialog.showMessageBox(win, {
    type: "info",
    title: tr("About PlexDeck"),
    message: `PlexDeck ${app.getVersion()}`,
    detail: tr("An unofficial Windows app for Plex, by Farathim.") + "\n" +
      tr("Free software under the GNU GPL v3 or later. Plays video with mpv (GPL).") + "\n" +
      tr("Not made by or affiliated with Plex, Inc. Plex and the Plex web app belong to Plex, Inc.") + "\n\n" +
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
    buttons: [tr("OK"), tr("PlexDeck on GitHub")],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) openExternal(REPO_URL);
}

// Shortcuts are shown in the menu but handled by onShortcut, so they never fire twice.
const shortcut = (accelerator) => ({ accelerator, registerAccelerator: false });

// The order of the top-level menus must match the buttons in titlebar.html.
function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: tr("App"),
      submenu: [
        { label: tr("Home"), ...shortcut("Alt+Home"), click: goHome },
        { label: tr("PlexDeck settings…"), ...shortcut("Ctrl+,"), click: openSettings },
        { label: tr("Plex settings…"), click: openPlexSettings },
        { label: tr("Audio & subtitle tool…"), click: () => openTrackTool() },
        { type: "separator" },
        {
          label: tr("Check for updates automatically"), type: "checkbox", checked: autoUpdateCheck(),
          click: (item) => { config = { ...config, updateCheck: item.checked }; writeJson(dataFile("config.json"), config); if (item.checked) checkForUpdates(false); },
        },
        {
          label: tr("Keep running in the tray when closed"), type: "checkbox", checked: !!config.closeToTray,
          click: (item) => setSetting("closeToTray", item.checked),
        },
        {
          label: app.isPackaged ? tr("Start with Windows") : tr("Start with Windows (installed app only)"),
          type: "checkbox", enabled: app.isPackaged, checked: !!config.startWithWindows,
          click: (item) => setSetting("startWithWindows", item.checked),
        },
        { type: "separator" },
        { label: tr("Reload"), ...shortcut("F5"), click: () => wc().reload() },
        { type: "separator" },
        { label: tr("Exit"), click: () => app.quit() },
      ],
    },
    {
      label: tr("Edit"),
      submenu: [
        { label: tr("Undo"), ...shortcut("Ctrl+Z"), click: () => wc().undo() },
        { label: tr("Redo"), ...shortcut("Ctrl+Y"), click: () => wc().redo() },
        { type: "separator" },
        { label: tr("Cut"), ...shortcut("Ctrl+X"), click: () => wc().cut() },
        { label: tr("Copy"), ...shortcut("Ctrl+C"), click: () => wc().copy() },
        { label: tr("Paste"), ...shortcut("Ctrl+V"), click: () => wc().paste() },
        { label: tr("Select all"), ...shortcut("Ctrl+A"), click: () => wc().selectAll() },
      ],
    },
    {
      label: tr("View"),
      submenu: [
        { label: tr("Bigger"), ...shortcut("Ctrl+="), click: () => zoom(1) },
        { label: tr("Smaller"), ...shortcut("Ctrl+-"), click: () => zoom(-1) },
        { label: tr("Normal size"), ...shortcut("Ctrl+0"), click: () => zoom(0) },
        { type: "separator" },
        {
          // Ticks, not radio buttons (Windows ticks the first item of each radio group).
          label: tr("Theme"),
          submenu: Object.entries(THEMES).map(([id, t]) => ({
            label: tr(t.label), type: "checkbox", checked: themeId() === id, click: () => setSetting("theme", id),
          })),
        },
        { type: "separator" },
        { label: tr("Full screen"), ...shortcut("F11"), click: toggleFullScreen },
      ],
    },
    {
      label: tr("Navigate"),
      submenu: [
        { label: tr("Back"), ...shortcut("Alt+Left"), click: () => navigate(-1) },
        { label: tr("Forward"), ...shortcut("Alt+Right"), click: () => navigate(1) },
        { label: tr("Home"), ...shortcut("Alt+Home"), click: goHome },
      ],
    },
    {
      label: tr("Help"),
      submenu: [
        { label: tr("Plex support"), click: () => openExternal("https://support.plex.tv/") },
        { label: tr("Open this page in your browser"), click: () => openExternal(wc().getURL()) },
        { type: "separator" },
        { label: tr("Report a problem…"), click: () => openExternal(`${REPO_URL}/issues/new/choose`) },
        { label: tr("PlexDeck on GitHub"), click: () => openExternal(REPO_URL) },
        { label: tr("Check for updates…"), click: () => checkForUpdates(true) },
        { type: "separator" },
        { label: tr("Developer tools"), ...shortcut("Ctrl+Shift+I"), click: toggleDevTools },
        { type: "separator" },
        { label: tr("About PlexDeck"), click: showAbout },
      ],
    },
  ]);
}

// Only grant the browser permissions Plex actually needs.
function hardenSession() {
  const allowed = new Set(["fullscreen", "clipboard-sanitized-write", "clipboard-read", "notifications", "media"]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
}

// ---- messages from pages ---------------------------------------------------
// Local pages (title bar, settings) get the desktop bridge; Plex pages only get
// their prefs, back/forward and controller key presses.
const fromLocalPage = (e) => { try { return e.senderFrame.url.startsWith("file:"); } catch { return false; } };
const fromPlexPage = (e) => { try { return isPlexUrl(e.senderFrame.url); } catch { return false; } };

ipcMain.handle("titlebar:get-title", (e) => (fromLocalPage(e) ? win.getTitle() : ""));
ipcMain.handle("titlebar:menu", (e, { index, x, y } = {}) => new Promise((resolve) => {
  if (!fromLocalPage(e)) return resolve();
  const item = buildMenu().items[index];
  if (!item || !item.submenu) return resolve();
  item.submenu.popup({ window: win, x: Math.round(x), y: Math.round(y), callback: () => resolve() });
}));
ipcMain.on("titlebar:settings", (e) => { if (fromLocalPage(e)) (settingsView ? closeSettings() : openSettings()); });
ipcMain.on("titlebar:nav", (e, dir) => { if (fromLocalPage(e)) navigate(dir === -1 ? -1 : 1); });

ipcMain.handle("settings:get", (e) => (fromLocalPage(e) ? publicSettings() : null));
ipcMain.on("settings:set", (e, { key, value } = {}) => {
  if (!fromLocalPage(e) || !(key in DEFAULTS)) return;
  if (typeof value !== typeof DEFAULTS[key]) return;
  setSetting(key, value);
});
ipcMain.on("settings:close", (e) => { if (fromLocalPage(e)) closeSettings(); });
ipcMain.on("settings:plex", (e) => { if (fromLocalPage(e)) openPlexSettings(); });

ipcMain.handle("plex:prefs", (e) => (fromPlexPage(e) ? prefsForPage() : null));
ipcMain.on("plex:nav", (e, dir) => { if (fromPlexPage(e)) navigate(dir === -1 ? -1 : 1, e.sender); });
ipcMain.on("plex:open-settings", (e) => { if (fromPlexPage(e)) openSettings(); });
// The paintbrush panel in Plex's top bar: themes (with small previews) and text size.
const LOOK_SIZES = [0.9, 1, 1.15, 1.3, 1.5];
function looksState() {
  return {
    theme: themeId(), textSize: Number(config.textSize) || 1,
    themes: Object.entries(THEMES).map(([id, t]) => ({ id, label: tr(t.label), title: t.title, accent: t.accent, page: t.solid || t.modal || PLEX_BG })),
    sizes: LOOK_SIZES.map((f) => ({ f, percent: Math.round(f * 100) })),
  };
}
ipcMain.handle("plex:looks", (e) => (fromPlexPage(e) ? looksState() : null));
ipcMain.handle("plex:set-look", (e, { kind, id } = {}) => {
  if (!fromPlexPage(e)) return null;
  if (kind === "theme" && THEMES[id]) setSetting("theme", id);
  if (kind === "text" && LOOK_SIZES.includes(Number(id))) setSetting("textSize", Number(id));
  return looksState();
});
ipcMain.on("plex:ready", (e) => { if (fromPlexPage(e) && view && e.sender === wc()) { hideSplash(); plexReadyResolve(); } });
// A real mouse click for the controller (Plex's player ignores clicks made by a script).
// The page gives CSS pixels; input events want them scaled by the page zoom.
ipcMain.on("plex:click", (e, { x, y } = {}) => {
  if (!fromPlexPage(e) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const z = e.sender.getZoomFactor();
  const X = Math.round(x * z), Y = Math.round(y * z);
  for (const type of ["mouseMove", "mouseDown", "mouseUp"]) e.sender.sendInputEvent({ type, x: X, y: Y, button: "left", clickCount: 1 });
});
// Controller buttons become real key presses, so Plex's own shortcuts react
// (Space = play/pause, arrows = seek / volume, Esc = close the player).
const KEYS = new Set(["Up", "Down", "Left", "Right", "Enter", "Escape", "Space"]);
ipcMain.on("plex:key", (e, key) => {
  if (!fromPlexPage(e) || !KEYS.has(key)) return;
  for (const type of ["keyDown", "keyUp"]) e.sender.sendInputEvent({ type, keyCode: key });
});

// ---- app lifecycle ---------------------------------------------------------
app.on("web-contents-created", (_e, contents) => {
  contents.on("dom-ready", () => { applyPageCss(contents); applyZoom(contents); });
  contents.on("zoom-changed", (_ev, dir) => { if (isPlexUrl(contents.getURL())) zoom(dir === "in" ? 1 : -1); });
  // Pop-ups (sign-in) follow the same link rules.
  if (contents.getType() === "window") contents.once("did-start-navigation", () => {
    if (win && contents !== win.webContents) guardLinks(contents);
  });
});

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  if (!gotLock) return;
  config = loadConfig();
  useLanguage();
  hardenSession();
  Menu.setApplicationMenu(null);   // no Windows menu bar — the menus live in our title bar
  refreshStartWithWindows();
  createWindow();
  createTray();
  startUpdateChecks();
  tv.init({
    win: () => win,
    plexContents: () => wc(),
    titlebar: () => win.webContents,
    preload: PRELOAD,
    layout, raiseOverlays, onShortcut, openSettings,
    config: () => config,
    setConfig: (patch) => { config = { ...config, ...patch }; writeJson(dataFile("config.json"), config); },
    plexReady: () => plexReady,
  });
  win.webContents.once("did-finish-load", () => { tv.startMode(); sendUpdateToTitleBar(); });
  mpv.init({
    config: () => config,
    saveConfig: (patch) => { config = { ...config, ...patch }; writeJson(dataFile("config.json"), config); },
    plexContents: () => wc(),
    win: () => win,
    preload: PRELOAD,
    tvView: () => tv.view(),
    onShortcut,
    // Where the video goes: everything under our title bar (all of it in full screen).
    contentBounds: () => {
      const b = win.getContentBounds();
      const top = win.isFullScreen() ? 0 : TITLE_H;
      return { x: b.x, y: b.y + top, width: b.width, height: Math.max(0, b.height - top) };
    },
    onClosed: () => {
      const v = tv.view();
      if (v) { v.webContents.send("tv:refresh"); v.webContents.focus(); }
    },
  });
});

// A real quit (App → Exit, tray → Quit, Windows shutting down) closes instead of hiding.
app.on("before-quit", () => { isQuitting = true; });
app.on("window-all-closed", () => app.quit());
