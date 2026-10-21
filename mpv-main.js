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

const { BrowserWindow, ipcMain, app, screen } = require("electron");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const fs = require("fs");
const refresh = require("./refresh");

let d = null;           // from main.js: win(), contentBounds(), preload, tvView(), onClosed()
let host = null;        // the window mpv draws into
let osd = null;         // our controls, on top
let origin = "tv";      // where playback started: "tv" or "pc"
let mini = false;       // PC mode: playing small in a corner while you browse
let lastFps = 0;        // the video's frame rate (refresh-rate matching after the mini player)
let lastVideo = null;   // { fps, hdrVideo } from Plex, for the screen (see prepareDisplay)
let screenLook = null;  // the screen PlexDeck plays on and how it is: looked at while the player opens
let rateDone = false;   // prepareDisplay() already matched the refresh rate for this video
const now = { paused: false, title: "" };   // for the tray menu
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
// Mini player: 16:9 in a corner of the window, three sizes; corner and size are remembered.
const MINI_WIDTHS = [320, 480, 640];
const CORNERS = ["br", "bl", "tr", "tl"];
function miniPrefs() {
  const m = d.config().miniPlayer || {};
  return { corner: CORNERS.includes(m.corner) ? m.corner : "br", size: [0, 1, 2].includes(m.size) ? m.size : 1 };
}
function miniBounds() {
  const b = d.contentBounds(), m = miniPrefs(), pad = 16;
  const width = Math.max(240, Math.min(MINI_WIDTHS[m.size], Math.round(b.width * 0.6)));
  const height = Math.round((width * 9) / 16);
  return {
    x: m.corner.includes("r") ? b.x + b.width - width - pad : b.x + pad,
    y: m.corner.includes("b") ? b.y + b.height - height - pad : b.y + pad,
    width, height,
  };
}
function place() {
  if (!host) return;
  const b = mini ? miniBounds() : d.contentBounds();
  host.setBounds(b);
  if (osd) osd.setBounds(b);
}
function setMini(on) {
  if (!host || origin !== "pc" || mini === !!on) return;
  mini = !!on;
  place();
  toOsd({ event: "mini", value: mini });
  if (mini) {
    // Browsing again: Plex gets the keyboard; the screen goes back to its own refresh rate.
    restoreDisplay();
    d.win().focus();
    d.plexContents().focus();
  } else {
    osd.focus();
    if (lastVideo) prepareDisplay();
    else if (d.config().matchRefresh && lastFps) refresh.match(lastFps).then(() => setTimeout(place, 1500));
  }
}
function createLayers() {
  const win = d.win();
  mini = false;
  // mpv draws into this layer through its own child window. Chromium also puts its drawing
  // surface in here as a child window, on top of mpv's: transparent, so it doesn't cover the
  // picture with black (the sound played but the screen stayed black).
  host = new BrowserWindow({
    parent: win, frame: false, show: false, skipTaskbar: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, focusable: false, transparent: true, backgroundColor: "#00000000", hasShadow: false,
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
  if (m.event === "property-change") {
    if (m.name === "pause") now.paused = !!m.data;
    toOsd({ prop: m.name, value: m.data });
  }
  else if (m.event === "end-file") toOsd({ event: "end-file", reason: m.reason });
  else if (m.event === "file-loaded") { toOsd({ event: "file-loaded" }); armSpdifGuard(); }
}
function connectPipe(tries = 0) {
  const c = net.connect(pipeName);
  c.on("connect", () => {
    pipe = c;
    pipeReadyResolve();
    for (const [i, prop] of ["time-pos", "pause", "duration", "paused-for-cache", "track-list", "eof-reached", "playlist-pos"].entries()) {
      send(["observe_property", i + 1, prop]);
    }
    // Windows' media controls and the keyboard's media keys (mpv shows up in Windows' media
    // overlay by itself). Next / Previous go through mpv's playlist, see tv-player.js.
    for (const [key, cmd] of [["PLAY", "set pause no"], ["PAUSE", "set pause yes"], ["PLAYPAUSE", "cycle pause"]]) send(["keybind", key, cmd]);
  });
  c.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let n;
    while ((n = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, n); buf = buf.slice(n + 1); if (line.trim()) onLine(line); }
  });
  c.on("error", () => { if (!pipe && tries < 40 && proc) setTimeout(() => connectPipe(tries + 1), 150); });
  c.on("close", () => { if (pipe === c) pipe = null; });
}

