// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// TV mode's own player — laid out like Plex's TV apps.
//
// Your server streams the video (HLS): what this player can play is passed
// through untouched, the rest is converted on the fly. Progress goes back to
// Plex (Continue Watching stays right), Skip Intro / Credits follow your
// auto-skip settings, and Up Next counts down to the next episode.
//
// Watching:  A play/pause · ←/→ back 10 s / forward 30 s · ↑/↓ show controls ·
//            L1/R1 previous / next episode · B stop.
// Controls:  ↑/↓ between the seek bar and the buttons · ←/→ move or scrub · A press · B hide.
// ===========================================================================
/* global Hls */
/* exported Player */
const Player = (() => {
  const $ = (id) => document.getElementById(id);
  let ctx = null;            // { S, api, put, prefs(), onClose(changed), fallback(item, resume) }
  let meta = null;           // full metadata of what's playing
  let partId = null, streams = { audio: [], subtitle: [] };
  let hls = null, session = null, base = 0, absolute = null;
  let quality = 0;           // index into QUALITIES
  let active = false, controls = false, menu = null;
  let zone = 1, btn = 4;     // 0 = seek bar, 1 = buttons; btn index in BUTTONS
  let hideTimer = null, tlTimer = null, scrobbled = false;
  let scrub = null, scrubTimer = null;
  let nextEp = null, upNextTimer = null, upNextShown = false, upNextCancelled = false;
  let skipShownAt = 0, skipKey = null, skipped = new Set();
  let mpvMode = false;        // playing through the native player (mpv)
  let mpvV = null;
  // Started from PC mode (there's a mini player there, to keep watching while you browse).
  const FROM_PC = new URLSearchParams(location.search).get("pc") === "1";
  let mini = false;
  const video = () => (mpvMode ? mpvV : $("video"));

  // mpv, made to look like a <video> element to the rest of the player.
  function MpvVideo() {
    const ev = new EventTarget();
    const st = { time: 0, paused: false, duration: 0, tracks: [] };
    const fire = (t) => ev.dispatchEvent(new Event(t));
    const cmd = (c) => window.ppDesktop.nativeCmd(c);
    window.ppDesktop.onNative((m) => {
      if (m.prop === "time-pos") { if (m.value != null) { st.time = m.value; fire("timeupdate"); } }
      else if (m.prop === "pause") { st.paused = !!m.value; fire(st.paused ? "pause" : "playing"); }
      else if (m.prop === "duration") { if (m.value) st.duration = m.value; }
      else if (m.prop === "paused-for-cache") fire(m.value ? "waiting" : "playing");
      else if (m.prop === "track-list") st.tracks = m.value || [];
      else if (m.prop === "eof-reached") { if (m.value) fire("ended"); }
      else if (m.prop === "playlist-pos") onPlaylistPos(m.value);
      else if (m.event === "mini") showMini(!!m.value);
      else if (m.event === "file-loaded") fire("loaded");
      else if (m.event === "mpv-exit") fire("error");
    });
    return {
      get currentTime() { return st.time; }, set currentTime(t) { st.time = t; cmd(["seek", t, "absolute"]); },
      get paused() { return st.paused; }, get duration() { return st.duration; }, get tracks() { return st.tracks; },
      play() { cmd(["set_property", "pause", false]); return Promise.resolve(); },
      pause() { cmd(["set_property", "pause", true]); },
      buffered: { length: 0 }, seekable: { length: 0 }, readyState: 4,
      addEventListener: (t, f) => ev.addEventListener(t, f), cmd,
      removeAttribute() {}, load() {},
    };
  }
  // Pick Plex's chosen audio / subtitle tracks in mpv (embedded ones by their
  // position in the file, separate subtitle files by adding them).
  // Your preferred languages (Settings → Playback), on top of Plex's own choice.
  let prefsApplied = false;
  async function applyLanguagePrefs() {
    if (prefsApplied) return;
    prefsApplied = true;
    const p = await window.ppDesktop.nativePrefs().catch(() => null);
    if (!p) return;
    const want = (lang) => (x) => x.language === String(lang).toLowerCase() || x.languageCode === String(lang).toLowerCase().slice(0, 3);
    if (p.preferredAudioLang && p.preferredAudioLang !== "Any") {
      const a = streams.audio.find(want(p.preferredAudioLang));
      if (a && !a.selected) streams.audio.forEach((x) => { x.selected = x === a; });
    }
    if (p.autoSubtitles && !streams.subtitle.some((x) => x.selected)) {
      let subs = streams.subtitle.filter(want(p.preferredSubtitleLang)).filter((x) => !x.forced);
      if (p.preferNonSdh && subs.some((x) => !x.sdh)) subs = subs.filter((x) => !x.sdh);
      if (subs[0]) subs[0].selected = true;
    }
  }
  async function mpvApplyTracks() {
    await applyLanguagePrefs();
    const tracks = mpvV.tracks || [];
    const a = streams.audio.find((x) => x.selected);
    if (a) { const t = tracks.find((t) => t.type === "audio" && t["ff-index"] === a.index); if (t) await mpvV.cmd(["set_property", "aid", t.id]); }
    const s = streams.subtitle.find((x) => x.selected);
    if (!s) await mpvV.cmd(["set_property", "sid", "no"]);
    else if (s.key) await mpvV.cmd(["sub-add", `${ctx.S.uri}${s.key}?X-Plex-Token=${ctx.S.token}`, "select"]);
    else { const t = tracks.find((t) => t.type === "sub" && t["ff-index"] === s.index); if (t) await mpvV.cmd(["set_property", "sid", t.id]); }
  }
  // Windows' media controls (and the keyboard's Next / Previous keys) only offer Next and
  // Previous when mpv's playlist has something there: put placeholders around the current
  // video, and when Windows moves to one, play the real next / previous episode instead.
  const PLACEHOLDER = "av://lavfi:color=c=black:s=16x16";
  let plExpected = null, plFor = null, fileLoaded = false, neighboursKnown = false;
  async function syncPlaylist() {
    if (!mpvMode || !meta || !fileLoaded || !neighboursKnown || plFor === meta.ratingKey) return;
    plFor = meta.ratingKey;
    plExpected = null;
    await mpvV.cmd(["playlist-clear"]);
    let pos = 0;
    if (prevEp) { await mpvV.cmd(["loadfile", PLACEHOLDER, "insert-at", 0]); pos = 1; }
    if (nextEp) await mpvV.cmd(["loadfile", PLACEHOLDER, "append"]);
    plExpected = pos;
  }
  function onPlaylistPos(p) {
    if (plExpected == null || p == null || p < 0 || p === plExpected || !active) return;
    const forward = p > plExpected;
    plExpected = null;
    if (forward && nextEp) playNext();
    else if (!forward && prevEp) { timeline("stopped"); open({ key: prevEp.ratingKey }, { resume: false }); }
  }
  // What Windows' media overlay shows.
  function mediaTitle(m) {
    if (m.type === "episode") return `${m.grandparentTitle} — S${m.parentIndex} · E${m.index}  ${m.title}`;
    return m.year ? `${m.title} (${m.year})` : m.title;
  }

  async function mpvLoad(offset) {
    const part = meta.Media && meta.Media[0] && meta.Media[0].Part && meta.Media[0].Part[0];
    if (!part) return fail();
    base = 0; absolute = true;
    $("pSpinner").hidden = false;
    await mpvV.cmd(["set_property", "start", String(Math.max(0, Math.floor(offset)))]);
    await mpvV.cmd(["loadfile", `${ctx.S.uri}${part.key}?X-Plex-Token=${ctx.S.token}`, "replace"]);
  }

  const QUALITIES = [
    { label: "Original (best)", bitrate: 200000, res: null },
    { label: "20 Mbps 1080p", bitrate: 20000, res: "1920x1080" },
    { label: "12 Mbps 1080p", bitrate: 12000, res: "1920x1080" },
    { label: "8 Mbps 1080p", bitrate: 8000, res: "1920x1080" },
    { label: "4 Mbps 720p", bitrate: 4000, res: "1280x720" },
    { label: "2 Mbps 720p", bitrate: 2000, res: "1280x720" },
    { label: "1.5 Mbps 480p", bitrate: 1500, res: "720x480" },
  ];
  const BUTTONS = ["subs", "audio", "quality", "prev", "play", "next", "chapters", "more"];
  // Playback speed, audio / subtitle sync and subtitle size (the ⋯ button).
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const DELAYS = [-1, -0.5, -0.3, -0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2, 0.3, 0.5, 1];
  const SUBSCALE = [["Small", 0.8], ["Normal", 1], ["Large", 1.3], ["Huge", 1.6]];
  const fx = { speed: 1, audioDelay: 0, subDelay: 0, subScale: null };
  const setProp = (name, v) => (mpvMode ? mpvV.cmd(["set_property", name, v]) : null);
  const ms = (s) => (s === 0 ? "In sync" : `${s > 0 ? "+" : ""}${Math.round(s * 1000)} ms`);
  function moreMenu() {
    const items = [{ label: `Playback speed: ${fx.speed}×`, value: "speed" }];
    if (mpvMode) items.push(
      { label: `Audio sync: ${ms(fx.audioDelay)}`, value: "audio" },
      { label: `Subtitle sync: ${ms(fx.subDelay)}`, value: "sub" },
      { label: `Subtitle size: ${fx.subScale ? SUBSCALE.find((x) => x[1] === fx.subScale)[0] : "From settings"}`, value: "size" });
    openMenu("More", items, (k) => {
      if (k === "speed") openMenu("Playback speed", SPEEDS.map((s) => ({ label: `${s}×`, value: s, selected: s === fx.speed })), (s) => {
        fx.speed = s; if (mpvMode) setProp("speed", s); else $("video").playbackRate = s; });
      if (k === "audio") openMenu("Audio sync (+ = later)", DELAYS.map((s) => ({ label: ms(s), value: s, selected: s === fx.audioDelay })), (s) => { fx.audioDelay = s; setProp("audio-delay", s); });
      if (k === "sub") openMenu("Subtitle sync (+ = later)", DELAYS.map((s) => ({ label: ms(s), value: s, selected: s === fx.subDelay })), (s) => { fx.subDelay = s; setProp("sub-delay", s); });
      if (k === "size") openMenu("Subtitle size", SUBSCALE.map(([l, v]) => ({ label: l, value: v, selected: v === fx.subScale })), (v) => { fx.subScale = v; setProp("sub-scale", v); });
    });
  }

  const mc = (r) => (r && r.MediaContainer) || {};
  const fmt = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const duration = () => (meta && meta.duration ? meta.duration / 1000 : (video().duration || 0));

  // Where we are in the film (the stream may restart part-way through after a seek).
  function position() {
    const v = video();
    if (absolute === null) return base + (v.currentTime || 0);
    return absolute ? v.currentTime : base + v.currentTime;
  }

  // ---- the stream -------------------------------------------------------------------
  function streamUrl(offset) {
    const q = QUALITIES[quality];
    const p = new URLSearchParams({
      hasMDE: 1, path: `/library/metadata/${meta.ratingKey}`, mediaIndex: 0, partIndex: 0,
      protocol: "hls", fastSeek: 1, directPlay: 0, directStream: 1, directStreamAudio: 1,
      subtitleSize: 100, audioBoost: 100, location: "lan", videoQuality: 100,
      maxVideoBitrate: q.bitrate, offset: Math.floor(offset), session, subtitles: "burn", copyts: 1,
      "X-Plex-Session-Identifier": session, "X-Plex-Client-Identifier": ctx.S.clientId,
      "X-Plex-Product": "PlexDeck", "X-Plex-Platform": "Chrome", "X-Plex-Device": "Windows",
      "X-Plex-Token": ctx.S.token,
    });
    if (q.res) p.set("videoResolution", q.res);
    return `${ctx.S.uri}/video/:/transcode/universal/start.m3u8?${p}`;
  }
  function stopTranscode(id) {
    if (id) ctx.api("/video/:/transcode/universal/stop", { session: id }).catch(() => {});
  }
  function load(offset) {
    if (mpvMode) return mpvLoad(offset);
    const old = session;
    session = uuid();
    if (hls) { hls.destroy(); hls = null; }
    stopTranscode(old);
    base = Math.max(0, offset);
    absolute = null;
    $("pSpinner").hidden = false;
    const v = video();
    hls = new Hls({ maxBufferLength: 40, backBufferLength: 60, startPosition: -1 });
    hls.on(Hls.Events.MANIFEST_PARSED, () => { v.play().catch(() => {}); });
    let retried = false;
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      if (!retried) { retried = true; setTimeout(() => load(position()), 800); return; }
      fail();
    });
    hls.loadSource(streamUrl(base));
    hls.attachMedia(v);
  }
  function fail() {
    $("pSpinner").hidden = true;
    const it = meta, at = position();
    if (mpvMode) { window.ppDesktop.nativeFallback({ key: it.ratingKey, resume: true }); return; }
    close(false);
    ctx.fallback(it, at);
  }
  function seekTo(t) {
    t = Math.max(0, Math.min(duration() - 2, t));
    if (mpvMode) { mpvV.currentTime = t; return; }
    const v = video();
    const local = absolute ? t : t - base;
    // Already loaded? jump there; otherwise ask the server for a new stream from that point.
    for (let i = 0; i < v.buffered.length; i++) {
      if (local >= v.buffered.start(i) && local <= v.buffered.end(i) - 1) { v.currentTime = local; return; }
    }
    if (absolute !== false && local >= 0 && local < (v.duration || 0) - 1 && v.seekable.length && local <= v.seekable.end(0)) {
      v.currentTime = local; return;
    }
    load(t);
  }
  const seekBy = (d) => { seekTo(position() + d); showControls(false); };

  // ---- progress back to Plex -----------------------------------------------------------
  function timeline(state) {
    if (!meta) return;
    const t = Math.round(position() * 1000);
    ctx.api("/:/timeline", {
      ratingKey: meta.ratingKey, key: `/library/metadata/${meta.ratingKey}`, state,
      time: t, duration: meta.duration || Math.round(duration() * 1000), playbackTime: t,
      "X-Plex-Session-Identifier": session || "",
    }).catch(() => {});
    if (!scrobbled && duration() && position() / duration() > 0.9) {
      scrobbled = true;
      ctx.api("/:/scrobble", { key: meta.ratingKey, identifier: "com.plexapp.plugins.library" }).catch(() => {});
    }
  }

  // ---- open / close ---------------------------------------------------------------------
  async function open(item, { resume = false, at = null, native = false } = {}) {
    if (native && !mpvV) mpvV = MpvVideo();
    if (native) { mpvMode = true; wireEvents(mpvV); }
    plExpected = null; plFor = null;   // our own file change mustn't count as Next / Previous
    active = true;
    $("player").hidden = false;
    $("pSpinner").hidden = false;
    document.body.classList.add("playing");
    const m = (mc(await ctx.api(`/library/metadata/${item.key}`, { includeMarkers: 1, includeChapters: 1 })).Metadata || [])[0];
    if (!m) { close(false); return; }
    meta = m;
    scrobbled = false; skipped = new Set(); nextEp = null; upNextShown = false; upNextCancelled = false;
    prefsApplied = false;
    fileLoaded = false; neighboursKnown = false; prevEp = null;
    if (mpvMode) {
      if (fx.speed !== 1) setProp("speed", fx.speed);
      setProp("force-media-title", mediaTitle(m));
    }
    const part = m.Media && m.Media[0] && m.Media[0].Part && m.Media[0].Part[0];
    partId = part ? part.id : null;
    readStreams(part);
    // Titles, like the TV app: show / episode line, or the movie.
    const ep = m.type === "episode";
    $("pTitle").textContent = ep ? m.grandparentTitle : m.title;
    $("pSub").textContent = ep ? `S${m.parentIndex} • E${m.index}  ·  ${m.title}` : [m.year, m.contentRating].filter(Boolean).join("  ·  ");
    const start = at != null ? at : resume && m.viewOffset ? m.viewOffset / 1000 : 0;
    load(start);
    if (ep) findNext(); else { neighboursKnown = true; syncPlaylist(); }
    btn = BUTTONS.indexOf("play"); zone = 1;
    showControls(false);
    clearInterval(tlTimer);
    tlTimer = setInterval(() => timeline(video().paused ? "paused" : "playing"), 10000);
  }
  function readStreams(part) {
    const all = (part && part.Stream) || [];
    const pick = (s) => ({ id: s.id, index: s.index, key: s.key || null, label: s.extendedDisplayTitle || s.displayTitle || s.language || "Unknown", selected: !!s.selected,
      language: (s.language || "").toLowerCase(), languageCode: (s.languageCode || "").toLowerCase(), forced: !!s.forced, sdh: !!s.hearingImpaired });
    streams = { audio: all.filter((s) => s.streamType === 2).map(pick), subtitle: all.filter((s) => s.streamType === 3).map(pick) };
  }
  async function findNext() {
    try {
      const leaves = mc(await ctx.api(`/library/metadata/${meta.grandparentRatingKey}/allLeaves`)).Metadata || [];
      const i = leaves.findIndex((x) => String(x.ratingKey) === String(meta.ratingKey));
      nextEp = i >= 0 ? leaves[i + 1] || null : null;
      prevEp = i > 0 ? leaves[i - 1] : null;
    } catch {}
    neighboursKnown = true;
    syncPlaylist();
  }
  let prevEp = null;
  function close(changed = true) {
    if (!active) return;
    timeline("stopped");
    active = false;
    clearInterval(tlTimer); clearTimeout(hideTimer); clearTimeout(upNextTimer);
    const old = session; session = null;
    if (mpvMode) {
      // The native player lives in its own layer: closing it takes us back to TV mode.
      window.ppDesktop.nativeClose(changed);
      return;
    }
    if (hls) { hls.destroy(); hls = null; }
    const v = video(); v.removeAttribute("src"); v.load();
    stopTranscode(old);
    $("player").hidden = true;
    $("pUpNext").hidden = true; $("pSkip").hidden = true; $("pMenu").hidden = true;
    menu = null; controls = false;
    document.body.classList.remove("playing");
    ctx.onClose(changed);
  }
  function playNext() {
    if (!nextEp) return close();
    const n = nextEp;
    timeline("stopped");
    clearTimeout(upNextTimer);
    $("pUpNext").hidden = true;
    open({ key: n.ratingKey }, { resume: false });
  }
  function playPrev() {
    if (position() > 15 || !prevEp) return seekTo(0);
    timeline("stopped");
    open({ key: prevEp.ratingKey }, { resume: false });
  }

  // ---- the on-screen controls ------------------------------------------------------------
  function showControls(focusButtons = true) {
    controls = true;
    $("player").classList.add("osd");
    if (focusButtons) zone = 1;
    draw();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { if (!video().paused && !menu) hideControls(); }, 5000);
  }
  function hideControls() { controls = false; scrub = null; $("player").classList.remove("osd"); draw(); }
  function draw() {
    const pos = scrub != null ? scrub : position(), d = duration();
    $("pTime").textContent = fmt(pos);
    $("pLeft").textContent = `-${fmt(d - pos)}`;
    const pct = d ? Math.min(100, (pos / d) * 100) : 0;
    $("pFill").style.width = `${pct}%`;
    $("pKnob").style.left = `${pct}%`;
    $("pBar").classList.toggle("focus", controls && zone === 0);
    const v = video();
    $("bPlay").innerHTML = v.paused ? ICONS.play : ICONS.pause;
    document.querySelectorAll("#pButtons .pb").forEach((el) => {
      el.classList.toggle("focus", controls && zone === 1 && BUTTONS[btn] === el.dataset.b);
    });
    $("bChapters").hidden = !(meta && meta.Chapter && meta.Chapter.length);
    document.querySelector('.pb[data-b="quality"]').hidden = mpvMode;
    $("bMini").hidden = !(mpvMode && FROM_PC);
    $("bPrev").classList.toggle("off", !(meta && meta.type === "episode"));
    $("bNext").classList.toggle("off", !nextEp);
  }
  const ICONS = {
    play: '<svg viewBox="0 0 24 24"><path d="M7 4l14 8-14 8z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
  };
  function togglePause() {
    const v = video();
    if (v.paused) v.play().catch(() => {}); else v.pause();
    timeline(v.paused ? "paused" : "playing");
    draw();
  }
  function pressButton(name) {
    if (name === "play") return togglePause();
    if (name === "prev") return playPrev();
    if (name === "next") return nextEp ? playNext() : null;
    if (name === "subs") return openMenu("Subtitles", [{ label: "Off", value: 0, selected: !streams.subtitle.some((s) => s.selected) },
      ...streams.subtitle.map((s) => ({ label: s.label, value: s.id, selected: s.selected }))], setSubtitle);
    if (name === "audio") return openMenu("Audio", streams.audio.map((a) => ({ label: a.label, value: a.id, selected: a.selected })), setAudio);
    if (name === "quality") return openMenu("Quality", QUALITIES.map((q, i) => ({ label: q.label, value: i, selected: i === quality })), (i) => { quality = i; load(position()); });
    if (name === "more") return moreMenu();
    if (name === "mini") return setMini(true);
    if (name === "chapters") return openMenu("Chapters", (meta.Chapter || []).map((c, i) => ({ label: `${c.tag || `Chapter ${i + 1}`}  ·  ${fmt(c.startTimeOffset / 1000)}`, value: c.startTimeOffset / 1000, selected: false })), (t) => seekTo(t));
  }
  // Audio / subtitles: the same per-file choice the audio & subtitle tool makes, then restart here.
  async function setAudio(id) {
    if (!partId) return;
    await ctx.put(`/library/parts/${partId}`, { audioStreamID: id, allParts: 1 }).catch(() => {});
    streams.audio.forEach((a) => { a.selected = a.id === id; });
    if (mpvMode) return mpvApplyTracks();   // mpv switches on the spot
    load(position());
  }
  async function setSubtitle(id) {
    if (!partId) return;
    await ctx.put(`/library/parts/${partId}`, { subtitleStreamID: id, allParts: 1 }).catch(() => {});
    streams.subtitle.forEach((s) => { s.selected = s.id === id; });
    if (mpvMode) return mpvApplyTracks();
    load(position());
  }

  // ---- mini player (PC mode) -----------------------------------------------------------------
  // The video shrinks to a corner of the window and Plex is yours again; the app moves the
  // layers, this page just swaps the TV controls for small ones.
  function setMini(on) {
    if (!mpvMode || !FROM_PC) return;
    if (on) { hideControls(); if (menu) { menu = null; $("pMenu").hidden = true; } }
    window.ppDesktop.nativeMini(on);
  }
  function showMini(on) {
    mini = on;
    document.body.classList.toggle("mini", on);
    $("pMini").hidden = !on;
    if (!on) showControls();
    drawMini();
  }
  function drawMini() {
    if (!mini) return;
    const d = duration();
    $("pMiniFill").style.width = `${d ? Math.min(100, (position() / d) * 100) : 0}%`;
    const paused = video().paused;
    $("pMini").classList.toggle("paused", paused);
    document.querySelector("#pMini .mm-play").innerHTML = paused ? ICONS.play : ICONS.pause;
  }
  function wireMini() {
    const box = $("pMini");
    box.querySelectorAll("button").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      const m = b.dataset.m;
      if (m === "play") togglePause();
      else if (m === "full") setMini(false);
      else if (m === "close") close();
      else if (m === "size") window.ppDesktop.nativeMiniSize();
      drawMini();
    }));
    // Drag it anywhere; let go and it snaps to the nearest corner. Double-click = full size.
    let drag = null;
    box.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      drag = { x: e.screenX, y: e.screenY, moved: false };
      box.setPointerCapture(e.pointerId);
    });
    box.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      box.classList.add("dragging");
      drag.x = e.screenX; drag.y = e.screenY;
      window.ppDesktop.nativeMiniDrag(dx, dy);
    });
    const end = () => {
      if (!drag) return;
      if (drag.moved) window.ppDesktop.nativeMiniDrop();
      drag = null;
      box.classList.remove("dragging");
    };
    box.addEventListener("pointerup", end);
    box.addEventListener("pointercancel", end);
    box.addEventListener("dblclick", (e) => { if (!e.target.closest("button")) setMini(false); });
  }

  // ---- side menu (subtitles, audio, quality, chapters) ------------------------------------
  function openMenu(title, options, onPick) {
    if (!options.length) return;
    menu = { options, onPick, focus: Math.max(0, options.findIndex((o) => o.selected)) };
    $("pMenuTitle").textContent = title;
    $("pMenu").hidden = false;
    drawMenu();
  }
  function drawMenu() {
    $("pMenuList").innerHTML = menu.options.map((o, i) =>
      `<div class="pm ${i === menu.focus ? "focus" : ""} ${o.selected ? "sel" : ""}">${o.selected ? "✓ " : ""}${String(o.label).replace(/[&<>]/g, "")}</div>`).join("");
    const el = $("pMenuList").children[menu.focus];
    if (el) el.scrollIntoView({ block: "nearest" });
  }
  function closeMenu() { menu = null; $("pMenu").hidden = true; showControls(); }

  // ---- Skip Intro / Credits, Up Next --------------------------------------------------------
  function markerCheck() {
    if (!meta) return;
    const pos = position(), ms = pos * 1000;
    const markers = meta.Marker || [];
    const cur = markers.find((mk) => (mk.type === "intro" || mk.type === "credits") && ms >= mk.startTimeOffset && ms < mk.endTimeOffset - 1000);
    const prefs = ctx.prefs() || {};
    const finalCredits = cur && cur.type === "credits" && (cur.final || mk_last(cur));
    if (cur && !(finalCredits && nextEp)) {
      const key = `${cur.type}-${cur.startTimeOffset}`;
      if (skipKey !== key) { skipKey = key; skipShownAt = Date.now(); }
      $("pSkip").hidden = false;
      $("pSkip").textContent = cur.type === "intro" ? "Skip Intro" : "Skip Credits";
      const auto = cur.type === "intro" ? prefs.autoSkipIntro : prefs.autoSkipCredits;
      const delay = (cur.type === "intro" ? prefs.skipIntroDelay : prefs.skipCreditsDelay) || 0;
      if (auto && !skipped.has(key) && Date.now() - skipShownAt >= delay * 1000) { skipped.add(key); seekTo(cur.endTimeOffset / 1000); }
    } else { $("pSkip").hidden = true; skipKey = null; }
    // Up Next: at the final credits, or 30 s before the end.
    const d = duration();
    const creditsStart = finalCredits ? cur.startTimeOffset / 1000 : d - 30;
    if (nextEp && !upNextShown && !upNextCancelled && d && pos >= creditsStart) showUpNext();
  }
  const mk_last = (mk) => (meta.Marker || []).filter((x) => x.type === "credits").pop() === mk;
  function showUpNext() {
    upNextShown = true;
    const n = nextEp;
    $("pUpNextTitle").textContent = `S${n.parentIndex} • E${n.index}  ·  ${n.title}`;
    const img = n.thumb ? `${ctx.S.uri}/photo/:/transcode?width=480&height=270&minSize=1&upscale=1&url=${encodeURIComponent(n.thumb)}&X-Plex-Token=${ctx.S.token}` : "";
    $("pUpNextImg").src = img;
    $("pUpNext").hidden = false;
    let left = 10;
    $("pUpNextCount").textContent = `Playing in ${left}`;
    clearInterval(upNextTimer);
    upNextTimer = setInterval(() => {
      left--;
      $("pUpNextCount").textContent = `Playing in ${left}`;
      if (left <= 0) { clearInterval(upNextTimer); playNext(); }
    }, 1000);
  }
  function cancelUpNext() { clearInterval(upNextTimer); upNextCancelled = true; $("pUpNext").hidden = true; }

  // ---- input ---------------------------------------------------------------------------------
  function act(name) {
    if (!active) return false;
    if (mini) {
      if (name === "Back") setMini(false);
      else if (name === "OK") { togglePause(); drawMini(); }
      return true;
    }
    if (menu) {
      if (name === "Up") menu.focus = Math.max(0, menu.focus - 1);
      else if (name === "Down") menu.focus = Math.min(menu.options.length - 1, menu.focus + 1);
      else if (name === "OK") { const o = menu.options[menu.focus]; const f = menu.onPick; closeMenu(); f(o.value); if (menu) drawMenu(); return true; }
      else if (name === "Back" || name === "Left") { closeMenu(); return true; }
      drawMenu();
      return true;
    }
    if (!$("pUpNext").hidden) {
      if (name === "OK") { playNext(); return true; }
      if (name === "Back") { cancelUpNext(); return true; }
    }
    if (!controls) {
      if (name === "OK") {
        if (!$("pSkip").hidden) { const k = skipKey; const mk = (meta.Marker || []).find((x) => `${x.type}-${x.startTimeOffset}` === k); if (mk) { skipped.add(k); seekTo(mk.endTimeOffset / 1000); } return true; }
        togglePause(); showControls(); return true;
      }
      if (name === "Left" || name === "L2") { seekBy(-10); return true; }
      if (name === "Right" || name === "R2") { seekBy(30); return true; }
      if (name === "Up" || name === "Down") { showControls(); return true; }
      if (name === "L1") { playPrev(); return true; }
      if (name === "R1") { if (nextEp) playNext(); return true; }
      if (name === "Back") { close(); return true; }
      if (name === "Start") { showControls(); pressButton("subs"); return true; }
      return true;
    }
    showControls(false);
    if (name === "Back") { hideControls(); return true; }
    if (zone === 0) {
      if (name === "Down") { zone = 1; }
      else if (name === "Left" || name === "Right") {
        // Scrub: move a preview point, jump there when you stop (or press A).
        scrub = Math.max(0, Math.min(duration(), (scrub != null ? scrub : position()) + (name === "Left" ? -10 : 30)));
        clearTimeout(scrubTimer);
        scrubTimer = setTimeout(() => { if (scrub != null) { const t = scrub; scrub = null; seekTo(t); } }, 900);
      } else if (name === "OK" && scrub != null) { clearTimeout(scrubTimer); const t = scrub; scrub = null; seekTo(t); }
      else if (name === "OK") togglePause();
    } else {
      if (name === "Up") zone = 0;
      else if (name === "Down") { hideControls(); return true; }
      else if (name === "Left" || name === "Right") {
        let i = btn;
        do { i = Math.max(0, Math.min(BUTTONS.length - 1, i + (name === "Left" ? -1 : 1))); }
        while (i !== btn && buttonOff(BUTTONS[i]) && i > 0 && i < BUTTONS.length - 1);
        if (!buttonOff(BUTTONS[i])) btn = i;
      } else if (name === "OK") pressButton(BUTTONS[btn]);
    }
    draw();
    return true;
  }
  function buttonOff(name) {
    if (name === "chapters") return !(meta && meta.Chapter && meta.Chapter.length);
    if (name === "quality") return mpvMode;
    if (name === "next") return !nextEp;
    if (name === "prev") return !(meta && meta.type === "episode");
    if (name === "mini") return !(mpvMode && FROM_PC);
    return false;
  }

  // ---- wiring ---------------------------------------------------------------------------------
  const wired = new WeakSet();
  function wireEvents(v) {
    if (wired.has(v)) return;
    wired.add(v);
    v.addEventListener("loaded", async () => {
      if ((await mpvV.cmd(["get_property", "path"])) === PLACEHOLDER) return;   // only passing through
      fileLoaded = true;
      syncPlaylist();
      mpvApplyTracks();
      const fps = await mpvV.cmd(["get_property", "container-fps"]);
      if (fps) window.ppDesktop.nativeFps(fps);
    });
    v.addEventListener("error", () => { if (mpvMode && active) fail(); });
    v.addEventListener("playing", () => {
      $("pSpinner").hidden = true;
      if (absolute === null) absolute = base > 20 ? Math.abs(v.currentTime - base) < 20 : true;
      timeline("playing");
    });
    v.addEventListener("waiting", () => { $("pSpinner").hidden = false; });
    v.addEventListener("pause", () => { draw(); drawMini(); if (!mini) showControls(false); });
    v.addEventListener("playing", drawMini);
    v.addEventListener("timeupdate", () => { if (controls) draw(); drawMini(); markerCheck(); });
    v.addEventListener("ended", () => { if (nextEp && !upNextCancelled) playNext(); else close(); });
  }
  function init(c) {
    ctx = c;
    wireEvents($("video"));
    document.querySelectorAll("#pButtons .pb").forEach((el) => el.addEventListener("click", () => { btn = BUTTONS.indexOf(el.dataset.b); pressButton(el.dataset.b); }));
    $("pSkip").addEventListener("click", () => act("OK"));
    wireMini();
  }

  return { init, open, close, act, isActive: () => active };
})();
