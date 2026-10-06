// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// TV mode's music player: a queue (an album, an artist, a playlist), a Now
// Playing screen in the TV-app style, and a small bar while you browse.
// Now Playing:  A play/pause · ←/→ previous / next track · ↑/↓ back / forward 15 s · B hide.
// Media keys and the Windows media overlay work too.
// ===========================================================================
/* exported Music */
const Music = (() => {
  const $ = (id) => document.getElementById(id);
  let ctx = null;              // { S, api, img(path,w,h), onChange() }
  let queue = [], index = 0, screen = false, tl = null;
  const audio = new Audio();
  audio.preload = "auto";
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
  function playIndex(i) {
    if (i < 0 || i >= queue.length) return;
    if (cur()) timeline("stopped");
    index = i;
    const t = cur();
    audio.src = url(t);
    audio.play().catch(() => {});
    draw();
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

  function showScreen() { screen = true; $("music").hidden = false; draw(); }
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
    progress();
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
    else if (name === "Start") stop();
    draw();
    return true;
  }

  function init(c) {
    ctx = c;
    audio.addEventListener("timeupdate", () => { if (screen) progress(); });
    audio.addEventListener("play", () => { draw(); timeline("playing"); });
    audio.addEventListener("pause", () => { draw(); timeline("paused"); });
    audio.addEventListener("ended", next);
    audio.addEventListener("error", () => { if (queue.length) setTimeout(next, 500); });
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