// Passthrough guard: some outputs (optical S/PDIF) can't take E-AC3 / TrueHD / DTS-HD, and
// mpv then waits for ever — no sound device, the picture stuck at 0:00. If a video hasn't got
// its sound going a few seconds after it loads, step passthrough down (AC3 / DTS, then none).
let spdifTimer = null;
function armSpdifGuard() {
  clearTimeout(spdifTimer);
  if (!d.config().passthrough || d.config().passthrough === "off") return;
  spdifTimer = setTimeout(async () => {
    if (!pipe) return;
    const get = async (p) => { const r = await send(["get_property", p]); return r && r.error === "success" ? r.data : null; };
    const [ao, aid, paused, t, spdif] = await Promise.all([get("current-ao"), get("aid"), get("pause"), get("time-pos"), get("audio-spdif")]);
    if (ao || aid === false || aid === "no" || paused || (t || 0) > 0.5 || !spdif) return;   // fine, no sound to play, or paused
    const next = /eac3|truehd|dts-hd/.test(spdif) ? "ac3,dts" : "";
    await send(["set_property", "audio-spdif", next]);
    if (next) armSpdifGuard();   // still nothing? then without passthrough
  }, 3500);
}

// mpv options from PlexDeck's settings (picture, sound, subtitles).
function settingsArgs(c) {
  const a = ["--vo=gpu-next"];
  a.push(`--target-colorspace-hint=${c.hdr === false ? "no" : "yes"}`);
  a.push(`--hwdec=${c.hwDecode === "off" ? "no" : c.hwDecode === "d3d11" ? "d3d11va" : "auto-safe"}`);
  if (c.passthrough === "dolby-dts") a.push("--audio-spdif=ac3,eac3,dts", "--audio-exclusive=yes");
  if (c.passthrough === "all") a.push("--audio-spdif=ac3,eac3,dts,dts-hd,truehd", "--audio-exclusive=yes");
  // Speakers: Automatic = Windows' speaker setup for the device. Stereo / 5.1 / 7.1 work whatever
  // Windows is set to — only possible with the device to ourselves (exclusive mode; in shared
  // mode Windows keeps its own layout, e.g. 5.1 even when stereo is asked for). 5.1 / 7.1 mean
  // "up to": a 5.1 or stereo source goes out as it is (the receiver can then upmix it its way).
  const layouts = { stereo: "stereo", "5.1": "5.1,stereo", "7.1": "7.1,5.1,stereo" }[c.audioChannels];
  if (layouts) a.push(`--audio-channels=${layouts}`, "--audio-exclusive=yes");
  const vol = Number(c.defaultVolume);   // 0 is a real choice (it was taken as "not set" → 100)
  a.push(`--volume=${Number.isFinite(vol) && c.defaultVolume !== "" && c.defaultVolume != null ? Math.max(0, Math.min(100, vol)) : 100}`);
  const size = { Small: 0.8, Normal: 1, Large: 1.3, Huge: 1.6 }[c.subSize] || 1;
  const colour = { White: "#FFFFFF", Yellow: "#FFE14D", Cyan: "#7FE7FF", Green: "#8CFF8C", Gray: "#C8C8C8" }[c.subColor] || "#FFFFFF";
  a.push(`--sub-scale=${size}`, `--sub-color=${colour}`, `--sub-pos=${c.subPosition === "Raised" ? 88 : 100}`);
  if (c.subBackground) a.push("--sub-border-style=background-box", "--sub-back-color=#B0000000");
  return a;
}

const hwndOf = (w) => { const b = w.getNativeWindowHandle(); return process.arch === "x64" ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0)); };

