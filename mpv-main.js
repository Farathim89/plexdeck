// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// Native player: mpv (https://mpv.io), bundled.
//
// mpv plays the file straight from your Plex server — every codec, HDR,
// surround, original subtitles — with no converting. It draws into a
// borderless layer over the window; TV mode's own controls (tv.html in
// "osd" mode) sit on top in a see-through layer, so it looks and works the
// same as the built-in player. We talk to mpv over its JSON control pipe.
// ===========================================================================

const { BrowserWindow, ipcMain, app } = require("electron");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const fs = require("fs");
const refresh = require("./refresh");

let d = null;           // from main.js: win(), contentBounds(), preload, tvView(), onClosed()
let host = null;        // the window mpv draws into
let osd = null;         // our controls, on top
let origin = "tv";      // where playback started: "tv" or "pc"
let proc = null, pipe = null, pipeName = null, buf = "", reqId = 0;
const pending = new Map();

// The bundled mpv (inside the app), else one installed on the PC.
function mpvPath() {
  const candidates = [
    path.join(process.resourcesPath || "", "mpv", "mpv.exe"),
    path.join(__dirname, "vendor", "mpv", "mpv.exe"),
    "C:\\Program Files\\MPV Player\\mpv.exe",
  ];
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}
const available = () => !!mpvPath();

