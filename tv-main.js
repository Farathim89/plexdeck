// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// TV mode — the app side.
//
// PlexDeck has two modes:
//   PC — the official Plex web app (mouse & keyboard), with our extras.
//   TV — our own controller-first interface (tv.html), built like Plex's TV
//        apps. It talks to your Plex server through Plex's API, using the
//        sign-in Plex Web already has. To play something it hands over to
//        Plex Web's player (with the controller layer) and comes back after.
//
// This file: switching modes, finding your server, API calls for tv.html,
// and the playback hand-over.
// ===========================================================================

const { WebContentsView, ipcMain, net, safeStorage, app, session: electronSession } = require("electron");
const fs = require("fs");
const i18n = require("./i18n");
const path = require("path");
const crypto = require("crypto");

let d = null;              // what main.js gives us (see init)
let tvView = null;         // tv.html
let mode = "pc";
let playingFromTv = false; // Plex Web's player was started from TV mode
let session = null;        // { uri, token, machineId, serverName, accountToken, user }
let profileToken = null;
let linkToken = null;      // signed in with a code (plex.tv/link) in TV mode, this run
let watchlistCache = null; // { at, data }
const profileFile = () => path.join(app.getPath("userData"), "tv-profile.json");
function saveProfile(token, user) {
  try {
    if (!token) { fs.rmSync(profileFile(), { force: true }); return; }
    if (!safeStorage.isEncryptionAvailable()) return;   // never store it in plain text
    const data = safeStorage.encryptString(token).toString("base64");
    fs.writeFileSync(profileFile(), JSON.stringify({ user, data }));
  } catch {}
}
function loadProfile() {
  try {
    const d = JSON.parse(fs.readFileSync(profileFile(), "utf8"));
    return safeStorage.decryptString(Buffer.from(d.data, "base64"));
  } catch { return null; }
}   // a Plex Home user picked in TV mode (Plex Web keeps its own)
let sessionPromise = null;

const PRODUCT = "PlexDeck";

