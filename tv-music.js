// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// TV mode's music player: a queue (an album, an artist, a playlist), a Now
// Playing screen in the TV-app style, and a small bar while you browse.
// Now Playing:  A play/pause · ←/→ previous / next track · ↑/↓ back / forward 15 s ·
//               Y lyrics · B hide.
// Media keys and the Windows media overlay work too. Lyrics come from the server (an .lrc /
// .txt next to the song, or Plex's own); synced ones follow the song. The visualiser reads
// the sound through Web Audio (the app allows that for our requests, see tv-main.js).
// ===========================================================================
/* exported Music */
const Music = (() => {
  const $ = (id) => document.getElementById(id);
  let ctx = null;              // { S, api, img(path,w,h), onChange(), prefs() }
  let queue = [], index = 0, screen = false, tl = null;
  // The visualiser needs the sound "CORS-clean", so the element asks for it (crossOrigin).
  // If that ever fails, a plain element takes over and the visualiser stays off.
  let vizBroken = false;
  let audio = makeAudio(true);
  function makeAudio(cors) {
    const a = new Audio();
    a.preload = "auto";
    if (cors) a.crossOrigin = "anonymous";
    a.addEventListener("timeupdate", () => { if (screen) { progress(); syncLyrics(); } });
    a.addEventListener("play", () => { draw(); timeline("playing"); startViz(); });
    a.addEventListener("pause", () => { draw(); timeline("paused"); });
    a.addEventListener("ended", () => next());
    a.addEventListener("error", () => {
      if (!queue.length) return;
      if (a.crossOrigin && !vizBroken) { vizBroken = true; swapToPlainAudio(); return; }
      setTimeout(next, 500);
    });
    return a;
  }
  function swapToPlainAudio() {
    const at = audio.currentTime;
    audio.removeAttribute("src"); audio.load();
    audio = makeAudio(false);
    analyser = null;
    playIndex(index, at);
  }
  const DIRECT = ["mp3", "flac", "aac", "m4a", "mp4", "ogg", "opus", "wav"];

  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const cur = () => queue[index];

  function url(t) {
    const part = t.Media && t.Media[0] && t.Media[0].Part && t.Media[0].Part[0];
    const container = ((t.Media && t.Media[0] && t.Media[0].container) || "").toLowerCase();
    if (part && DIRECT.includes(container)) return `${ctx.S.uri}${part.key}?X-Plex-Token=${ctx.S.token}`;
    // Anything else (ALAC, WMA…) the server converts to MP3 on the fly.
    const p = new URLSearchParams({
      path: `/library/metadata/${t.ratingKey}`, mediaIndex: 0, partIndex: 0, protocol: "http", directPlay: 0, directStream: 1,
      "X-Plex-Client-Identifier": ctx.S.clientId, "X-Plex-Product": "PlexDeck", "X-Plex-Platform": "Chrome", "X-Plex-Token": ctx.S.token,
    });
    return `${ctx.S.uri}/music/:/transcode/universal/start.mp3?${p}`;
  }
  function timeline(state) {
    const t = cur();
    if (!t) return;
    ctx.api("/:/timeline", { ratingKey: t.ratingKey, key: `/library/metadata/${t.ratingKey}`, state,
      time: Math.round(audio.currentTime * 1000), duration: t.duration || Math.round((audio.duration || 0) * 1000) }).catch(() => {});
  }

  function playQueue(tracks, start = 0, { shuffle = false } = {}) {
    queue = [...tracks];
    if (shuffle) {
      for (let i = queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [queue[i], queue[j]] = [queue[j], queue[i]]; }
      start = 0;
    }
    if (!queue.length) return;
    playIndex(start);
    showScreen();
    ctx.onChange();
  }
  function playIndex(i, at = 0) {
    if (i < 0 || i >= queue.length) return;
    if (cur() && !at) timeline("stopped");
    index = i;
    const t = cur();
    audio.src = url(t);
    if (at) audio.currentTime = at;
    audio.play().catch(() => {});
    draw();
    loadLyrics();
    if ("mediaSession" in navigator) {
      const art = ctx.img(t.parentThumb || t.thumb || t.grandparentThumb, 512, 512);
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.grandparentTitle || t.originalTitle || "", album: t.parentTitle || "", artwork: art ? [{ src: art, sizes: "512x512" }] : [] });
    }
    clearInterval(tl);
    tl = setInterval(() => timeline(audio.paused ? "paused" : "playing"), 10000);
  }
  const next = () => (index < queue.length - 1 ? playIndex(index + 1) : stop());
  const prev = () => (audio.currentTime > 5 || index === 0 ? (audio.currentTime = 0) : playIndex(index - 1));
  const toggle = () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); };
  function stop() {
    timeline("stopped");
    clearInterval(tl);
    audio.pause(); audio.removeAttribute("src"); audio.load();
    queue = []; index = 0;
    hideScreen();
    draw();
    ctx.onChange();
  }

  function showScreen() { screen = true; $("music").hidden = false; draw(); drawLyrics(); startViz(); }
  function hideScreen() { screen = false; $("music").hidden = true; draw(); }
  function draw() {
    const t = cur();
    $("mini").hidden = !t || screen;
    if (!t) return;
    const art = ctx.img(t.parentThumb || t.thumb || t.grandparentThumb, 640, 640);
    $("mArt").src = art; $("miniArt").src = art;
    $("mTitle").textContent = t.title;
    $("mArtist").textContent = t.grandparentTitle || t.originalTitle || "";
    $("mAlbum").textContent = [t.parentTitle, t.parentYear].filter(Boolean).join(" · ");
    $("miniTitle").textContent = t.title;
    $("miniArtist").textContent = t.grandparentTitle || "";
    $("mPlay").innerHTML = audio.paused ? '<svg viewBox="0 0 24 24"><path d="M7 4l14 8-14 8z"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>';
    $("mQueue").textContent = `${index + 1} of ${queue.length}`;
    const nextT = queue[index + 1];
    $("mNext").textContent = nextT ? `Next: ${nextT.title}` : "";
    $("music").classList.toggle("lyrics", lyricsOn);
    progress();
  }

  // ---- lyrics ------------------------------------------------------------------------------
  let lyricsOn = false;
  try { lyricsOn = localStorage.getItem("ppd-lyrics") === "1"; } catch {}
  let lyrics = null, lyricsFor = null, lyricLine = -1;
  const lyricsCache = new Map();
  // LRC: "[01:23.45]words" (a line can have several times); anything else is plain text.
  function parseLyrics(text) {
    const timed = [], plain = [];
    for (const raw of String(text).replace(/\r/g, "").split("\n")) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
      const words = raw.replace(/\[[^\]]*\]/g, "").trim();
      if (stamps.length) for (const m of stamps) timed.push({ t: Number(m[1]) * 60 + Number(m[2].replace(":", ".")), text: words });
      else if (!/^\s*\[[a-z]+:.*\]\s*$/i.test(raw)) plain.push({ t: null, text: words });
    }
    if (timed.length) return { synced: true, lines: timed.sort((a, b) => a.t - b.t) };
    while (plain.length && !plain[0].text) plain.shift();
    while (plain.length && !plain[plain.length - 1].text) plain.pop();
    return { synced: false, lines: plain };
  }
  async function fetchLyrics(t) {
    if (lyricsCache.has(t.ratingKey)) return lyricsCache.get(t.ratingKey);
    let result = { synced: false, lines: [] };
    try {
      const m = ((await ctx.api(`/library/metadata/${t.ratingKey}`)).MediaContainer.Metadata || [])[0];
      const streams = (m && m.Media && m.Media[0] && m.Media[0].Part && m.Media[0].Part[0] && m.Media[0].Part[0].Stream) || [];
      const all = streams.filter((s) => s.streamType === 4);
      const st = all.find((s) => /lrc/i.test(s.format || s.codec || "")) || all[0];
      const id = st && ((/\/library\/streams\/(\d+)/.exec(st.key || "") || [])[1] || st.id);
      if (id) { const text = await window.ppDesktop.tvLyrics(id); if (text) result = parseLyrics(text); }
    } catch {}
    lyricsCache.set(t.ratingKey, result);
    return result;
  }
  async function loadLyrics() {
    const t = cur();
    if (!t || !lyricsOn) return;
    if (lyricsFor === t.ratingKey) return drawLyrics();
    lyricsFor = t.ratingKey; lyrics = null;
    drawLyrics();
    const l = await fetchLyrics(t);
    if (cur() !== t) return;
    lyrics = l;
    drawLyrics();
  }
  function drawLyrics() {
    const box = $("mLyrics");
    lyricLine = -1;
    if (!lyricsOn) return;
    if (!lyrics) { box.innerHTML = '<p class="lnote">Loading lyrics…</p>'; return; }
    if (!lyrics.lines.length) { box.innerHTML = '<p class="lnote">No lyrics for this song</p>'; return; }
    box.innerHTML = "";
    box.classList.toggle("synced", lyrics.synced);
    for (const l of lyrics.lines) {
      const p = document.createElement("p");
      p.textContent = l.text || "♪";
      box.append(p);
    }
    box.scrollTop = 0;
    syncLyrics();
  }
  // Synced lyrics: light up the line being sung and keep it in the middle.
  function syncLyrics() {
    if (!lyricsOn || !lyrics || !lyrics.synced) return;
    const now = audio.currentTime + 0.2;
    let i = -1;
    while (i + 1 < lyrics.lines.length && lyrics.lines[i + 1].t <= now) i++;
    if (i === lyricLine) return;
    const box = $("mLyrics");
    if (box.children[lyricLine]) box.children[lyricLine].classList.remove("now");
    lyricLine = i;
    const el = box.children[i];
    if (!el) return;
    el.classList.add("now");
    box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2, behavior: "smooth" });
  }
  function toggleLyrics() {
    lyricsOn = !lyricsOn;
    try { localStorage.setItem("ppd-lyrics", lyricsOn ? "1" : "0"); } catch {}
    draw();
    if (lyricsOn) loadLyrics(); else lyricLine = -1;
  }

  // ---- visualiser ----------------------------------------------------------------------------
  // Soft bars along the bottom of Now Playing, in the theme's colour (about 30 frames a second,
  // only while Now Playing is on screen and the song plays).
  let actx = null, analyser = null, bins = null, vizRunning = false, lastFrame = 0;
  const vizWanted = () => screen && !audio.paused && !vizBroken && !(ctx.prefs && ctx.prefs().musicVisualiser === false);
  function startViz() {
    if (vizRunning || !vizWanted()) { if (!vizWanted()) clearViz(); return; }
    try {
      if (!actx) actx = new AudioContext();
      if (!analyser) {
        const src = actx.createMediaElementSource(audio);
        analyser = actx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
        src.connect(analyser);
        analyser.connect(actx.destination);
        bins = new Uint8Array(analyser.frequencyBinCount);
      }
      actx.resume().catch(() => {});
    } catch { return; }
    vizRunning = true;
    requestAnimationFrame(frame);
  }
  function clearViz() {
    const c = $("mViz");
    c.getContext("2d").clearRect(0, 0, c.width, c.height);
  }
  function frame(ts) {
    if (!vizWanted() || !analyser) { vizRunning = false; clearViz(); return; }
    requestAnimationFrame(frame);
    if (ts - lastFrame < 33) return;
    lastFrame = ts;
    analyser.getByteFrequencyData(bins);
    const c = $("mViz"), g = c.getContext("2d");
    const W = c.width, H = c.height, n = 64, gap = 8, w = (W - gap * (n - 1)) / n;
    g.clearRect(0, 0, W, H);
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#e5a00d";
    g.globalAlpha = 0.35;
    // The low end carries most of the energy: spread the bars over the first ~3/4 of the bins.
    const used = Math.floor(bins.length * 0.75);
    for (let i = 0; i < n; i++) {
      const v = bins[Math.floor((i / n) * used)] / 255;
      const h = Math.max(4, v * v * H);
      g.beginPath();
      g.roundRect(i * (w + gap), H - h, w, h, [6, 6, 0, 0]);
      g.fill();
    }
  }
  function progress() {
    const d = audio.duration || (cur() && cur().duration / 1000) || 0;
    $("mTime").textContent = fmt(audio.currentTime);
    $("mLeft").textContent = `-${fmt(d - audio.currentTime)}`;
    $("mFill").style.width = d ? `${Math.min(100, (audio.currentTime / d) * 100)}%` : "0%";
  }

  // Keys while the Now Playing screen is open.
  function act(name) {
    if (!screen) return false;
    if (name === "OK") toggle();
    else if (name === "Left" || name === "L1") prev();
    else if (name === "Right" || name === "R1") next();
    else if (name === "Up" || name === "R2") audio.currentTime = Math.min((audio.duration || 0) - 1, audio.currentTime + 15);
    else if (name === "Down" || name === "L2") audio.currentTime = Math.max(0, audio.currentTime - 15);
    else if (name === "Back") hideScreen();
    else if (name === "Y") toggleLyrics();
    else if (name === "Start") stop();
    draw();
    return true;
  }

  function init(c) {
    ctx = c;
    if ("mediaSession" in navigator) {
      navigator.mediaSession.setActionHandler("play", () => audio.play());
      navigator.mediaSession.setActionHandler("pause", () => audio.pause());
      navigator.mediaSession.setActionHandler("nexttrack", next);
      navigator.mediaSession.setActionHandler("previoustrack", prev);
    }
  }

  return {
    init, playQueue, stop, act, showScreen,
    isScreen: () => screen,
    isActive: () => queue.length > 0,
    pauseForVideo: () => { if (!audio.paused) audio.pause(); },
  };
})();