// ---- the screen while a video plays (like a Shield) -----------------------------------
// Before the video starts (its frame rate and HDR from Plex), by your settings: the screen's
// full resolution (a 4K TV the PC runs at 1080p), a refresh rate that fits the video, Windows
// HDR on for HDR videos. Only in full screen, only the screen PlexDeck is on. Put back when the
// player closes (or goes small). While switched it's written down, so a crash is undone at the
// next start.
const DISPLAY_FILE = () => path.join(app.getPath("userData"), "display-restore.json");
function rememberDisplay() {
  const info = refresh.pending();
  try { if (info) fs.writeFileSync(DISPLAY_FILE(), JSON.stringify(info)); else fs.rmSync(DISPLAY_FILE(), { force: true }); } catch {}
}
// The main window fills the screen again after the screen changed (and the layers follow).
function refit() {
  const win = d.win();
  if (win && !win.isDestroyed() && win.isFullScreen()) {
    const b = screen.getDisplayMatching(win.getBounds()).bounds, w = win.getBounds();
    if (w.x !== b.x || w.y !== b.y || w.width !== b.width || w.height !== b.height) win.setBounds(b);
  }
  place();
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function prepareDisplay() {
  const c = d.config(), win = d.win();
  if (!lastVideo || mini || !proc || !win.isFullScreen()) return false;
  if (!c.videoNativeRes && !c.autoHdr && !c.matchRefresh) return false;
  const s = await (screenLook || (screenLook = refresh.look(hwndOf(win))));
  if (!s || !proc) return false;
  if (lastVideo.fps && c.matchRefresh) rateDone = true;
  const done = await refresh.prepare(s, { ...lastVideo, native: !!c.videoNativeRes, matchRate: !!c.matchRefresh, autoHdr: !!c.autoHdr && c.hdr !== false });
  rememberDisplay();
  if (!done) return false;
  // the TV (and a receiver in between) take a moment to show the new signal
  await wait(1200); refit();
  await wait(1600); refit();
  return true;
}
// NVIDIA's AI picture (an RTX card, through Windows' video processor, mpv's d3d11vpp): Super
// Resolution upscales a video smaller than the screen (like a Shield's AI upscaling); Video HDR
// turns SDR into HDR — only when the screen shows HDR, else it'd be turned back into SDR.
// Needs the GPU's own decoding (d3d11va); without it mpv drops the filter and plays on.
async function setRtx({ width, height, rtxHdr }) {
  const c = d.config(), parts = [];
  if (c.hwDecode !== "off" && host) {
    const b = host.getBounds(), sf = screen.getDisplayMatching(b).scaleFactor;
    const k = width && height ? Math.min((b.width * sf) / width, (b.height * sf) / height) : 0;
    if (c.rtxUpscale && k > 1.1) parts.push(`scale=${Math.min(4, k).toFixed(3)}`, "scaling-mode=nvidia");
    if (rtxHdr) {
      const s = await (screenLook || (screenLook = refresh.look(hwndOf(d.win()))));
      if (s && s.hdr === 1) parts.push("nvidia-true-hdr");
    }
  }
  await send(["set_property", "vf", parts.length ? `d3d11vpp=${parts.join(":")}` : ""]);
}
function restoreDisplay() {
  screenLook = null;
  if (!refresh.pending()) return;
  refresh.restore().then(() => { setTimeout(refit, 1500); setTimeout(refit, 3500); });
  rememberDisplay();
}

// Start playing: the layers, mpv inside the bottom one, our controls loaded on top.
function open(item) {
  const exe = mpvPath();
  if (!exe) return false;
  if (proc) stop();
  resetPipeReady();
  const mpvDir = path.join(app.getPath("userData"), "mpv");
  try { fs.mkdirSync(path.join(mpvDir, "cache"), { recursive: true }); } catch {}
  createLayers();
  const wid = hwndOf(host);
  pipeName = `\\\\.\\pipe\\plexplayer-mpv-${process.pid}-${Date.now()}`;
  const args = [
    `--wid=${wid}`, `--input-ipc-server=${pipeName}`, "--idle=yes", "--force-window=yes",
    "--no-osc", "--osd-level=0", "--no-input-default-bindings", "--input-vo-keyboard=no", "--no-input-cursor",
    "--cursor-autohide=always", "--hwdec=auto-safe", "--keep-open=always", "--cache=yes", "--media-controls=yes",
    "--demuxer-max-bytes=200MiB", "--audio-display=no", "--no-terminal", "--sub-auto=no",
    // mpv's own settings and caches live in PlexDeck's data folder (for the portable
    // version: inside its folder), not in %APPDATA% / %LOCALAPPDATA%\mpv.
    `--config-dir=${mpvDir}`, `--gpu-shader-cache-dir=${path.join(mpvDir, "cache")}`, `--icc-cache-dir=${path.join(mpvDir, "cache")}`,
    `--watch-later-dir=${path.join(mpvDir, "watch_later")}`,
    ...settingsArgs(d.config()),
  ];
  now.paused = false; now.title = ""; lastFps = 0; lastVideo = null; rateDone = false;
  // which screen, and how it is now — ready by the time the video's details are in
  const win = d.win();
  screenLook = win.isFullScreen() ? refresh.look(hwndOf(win)) : null;
  const child = proc = spawn(exe, args, { windowsHide: true, stdio: "ignore" });
  // Only if it's still the current mpv: the previous one closes a moment after the next one
  // starts, and must not make us forget the new one (then it never got stopped, and played on).
  child.on("exit", () => { if (proc !== child) return; proc = null; pipe = null; if (osd) toOsd({ event: "mpv-exit" }); });
  host.showInactive();
  // What to play goes along in the address, so the controls have it as soon as they're ready.
  osd.loadFile(path.join(__dirname, "tv.html"), { query: {
    osd: "1", key: String(item.key || ""), resume: item.resume ? "1" : "0", at: item.at != null ? String(item.at) : "", pc: origin === "pc" ? "1" : "0",
  } });
  osd.webContents.once("did-finish-load", () => { osd.show(); osd.focus(); });
  setTimeout(() => connectPipe(), 200);
  return true;
}
function stop() {
  clearTimeout(spdifTimer);
  restoreDisplay();
  if (pipe) { try { pipe.write(JSON.stringify({ command: ["quit"] }) + "\n"); } catch {} }
  const p = proc;
  setTimeout(() => { try { if (p && !p.killed) p.kill(); } catch {} }, 800);
  proc = null; pipe = null;
  // Back to the main window BEFORE the layers go. With the focused controls gone, Windows
  // looked for another window to activate (the video layer can't take focus) and sometimes
  // picked one outside PlexDeck — then the taskbar stayed on top of PlexDeck's full screen
  // (Windows only hides it for the window in front). Only when PlexDeck is in front anyway.
  const win = d.win(), focused = BrowserWindow.getFocusedWindow();
  const front = !!focused && (focused === osd || focused === host || focused === win) && win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
  if (front) win.focus();
  destroyLayers();
  if (front) setTimeout(() => { if (!win.isDestroyed() && !proc && !BrowserWindow.getFocusedWindow()) { win.moveTop(); win.focus(); } }, 200);
}

// What the sound device gets from a 7.1 source with your settings: a second of silent
// test tone, then mpv says which device and layout it opened ("5.1 · DENON-AVR").
let audioInfo = null;
function probeAudio() {
  const audioArgs = settingsArgs(d.config()).filter((x) => /^--audio-(channels|exclusive)/.test(x));
  const key = audioArgs.join(" ");
  if (audioInfo && audioInfo.key === key && Date.now() - audioInfo.at < 30000) return Promise.resolve(audioInfo);
  const exe = mpvPath();
  if (!exe) return Promise.resolve(null);
  const args = ["--no-config", "--vo=null", "--volume=0", "--length=0.4", "--msg-level=all=no,cplayer=info,ao/wasapi=v", ...audioArgs,
    "av://lavfi:sine=frequency=440:sample_rate=48000,aformat=channel_layouts=7.1"];
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(exe, args, { windowsHide: true });
    p.stdout.on("data", (b) => { out += b; });
    p.stderr.on("data", (b) => { out += b; });
    const done = () => {
      const ao = /AO: \[\w+\] (\d+)Hz (\S+) (\d+)ch/.exec(out);
      const dev = /Selecting device '[^']*' \((.+)\)\s*$/m.exec(out);
      audioInfo = ao ? { key, at: Date.now(), layout: ao[2], channels: Number(ao[3]), device: dev ? dev[1].replace(/ \((?:NVIDIA|AMD|Intel|Realtek)[^)]*\)$/i, "") : "" } : null;
      resolve(audioInfo);
    };
    p.on("exit", done);
    p.on("error", () => resolve(null));
    setTimeout(() => { try { p.kill(); } catch {} }, 8000);
  });
}