function clientId() {
  if (!d.config().clientId) d.setConfig({ clientId: crypto.randomUUID() });
  return d.config().clientId;
}
function plexHeaders(token) {
  return {
    Accept: "application/json",
    "X-Plex-Token": token,
    "X-Plex-Client-Identifier": clientId(),
    "X-Plex-Product": PRODUCT,
    "X-Plex-Device-Name": "PlexDeck TV",
    "X-Plex-Platform": "Windows",
    "X-Plex-Language": i18n.current().lang,   // the server's own row titles ("Continue Watching") in that language
  };
}
async function fetchJson(url, token, timeoutMs = 8000, method = "GET") {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await net.fetch(url, { method, headers: plexHeaders(token), signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

// ---- finding your server -----------------------------------------------------
// The account token comes from Plex Web (it's already signed in there). Then
// plex.tv lists your servers; we pick yours and the fastest address that answers.
async function readAccountToken() {
  await d.plexReady();
  const wc = d.plexContents();
  if (!wc || wc.isDestroyed()) return null;
  // Not signed in, Plex Web still keeps a guest token (an anonymous account, for its free films and TV):
  // that's no account of yours - it has no servers - so it counts as not signed in.
  try {
    const got = await wc.executeJavaScript(`(() => {
      const token = localStorage.getItem('myPlexAccessToken');
      let anonymous = false;
      try {
        const users = JSON.parse(localStorage.getItem('users') || '{}').users || [];
        const me = users.find((u) => u.authToken === token);
        anonymous = !!(me && me.anonymous);
      } catch {}
      return { token, anonymous };
    })()`);
    return got && got.token && !got.anonymous ? got.token : null;
  } catch { return null; }
}
// Plex Web's sign-in, or the one TV mode just got with a code (this run only: Plex Web keeps it from then on)
async function signedInToken() { return (await readAccountToken()) || linkToken; }
// Plex Web signs in the same way itself: the token in its storage, then a reload.
async function signInPlexWeb(token) {
  const wc = d.plexContents();
  if (!wc || wc.isDestroyed()) return;
  const loaded = () => new Promise((res) => { wc.once("did-finish-load", res); setTimeout(res, 20000); });
  try {
    const home = d.plexUrl();
    if (new URL(wc.getURL()).origin !== new URL(home).origin) { const l = loaded(); wc.loadURL(home); await l; }
    // (its guest user goes, like Plex Web's own reset before a sign-in)
    await wc.executeJavaScript(`(() => {
      try { const u = JSON.parse(localStorage.getItem('users') || '{}').users || []; if (u.every((x) => x.anonymous)) localStorage.removeItem('users'); } catch {}
      localStorage.setItem('myPlexAccessToken', ${JSON.stringify(token)});
      return true;
    })()`);
    const l = loaded(); wc.reload(); await l;
  } catch {}
}
async function connectSession() {
  const accountToken = profileToken || await signedInToken();
  if (!accountToken) throw new Error("signin");
  const resources = await fetchJson("https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1", accountToken);
  const servers = (Array.isArray(resources) ? resources : []).filter((r) => String(r.provides || "").includes("server"));
  if (!servers.length) throw new Error("noserver");
  // Prefer the server PlexDeck was set up with, then one you own.
  const wanted = (() => { try { return new URL(d.config().serverUrl).hostname; } catch { return ""; } })();
  servers.sort((a, b) => {
    const aw = a.connections.some((c) => c.uri.includes(wanted)) ? 0 : 1;
    const bw = b.connections.some((c) => c.uri.includes(wanted)) ? 0 : 1;
    return (aw - bw) || ((b.owned ? 1 : 0) - (a.owned ? 1 : 0));
  });
  for (const server of servers) {
    const token = server.accessToken || accountToken;
    // Home network first, then remote, the Plex relay last.
    const conns = [...server.connections].sort((a, b) =>
      ((a.relay ? 2 : 0) + (a.local ? 0 : 1)) - ((b.relay ? 2 : 0) + (b.local ? 0 : 1)));
    for (const c of conns) {
      try {
        await fetchJson(`${c.uri}/identity`, token, 3500);
        let user = null;
        try { user = await fetchJson("https://plex.tv/api/v2/user", accountToken); } catch {}
        return {
          uri: c.uri, token, machineId: server.clientIdentifier, serverName: server.name, accountToken,
          user: user ? { name: user.title || user.username || "", thumb: user.thumb || "" } : null,
        };
      } catch {}
    }
  }
  throw new Error("unreachable");
}
function getSession(force = false) {
  if (force) { session = null; sessionPromise = null; }
  if (session) return Promise.resolve(session);
  if (!sessionPromise) {
    sessionPromise = connectSession()
      .catch(async (err) => {
        if (!profileToken) throw err;
        profileToken = null; saveProfile(null);
        return connectSession();
      })
      .then((s) => { session = s; return s; })
      .finally(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

// ---- modes -------------------------------------------------------------------
function createTvView() {
  tvView = new WebContentsView({
    webPreferences: { preload: d.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  tvView.setBackgroundColor("#101010");
  d.win().contentView.addChildView(tvView);
  tvView.webContents.on("before-input-event", d.onShortcut);
  tvView.webContents.on("will-navigate", (e) => e.preventDefault());
  tvView.webContents.loadFile(path.join(__dirname, "tv.html"));
  d.layout();
}
function setMode(next, { remember = true } = {}) {
  if (next !== "pc" && next !== "tv") return;
  mode = next;
  if (next === "tv") {
    if (!tvView) createTvView();
    tvView.setVisible(true);
    // Keep the settings / loading screens above it.
    d.raiseOverlays();
    tvView.webContents.focus();
    tvView.webContents.send("tv:shown");
  } else if (tvView) {
    tvView.setVisible(false);
    d.plexContents().focus();
  }
  if (remember) d.setConfig({ lastMode: next });
  d.titlebar().send("titlebar:mode", next);
  try { d.plexContents().send("plex:app-mode", next); } catch {}   // Plex leaves the controller alone in TV mode
}
function startMode() {
  const c = d.config();
  const pick = c.startMode === "tv" || c.startMode === "pc" ? c.startMode : (c.lastMode || "pc");
  if (pick === "tv") setMode("tv", { remember: false });
  else d.titlebar().send("titlebar:mode", "pc");
}

// ---- playing: hand over to Plex Web's player, come back after ----------------
function play({ ratingKey, resume }) {
  if (!session || !ratingKey) return;
  playingFromTv = true;
  const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
  const wc = d.plexContents();
  const hash = `#!/server/${session.machineId}/details?key=${key}`;
  wc.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
  wc.send("plex:autoplay", { resume: !!resume });
  if (tvView) tvView.setVisible(false);
  wc.focus();
  d.titlebar().send("titlebar:mode", "tv");
}
// Open something in PC mode (Search, Watchlist… until TV mode has them).
function openInPc(hash) {
  setMode("pc");
  const wc = d.plexContents();
  if (hash) wc.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
}

function init(deps) {
  d = deps;
  profileToken = loadProfile();
  const fromTv = (e) => tvView && e.sender === tvView.webContents;
  // TV mode and our own tool pages (audio & subtitle tool) may use the server API.
  const fromApiPage = (e) => {
    if (fromTv(e)) return true;
    try { return /\/(tracks\.html(\?|$)|tv\.html\?osd=1)/.test(e.senderFrame.url) && e.senderFrame.url.startsWith("file:"); } catch { return false; }
  };

  // A song's lyrics (an .lrc / .txt file or Plex's lyrics, as plain text).
  ipcMain.handle("tv:lyrics", async (e, streamId) => {
    if (!fromTv(e) || !/^\d+$/.test(String(streamId))) return null;
    const s = await getSession();
    const res = await net.fetch(`${s.uri}/library/streams/${streamId}`, { headers: plexHeaders(s.token) }).catch(() => null);
    if (!res || !res.ok) return null;
    return (await res.text()).slice(0, 200000);
  });
  // The music visualiser reads the sound of the song TV mode plays. A page may only do that
  // when the server allows it (CORS), and Plex only allows app.plex.tv, so for TV mode's own
  // music requests to your server the app adds that permission itself.
  electronSession.defaultSession.webRequest.onHeadersReceived(
    { urls: ["*://*/library/parts/*", "*://*/music/:/transcode/*"] },
    (details, callback) => {
      const ours = tvView && details.webContentsId === tvView.webContents.id && session && details.url.startsWith(session.uri);
      if (!ours) return callback({});
      const headers = Object.fromEntries(Object.entries(details.responseHeaders || {}).filter(([k]) => k.toLowerCase() !== "access-control-allow-origin"));
      headers["Access-Control-Allow-Origin"] = ["*"];
      callback({ responseHeaders: headers });
    });

  ipcMain.handle("tv:session", async (e, { force } = {}) => {
    if (!fromApiPage(e)) return null;
    try {
      const s = await getSession(!!force);
      return { ok: true, uri: s.uri, token: s.token, machineId: s.machineId, serverName: s.serverName, user: s.user, clientId: clientId() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  // GET a Plex API path (e.g. "/hubs") on your server, as JSON.
  ipcMain.handle("tv:api", async (e, { path: p, params, method } = {}) => {
    if (!fromApiPage(e) || typeof p !== "string" || !p.startsWith("/")) return null;
    // Only reading, plus the one change the audio & subtitle tool makes (track choice per file).
    // Allowed changes: the track choice per file, and adding to / creating / editing playlists.
    const ALLOW = [["PUT", /^\/library\/parts\/\d+$/], ["PUT", /^\/playlists\/\d+\/items$/], ["POST", /^\/playlists$/], ["DELETE", /^\/playlists\/\d+\/items\/\d+$/]];
    const m = ALLOW.some(([mm, re]) => mm === method && re.test(p)) ? method : "GET";
    const build = (s) => {
      const url = new URL(s.uri + p);
      for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
      return url.toString();
    };
    const s = await getSession();
    try {
      return await fetchJson(build(s), s.token, 15000, m);
    } catch (err) {
      if (m !== "GET") throw err;
      // Address stopped working (e.g. left the home network): find it again once.
      session = null;
      const s2 = await getSession();
      return fetchJson(build(s2), s2.token, 15000);
    }
  });
  // Your Plex Watchlist (it lives on your Plex account, not your server).
  ipcMain.handle("tv:watchlist", async (e) => {
    if (!fromTv(e)) return null;
    // Plex rate-limits this service hard: reuse the answer for a minute.
    if (watchlistCache && Date.now() - watchlistCache.at < 60000) return watchlistCache.data;
    const s = await getSession();
    const data = await fetchJson("https://discover.provider.plex.tv/library/sections/watchlist/all?X-Plex-Container-Start=0&X-Plex-Container-Size=50", s.accountToken, 15000);
    watchlistCache = { at: Date.now(), data };
    return data;
  });
  // Add / remove something on your Watchlist (the details page's bookmark button). id = the
  // item's Plex id (the last part of its plex:// guid).
  ipcMain.handle("tv:watchlist-set", async (e, { id, on } = {}) => {
    if (!fromTv(e) || !/^[0-9a-f]{12,40}$/i.test(String(id || ""))) return false;
    const s = await getSession();
    await fetchJson(`https://discover.provider.plex.tv/actions/${on ? "addToWatchlist" : "removeFromWatchlist"}?ratingKey=${id}`, s.accountToken, 15000, "PUT");
    watchlistCache = null;
    return true;
  });
  // Plex's online services for TV mode (read only): Live TV channels and Discover.
  const PROVIDERS = /^https:\/\/(epg|discover|metadata)\.provider\.plex\.tv\//;
  ipcMain.handle("tv:provider", async (e, url) => {
    if (!fromTv(e) || typeof url !== "string" || !PROVIDERS.test(url)) return null;
    const s = await getSession();
    return fetchJson(url, s.accountToken, 15000);
  });
  // Play something from Plex's online services: Plex's own player handles it, then back to TV mode.
  ipcMain.on("tv:play-provider", (e, hash, opts) => {
    if (!fromTv(e) || typeof hash !== "string" || !/^#!\/provider\/tv\.plex\.provider\.(epg|discover|vod)\//.test(hash)) return;
    playingFromTv = true;
    const wc = d.plexContents();
    wc.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
    wc.send("plex:autoplay", { resume: false, trailer: !!(opts && opts.trailer) });
    if (tvView) tvView.setVisible(false);
    wc.focus();
  });
  // Sign in with a code, like Plex's TV apps: plex.tv gives a 4-letter code, you enter it at
  // plex.tv/link on your phone, and the code then carries your sign-in. No mouse or keyboard needed.
  const linkFetch = async (url, method = "GET") => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await net.fetch(url, { method, signal: ctl.signal, headers: {
        Accept: "application/json", "X-Plex-Client-Identifier": clientId(), "X-Plex-Product": PRODUCT,
        "X-Plex-Device-Name": "PlexDeck TV", "X-Plex-Platform": "Windows", "X-Plex-Version": app.getVersion(),
      } });
      if (res.status === 404) return { gone: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  };
  ipcMain.handle("tv:link-code", async (e) => {
    if (!fromTv(e)) return null;
    const r = await linkFetch("https://plex.tv/api/v2/pins?strong=false", "POST");
    return r && r.id && r.code ? { id: r.id, code: r.code, expiresIn: Number(r.expiresIn) || 900 } : null;
  });
  ipcMain.handle("tv:link-check", async (e, id) => {
    if (!fromTv(e) || !/^\d+$/.test(String(id || ""))) return { state: "expired" };
    let r;
    try { r = await linkFetch(`https://plex.tv/api/v2/pins/${id}`); } catch { return { state: "waiting" }; }   // offline a moment
    if (r.gone || (!r.authToken && Number(r.expiresIn) <= 0)) return { state: "expired" };
    if (!r.authToken) return { state: "waiting" };
    linkToken = r.authToken;
    session = null; sessionPromise = null;
    await signInPlexWeb(r.authToken);   // PC mode is signed in too
    return { state: "linked" };
  });
  // Plex Home users, and switching to one (with its PIN if it has one).
  ipcMain.handle("tv:home-users", async (e) => {
    if (!fromTv(e)) return null;
    const token = await signedInToken();
    const r = await fetchJson("https://clients.plex.tv/api/v2/home/users", token, 15000);
    return (r.users || r || []).map((u) => ({ uuid: u.uuid, title: u.title || u.username, thumb: u.thumb, protected: !!u.protected, admin: !!u.admin }));
  });
  ipcMain.handle("tv:switch-user", async (e, { uuid, pin } = {}) => {
    if (!fromTv(e) || !/^[\w-]+$/.test(String(uuid || ""))) return { ok: false };
    const token = await signedInToken();
    const url = `https://clients.plex.tv/api/v2/home/users/${uuid}/switch${pin ? `?pin=${encodeURIComponent(String(pin))}` : ""}`;
    try {
      const r = await fetchJson(url, token, 15000, "POST");
      if (!r || !r.authToken) return { ok: false };
      profileToken = r.authToken;
      session = null;
      await getSession();
      saveProfile(profileToken, uuid);   // remembered for next time
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
  // PC mode: which of your server's items is Plex Web playing right now (and where)?
  ipcMain.handle("plex:my-session", async (e, { clientId } = {}) => {
    if (e.sender !== d.plexContents() || !clientId) return null;
    const s = await getSession();
    const r = await fetchJson(`${s.uri}/status/sessions`, s.token, 8000).catch(() => null);
    const list = (r && r.MediaContainer && r.MediaContainer.Metadata) || [];
    const mine = list.find((m) => m.Player && m.Player.machineIdentifier === clientId && m.type !== "track");
    return mine && mine.ratingKey ? { key: String(mine.ratingKey), offset: Number(mine.viewOffset) || 0 } : null;
  });
  ipcMain.on("tv:play", (e, item) => { if (fromTv(e)) play(item || {}); });
  ipcMain.on("tv:open-pc", (e, hash) => { if (fromTv(e)) openInPc(typeof hash === "string" ? hash : ""); });
  ipcMain.on("tv:settings", (e) => { if (fromTv(e)) d.openSettings(); });
  // TV mode's quit menu (Esc): quit for real, like the tray's Quit.
  ipcMain.on("tv:quit", (e) => { if (fromTv(e)) app.quit(); });
  // Plex asks which mode we're in when it (re)loads.
  ipcMain.handle("plex:app-mode", (e) => (e.sender === d.plexContents() ? mode : null));
  // A controller button in PC mode: over to TV mode (if switching by itself is on).
  ipcMain.on("plex:pad-used", (e) => {
    if (e.sender !== d.plexContents() || playingFromTv || mode === "tv") return;
    if (d.config().autoMode !== false) setMode("tv");
  });
  // Plex Web's player closed: back to TV mode if that's where it was started.
  ipcMain.on("plex:player-closed", (e) => {
    if (e.sender !== d.plexContents() || !playingFromTv) return;
    playingFromTv = false;
    setMode("tv");
    if (tvView) tvView.webContents.send("tv:refresh");
  });
  ipcMain.on("titlebar:set-mode", (e, next) => { if (e.sender === d.titlebar()) setMode(next); });
}

module.exports = {
  init, setMode, startMode,
  view: () => tvView,
  mode: () => mode,
  isPlayingFromTv: () => playingFromTv,
};