// ---- the two layers --------------------------------------------------------------
function place() {
  if (!host) return;
  const b = d.contentBounds();
  host.setBounds(b);
  if (osd) osd.setBounds(b);
}
function createLayers() {
  const win = d.win();
  host = new BrowserWindow({
    parent: win, frame: false, show: false, skipTaskbar: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, focusable: false, backgroundColor: "#000000", hasShadow: false,
  });
  osd = new BrowserWindow({
    parent: host, frame: false, show: false, skipTaskbar: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
    webPreferences: { preload: d.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  osd.webContents.on("before-input-event", d.onShortcut);
  osd.webContents.on("will-navigate", (e) => e.preventDefault());
  place();
  for (const ev of ["move", "resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "restore"]) win.on(ev, place);
  win.on("minimize", onMin);
  win.on("restore", onRestore);
}
function onMin() { if (host) host.hide(); }
function onRestore() { if (host) { host.showInactive(); if (osd) osd.show(); } }
function destroyLayers() {
  const win = d.win();
  for (const ev of ["move", "resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "restore"]) win.removeListener(ev, place);
  win.removeListener("minimize", onMin);
  win.removeListener("restore", onRestore);
  if (osd && !osd.isDestroyed()) osd.destroy();
  if (host && !host.isDestroyed()) host.destroy();
  osd = null; host = null;
}

// ---- mpv and its control pipe -------------------------------------------------------
// mpv's control pipe takes a moment to appear: commands wait for it (up to 8 s).
let pipeReady = null, pipeReadyResolve = null;
function resetPipeReady() { pipeReady = new Promise((r) => { pipeReadyResolve = r; }); }
resetPipeReady();
async function send(command) {
  if (!pipe) await Promise.race([pipeReady, new Promise((r) => setTimeout(r, 8000))]);
  return new Promise((resolve) => {
    if (!pipe) return resolve(null);
    const id = ++reqId;
    pending.set(id, resolve);
    pipe.write(JSON.stringify({ command, request_id: id }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 4000);
  });
}
function toOsd(msg) { if (osd && !osd.isDestroyed()) osd.webContents.send("native:event", msg); }
function onLine(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.request_id && pending.has(m.request_id)) { pending.get(m.request_id)(m); pending.delete(m.request_id); return; }
  if (m.event === "property-change") toOsd({ prop: m.name, value: m.data });
  else if (m.event === "end-file") toOsd({ event: "end-file", reason: m.reason });
  else if (m.event === "file-loaded") toOsd({ event: "file-loaded" });
}
function connectPipe(tries = 0) {
  const c = net.connect(pipeName);
  c.on("connect", () => {
    pipe = c;
    pipeReadyResolve();
    for (const [i, prop] of ["time-pos", "pause", "duration", "paused-for-cache", "track-list", "eof-reached"].entries()) {
      send(["observe_property", i + 1, prop]);
    }
  });
  c.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let n;
    while ((n = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); if (line.trim()) onLine(line); }
  });
  c.on("error", () => { if (!pipe && tries < 40 && proc) setTimeout(() => connectPipe(tries + 1), 150); });
  c.on("close", () => { if (pipe === c) pipe = null; });
}

// mpv options from PlexDeck's settings (picture, sound, subtitles).
function settingsArgs(c) {
  const a = ["--vo=gpu-next"];
  a.push(`--target-colorspace-hint=${c.hdr === false ? "no" : "yes"}`);
  a.push(`--hwdec=${c.hwDecode === "off" ? "no" : c.hwDecode === "d3d11" ? "d3d11va" : "auto-safe"}`);
  if (c.passthrough === "dolby-dts") a.push("--audio-spdif=ac3,eac3,dts", "--audio-exclusive=yes");
  if (c.passthrough === "all") a.push("--audio-spdif=ac3,eac3,dts,dts-hd,truehd", "--audio-exclusive=yes");
  a.push(`--volume=${Math.max(0, Math.min(100, Number(c.defaultVolume) || 100))}`);
  const size = { Small: 0.8, Normal: 1, Large: 1.3, Huge: 1.6 }[c.subSize] || 1;
  const colour = { White: "#FFFFFF", Yellow: "#FFE14D", Cyan: "#7FE7FF", Green: "#8CFF8C", Gray: "#C8C8C8" }[c.subColor] || "#FFFFFF";
  a.push(`--sub-scale=${size}`, `--sub-color=${colour}`, `--sub-pos=${c.subPosition === "Raised" ? 88 : 100}`);
  if (c.subBackground) a.push("--sub-border-style=background-box", "--sub-back-color=#B0000000");
  return a;
}

// Start playing: the layers, mpv inside the bottom one, our controls loaded on top.
function open(item) {
  const exe = mpvPath();
  if (!exe) return false;
  if (proc) stop();
  resetPipeReady();
  createLayers();
  const hwnd = host.getNativeWindowHandle();
  const wid = process.arch === "x64" ? hwnd.readBigUInt64LE(0).toString() : String(hwnd.readUInt32LE(0));
  pipeName = `\\\\.\\pipe\\plexplayer-mpv-${process.pid}-${Date.now()}`;
  const args = [
    `--wid=${wid}`, `--input-ipc-server=${pipeName}`, "--idle=yes", "--force-window=yes",
    "--no-osc", "--osd-level=0", "--no-input-default-bindings", "--input-vo-keyboard=no", "--no-input-cursor",
    "--cursor-autohide=always", "--hwdec=auto-safe", "--keep-open=yes", "--cache=yes",
    "--demuxer-max-bytes=200MiB", "--audio-display=no", "--no-terminal", "--sub-auto=no",
    ...settingsArgs(d.config()),
  ];
  proc = spawn(exe, args, { windowsHide: true, stdio: "ignore" });
  proc.on("exit", () => { proc = null; pipe = null; if (osd) toOsd({ event: "mpv-exit" }); });
  host.showInactive();
  // What to play goes along in the address, so the controls have it as soon as they're ready.
  osd.loadFile(path.join(__dirname, "tv.html"), { query: { osd: "1", key: String(item.key || ""), resume: item.resume ? "1" : "0", at: item.at != null ? String(item.at) : "" } });
  osd.webContents.once("did-finish-load", () => { osd.show(); osd.focus(); });
  setTimeout(() => connectPipe(), 200);
  return true;
}
function stop() {
  if (d.config().matchRefresh) refresh.restore();
  if (pipe) { try { pipe.write(JSON.stringify({ command: ["quit"] }) + "\n"); } catch {} }
  const p = proc;
  setTimeout(() => { try { if (p && !p.killed) p.kill(); } catch {} }, 800);
  proc = null; pipe = null;
  destroyLayers();
}

function init(deps) {
  d = deps;
  const fromOsd = (e) => osd && e.sender === osd.webContents;
  ipcMain.handle("native:available", () => available());
  // The controls tell us the video's frame rate once it's loaded.
  ipcMain.on("native:fps", async (e, fps) => {
    if (!fromOsd(e) || !d.config().matchRefresh || !(fps > 10 && fps < 130)) return;
    await refresh.match(Number(fps));
    setTimeout(place, 1500);   // the window may move while the screen switches
  });
  // Track preferences for the controls (languages).
  ipcMain.handle("native:prefs", (e) => {
    if (!fromOsd(e)) return null;
    const c = d.config();
    return { preferredAudioLang: c.preferredAudioLang, autoSubtitles: c.autoSubtitles, preferredSubtitleLang: c.preferredSubtitleLang, preferNonSdh: c.preferNonSdh };
  });
  ipcMain.on("native:play", (e, item) => {
    const tv = d.tvView();
    if (!tv || e.sender !== tv.webContents) return;
    origin = "tv";
    if (!open(item)) tv.webContents.send("native:failed", item);
  });
  // PC mode: Plex's player started one of your server's videos — continue it in mpv.
  ipcMain.on("native:play-from-pc", (e, item) => {
    if (e.sender !== d.plexContents() || !item || !/^\d+$/.test(String(item.key))) return;
    if (d.config().pcPlayerEngine === "plex" || !available()) return;
    origin = "pc";
    open({ key: String(item.key), at: Math.max(0, Number(item.at) || 0) });
  });
  ipcMain.handle("native:pc-enabled", (e) => e.sender === d.plexContents() && d.config().pcPlayerEngine !== "plex" && available());
  // Commands from our controls, passed to mpv as they are (only these ones).
  const ALLOWED = new Set(["loadfile", "set_property", "get_property", "seek", "sub-add", "cycle", "stop"]);
  ipcMain.handle("native:cmd", async (e, command) => {
    if (!fromOsd(e) || !Array.isArray(command) || !ALLOWED.has(command[0])) return null;
    const r = await send(command);
    return r ? r.data ?? null : null;
  });
  // Our controls closed the player: back to TV mode.
  ipcMain.on("native:close", (e, changed) => {
    if (!fromOsd(e)) return;
    stop();
    if (origin === "pc") { const wc = d.plexContents(); wc.focus(); wc.send("plex:native-closed"); }
    else d.onClosed(!!changed);
  });
  // The controls couldn't play it with mpv: let TV mode use the built-in player.
  ipcMain.on("native:fallback", (e, item) => {
    if (!fromOsd(e)) return;
    stop();
    if (origin === "pc") { d.plexContents().send("plex:native-failed", item); return; }
    const tv = d.tvView();
    if (tv) tv.webContents.send("native:failed", item);
  });
  app.on("before-quit", () => { if (proc) stop(); });
}

module.exports = { init, available, stop, isOpen: () => !!host };