function init(deps) {
  d = deps;
  // PlexDeck closed while a video had the screen switched: put it back (only what's still ours)
  let saved = null;
  try { saved = fs.readFileSync(DISPLAY_FILE(), "utf8"); fs.rmSync(DISPLAY_FILE(), { force: true }); } catch {}
  try { if (saved) refresh.restoreAfterCrash(JSON.parse(saved)); } catch {}
  ipcMain.handle("native:audio-info", (e) => {
    const tv = d.tvView();
    if (!tv || e.sender !== tv.webContents || proc) return audioInfo;   // not while a video plays
    return probeAudio();
  });
  const fromOsd = (e) => osd && e.sender === osd.webContents;
  ipcMain.handle("native:available", () => available());
  // The controls tell us the video's frame rate once it's loaded.
  // The controls, just before loading the video: its frame rate and HDR from Plex. Answers once
  // the screen is ready (switched or not).
  ipcMain.handle("native:prepare", async (e, v) => {
    if (!fromOsd(e)) return false;
    const c = d.config(), fps = Number(v && v.fps), hdr = !!(v && v.hdr);
    // RTX Video HDR makes an SDR video HDR — so the screen gets Windows HDR for it too
    const rtxHdr = !hdr && !!c.rtxHdr && c.hwDecode !== "off" && c.hdr !== false;
    lastVideo = { fps: fps > 10 && fps < 130 ? fps : 0, hdrVideo: hdr || rtxHdr };
    let switched = false;
    try { switched = await prepareDisplay(); } catch {}
    try { await setRtx({ width: Number(v && v.width) || 0, height: Number(v && v.height) || 0, rtxHdr }); } catch {}
    return switched;
  });
  ipcMain.on("native:fps", async (e, fps) => {
    if (!fromOsd(e) || !(fps > 10 && fps < 130)) return;
    lastFps = Number(fps);
    if (!d.config().matchRefresh || mini || rateDone) return;
    await refresh.match(lastFps);
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
  const ALLOWED = new Set(["loadfile", "set_property", "get_property", "seek", "sub-add", "cycle", "stop", "playlist-clear"]);
  ipcMain.handle("native:cmd", async (e, command) => {
    if (!fromOsd(e) || !Array.isArray(command) || !ALLOWED.has(command[0])) return null;
    if (command[0] === "set_property" && command[1] === "force-media-title") now.title = String(command[2] || "");
    const r = await send(command);
    return r ? r.data ?? null : null;
  });
  // Mini player (PC mode): on / off, a bigger or smaller size, and dragging it to another corner.
  ipcMain.on("native:mini", (e, on) => { if (fromOsd(e)) setMini(on); });
  ipcMain.on("native:mini-size", (e) => {
    if (!fromOsd(e) || !mini) return;
    const m = miniPrefs();
    d.saveConfig({ miniPlayer: { ...m, size: (m.size + 1) % MINI_WIDTHS.length } });
    place();
  });
  ipcMain.on("native:mini-drag", (e, { dx, dy } = {}) => {
    if (!fromOsd(e) || !mini || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const b = host.getBounds();
    const moved = { ...b, x: Math.round(b.x + dx), y: Math.round(b.y + dy) };
    host.setBounds(moved);
    osd.setBounds(moved);
  });
  ipcMain.on("native:mini-drop", (e) => {
    if (!fromOsd(e) || !mini) return;
    // Snap to the corner nearest to where it was dropped.
    const b = host.getBounds(), c = d.contentBounds();
    const right = b.x + b.width / 2 > c.x + c.width / 2, bottom = b.y + b.height / 2 > c.y + c.height / 2;
    d.saveConfig({ miniPlayer: { ...miniPrefs(), corner: `${bottom ? "b" : "t"}${right ? "r" : "l"}` } });
    place();
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

// The tray menu: what's playing, and play/pause / back / forward.
function state() { return { active: true, playing: !now.paused, title: now.title, artist: "" }; }
function command(cmd) {
  const c = { toggle: ["cycle", "pause"], back: ["seek", -10, "relative"], forward: ["seek", 30, "relative"] }[cmd];
  if (c && pipe) send(c);
}

// The player's controls, when they should have the keyboard / controller (not in the mini player).
const controls = () => (osd && !osd.isDestroyed() && !mini ? osd : null);
module.exports = { init, available, stop, isOpen: () => !!host, state, command, controls };
