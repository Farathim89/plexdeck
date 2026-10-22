// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// TV mode — a controller-first Plex interface, built like Plex's TV apps.
//
//  Side menu (profile, Search, Home, Watchlist, libraries): open on start,
//  folds to an icon rail; moving through it loads each library live.
//  Hero: the focused item's art, title and details, updating as you move.
//  Rows: the focused row stays at a fixed height; each row remembers your spot.
//  Back: top row → side menu → Home (and stays there).
//  Show pages: season tabs, episode strip, Resume / From start / Watched.
//  Play hands over to Plex's player (with the controller layer) and returns.
// ===========================================================================

const desktop = window.ppDesktop;   // tr() / N_(): PlexDeck's language, from i18n-dom.js
const $ = (id) => document.getElementById(id);
const stage = $("stage");

let S = null;               // session: { uri, token, machineId, serverName, user }
let sections = [];          // libraries
let menuItems = [];         // [{ id, label, icon, open() }]
let menuIndex = 0;
let menuOpen = true;
let menuScroll = 0;            // how far the menu list is scrolled
let currentMenuId = "home";
let page = null;            // the page on screen
const stack = [];           // pages to go Back to
let overlayOpen = false;

// ---- the stage, scaled to the window --------------------------------------------
// Laid out for a 1920-wide TV screen. Text Size (Settings → Experience) changes that width:
// at 130 % the stage is 1920 / 1.3 wide and scaled up more, so everything grows and rows hold
// fewer cards — like a TV's own display size setting.
let textScale = 1, STAGE_W = 1920, gridGen = 0;   // gridGen: +1 when the stage width changes
function fit() {
  const w = Math.round(1920 / textScale);
  if (w !== STAGE_W) { STAGE_W = w; gridGen++; }
  stage.style.width = `${STAGE_W}px`;
  const scale = innerWidth / STAGE_W, h = innerHeight / scale;
  stage.style.transform = `scale(${scale})`;
  stage.style.height = `${h}px`;
  stage.style.setProperty("--short", `${Math.max(0, 1080 - h)}px`);   // height lost to bigger text (see tv.css)
  // how much shorter: a little (≥ ~115 %), or very (≥ ~150 % on a 16:9 screen) — see tv.css
  document.body.classList.toggle("short", 1080 - h > 100);
  document.body.classList.toggle("shortest", 1080 - h > 300);
  layoutGen++;   // pages kept in memory work out their rows' place again
  if (typeof page !== "undefined" && page) fitLayout(page);
}
let layoutGen = 0;
// On a shorter stage the hero and the rows can't keep their 100 % places: the hero goes under
// the tab bar (library tabs, seasons) and the rows under the hero, with room for the highlight.
// Within a page the rows only ever move down (not up and down as you move between items).
function fitLayout(p) {
  const hero = $("hero"), win = $("rowsWindow"), tabs = $("tabs");
  hero.style.top = ""; win.style.top = "";
  if (!document.body.classList.contains("short") || document.body.classList.contains("no-hero") || !hero.offsetHeight) return;
  if (tabs.children.length && tabs.offsetHeight) {
    const min = tabs.offsetTop + tabs.offsetHeight + 18;
    if (hero.offsetTop < min) hero.style.top = `${min}px`;
  }
  const kept = p && p.rowsMin && p.rowsMin.gen === layoutGen ? p.rowsMin.top : 0;
  const need = Math.max(hero.offsetTop + hero.offsetHeight + 8, kept);   // (+12 inside the window, see tv.css)
  if (p) p.rowsMin = { gen: layoutGen, top: need };
  if (win.offsetTop < need) win.style.top = `${need}px`;
}
// A new stage width (Text Size): a page's grids count their cards again the next time it's shown
// (pages kept in memory too — a library's tabs, pages further back).
function resizePage(p) {
  if (!p) return;
  p.gridGen = gridGen;
  if (p.onResize) p.onResize();
  else { p.rendered = false; drawPage(p); freshen(p); }
}
// How many cards fit across a grid row (cards `step` apart; `reserve` keeps room on the right).
const perRow = (step, reserve = 40) => Math.max(3, Math.floor((STAGE_W - 128 - reserve) / step));
// Poster grids (Browse, Collections, a genre…): as many as fit at full size, never fewer than 5 —
// at a bigger Text Size the posters get a little narrower instead of dropping to 4 (or 3) a row.
// { per: posters a row, cw: their width }
function gridFit(reserve = 40) {
  const room = STAGE_W - 128 - reserve;
  const per = Math.max(5, Math.floor(room / 248));
  return { per, cw: Math.min(220, Math.floor(room / per) - 28) };
}
addEventListener("resize", fit);
fit();

// ---- clock ----------------------------------------------------------------------
function tick() {
  const t = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  $("clock").textContent = t;
  if ($("pClock")) $("pClock").textContent = t;
}
setInterval(tick, 10000); tick();

// ---- server data ----------------------------------------------------------------
const api = (path, params) => desktop.tvApi(path, params);
const mc = (r) => (r && r.MediaContainer) || {};
function img(path, w, h) {
  if (!path || !S) return "";
  if (/^https?:/.test(path)) return path;   // Plex's online artwork (Watchlist)
  const url = /^https?:/.test(path) ? path : path;
  return `${S.uri}/photo/:/transcode?width=${w}&height=${h}&minSize=1&upscale=1&url=${encodeURIComponent(url)}&X-Plex-Token=${S.token}`;
}
function fmtDuration(ms) {
  if (!ms) return "";
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
function fmtDate(d) {
  if (!d) return "";
  const t = new Date(d);
  return isNaN(t) ? "" : t.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
const esc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// One shape for every item the server returns.
function norm(m) {
  const t = m.type;
  const ep = t === "episode";
  const season = t === "season";
  return {
    raw: m, key: m.ratingKey, type: t,
    title: ep ? m.grandparentTitle : season ? m.parentTitle : m.title,
    sub: ep ? m.title : season ? m.title : t === "album" ? (m.parentTitle || "") : "",
    epTitle: m.title,
    poster: ep ? (m.grandparentThumb || m.parentThumb || m.thumb) : season ? (m.thumb || m.parentThumb) : (m.thumb || m.composite),
    still: m.thumb,
    art: ep ? (m.grandparentArt || m.art) : season ? (m.parentArt || m.art) : m.art,
    year: m.year, duration: m.duration, rating: m.contentRating, date: m.originallyAvailableAt,
    summary: m.summary || "", offset: m.viewOffset || 0, viewCount: m.viewCount || 0,
    leafCount: m.leafCount, viewedLeafCount: m.viewedLeafCount,
    seasonNo: m.parentIndex, epNo: m.index,
    showKey: ep ? m.grandparentRatingKey : season ? m.parentRatingKey : (t === "show" ? m.ratingKey : null),
    seasonKey: ep ? m.parentRatingKey : season ? m.ratingKey : null,
    genres: (m.Genre || []).map((g) => g.tag).slice(0, 3),
    cast: (m.Role || []).map((r) => r.tag).slice(0, 3),
    directors: (m.Director || []).map((d) => d.tag).slice(0, 2),
    // critic / audience scores, like Plex shows them (Rotten Tomatoes, IMDb, TMDB)
    rates: (m.Rating && m.Rating.length ? m.Rating.map((r) => [r.value, r.image]) : [[m.rating, m.ratingImage], [m.audienceRating, m.audienceRatingImage]])
      .filter(([v, i]) => v != null && i).map(([v, i]) => ({ v: Number(v), i })),
    // the title as artwork (Plex's clear logo), like the new Plex
    logo: ((m.Image || []).find((x) => x.type === "clearLogo") || {}).url || "",
    blur: m.UltraBlurColors || null,
    childCount: m.childCount,
    square: ["artist", "album", "track", "photo", "photoalbum"].includes(t),
    guid: m.guid,
  };
}
const watched = (it) => ["artist", "album", "track", "photo", "photoalbum", "playlist", "collection"].includes(it.type) ? false
  : (it.type === "show" || it.type === "season")
  ? it.leafCount > 0 && it.viewedLeafCount >= it.leafCount
  : it.viewCount > 0 && !it.offset;

// ---- hero + background ----------------------------------------------------------
let artToken = 0;
function showHero(it) {
  if (!it) return;
  const logoSrc = it.logo && S && lastPrefs.heroTitle !== "text" ? `${S.uri}${it.logo}${it.logo.includes("?") ? "&" : "?"}X-Plex-Token=${S.token}` : "";
  $("heroTitle").classList.toggle("logo", !!logoSrc);
  if (logoSrc) $("heroTitle").innerHTML = `<img src="${esc(logoSrc)}" alt="${esc(it.title || "")}">`;
  else $("heroTitle").textContent = it.title || "";
  $("heroSub").textContent = it.sub || "";
  const meta = [];
  if (it.type === "episode") {
    meta.push(`S${it.seasonNo ?? "?"} • E${it.epNo ?? "?"}`);
    if (it.date) meta.push(fmtDate(it.date));
  } else if (it.year) meta.push(it.year);
  if (it.duration) meta.push(fmtDuration(it.duration));
  if (it.details && it.genres.length) meta.push(it.genres.join(", "));
  if (it.type === "show" && it.childCount) meta.push(it.childCount > 1 ? tr("{n} seasons", { n: it.childCount }) : tr("1 season"));
  let chips = "";
  if (it.offset && it.duration) chips = `<span class="chip"><i class="ring"></i>${esc(tr("{time} left", { time: fmtDuration(it.duration - it.offset) }))}</span>`;
  else if (watched(it)) chips = `<span class="chip">✓ ${esc(tr("Watched"))}</span>`;
  $("heroMeta").innerHTML = meta.map((x) => `<span>${esc(x)}</span>`).join("") + (it.rating ? `<span class="cr">${esc(it.rating)}</span>` : "") + chips;
  $("heroLine").textContent = it.details ? "" : "";
  $("heroRates").innerHTML = it.details ? (it.rates || []).map(rateHtml).join("") : "";
  $("heroSummary").textContent = it.summary;
  // details pages say who directed it (like Plex); rows show the cast
  $("heroCast").textContent = it.details && it.directors && it.directors.length ? tr("Directed by {names}", { names: it.directors.join(", ") }) : it.cast.join(", ");
  setArt(it);
}
// "rrggbb" darkened to `k` of its brightness → "#rrggbb"
function shadeHex(hex, k) {
  const n = parseInt(String(hex || "202020").replace("#", "").slice(0, 6), 16) || 0x202020;
  const ch = (s) => Math.round(((n >> s) & 255) * k).toString(16).padStart(2, "0");
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}
// A score with its source's mark: Rotten Tomatoes (tomato / splat, popcorn), IMDb, TMDB.
function rateHtml({ v, i }) {
  const pct = `${Math.round(v * 10)}%`;
  if (/rottentomatoes/.test(i)) {
    const audience = /upright|spilled/.test(i), bad = /rotten|spilled/.test(i);
    const mark = audience ? `<i class="rt-pop ${bad ? "bad" : ""}"></i>` : `<i class="rt-tom ${bad ? "bad" : ""}"></i>`;
    return `<span class="rate">${mark}${pct}</span>`;
  }
  if (/imdb/.test(i)) return `<span class="rate"><b class="rt-imdb">IMDb</b>${Number(v).toFixed(1)}</span>`;
  if (/themoviedb/.test(i)) return `<span class="rate"><b class="rt-tmdb">TMDB</b>${Number(v).toFixed(1)}</span>`;
  return `<span class="rate">${pct}</span>`;
}
function setArt(it) {
  const my = ++artToken;
  const im = $("artImg");
  const src = img(it.art, 1340, 780);
  // Plex's colours for the artwork: the page is tinted with them and the picture fades into
  // that tint (not into black), like Plex's TV app.
  if (it.blur) {
    const c = it.blur;
    $("bg").style.background = `linear-gradient(135deg, ${shadeHex(c.topLeft, .5)} 0%, ${shadeHex(c.bottomLeft || c.topLeft, .42)} 55%, ${shadeHex(c.bottomRight, .55)} 100%)`;
    $("bg").style.filter = "";
    stage.style.setProperty("--tint", shadeHex(c.topLeft, .5));
    stage.style.setProperty("--tint2", shadeHex(c.bottomLeft || c.topLeft, .42));
  } else {
    $("bg").style.background = ""; $("bg").style.filter = "";
    stage.style.removeProperty("--tint"); stage.style.removeProperty("--tint2");
  }
  if (!src) { im.classList.remove("on"); return; }
  if (im.dataset.src === src) return;
  const pre = new Image();
  pre.onload = () => { if (my !== artToken) return; im.src = src; im.dataset.src = src; im.classList.add("on"); };
  pre.onerror = () => { if (my === artToken) im.classList.remove("on"); };
  im.classList.remove("on");
  setTimeout(() => { if (my === artToken) pre.src = src; }, 120);   // don't fetch every art while scrolling fast
}

// ---- icons --------------------------------------------------------------------------
const ICON = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 01-1 1h-5v-6H9v6H4a1 1 0 01-1-1z"/></svg>',
  watchlist: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  movie: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4"/></svg>',
  show: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="13" rx="2"/><path d="M8 21h8"/></svg>',
  artist: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  photo: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 17l-5-5-9 7"/></svg>',
  play: '<svg class="solid" viewBox="0 0 24 24"><path d="M7 4l14 8-14 8z"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
  brush: '<svg viewBox="0 0 24 24"><path d="M18.4 2.6a2 2 0 012.9 2.9L13 13.8l-2.8-2.8z"/><path d="M10.2 11a3.4 3.4 0 00-4.8 0C4 12.4 4.8 14.3 3 16.4c2.9.9 6.3 1 7.9-.6a3.4 3.4 0 00-.7-4.8z"/></svg>',
  live: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M8 3l4 4 4-4"/></svg>',
  discover: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6"/></svg>',
  settings: '<svg class="solid" viewBox="0 0 24 24"><path d="M19.4 13a7.6 7.6 0 000-2l2.1-1.6-2-3.5-2.5 1a7.3 7.3 0 00-1.7-1L15 3h-4l-.4 2.7a7.3 7.3 0 00-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 000 2l-2.1 1.6 2 3.5 2.5-1a7.3 7.3 0 001.7 1L11 21h4l.4-2.7a7.3 7.3 0 001.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 113.5-3.5 3.5 3.5 0 01-3.5 3.5z" fill-rule="evenodd"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.5M3.5 12h.5M3.5 18h.5"/></svg>',
  more: '<svg class="solid" viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  plexmark: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M9.6 6.5h2.8l3.6 5.5-3.6 5.5H9.6l3.6-5.5z"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  lists: '<svg class="solid" viewBox="0 0 24 24"><path d="M8 3h11a1 1 0 011 1v17l-6.5-4L7 21V4a1 1 0 011-1z" opacity=".55"/><path d="M5 6h10a1 1 0 011 1v15l-5.5-3.5L5 22V7a1 1 0 011-1z" transform="translate(-1 -1)"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5 6.5 20.4l1-6.3L3 9.7l6.2-.9z"/></svg>',
  dots: '<svg class="solid" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  sort: '<svg viewBox="0 0 24 24"><path d="M4 6h9M4 11h6M4 16h4M17 4v16M14 17l3 3 3-3"/></svg>',
  burger: '<svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14"/></svg>',
  switchuser: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M16 4.5h5M19 2.5l2 2-2 2M21 11h-5M18 9l-2 2 2 2"/></svg>',
  tv: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M5 5l9 7-9 7zM17 5v14"/></svg>',
  gamepad: '<svg viewBox="0 0 24 24"><path d="M6 8h12a4 4 0 014 4v1a4 4 0 01-7 2.6L14 14h-4l-1 1.6A4 4 0 012 13v-1a4 4 0 014-4zM7 11v3M5.5 12.5h3M16 12h.01M18 13.5h.01"/></svg>',
  checked: '<svg class="solid" viewBox="0 0 24 24"><path d="M12 2a10 10 0 100 20 10 10 0 000-20zm-1.4 14.2l-4.2-4.2 1.4-1.4 2.8 2.8 6-6 1.4 1.4z"/></svg>',
  audio: '<svg class="solid" viewBox="0 0 24 24"><path d="M3 5h18v14H3zm4 4v6h2l3 2.5V6.5L9 9zm8 .5v5h1.5v-5z"/></svg>',
  subs: '<svg class="solid" viewBox="0 0 24 24"><path d="M3 5h18v14H3zm3 7v2h5v-2zm7 0v2h5v-2zm-7 3.5v1h12v-1z"/></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  playlist: '<svg viewBox="0 0 24 24"><path d="M4 6h12M4 11h12M4 16h7"/><path d="M16 14v6l5-3z"/></svg>',
  tracks: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M13 15h4M7 11h10"/></svg>',
};

// ---- the side menu (like Plex's) ------------------------------------------------------
// You at the top (picture + name: Switch user / Theme / Settings), Search, Home, Watchlist, your
// libraries, Playlists, Live TV, Movies & Shows on Plex, More, Settings. Left on an entry selects
// its ⋮, which opens its Actions (Unpin from sidebar, Reorder, Scan Library Files). Unpinned
// entries live under More. Order and pins are kept per Plex user on this PC.
let menuHandle = false;   // the ⋮ beside the focused entry has focus
let reorder = null;       // { before: [ids] } while moving an entry
let moreMode = false;     // the menu shows More's list
const userKey = (k) => `${k}:${(S && S.user && S.user.name) || ""}`;
const readList = (k) => { try { const v = JSON.parse(localStorage.getItem(userKey(k)) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeList = (k, v) => { try { localStorage.setItem(userKey(k), JSON.stringify(v)); } catch {} };
const FIXED = new Set(["profile", "mylists", "search", "home", "more", "back"]);   // can't be moved or unpinned
const LIB_ORDER = { movie: 0, show: 1, artist: 2, photo: 3 };
function allEntries() {
  return [
    { id: "profile", label: S && S.user ? S.user.name : tr("Switch user"), icon: "user", me: true, pin: true, open: () => openProfile() },
    ...(Music.isActive() ? [{ id: "nowplaying", label: tr("Now playing"), icon: "music", open: () => { closeMenu(); Music.showScreen(); } }] : []),
    { id: "mylists", label: tr("My Lists"), icon: "lists", live: true, open: () => menuPage("mylists", myListsPage) },
    { id: "search", label: tr("Search"), icon: "search", pin: true, open: () => { currentMenuId = "search"; stack.length = 0; showPage(searchPage()); } },
    { id: "home", label: tr("Home"), icon: "home", pin: true, live: true, open: () => menuPage("home", homePage) },
    ...sections.map((sec, i) => ({
      id: `lib-${sec.key}`, label: sec.title, live: true, lib: sec, sec: i === 0 ? tr("Libraries") : "",
      icon: sec.type === "show" ? "show" : sec.type === "artist" ? "music" : sec.type === "photo" ? "photo" : "movie",
      open: () => menuPage(`lib-${sec.key}`, () => libraryPage(sec)),
    })),
    { id: "livetv", label: tr("Live TV"), icon: "live", live: true, sec: tr("On Plex"), open: () => menuPage("livetv", () => providerPage("epg")) },
    { id: "discover", label: tr("Discover"), icon: "discover", live: true, open: () => menuPage("discover", () => providerPage("discover")) },
  ];
}
function buildMenu() {
  if (moreMode) return buildMore();
  const hidden = readList("tvMenuHidden");
  let items = allEntries().filter((m) => !hidden.includes(m.id));
  // your order (Reorder): saved ids first in that order, new entries where they'd normally be
  const saved = readList("tvMenuOrder");
  if (saved.length) {
    const movable = items.filter((m) => !FIXED.has(m.id));
    const out = saved.map((id) => movable.find((m) => m.id === id)).filter(Boolean);
    movable.forEach((m, i) => { if (!out.includes(m)) out.splice(Math.min(i, out.length), 0, m); });
    const head = items.filter((m) => FIXED.has(m.id) || m.id === "nowplaying");
    items = [...head, ...out.filter((m) => m.id !== "nowplaying")];
  }
  const onPlex = items.findIndex((m) => m.id === "livetv" || m.id === "discover");
  const more = { id: "more", label: tr("More"), icon: "more", open: () => openMore() };
  if (onPlex >= 0) items.splice(onPlex, 0, more); else items.push(more);
  // the first of "On Plex" carries the section title (Live TV may be unpinned)
  items.forEach((m) => { if (m.lib) m.sec = ""; });
  const firstLib = items.find((m) => m.lib);
  if (firstLib) firstLib.sec = tr("Libraries");
  const firstPlex = items.find((m) => m.id === "livetv" || m.id === "discover");
  if (firstPlex) firstPlex.sec = tr("On Plex");
  menuItems = items;
  renderMenu();
}
// More: everything you can put in the sidebar (pinned or not); its Actions pin / unpin.
function openMore() {
  moreMode = true; menuHandle = false;
  buildMore();
  menuIndex = Math.min(1, menuItems.length - 1);
  drawMenu();
}
function buildMore() {
  const hidden = readList("tvMenuHidden");
  const all = allEntries().filter((m) => !FIXED.has(m.id) && m.id !== "nowplaying");
  menuItems = [
    { id: "back", label: tr("BACK"), icon: "back", open: () => closeMore() },
    ...all.filter((m) => hidden.includes(m.id)).map((m) => ({ ...m, unpinned: true })),
    ...all.filter((m) => !hidden.includes(m.id)),
  ];
  renderMenu();
}
function closeMore() {
  moreMode = false; menuHandle = false;
  buildMenu();
  menuIndex = Math.max(0, menuItems.findIndex((m) => m.id === "more"));
  drawMenu();
}
function renderMenu() {
  const face = () => (S && S.user && S.user.thumb ? `<img class="mi-face" src="${esc(S.user.thumb)}" alt="">`
    : `<div class="mi-face">${esc(((S && S.user && S.user.name) || "?").slice(0, 1).toUpperCase())}</div>`);
  $("menuItems").innerHTML = menuItems.map((m, i) => `<div class="mi ${m.me ? "me" : ""} ${m.pin ? "pin" : ""} ${m.sec ? "sec" : ""}" data-i="${i}" data-sec="${esc(m.sec || "")}">${m.me ? face() : ICON[m.icon] || ""}`
    + `<span>${esc(m.label)}${m.sub ? `<small>${esc(m.sub)}</small>` : ""}</span>${m.me ? `<i class="chev">${ICON.chev}</i>` : ""}</div>`).join("");
  drawMenu();
}
const hasActions = (m) => m && !FIXED.has(m.id) && m.id !== "nowplaying";
function drawMenu() {
  document.body.classList.toggle("menu-open", menuOpen);
  document.body.classList.toggle("menu-more", moreMode);
  const list = $("menuItems");
  $("profile").hidden = true;
  $("menuHint").textContent = "";
  [...list.children].forEach((el, i) => {
    el.classList.toggle("focus", menuOpen && !menuHandle && i === menuIndex);
    el.classList.toggle("moving", menuOpen && !!reorder && i === menuIndex);
    el.classList.toggle("current", menuItems[i].id === currentMenuId);
  });
  // Long menus scroll: keep the selected entry (and one more) on screen.
  const sel = list.children[menuOpen ? menuIndex : Math.max(0, menuItems.findIndex((m) => m.id === currentMenuId))];
  if (!menuOpen) { menuScroll = 0; list.style.transform = ""; list.style.clipPath = ""; }
  else if (sel) {
    // what the open panel shows (it floats, with space above and below it on the screen)
    const viewH = $("menu").clientHeight - list.offsetTop - 24;
    const itemH = sel.offsetHeight + 8;
    let shift = menuScroll;
    if (sel.offsetTop - shift < itemH) shift = Math.max(0, sel.offsetTop - itemH);
    if (sel.offsetTop + itemH * 2 - shift > viewH) shift = sel.offsetTop + itemH * 2 - viewH;
    shift = Math.max(0, Math.min(shift, list.scrollHeight - viewH));
    menuScroll = shift;
    list.style.transform = `translateY(${-shift}px)`;
    list.style.clipPath = `inset(${shift}px -40px -4000px -40px)`;
  }
  // the ⋮ beside the focused entry (white when it has the focus)
  const dots = $("menuDots");
  const m = menuItems[menuIndex];
  dots.hidden = !(menuOpen && !reorder && hasActions(m) && sel);
  if (!dots.hidden) {
    dots.style.top = `${list.offsetTop + sel.offsetTop - menuScroll}px`;
    dots.style.height = `${sel.offsetHeight}px`;
    dots.classList.toggle("focus", menuHandle);
  }
  drawProfPanel();
  if (page) page.draw();   // positions follow the menu width
}
let liveTimer = null;
function menuMove(delta) {
  menuHandle = false; panels = [];
  const next = Math.max(0, Math.min(menuItems.length - 1, menuIndex + delta));
  if (next === menuIndex) { drawMenu(); return; }
  menuIndex = next;
  drawMenu();
  // Like the new Plex: moving through the sidebar only moves; OK opens the page.
  clearTimeout(liveTimer);
}
function openMenu() {
  if (page && page.noMenu) return;   // full-screen pages (who's watching, PIN), like Plex's own
  menuOpen = true; menuHandle = false;
  const i = menuItems.findIndex((m) => m.id === currentMenuId);
  menuIndex = i >= 0 ? i : menuItems.findIndex((m) => m.id === "home");
  drawMenu();
}
function closeMenu() {
  if (reorder) cancelReorder();
  if (moreMode) { moreMode = false; buildMenu(); }
  menuHandle = false; menuOpen = false; profPanel = null; panels = [];
  drawMenu();
}
function menuOk() {
  clearTimeout(liveTimer);
  const m = menuItems[menuIndex];
  if (menuHandle) return menuActions(m);
  if (moreMode && m.id !== "back") { moreMode = false; buildMenu(); }
  if (!m.live) { m.open(); if (m.id === "search") closeMenu(); return; }
  if (m.id !== currentMenuId) { currentMenuId = m.id; stack.length = 0; m.open(); }
  closeMenu();
}
function menuBack() {
  if (menuHandle) { menuHandle = false; drawMenu(); return; }
  if (moreMode) return closeMore();
  // Back in the sidebar: the focus jumps to Home (nothing opens until OK); Back on Home opens the Home page.
  const home = menuItems.findIndex((m) => m.id === "home");
  if (menuIndex !== home) { menuIndex = home; drawMenu(); return; }
  // on Home: Back again opens the Home page
  if (currentMenuId !== "home") { currentMenuId = "home"; stack.length = 0; menuPage("home", homePage); }
  closeMenu();
}
// Keys while the menu is open that aren't plain up / down: the ⋮ handle and Reorder.
function menuKey(name) {
  if (reorder) {
    if (name === "Up" || name === "Down") {
      const to = menuIndex + (name === "Up" ? -1 : 1);
      const ok = (i) => i >= 0 && i < menuItems.length && !FIXED.has(menuItems[i].id) && menuItems[i].id !== "nowplaying";
      if (ok(to)) { [menuItems[menuIndex], menuItems[to]] = [menuItems[to], menuItems[menuIndex]]; menuIndex = to; renderMenu(); }
    } else if (name === "OK") { writeList("tvMenuOrder", menuItems.filter((m) => !FIXED.has(m.id) && m.id !== "nowplaying").map((m) => m.id)); reorder = null; drawMenu(); }
    else if (name === "Back") cancelReorder();
    return true;
  }
  if (name === "Right" && menuItems[menuIndex] && menuItems[menuIndex].me) { openProfile(); return true; }
  if (name === "Left" && !menuHandle && hasActions(menuItems[menuIndex])) { menuHandle = true; drawMenu(); return true; }
  if (name === "Right" && menuHandle) { menuHandle = false; drawMenu(); return true; }
  return false;
}
function cancelReorder() {
  const id = menuItems[menuIndex] && menuItems[menuIndex].id;
  reorder = null;
  buildMenu();
  menuIndex = Math.max(0, menuItems.findIndex((m) => m.id === id));
  drawMenu();
}
// Actions for a sidebar entry (the ⋮): full screen, like Plex's.
function menuActions(m) {
  menuHandle = false; drawMenu();
  const label = m.label;
  const opts = [];
  const hidden = readList("tvMenuHidden");
  if (hidden.includes(m.id)) {
    opts.push({ label: tr("Pin to sidebar"), desc: tr("Show '{name}' in the sidebar menu again.", { name: label }),
      action: () => { writeList("tvMenuHidden", hidden.filter((x) => x !== m.id)); buildMenu(); } });
  } else {
    opts.push({ label: tr("Unpin from sidebar"), desc: tr("Don't display '{name}' in the sidebar menu. You can still access and re-pin this item via the 'More' option in the sidebar.", { name: label }),
      action: () => {
        writeList("tvMenuHidden", [...hidden, m.id]);
        if (currentMenuId === m.id) { currentMenuId = "home"; stack.length = 0; menuPage("home", homePage); }
        buildMenu(); menuIndex = Math.min(menuIndex, menuItems.length - 1); drawMenu();
      } });
  }
  if (m.lib) opts.push({ label: tr("Scan Library Files"), desc: tr("Request an update for the content of {name}.", { name: label }),
    action: () => api(`/library/sections/${m.lib.key}/refresh`).then(() => toast(tr("Scanning {name}…", { name: label }))).catch(() => toast(tr("Couldn't start the scan"))) });
  if (!moreMode) opts.push({ label: tr("Reorder"), desc: tr("Allows you to move '{name}' within the home sidebar. Up and Down will change the position, back cancels the move and OK saves the new position.", { name: label }),
    action: () => { reorder = { id: m.id }; drawMenu(); } });
  Dialog.open({ layout: "side", title: `${tr("Actions")} • ${label}`, icon: m.icon, items: opts });
}

// ---- My Lists: your Watchlist and your playlists (like Plex's) ---------------------------
function myListsPage() {
  const p = makePage({});
  loadInto(p, async () => {
    const [wl, pls] = await Promise.all([
      desktop.tvWatchlist().catch(() => null),
      api("/playlists", { playlistType: "video" }).catch(() => null),
    ]);
    const rows = [];
    const w = (mc(wl).Metadata || []).map((m) => ({ ...norm(m), cloud: true }));
    if (w.length) rows.push({ kind: "posters", title: tr("Watchlist"), col: 0, items: w });
    const l = (mc(pls).Metadata || []).map(norm);
    if (l.length) rows.push({ kind: "posters", title: tr("Playlists"), col: 0, items: l });
    return rows.length ? rows : [{ kind: "posters", title: tr("Nothing on your lists yet"), col: 0, items: [] }];
  });
  return p;
}

// ---- your profile (the top entry): full screen like Plex's ------------------------------
// ---- your profile and Settings: panels beside the sidebar (like the new Plex) -------------
// panels = a stack; each { title, rows: () => [...], i }. Rows: { label, sub, value, toggle, header,
// face, action }. The first panel (your profile's) shows as soon as your name has focus.
let panels = [];
let profPanel = null;   // true while a panel has the focus
const ONOFF = (v) => (v ? tr("On") : tr("Off"));
const secs = (v) => (v === 0 ? tr("at once") : v === 1 ? tr("1 second") : tr("{n} seconds", { n: v }));
const LANGS = ["Any", "English", "Japanese", "Swedish", "German", "French", "Spanish", "Italian", "Korean", "Chinese"];
const steps = (from, to, by, fmt) => { const o = []; for (let n = from; n <= to; n += by) o.push({ v: n, l: fmt(n) }); return o; };
function setPref(key, value) {
  lastPrefs = { ...lastPrefs, [key]: value }; desktop.setSetting(key, value); drawProfPanel();
  // the Speakers line (Video & Audio) asks the player again
  if (key === "audioChannels" || key === "passthrough") {
    const pn = panels.find((x) => x.load && "audio" in x);
    if (pn) { pn.audio = null; pn.loaded = false; pn.load(pn).then(() => drawProfPanel()); }
  }
}
// a setting as a row: a switch, or a list you pick from (opens as the next panel)
function prefRow(label, key, options, sub, custom = null) {
  if (options === "toggle") return { label, sub, toggle: () => !!lastPrefs[key], action: () => setPref(key, !lastPrefs[key]) };
  const list = () => (typeof options === "function" ? options() : options);
  const cur = () => list().find((o) => o.v === lastPrefs[key]);
  const shown = () => (cur() ? cur().l : custom && lastPrefs[key] != null ? secs(lastPrefs[key]) : "");
  return { label, sub, value: shown, action: () => pushPanel({
    title: label, focus: cur() ? list().indexOf(cur()) : custom ? list().length : 0,
    rows: () => [
      ...list().map((o) => ({ label: o.l, radio: () => lastPrefs[key] === o.v, action: () => { setPref(key, o.v); popPanel(); } })),
      // any number of seconds: ← / → in a box, OK saves
      ...(custom ? [{ label: tr("Custom…"), radio: () => !cur(), value: () => (!cur() ? secs(lastPrefs[key]) : ""), action: () => pushPanel({
        title: label, stepper: { key, min: custom.min, max: custom.max, v: Number(lastPrefs[key]) || custom.min },
        rows: (pn) => [{ label: tr("← / →  change   ·   OK  save"), box: () => secs(pn.stepper.v), action: () => { setPref(key, pn.stepper.v); popPanel(); popPanel(); } }],
      }) }] : []),
    ],
  }) };
}
const PROFILE_PANEL = () => ({ rows: () => [
  { icon: "switchuser", label: tr("Switch Profile"), action: () => { closeMenu(); openUserPicker(); } },
  { icon: "plexmark", label: tr("Server"), action: () => pushPanel({ title: tr("Server"), rows: () => [
    { label: tr("Server"), value: () => (S && S.serverName) || "" },
    { label: tr("Reconnect"), sub: tr("Connect to {name} again (finds its fastest address).", { name: (S && S.serverName) || tr("your server") }), action: () => { closeMenu(); start(true); } },
  ] }) },
  { icon: "settings", label: tr("Settings"), action: () => pushPanel(SETTINGS_PANEL()) },
] });
const SETTINGS_PANEL = () => ({ title: tr("Settings"), rows: () => [
  { label: tr("Account"), action: () => pushPanel({ title: tr("Account"), rows: () => [
    { label: tr("Username"), value: () => (S && S.user && S.user.name) || "" },
    prefRow(tr("Language"), "language", () => [{ v: "", l: tr("Automatic (like Windows)") }, ...(lastPrefs.languages || []).map((l) => ({ v: l.code, l: l.name }))]),
    prefRow(tr("Ask Who's Watching at Start"), "askUserAtStart", "toggle"),
    { label: tr("Plex Account Settings"), sub: tr("Opens in PC mode"), action: () => desktop.tvOpenPc("#!/settings/account") },
  ] }) },
  { label: tr("Plex Home"), action: () => pushPanel({ title: tr("Plex Home"), intro: tr("Plex home allows you to create a group of family and friends who share devices in the same home and manage access to media on a per-account basis."),
    load: async (pn) => { pn.users = (await desktop.tvHomeUsers().catch(() => null)) || []; },
    rows: (pn) => (pn.users || []).map((u) => ({ label: u.title, sub: u.admin ? tr("Admin") : u.restricted ? tr("Managed Account") : "", face: u.thumb,
      action: () => { closeMenu(); openUserPicker({ focusUser: u.title }); } })) }) },
  { label: tr("Experience"), action: () => pushPanel({ title: tr("Experience"), rows: () => [
    { label: tr("Theme"), value: () => { const t = (lastPrefs.themes || []).find((x) => x.id === lastPrefs.theme); return t ? tr(t.label || t.name || "") : ""; },
      action: () => pushPanel({ title: tr("Theme"), rows: () => (lastPrefs.themes || []).map((t) => ({ label: tr(t.label || t.name || t.id), radio: () => lastPrefs.theme === t.id, action: () => { setPref("theme", t.id); popPanel(); } })) }) },
    prefRow(tr("Text Size"), "tvTextSize", [0.85, 1, 1.15, 1.3, 1.5].map((n) => ({ v: n, l: `${Math.round(n * 100)} %` })), tr("Makes everything in TV mode bigger or smaller.")),
    prefRow(tr("Title Style"), "heroTitle", [{ v: "logo", l: tr("Logo artwork") }, { v: "text", l: tr("Text") }]),
    prefRow(tr("Theme Music"), "themeMusic", "toggle"),
    prefRow(tr("Theme Music Volume"), "themeVolume", THEME_LEVELS.map((x) => ({ v: x.v, l: tr(x.l) })), tr("How loud a show's theme tune plays on its page.")),
    prefRow(tr("Music Visualiser"), "musicVisualiser", "toggle"),
    prefRow(tr("Screensaver"), "screensaver", [0, 2, 5, 10, 20].map((n) => ({ v: n, l: n ? tr("{n} minutes", { n }) : tr("Never") }))),
    { label: tr("Screensaver Libraries"), value: () => { const n = saverLibs().length; return n === 1 ? tr("1 library") : tr("{n} libraries", { n }); },
      action: () => pushPanel({ title: tr("Screensaver Libraries"), intro: tr("The screensaver shows artwork from the libraries switched on here. With none on, it only shows the clock."),
        rows: () => saverChoices().map((sec) => ({ label: sec.title, toggle: () => saverLibs().includes(sec.key), action: () => toggleSaverLib(sec.key) })) }) },
    prefRow(tr("Start In"), "startMode", [{ v: "last", l: tr("The mode I used last") }, { v: "pc", l: tr("PC mode") }, { v: "tv", l: tr("TV mode") }]),
    prefRow(tr("Switch Mode by Itself"), "autoMode", "toggle", tr("Controller → TV mode, mouse → PC mode")),
  ] }) },
  { label: tr("Player Experience"), action: () => pushPanel({ title: tr("Player Experience"), rows: () => [
    prefRow(tr("Auto Play"), "autoPlay", "toggle", tr('Play "Up Next" videos automatically')),
    prefRow(tr("Auto Play Countdown"), "autoPlayCountdown", [2, 5, 10, 15, 20, 30].map((n) => ({ v: n, l: secs(n) })), null, { min: 1, max: 120 }),
    prefRow(tr("Show Up Next"), "upNextAt", [{ v: "credits", l: tr("At the credits") }, { v: "end", l: tr("At the end") }],
      tr("At the end leaves time for scenes after the credits (common in anime).")),
    prefRow(tr("Passout Protection"), "passoutHours", [{ v: 0, l: tr("Off") }, ...[1, 2, 3, 4].map((n) => ({ v: n, l: n === 1 ? tr("After 1 hour") : tr("After {n} hours", { n }) }))]),
    prefRow(tr("Rewind Video on Resume"), "rewindOnResume", [{ v: 0, l: tr("None") }, ...[2, 5, 10, 15, 30].map((n) => ({ v: n, l: secs(n) }))], null, { min: 0, max: 300 }),
    prefRow(tr("Skip Intros"), "autoSkipIntro", [{ v: false, l: tr("Manual") }, { v: true, l: tr("Automatic") }]),
    prefRow(tr("Skip Intros After"), "skipIntroDelay", [0, 2, 5, 10, 15, 20, 30].map((n) => ({ v: n, l: secs(n) })), null, { min: 0, max: 120 }),
    prefRow(tr("Skip Credits"), "autoSkipCredits", [{ v: false, l: tr("Manual") }, { v: true, l: tr("Automatic") }]),
    prefRow(tr("Skip Credits After"), "skipCreditsDelay", [0, 2, 5, 10, 15, 20, 30].map((n) => ({ v: n, l: secs(n) })), null, { min: 0, max: 120 }),
    prefRow(tr("Seek Back Time"), "jumpBack", [2, 5, 10, 15, 20, 30, 45, 60, 90, 120].map((n) => ({ v: n, l: secs(n) })), null, { min: 1, max: 600 }),
    prefRow(tr("Seek Forward Time"), "jumpForward", [2, 5, 10, 15, 20, 30, 45, 60, 90, 120].map((n) => ({ v: n, l: secs(n) })), null, { min: 1, max: 600 }),
    prefRow(tr("Player"), "playerEngine", [{ v: "mpv", l: tr("Native (mpv)") }, { v: "builtin", l: tr("Built-in") }]),
  ] }) },
  { label: tr("Video & Audio"), action: () => pushPanel({ title: tr("Video & Audio"),
    // what the sound device gets (asked from the player each time this opens)
    load: async (pn) => { pn.audio = await desktop.nativeAudioInfo().catch(() => null); pn.loaded = true; },
    rows: (pn) => [
    { header: tr("Video") },
    prefRow(tr("HDR"), "hdr", "toggle"),
    prefRow(tr("Refresh Rate Switching"), "matchRefresh", "toggle", tr("Plays at the video's own rate (23.976 Hz for films), like a TV box, so the TV's motion smoothing works.")),
    prefRow(tr("Full Resolution for Videos"), "videoNativeRes", "toggle", tr("A 4K TV that Windows runs at a lower resolution plays videos at 4K.")),
    prefRow(tr("HDR Switching"), "autoHdr", "toggle", tr("Windows HDR on while an HDR video plays.")),
    prefRow(tr("RTX Super Resolution"), "rtxUpscale", "toggle", tr("NVIDIA RTX cards: videos smaller than the screen are upscaled with AI.")),
    prefRow(tr("RTX Video HDR"), "rtxHdr", "toggle", tr("NVIDIA RTX cards: SDR videos play as HDR (with HDR Switching, or Windows HDR on).")),
    prefRow(tr("Hardware Decoding"), "hwDecode", [{ v: "auto", l: tr("Automatic") }, { v: "d3d11", l: "Direct3D 11" }, { v: "off", l: tr("Software") }]),
    { header: tr("Audio") },
    prefRow(tr("Passthrough"), "passthrough", [{ v: "off", l: tr("Off") }, { v: "dolby-dts", l: "Dolby Digital / DTS" }, { v: "all", l: tr("All (TrueHD, Atmos, DTS-HD)") }]),
    prefRow(tr("Audio Channels"), "audioChannels", [{ v: "auto", l: tr("Automatic") }, { v: "stereo", l: tr("Stereo") }, { v: "5.1", l: tr("Up to {layout}", { layout: "5.1" }) }, { v: "7.1", l: tr("Up to {layout}", { layout: "7.1" }) }],
      tr("Automatic follows Windows' speaker setup. Stereo / 5.1 / 7.1 take the sound device while playing.")),
    { label: tr("Speakers"),
      value: () => (pn.audio ? [pn.audio.layout, pn.audio.device].filter(Boolean).join(" · ") : pn.loaded ? tr("Unknown") : "…"),
      sub: pn.audio && pn.audio.channels < 8 && lastPrefs.passthrough !== "all"
        ? tr("7.1 is mixed down to {layout} (Windows' speaker setup). 7.1 speakers? Set Audio Channels to 7.1.", { layout: pn.audio.layout })
        : "" },
    prefRow(tr("Volume"), "defaultVolume", steps(0, 100, 10, (n) => `${n}%`)),
    prefRow(tr("Audio Language"), "preferredAudioLang", LANGS.map((x) => ({ v: x, l: tr(x) }))),
  ] }) },
  { label: tr("Subtitles"), action: () => pushPanel({ title: tr("Subtitles"), rows: () => [
    prefRow(tr("Subtitle Color"), "subColor", ["White", "Yellow", "Cyan", "Green", "Gray"].map((x) => ({ v: x, l: tr(x) }))),
    prefRow(tr("Subtitle Position"), "subPosition", [{ v: "Bottom", l: tr("Bottom") }, { v: "Raised", l: tr("Raised") }]),
    prefRow(tr("Subtitle Size"), "subSize", ["Small", "Normal", "Large", "Huge"].map((x) => ({ v: x, l: tr(x) }))),
    prefRow(tr("Subtitle Background"), "subBackground", "toggle"),
    prefRow(tr("Subtitles Automatically"), "autoSubtitles", "toggle"),
    prefRow(tr("Subtitle Language"), "preferredSubtitleLang", LANGS.slice(1).map((x) => ({ v: x, l: tr(x) }))),
    prefRow(tr("Prefer Subtitles Without SDH"), "preferNonSdh", "toggle"),
  ] }) },
  { label: tr("Advanced"), action: () => pushPanel({ title: tr("Advanced"), rows: () => [
    prefRow(tr("What PlexDeck Shows"), "source", [{ v: "app", l: tr("Everything Plex has") }, { v: "server", l: tr("Just my server") }]),
    prefRow(tr("Game Controller"), "controller", "toggle"),
    prefRow(tr("Start Maximised"), "startMaximized", "toggle"),
    prefRow(tr("Keep Running in the Tray"), "closeToTray", "toggle"),
    { label: tr("All PlexDeck Settings"), sub: tr("Backup, fonts and more (PC view)"), action: () => { closeMenu(); desktop.tvSettings(); } },
    { label: tr("Plex Web Settings"), sub: tr("Opens in PC mode"), action: () => desktop.tvOpenPc("#!/settings/web/general") },
  ] }) },
  { label: tr("About"), action: () => pushPanel({ title: tr("About"), rows: () => [
    { header: tr("Device") },
    { label: tr("App Name"), sub: "PlexDeck (TV mode)" },
    { label: tr("Version"), sub: lastPrefs.version || "" },
    { label: tr("Server"), sub: (S && S.serverName) || "" },
  ] }) },
] });
function openProfile() { clearTimeout(liveTimer); panels = [{ ...PROFILE_PANEL(), i: 0 }]; profPanel = true; drawMenu(); }
function pushPanel(pn) {
  const p2 = { ...pn, i: pn.focus || 0 };
  panels.push(p2);
  if (p2.load) p2.load(p2).then(() => { if (panels.includes(p2)) drawProfPanel(); });
  skipHeaders(p2, 1);
  drawProfPanel();
}
function popPanel() {
  panels.pop();
  if (!panels.length) profPanel = null;
  drawMenu();
}
const selectable = (r) => r && !r.header && (r.action || r.toggle || r.radio);
function skipHeaders(pn, dir) {
  const rows = pn.rows(pn);
  let i = pn.i;
  while (rows[i] && !selectable(rows[i]) && i + dir >= 0 && i + dir < rows.length) i += dir;
  if (selectable(rows[i])) pn.i = i;
}
function drawProfPanel() {
  const box = $("profPanel");
  const onMe = menuItems[menuIndex] && menuItems[menuIndex].me;
  if (menuOpen && onMe && !menuHandle && !panels.length) panels = [{ ...PROFILE_PANEL(), i: 0 }];
  if (!(menuOpen && (profPanel || onMe) && !menuHandle) || !panels.length) { box.hidden = true; if (!menuOpen) panels = []; return; }
  box.hidden = false;
  const pn = panels[panels.length - 1];
  const rows = pn.rows(pn);
  const val = (x) => (typeof x === "function" ? x() : x);
  box.classList.toggle("wide", panels.length > 1);
  box.innerHTML = (pn.title ? `<h2>${esc(pn.title)}</h2>` : "") + (pn.intro ? `<p class="intro">${esc(pn.intro)}</p>` : "")
    + `<div class="pplist">` + rows.map((r, i) => {
      if (r.header) return `<h3>${esc(r.header)}</h3>`;
      const focus = profPanel && i === pn.i ? "focus" : "";
      const lead = r.face ? `<img class="pface" src="${esc(/^https?:/.test(r.face) ? r.face : img(r.face, 96, 96))}" alt="">` : r.icon ? ICON[r.icon] || "" : "";
      if (r.box) return `<div class="pp stepbox ${focus}"><span class="t">${esc(r.label)}</span><span class="box">‹  ${esc(val(r.box))}  ›</span></div>`;
      const right = r.toggle ? `<i class="sw ${val(r.toggle) ? "on" : ""}"></i>` : r.radio ? `<i class="rd ${val(r.radio) ? "on" : ""}"></i>` : r.value ? `<span class="v">${esc(val(r.value))}</span>` : "";
      return `<div class="pp ${focus} ${selectable(r) ? "" : "info"}">${lead}<span class="t">${esc(r.label)}${r.sub ? `<small>${esc(val(r.sub))}</small>` : ""}</span>${right}</div>`;
    }).join("") + `</div>`;
  // keep the focused row in view
  const list = box.querySelector(".pplist"), el = list && list.querySelector(".pp.focus");
  if (el) { const top = el.offsetTop - list.offsetTop, h = list.clientHeight; if (top + el.offsetHeight > h + list.scrollTop - 20 || top < list.scrollTop) list.scrollTop = Math.max(0, top - h / 2); }
}
let stepHeld = 0, stepAt = 0;
function profPanelAct(name) {
  const pn = panels[panels.length - 1];
  if (!pn) { profPanel = null; drawMenu(); return; }
  if (pn.stepper && (name === "Left" || name === "Right")) {
    const st = pn.stepper, now = Date.now();
    stepHeld = now - stepAt < 200 ? stepHeld + 1 : 0; stepAt = now;   // held: bigger steps
    const by = stepHeld > 20 ? 10 : stepHeld > 8 ? 5 : 1;
    st.v = Math.max(st.min, Math.min(st.max, st.v + (name === "Left" ? -by : by)));
    drawProfPanel();
    return;
  }
  const rows = pn.rows(pn);
  if (name === "Up" || name === "Down") {
    const d = name === "Up" ? -1 : 1;
    let i = pn.i + d;
    while (rows[i] && !selectable(rows[i])) i += d;
    if (rows[i]) pn.i = i;
  } else if (name === "OK") { const r = rows[pn.i]; if (r && r.action) r.action(); return; }
  else if (name === "Back" || name === "Left") { if (panels.length > 1) { panels.pop(); drawProfPanel(); return; } profPanel = null; }
  drawMenu();
}

// ---- full-screen choices (profile, Actions, ⋯ menus), like Plex's ----------------------
// layout "side": picture/icon + name + the focused choice's description on the left, choices on the right.
// layout "list": a title and the choices in the middle. OK picks, Back closes.
const Dialog = (() => {
  let cur = null;
  function open(o) { cur = { ...o, i: o.focus || 0 }; $("dlg").hidden = false; draw(); }
  function close() { cur = null; $("dlg").hidden = true; }
  function draw() {
    const o = cur;
    $("dlg").className = (o.layout === "list" ? "list" : "side") + (o.cls ? ` ${o.cls}` : "");
    $("dlgTitle").textContent = o.title || "";
    const icon = $("dlgIcon");
    if (o.face) icon.innerHTML = `<img src="${esc(o.face)}" alt="">`;
    else if (o.name && !o.icon) icon.innerHTML = `<div class="face">${esc(o.name.slice(0, 1).toUpperCase())}</div>`;
    else icon.innerHTML = ICON[o.icon] || "";
    $("dlgName").textContent = o.name || "";
    $("dlgDesc").textContent = (o.items[o.i] && o.items[o.i].desc) || "";
    $("dlgList").innerHTML = o.items.map((it, i) => `<div class="dl ${i === o.i ? "focus" : ""}">${esc(it.label)}</div>`).join("");
  }
  function act(name) {
    const o = cur;
    if (name === "Up") o.i = Math.max(0, o.i - 1);
    else if (name === "Down") o.i = Math.min(o.items.length - 1, o.i + 1);
    else if (name === "OK") { const it = o.items[o.i]; close(); if (it) it.action(); return; }
    else if (name === "Back") { close(); if (o.onBack) o.onBack(); return; }
    else return;
    draw();
  }
  return { open, close, act, isOpen: () => !!cur };
})();

// ---- Audio & subtitles, the TV way (like PASTA; the logic is tracks-core.js, shared with the PC
// window): pick the exact audio / subtitle track from one episode and set it on that episode, its
// season or the whole show (or the movie). Full-screen lists for the controller, like the ⋯ menu;
// the focused row shows the tracks it's about.
async function tracksDialog(it, after) {
  const raw = it.raw || {};
  const scopes = [];
  const season = (key, title, n) => ({ type: "season", key, label: title || tr("Season {n}", { n }) });
  if (it.type === "movie") scopes.push({ type: "movie", key: it.key, label: tr("This movie") });
  else if (it.type === "episode") {
    scopes.push({ type: "episode", key: it.key, label: tr("This episode only ({episode})", { episode: `S${raw.parentIndex}·E${raw.index}` }) });
    if (raw.parentRatingKey) scopes.push(season(raw.parentRatingKey, raw.parentTitle, raw.parentIndex));
    if (raw.grandparentRatingKey) scopes.push({ type: "show", key: raw.grandparentRatingKey, label: tr("The whole show (all seasons)") });
  } else if (it.type === "season") {
    scopes.push(season(it.key, raw.title, raw.index));
    if (raw.parentRatingKey) scopes.push({ type: "show", key: raw.parentRatingKey, label: tr("The whole show (all seasons)") });
  } else if (it.type === "show") {
    scopes.push({ type: "show", key: it.key, label: tr("The whole show (all seasons)") });
    try { for (const s of (mc(await api(`/library/metadata/${it.key}/children`)).Metadata || []).filter((x) => x.type === "season")) scopes.push(season(s.ratingKey, s.title, s.index)); } catch {}
  }
  if (!scopes.length) return;
  const name = it.type === "episode" ? raw.grandparentTitle || it.title : it.title;
  // an episode: its season by default (like the PC window)
  const st = { scope: scopes.find((s) => s.type === "season") || scopes[0], audio: null, sub: null, tracks: null };
  const clean = (s) => s.replace(/\s+✓$/, "");
  async function read() {
    toast(tr("Reading the tracks…"));
    try { const k = await Tracks.sample(st.scope); st.tracks = k ? await Tracks.streams(k) : { audio: [], subtitle: [] }; }
    catch { st.tracks = null; toast(tr("Something went wrong talking to your Plex server.")); }
  }
  const list = (kind) => {
    const t = st.tracks || { audio: [], subtitle: [] };
    const rows = kind === "audio"
      ? t.audio.map((a, i) => `${i + 1}. ${Tracks.audioLabel(a)}${a.default ? `  · ${tr("default")}` : ""}`)
      : t.subtitle.map((x, i) => `${i + 1}. ${Tracks.subLabel(x)}${x.forced ? `  · ${tr("FORCED")}` : ""}`);
    return rows.length ? rows.join("\n") : tr("None");
  };
  function main(focus = 0) {
    const aNow = st.audio ? clean(Tracks.audioLabel(st.audio)) : tr("No change");
    const sNow = st.sub === "off" ? tr("Off (no subtitles)") : st.sub ? clean(Tracks.subLabel(st.sub)) : tr("No change");
    Dialog.open({ layout: "side", cls: "tracks", icon: "subs", name, title: tr("Audio & subtitles"), focus, items: [
      { label: `${tr("Apply to")}: ${st.scope.label}`, desc: tr("Pick the exact audio and subtitle track once and set it on a whole season, show or movie, like PASTA. Plex then uses those tracks every time you play."), action: pickScope },
      { label: `${tr("Audio track")}: ${aNow}`, desc: `${tr("Audio")}\n${list("audio")}`, action: () => pick("audio") },
      { label: `${tr("Subtitles")}: ${sNow}`, desc: `${tr("Subtitles")}\n${list("subs")}`, action: () => pick("subs") },
      { label: tr("Apply"), desc: `${st.scope.label}\n${tr("Audio track")}: ${aNow}\n${tr("Subtitles")}: ${sNow}`, action: apply },
    ] });
  }
  function pickScope() {
    Dialog.open({ layout: "list", title: tr("Apply to"), focus: Math.max(0, scopes.indexOf(st.scope)), onBack: () => main(0),
      items: scopes.map((s) => ({ label: s.label, action: async () => { if (s !== st.scope) { st.scope = s; await read(); } main(0); } })) });
  }
  function pick(kind) {
    const t = st.tracks || { audio: [], subtitle: [] };
    const tracks = kind === "audio" ? t.audio : t.subtitle;
    const items = [{ label: tr("No change"), value: null }];
    if (kind === "subs") items.push({ label: tr("Off (no subtitles)"), value: "off" });
    items.push(...tracks.map((x) => ({ label: kind === "audio" ? Tracks.audioLabel(x) : Tracks.subLabel(x), value: x })));
    const now = kind === "audio" ? st.audio : st.sub;
    const row = kind === "audio" ? 1 : 2;
    Dialog.open({ layout: "list", title: kind === "audio" ? tr("Audio track") : tr("Subtitles"), focus: Math.max(0, items.findIndex((x) => x.value === now)), onBack: () => main(row),
      items: items.map((x) => ({ label: x.label, action: () => { if (kind === "audio") st.audio = x.value; else st.sub = x.value; main(row); } })) });
  }
  async function apply() {
    if (!st.audio && !st.sub) { toast(tr("Choose an audio and/or subtitle track first.")); main(1); return; }
    try {
      const r = await Tracks.apply(st.scope, st.audio, st.sub, (d, total) => toast(`${tr("Applying…")} ${d} / ${total}`));
      toast(tr("Done — updated {n} of {total}. Plex now plays these with your chosen tracks.", { n: r.changed, total: r.total }));
      if (after) after();
    } catch { toast(tr("Something went wrong talking to your Plex server.")); }
  }
  await read();
  if (st.tracks) main(0);
}

// Pages opened from the menu are kept: going back to one shows it at once, where you left it,
// and it refreshes quietly behind the scenes.
const pageCache = new Map();
function menuPage(id, make) {
  const kept = pageCache.get(id);
  if (kept) {
    showPage(kept);
    if (kept.ver === dataVer) freshen(kept);   // (an older one already reloaded in showPage)
    return;
  }
  const p = make();
  pageCache.set(id, p);
  showPage(p);
}

// ---- pages: rows of items ----------------------------------------------------------
// A page is a list of rows; a row is { kind: "posters"|"wide"|"tabs"|"buttons", title, items, col }.
// Pages keep their own focus, so Back returns to exactly where you were.
// What you've watched may have changed (a video played, marked watched, PC mode used): pages
// older than this reload quietly when they're shown again (Back, the menu), keeping your place.
let dataVer = 0;
function freshen(p) {
  if (!p) return;
  p.ver = dataVer;
  if (p.refresh) p.refresh(); else if (p.reload) p.reload();
}
function watchedChanged() { dataVer++; autoFreshen(page); }
// Pages from Plex's online services (Live TV, Discover) don't change with what you watched, and
// Plex limits how often they may be asked: they refresh only when you open them again.
function autoFreshen(p) { if (!p) return; if (p.online) p.ver = dataVer; else freshen(p); }
function makePage({ rows = [], tabs = null, heroItem = null, pinned = true, onTab = null, loadMore = null, pinFrom = null }) {
  const p = {
    ver: dataVer, gridGen,
    rows, tabs, heroItem, pinned, onTab, loadMore, pinFrom,
    row: tabs ? 1 : 0,                 // row 0 is the tab bar when there is one
    draw() { drawPage(this); },
    focused() { const r = this.allRows()[this.row]; return r && r.items[r.col]; },
    allRows() { return this.tabs ? [this.tabs, ...this.rows] : this.rows; },
  };
  return p;
}
function cardHtml(it, kind, grid = false) {
  if (kind === "set") return `<div class="card stile"><div class="img">${ICON[it.icon] || ICON.tv}</div><div class="label">${esc(it.title)}</div><div class="label small">${esc(it.value || "")}</div></div>`;
  if (kind === "people") {
    const face = it.thumb ? `<img src="${esc(/^https?:/.test(it.thumb) ? it.thumb : img(it.thumb, 240, 240))}" alt="" loading="lazy">` : `<div class="fallback">${esc((it.title || "?").slice(0, 1))}</div>`;
    return `<div class="card person"><div class="img">${face}</div><div class="label">${esc(it.title)}</div><div class="label small">${esc(it.role || "")}</div></div>`;
  }
  if (kind === "landscape") {
    const still = it.still ? `<img src="${esc(img(it.still, 480, 270))}" alt="" loading="lazy">` : `<div class="fallback">${esc(it.title)}</div>`;
    return `<div class="card wide"><div class="img">${still}</div><div class="label">${esc(it.title)}</div></div>`;
  }
  if (kind === "tiles" && it.swatch) return `<div class="card tile sw${it.on ? " on" : ""}"><div class="img"><i class="sw-bar"></i><b class="sw-acc"></b></div><div class="label">${esc(it.title)}${it.on ? " ✓" : ""}</div></div>`;
  if (kind === "tiles") return `<div class="card tile"><div class="img"><div class="fallback">${esc(it.title)}</div></div></div>`;
  if (kind === "wide") {
    const prog = it.offset && it.duration ? `<div class="progress"><i data-w="${Math.min(100, (it.offset / it.duration) * 100)}"></i></div>` : "";
    const badge = `<div class="badge">${watched(it) ? "✓ " : ""}E${it.epNo ?? ""}</div>`;
    const still = it.still ? `<img src="${esc(img(it.still, 480, 270))}" alt="" loading="lazy">` : "";
    return `<div class="card wide"><div class="img">${still}${badge}${prog}</div></div>`;
  }
  const prog = it.offset && it.duration ? `<div class="progress"><i data-w="${Math.min(100, (it.offset / it.duration) * 100)}"></i></div>` : "";
  const left = (it.type === "show" || it.type === "season") && it.leafCount ? it.leafCount - (it.viewedLeafCount || 0) : 0;
  const badge = watched(it) ? `<div class="badge">✓</div>` : left > 0 ? `<div class="badge">${left}</div>` : "";
  const art = it.poster ? `<img src="${esc(img(it.poster, 330, it.square ? 330 : 495))}" alt="" loading="lazy">` : `<div class="fallback">${esc(it.title)}</div>`;
  // library grids: title and year under the poster (collections: how many items), like Plex
  if (grid && kind === "posters") {
    const n = it.childCount, of = it.raw && it.raw.subtype;   // a collection: "2 movies" / "3 shows", like Plex
    const count = n == null ? "" : of === "movie" ? (n === 1 ? tr("1 movie") : tr("{n} movies", { n })) : of === "show" ? (n === 1 ? tr("1 show") : tr("{n} shows", { n })) : tr("{n} items", { n });
    const second = it.type === "collection" ? count : (it.year || "");
    return `<div class="card g ${it.square ? "sq" : ""}"><div class="img">${art}${badge}${prog}</div><div class="label">${esc(it.title)}</div><div class="label small">${esc(second)}</div></div>`;
  }
  const label = it.labelBelow || (it.square ? it.title : "");
  return `<div class="card ${it.square ? "sq" : ""}"><div class="img">${art}${badge}${prog}</div><div class="label">${esc(label)}</div></div>`;
}
function buttonHtml(b) {
  return `<div class="btn ${b.on ? "on" : ""} ${b.named ? "named" : ""}">${ICON[b.icon] || ""}<span>${esc(b.label)}</span></div>`;
}
function renderRows(p) {
  const box = $("rows");
  box.innerHTML = p.rows.map((r, i) => {
    if (r.kind === "buttons") return `<div class="row brow" data-r="${i}"><div class="buttons">${r.items.map(buttonHtml).join("")}</div>`
      + (r.chips && r.chips.length ? `<div class="mchips">${r.chips.map((c) => `<span class="mchip">${c.icon ? ICON[c.icon] : ""}${esc(c.text)}</span>`).join("")}</div>` : "") + `</div>`;
    if (r.kind === "options" && r.fixed) return `<div class="row fixedph" data-r="${i}"></div>`;
    if (r.kind === "options") return `<div class="row" data-r="${i}"><div class="buttons opts">${r.items.map((b) => `<div class="btn opt"><span>${esc(b.label)}</span></div>`).join("")}</div></div>`;
    if (r.kind === "track") { const t = r.items[0]; return `<div class="row trkrow" data-r="${i}"><div class="trk"><span class="n">${esc(t.n)}</span><span class="t">${esc(t.title)}</span><span class="d">${esc(t.len)}</span></div></div>`; }
    if (r.kind === "keys") return `<div class="row" data-r="${i}"><div class="strip keys">${r.items.map((k) => `<div class="key ${k.wide ? "wide" : ""}">${esc(k.label)}</div>`).join("")}</div></div>`;
    const title = r.title ? `<h3>${esc(r.title)}</h3>` : "";
    return `<div class="row ${r.grid ? "grid" : ""}" data-r="${i}">${title}<div class="strip">${r.items.map((it) => cardHtml(it, r.kind, r.grid)).join("")}</div></div>`;
  }).join("");
  box.querySelectorAll(".progress i").forEach((i) => { i.style.width = `${i.dataset.w}%`; });
  // poster grids: their card width (gridFit) — set here, the page's CSP drops inline style="…"
  p.rows.forEach((r, i) => { if (r.cw) { const el = box.querySelector(`.row[data-r="${i}"]`); if (el) el.style.setProperty("--cw", `${r.cw}px`); } });
  p.rows.forEach((r, ri) => r.items.forEach((it, ci) => {
    if (!it.swatch) return;
    const el = box.children[ri] && box.children[ri].querySelectorAll(".card")[ci];
    if (!el) return;
    el.querySelector(".img").style.background = it.swatch.page;
    el.querySelector(".sw-bar").style.background = it.swatch.title;
    el.querySelector(".sw-acc").style.background = it.swatch.accent;
  }));
  $("tabs").innerHTML = p.tabs ? p.tabs.items.map((t) => `<div class="tab">${esc(t.label)}</div>`).join("") : "";
  // a library's filter bar stays put above the grid (like Plex)
  const fixed = p.rows.find((r) => r.kind === "options" && r.fixed);
  $("libBar").hidden = !fixed;
  document.body.classList.toggle("lib-bar", !!fixed);
  $("libBar").innerHTML = fixed ? `<div class="buttons opts">${fixed.items.map((b) => b.iconOnly
    ? `${fixed.count ? `<span class="count">${esc(fixed.count)}</span>` : ""}<div class="btn opt icon">${ICON[b.icon] || ""}</div>`
    : `${b.before ? `<span class="by">${esc(b.before)}</span>` : ""}<div class="btn opt ${b.plain ? "plain" : ""}">${b.sortIcon ? ICON.sort : ""}<span>${esc(b.label)}</span></div>`).join("")}</div>` : "";
  p.rendered = true;
}
function drawPage(p) {
  // Still loading and nothing to show yet: leave what's on screen until the rows arrive.
  if (p.pending && !p.rows.length) return;
  if (!p.isPicker) { document.body.classList.remove("who-mode"); $("who").hidden = true; }
  document.body.classList.toggle("no-menu", !!p.noMenu);
  document.body.classList.toggle("details", !!(p.heroItem && p.heroItem.details));
  // library grids (Library / Collections / Categories tabs) have no hero, like Plex
  document.body.classList.toggle("no-hero", !!(p.noHero && p.noHero()));
  $("ovMenu").hidden = !p.overflow;
  $("ovMenu").classList.toggle("focus", !!p.ovFocus && !menuOpen);
  if (!p.rendered) renderRows(p);
  const all = p.allRows();
  const rowEls = [...$("rows").children];
  // tabs
  if (p.tabs) [...$("tabs").children].forEach((el, i) => {
    el.classList.toggle("selected", i === p.tabs.selected);
    el.classList.toggle("focus", !menuOpen && p.row === 0 && i === p.tabs.col);
  });
  if (p.tabs) {   // a long tab bar (many seasons) scrolls: keep the focused / chosen tab in view
    const bar = $("tabs"), el = bar.children[p.row === 0 ? p.tabs.col : p.tabs.selected];
    if (el) {
      const l = el.offsetLeft, r = l + el.offsetWidth;
      if (l < bar.scrollLeft + 6) bar.scrollLeft = Math.max(0, l - 6);
      else if (r > bar.scrollLeft + bar.clientWidth - 6) bar.scrollLeft = r - bar.clientWidth + 6;
    }
  }
  // focus marks
  p.rows.forEach((r, ri) => {
    const el = r.fixed ? $("libBar") : rowEls[ri];
    if (!el) return;
    const items = r.kind === "track" ? el.querySelectorAll(".trk") : r.kind === "buttons" || r.kind === "options" ? el.querySelectorAll(".btn") : r.kind === "keys" ? el.querySelectorAll(".key") : el.querySelectorAll(".card");
    const isFocusRow = !menuOpen && !p.ovFocus && !p.azFocus && all[p.row] === r;
    items.forEach((c, ci) => c.classList.toggle("focus", isFocusRow && ci === r.col));
    el.classList.toggle("dim", !isFocusRow);
    // keep the focused card in view: the row slides left once you pass the middle
    if (r.kind !== "buttons" && r.kind !== "options" && r.kind !== "track" && !r.grid) {   // (grids are sized to fit)
      const step = r.kind === "wide" || r.kind === "landscape" || r.kind === "tiles" ? 368 : r.kind === "keys" ? 76 : r.kind === "set" ? 272 : 248;
      const contentX = 128;
      const visible = Math.floor((STAGE_W - contentX - 120) / step);
      const shift = Math.max(0, Math.min(r.col - (visible - 2), r.items.length - visible)) * step;
      el.querySelector(".strip").style.transform = `translateX(${-Math.max(0, shift)}px)`;
    }
  });
  // the focused row sits at the top of the rows area (rows above slide away)
  const contentRow = p.row - (p.tabs ? 1 : 0);
  if (p.pinned && contentRow >= 0 && rowEls[contentRow]) {
    $("rows").style.transform = `translateY(${-rowEls[contentRow].offsetTop}px)`;
  } else if (!p.pinned) {
    const pin = p.pinFrom != null && contentRow >= p.pinFrom && rowEls[contentRow];
    $("rows").style.transform = pin ? `translateY(${-rowEls[contentRow].offsetTop}px)` : "translateY(0)";
  }
  // hero: the focused item, else the page's own item
  const f = p.focused();
  const heroIt = f && f.title && f.key ? f : (p.heroItem || (p.rows[0] && p.rows[0].items[0]));
  if (heroIt && heroIt.key) showHero(heroIt);
  else if (p.drawHero) p.drawHero();
  // near the end of what's loaded (library grid): load more
  if (p.loadMore && contentRow >= p.rows.length - 3) p.loadMore();
  if (p.after) p.after(); else $("azBar").hidden = true;
  fitLayout(p);
}
function showPage(p, { push = false } = {}) {
  if (push && page) stack.push(page);
  if (!p.themeFor || p.themeFor !== themeFor) stopTheme();
  page = p;
  page.rendered = false;
  drawPage(page);
  if (p.gridGen !== gridGen) resizePage(p);
  else if (p.ver < dataVer) autoFreshen(p);
}

// ---- moving around -------------------------------------------------------------------
function move(dir) {
  if (menuOpen) {
    if (dir === "Up") menuMove(-1);
    else if (dir === "Down") menuMove(1);
    else if (dir === "Right") closeMenu();
    return;
  }
  if (!page) return;
  const all = page.allRows();
  const r = all[page.row];
  if (!r) return;
  if (dir === "Left") {
    if (r.col > 0) r.col--;   // tabs open with OK, like Plex
    else if (r.kind !== "buttons" || r.col === 0) openMenu();
  } else if (dir === "Right") {
    if (r.col < r.items.length - 1) r.col++;
  } else {
    const next = page.row + (dir === "Down" ? 1 : -1);
    if (next >= 0 && next < all.length && all[next].items.length) {
      // within a grid (Browse, Collections, Categories…): straight down / up, the same column
      // (the last row can be shorter: its last card) — like Plex. Other rows keep their own place.
      if (r.grid && all[next].grid) all[next].col = Math.min(r.col, all[next].items.length - 1);
      page.row = next;
    }
  }
  page.draw();
}
let tabTimer = null;
function switchTab() {
  clearTimeout(tabTimer);
  const p = page;
  tabTimer = setTimeout(() => { if (p === page && p.onTab && p.tabs.col !== p.tabs.selected) { p.tabs.selected = p.tabs.col; p.onTab(p.tabs.col); } }, 300);
}
function ok() {
  if (menuOpen) return menuOk();
  if (!page) return;
  const r = page.allRows()[page.row];
  if (!r) return;
  if (r === page.tabs) { // a tab: open it and go to its content
    if (page.tabs.selected !== r.col) { page.tabs.selected = r.col; page.onTab(r.col); }
    return;
  }
  const it = r.items[r.col];
  if (!it) return;
  if (it.open && r.kind !== "buttons") return it.open();
  if (r.kind === "buttons" || r.kind === "keys") return it.action();
  if (r.kind === "options" || r.kind === "track") return it.action();
  if (it.type === "photo") return Photos.open(page, it);
  if (r.kind === "wide") return playItem(it, !!it.offset);
  if (r.kind === "landscape") return playItem(it, false);   // extras / trailers
  if (it.open) return it.open();                            // people, genres, sort buttons…
  openItem(it);
}
function back() {
  if (menuOpen) return menuBack();
  // Who's watching (no menu there): Back goes Home.
  if (page && page.noMenu && !stack.length) { const h = menuItems.find((m) => m.id === "home"); currentMenuId = "home"; h.open(); drawMenu(); return; }
  if (stack.length) { const prev = stack.pop(); if (prev.themeFor !== themeFor) stopTheme(); page = prev; prev.rendered = false; drawPage(prev); if (prev.gridGen !== gridGen) resizePage(prev); else if (prev.ver < dataVer) autoFreshen(prev); return; }
  if (!page) return openMenu();
  // On a page: first back to the top row, then the sidebar.
  const first = page.tabs ? 1 : 0;
  if (page.row > first) { page.row = first; page.draw(); return; }
  openMenu();
}

// ---- opening and playing --------------------------------------------------------------
function openItem(it) {
  // Watchlist items carry Plex's online id: find the copy on your server first.
  if (it.cloud) return openWatchlistItem(it);
  if (it.type === "movie" || it.type === "video" || it.type === "clip") return showPage(moviePage(it), { push: true });
  if (it.type === "show") return showPage(showPage_(it.key), { push: true });
  if (it.type === "season") return showPage(showPage_(it.showKey, { seasonKey: it.key }), { push: true });
  if (it.type === "episode") return showPage(showPage_(it.showKey, { seasonKey: it.seasonKey, episodeKey: it.key }), { push: true });
  if (it.type === "collection") return showPage(listPage(it.title, `/library/collections/${it.key}/children`, it), { push: true });
  if (it.type === "playlist") return showPage(playlistPage(it), { push: true });
  if (it.type === "artist") return showPage(artistPage(it), { push: true });
  if (it.type === "album") return showPage(albumPage(it), { push: true });
  if (it.type === "track") return Music.playQueue([it.raw], 0);
  if (it.type === "photoalbum") return showPage(listPage(it.title, `/library/metadata/${it.key}/children`, it), { push: true });
  // Anything else opens in PC mode.
  desktop.tvOpenPc(`#!/server/${S.machineId}/details?key=${encodeURIComponent(`/library/metadata/${it.key}`)}`);
}
async function playItem(it, resume) {
  Music.pauseForVideo();
  stopTheme();
  // The native player (mpv) plays everything straight from the server; the built-in one is the fallback.
  if (lastPrefs.playerEngine !== "builtin" && await desktop.nativeAvailable()) { nativePlaying = true; desktop.nativePlay({ key: it.key, resume: !!resume }); return; }
  Player.open(it, { resume: !!resume });
}
desktop.onNativeFailed((it) => { nativePlaying = false; if (it && it.key) Player.open(it, { resume: !!it.resume }); });
async function setWatched(it, on) {
  await api(on ? "/:/scrobble" : "/:/unscrobble", { key: it.key, identifier: "com.plexapp.plugins.library" }).catch(() => {});
  dataVer++;   // the page you're on refreshes itself; the others when you go back to them
}

// ---- Home ------------------------------------------------------------------------------
function hubRows(hubs) {
  return hubs.filter((h) => h.Metadata && h.Metadata.length).map((h) => ({
    kind: "posters", title: h.title, col: 0,
    items: h.Metadata.map(norm).map((it) => ({ ...it, labelBelow: "" })),
  }));
}
function homePage() {
  const p = makePage({});
  // the ⋮ by the clock (Up from the top row), like Plex: Manage Home Screen
  p.overflow = true;
  p.onAct = (name) => {
    if (!p.ovFocus) {
      if (name === "Up" && p.row === 0) { p.ovFocus = true; p.draw(); return true; }
      return false;
    }
    if (name === "OK") { manageHome(); return true; }
    if (name === "Down" || name === "Back") { p.ovFocus = false; p.draw(); return true; }
    if (name === "Left") { p.ovFocus = false; openMenu(); return true; }
    return true;
  };
  loadInto(p, async () => {
    const [cont, hubs] = await Promise.all([
      api("/hubs/continueWatching", { count: 30 }).catch(() => null),
      api("/hubs", { count: 20, excludeContinueWatching: 1 }),
    ]);
    const rows = [];
    const cw = mc(cont).Hub || [];
    rows.push(...hubRows(cw));
    rows.push(...hubRows((mc(hubs).Hub || []).filter((h) => !/continue|on deck/i.test(h.title) || !cw.length)));
    return rows;
  });
  return p;
}

function manageHome() {
  Dialog.open({
    layout: "side", title: tr("Manage Home Screen"), icon: "plexmark",
    items: [{ label: tr("Reset All Customizations"), desc: tr("Restore the default sidebar: its order and the entries you unpinned."),
      action: () => { writeList("tvMenuOrder", []); writeList("tvMenuHidden", []); buildMenu(); drawMenu(); toast(tr("Sidebar restored")); } }],
  });
}
// Rows of 7 posters (a grid you move through like rows).
function gridRows(items, title) {
  const rows = [];
  const { per: n, cw } = gridFit();   // 7 at 100 % text size, at least 5
  for (let i = 0; i < items.length; i += n) rows.push({ kind: "posters", grid: true, cw, title: i === 0 ? title : "", col: 0, items: items.slice(i, i + n) });
  return rows;
}
// A plain list of things as a poster grid (a collection, a playlist, a genre, an actor).
function listPage(title, path, heroItem = null, params = {}) {
  const p = makePage({ heroItem });
  loadInto(p, async () => {
    const items = (mc(await api(path, params)).Metadata || []).map(norm);
    return items.length ? gridRows(items, title) : [{ kind: "posters", title: tr("{title} — nothing here", { title }), col: 0, items: [] }];
  });
  return p;
}

// ---- a library: Recommended / Library / Collections / Categories -----------------------
const SORTS = [
  { label: tr("Title"), v: "titleSort" }, { label: tr("Recently added"), v: "addedAt:desc" },
  { label: tr("Release date"), v: "originallyAvailableAt:desc" }, { label: tr("Year"), v: "year:desc" },
  { label: tr("Rating"), v: "rating:desc" }, { label: tr("Recently watched"), v: "lastViewedAt:desc" },
];
const SHOWS = [{ label: tr("All"), q: {} }, { label: tr("Unwatched Only"), q: { unwatched: 1 } }, { label: tr("In progress"), q: { inProgress: 1 } }];
// What each library had chosen — its tab, and Browse's "All ▾ by Title ▾" — is kept per library
// (and per Plex user on this PC, like the menu), so it opens that way again, also after a restart.
function libChoices(sec) {
  const id = `${(S && S.machineId) || ""}/${sec.key}`;
  const all = () => { try { const v = JSON.parse(localStorage.getItem(userKey("tvLibChoices")) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
  const c = all()[id] || {};
  return {
    tab: [0, 1, 2, 3].includes(c.tab) ? c.tab : 0,
    sort: Math.max(0, SORTS.findIndex((x) => x.v === c.sort)),
    show: [0, 1, 2].includes(c.show) ? c.show : 0,
    save: (v) => { try { const a = all(); a[id] = { ...a[id], ...v }; localStorage.setItem(userKey("tvLibChoices"), JSON.stringify(a)); } catch {} },
  };
}
function libraryPage(sec) {
  const kept = libChoices(sec);
  const tabs = { kind: "tabs", items: [{ label: tr("Recommended") }, { label: tr("Browse") }, { label: tr("Collections") }, { label: tr("Categories") }], col: kept.tab, selected: kept.tab };
  const p = makePage({ tabs });
  p.noHero = () => tabs.selected > 0;
  let sort = kept.sort, show = kept.show;
  const remember = () => kept.save({ tab: tabs.selected, sort: SORTS[sort].v, show });
  // What each tab showed last time: switching back shows it at once (then refreshes quietly).
  const tabRows = [];
  const keep = (i) => (rows) => { tabRows[i] = { rows, loadMore: null }; };
  const loadRecommended = (o = {}) => loadInto(p, async () => hubRows(mc(await api(`/hubs/sections/${sec.key}`, { count: 20 })).Hub || []), { ...o, done: keep(0) });
  // The Library tab pages in 84 titles at a time; the old grid stays up until the first batch is in.
  let libLoad = null;
  // posters across the Browse grid (6 at 100 % text size; the A–Z bar keeps the right edge)
  const libPer = () => gridFit(160).per;   // (at least 5)
  const loadLibrary = ({ quiet = false } = {}) => {
    p.loadSeq = (p.loadSeq || 0) + 1;   // drops answers still on their way for the other tabs
    const { per, cw } = gridFit(160);
    let start = 0, total = Infinity, loading = false;
    const old = p.rows[0] && p.rows[0].kind === "options" ? p.rows[0] : null;
    const opts = {
      kind: "options", fixed: true, col: old ? old.col : 0,
      items: [
        // like Plex: "All ▾  by  Title ▾" — each opens its list
        { label: SHOWS[show].label, action: () => Dialog.open({ layout: "list", title: sec.title, focus: show,
          items: SHOWS.map((x, i) => ({ label: (i === show ? "✓  " : "") + x.label, action: () => { show = i; remember(); loadLibrary(); } })) }) },
        { label: sec.type === "show" ? tr("Shows") : sec.type === "artist" ? tr("Artists") : tr("Movies"), plain: true, action: () => {} },
        { label: SORTS[sort].label, sortIcon: true, before: tr("by"), action: () => Dialog.open({ layout: "list", title: tr("Sort by"), focus: sort,
          items: SORTS.map((x, i) => ({ label: (i === sort ? "✓  " : "") + x.label, action: () => { sort = i; remember(); loadLibrary(); } })) }) },
        // ⋮: play the library from the top, or something at random
        { icon: "dots", iconOnly: true, label: tr("More"), action: () => Dialog.open({ layout: "list", title: sec.title,
          items: [{ label: tr("Play"), action: () => playLibrary(false) }, { label: tr("Shuffle"), action: () => playLibrary(true) }] }) },
      ],
    };
    const rows = [opts];
    const loadMore = libLoad = async () => {
      if (loading || start >= total) return;
      loading = true;
      const first = start === 0;
      if (first && !quiet) busy(true);
      try {
        // with collections, like Plex: a movie that's in a collection shows as the collection
        // ("300 Collection · 2 movies"), as the library's collection setting on the server says
        const r = mc(await api(`/library/sections/${sec.key}/all`, { "X-Plex-Container-Start": start, "X-Plex-Container-Size": 84, sort: SORTS[sort].v, includeCollections: 1, ...SHOWS[show].q }));
        if (libLoad !== loadMore) return;   // sort/show changed meanwhile
        total = r.totalSize ?? r.size ?? 0;
        opts.count = tr("{n} Items", { n: total });
        const items = (r.Metadata || []).map(norm);
        start += items.length;
        if (!items.length) total = start;
        // 6 to a row (the A–Z bar has the right edge), no heading — like Plex
        const last = rows[rows.length - 1];
        let rest = items;
        if (rows.length > 1 && last.items.length < per) { const fill = per - last.items.length; last.items.push(...rest.slice(0, fill)); rest = rest.slice(fill); }
        for (let i = 0; i < rest.length; i += per) rows.push({ kind: "posters", grid: true, cw, title: "", col: 0, items: rest.slice(i, i + per) });
        tabRows[1] = { rows, loadMore };
        if (p.tabs.selected !== 1 || (!first && p.rows !== rows)) return;
        if (first) {
          if (quiet) keepCols(p.rows, rows);
          p.rows = rows; p.loadMore = loadMore; p.pending = false;
          if (!quiet) p.row = 1;
          else if (p.row >= p.allRows().length) p.row = 1;
        }
        if (page === p) { p.rendered = false; drawPage(p); }
      } catch (err) {
        if (first && !quiet && libLoad === loadMore) showError(tr("Couldn't load this from your Plex server."), tr("Try again"), () => loadLibrary());
      } finally {
        loading = false;
        if (first && !quiet) busy(false);
      }
    };
    loadMore();
    loadLetters();
  };
  // ---- the Library tab's A–Z bar: Plex's own letter counts (only when sorted by title) ----
  let az = [];   // [{ ch, size, start }]
  const loadLetters = async () => {
    az = [];
    if (SORTS[sort].v !== "titleSort") { if (page === p) p.draw(); return; }
    try {
      const d = mc(await api(`/library/sections/${sec.key}/firstCharacter`, { includeCollections: 1, ...SHOWS[show].q })).Directory || [];   // the same list as the grid
      let n = 0;
      az = d.map((x) => { const e = { ch: x.title, size: Number(x.size) || 0, start: n }; n += e.size; return e; });
    } catch {}
    if (page === p) p.draw();
  };
  const gridItems = () => p.rows.slice(1).flatMap((r) => r.items);
  const letterOf = (it) => {
    const t = String((it && ((it.raw && it.raw.titleSort) || it.title)) || "").trim().toUpperCase();
    const c = t[0] || "#";
    return /[A-Z]/.test(c) ? c : "#";
  };
  const azIndexFor = (ch) => Math.max(0, az.findIndex((e) => e.ch === ch));
  async function jumpTo(k) {
    const e = az[k];
    if (!e) return;
    for (let tries = 0; tries < 60 && gridItems().length <= e.start && p.loadMore; tries++) { await p.loadMore(); await new Promise((r) => setTimeout(r, 60)); }
    const idx = Math.min(e.start, gridItems().length - 1);
    if (idx < 0) return;
    const per = libPer();
    p.row = 2 + Math.floor(idx / per);
    const r = p.allRows()[p.row];
    if (r) r.col = idx % per;
    p.azFocus = false;
    p.draw();
  }
  async function playLibrary(shuffle) {
    try {
      // a real title (the grid can start with a collection)
      let it = (mc(await api(`/library/sections/${sec.key}/all`, { sort: shuffle ? "random" : SORTS[sort].v, "X-Plex-Container-Size": 1, ...SHOWS[show].q })).Metadata || []).map(norm)[0];
      if (!it) return;
      // a show: its next episode (the first one not watched yet)
      if (it.type === "show") {
        const eps = (mc(await api(`/library/metadata/${it.key}/allLeaves`)).Metadata || []).map(norm);
        it = (shuffle ? eps[Math.floor(Math.random() * eps.length)] : eps.find((e) => !watched(e))) || eps[0];
        if (!it) return;
      }
      playItem(it, !!it.offset);
    } catch { toast(tr("Couldn't play this")); }
  }
  // keys: Right at the end of a grid row goes to the A–Z bar; there Up / Down pick a letter, OK jumps
  p.onAct = (name) => {
    if (tabs.selected !== 1 || !az.length) { p.azFocus = false; return false; }
    if (p.azFocus) {
      if (name === "Up") p.azIndex = Math.max(0, p.azIndex - 1);
      else if (name === "Down") p.azIndex = Math.min(az.length - 1, p.azIndex + 1);
      else if (name === "OK") { jumpTo(p.azIndex); return true; }
      else if (name === "Left" || name === "Back") p.azFocus = false;
      else return true;
      p.draw();
      return true;
    }
    const r = p.allRows()[p.row];
    if (name === "Right" && r && r.grid && r.col >= r.items.length - 1) {
      p.azFocus = true; p.azIndex = azIndexFor(letterOf(r.items[r.col])); p.draw();
      return true;
    }
    return false;
  };
  // draw the bar; the letter of the focused title is lit, like Plex
  p.after = () => {
    const bar = $("azBar");
    const on = tabs.selected === 1 && az.length > 0 && page === p;
    bar.hidden = !on;
    if (!on) return;
    const r = p.allRows()[p.row];
    const cur = p.azFocus ? -1 : r && r.grid ? azIndexFor(letterOf(r.items[r.col])) : -1;
    bar.innerHTML = az.map((e, i) => `<div class="${i === cur ? "cur" : ""} ${p.azFocus && i === p.azIndex ? "focus" : ""}">${esc(e.ch)}</div>`).join("");
  };
  const loadCollections = (o = {}) => loadInto(p, async () => {
    const items = (mc(await api(`/library/sections/${sec.key}/collections`)).Metadata || []).map(norm);
    return items.length ? gridRows(items, tr("Collections")) : [{ kind: "posters", title: tr("No collections in this library"), col: 0, items: [] }];
  }, { ...o, done: keep(2) });
  const loadCategories = (o = {}) => loadInto(p, async () => {
    const genres = mc(await api(`/library/sections/${sec.key}/genre`)).Directory || [];
    const tiles = genres.map((g) => ({ title: g.title, open: () => showPage(listPage(g.title, `/library/sections/${sec.key}/all`, null, { genre: g.key, sort: "titleSort" }), { push: true }) }));
    const rows = [];
    const n = perRow(368);   // 4 at 100 % text size
    for (let i = 0; i < tiles.length; i += n) rows.push({ kind: "tiles", grid: true, title: i === 0 ? tr("Genres") : "", col: 0, items: tiles.slice(i, i + n) });
    return rows;
  }, { ...o, done: keep(3) });
  const loaders = [loadRecommended, loadLibrary, loadCollections, loadCategories];
  p.onTab = (i) => {
    remember();
    const saved = tabRows[i];
    if (saved) {
      p.rows = saved.rows; p.loadMore = saved.loadMore;
      p.row = saved.rows.length ? 1 : 0;
      if (page === p) { p.rendered = false; drawPage(p); }
      // the Library grid only refreshes from the top, so leave it be once you've paged down it
      if (i !== 1) loaders[i]({ quiet: true });
    } else {
      p.loadMore = null;   // the old tab stays on screen until the new one arrives
      loaders[i]();
    }
  };
  // A new Text Size: forget what the tabs showed (their grids hold the old number of cards per
  // row) and load the tab you're on again.
  p.onResize = () => {
    tabRows.length = 0;
    if (p.tabs.selected === 1) p.row = 1;
    loaders[p.tabs.selected]({ quiet: true });
  };
  // Coming back to this library from the menu or the player: refresh the tab you're on.
  p.refresh = () => {
    const i = p.tabs.selected;
    if (i === 1 && p.row > 1) return;
    loaders[i]({ quiet: true });
  };
  loaders[tabs.selected]();   // the tab you had chosen last time
  return p;
}

// Load rows into a page. What's on screen stays until the new rows arrive (no blank page),
// and a newer load for the same page wins over an older one still on its way.
// quiet: a refresh behind the scenes — no spinner, no error, focus stays where it is.
async function loadInto(p, fetchRows, { quiet = false, done = null } = {}) {
  const seq = p.loadSeq = (p.loadSeq || 0) + 1;
  p.reload = () => loadInto(p, fetchRows, { quiet: true, done });
  if (!p.rows.length) p.pending = true;
  if (!quiet) busy(true);
  try {
    const rows = await fetchRows();
    if (seq !== p.loadSeq) return;
    p.pending = false;
    if (done) done(rows);
    if (quiet && sameRows(p.rows, rows)) return;
    if (quiet) keepCols(p.rows, rows);
    p.rows = rows;
    if (p.row >= p.allRows().length) p.row = p.tabs ? 1 : 0;
    if (!quiet && p.tabs && p.row === 0) p.row = rows.length ? 1 : 0;
    if (page === p) { p.rendered = false; drawPage(p); }
  } catch (err) {
    if (seq !== p.loadSeq) return;
    p.pending = false;
    if (!quiet) showError(tr("Couldn't load this from your Plex server."), tr("Try again"), () => loadInto(p, fetchRows, { done }));
  } finally { if (!quiet) busy(false); }
}
function sameRows(a, b) {
  try {
    const sig = (rows) => JSON.stringify(rows, (k, v) => (k === "col" ? undefined : v));
    return sig(a) === sig(b);
  } catch { return false; }
}
// A refreshed page keeps the card you were on in each row.
function keepCols(old, rows) {
  rows.forEach((r, i) => {
    const o = old[i];
    if (o && o.kind === r.kind && o.title === r.title) r.col = Math.max(0, Math.min(o.col, r.items.length - 1));
  });
}

// ---- extra rows on details pages ------------------------------------------------------
function peopleRow(m) {
  const people = [...(m.Role || []).map((r) => ({ ...r, kind: "actor" })), ...(m.Director || []).map((d) => ({ ...d, role: tr("Director"), kind: "director" }))].slice(0, 20);
  if (!people.length) return null;
  return {
    kind: "people", title: tr("Cast & Crew"), col: 0,
    items: people.map((r) => ({
      title: r.tag, role: r.role || "", thumb: r.thumb,
      open: () => showPage(listPage(r.tag, `/library/sections/${m.librarySectionID}/all`, null, { [r.kind]: r.id, sort: "year:desc" }), { push: true }),
    })),
  };
}
async function extraRows(m) {
  const rows = [];
  const pr = peopleRow(m);
  if (pr) rows.push(pr);
  const [similar, extras] = await Promise.all([
    api(`/library/metadata/${m.ratingKey}/similar`, { count: 20 }).catch(() => null),
    api(`/library/metadata/${m.ratingKey}/extras`).catch(() => null),
  ]);
  const sim = (mc(similar).Metadata || []).map(norm);
  if (sim.length) rows.push({ kind: "posters", title: tr("More like this"), col: 0, items: sim });
  const ex = (mc(extras).Metadata || []).map(norm);
  if (ex.length) rows.push({ kind: "landscape", title: tr("Extras & trailers"), col: 0, items: ex });
  return rows;
}

// The buttons on a details page, like Plex's: Play (or Resume) with its name, then round ones —
// play from the start, watched, and ⋯ for the rest (audio & subtitles, add to playlist).
function detailButtons(it, after) {
  const b = [];
  b.push({ icon: "play", label: it.offset ? tr("Resume") : tr("Watch"), named: true, action: () => playItem(it, !!it.offset) });
  const plexId = String(it.guid || (it.raw && it.raw.guid) || "").split("/").pop();
  if (/^plex:\/\//.test(String(it.guid || (it.raw && it.raw.guid) || ""))) {
    b.push({ icon: "bookmark", label: tr("Watchlist"), action: async () => {
      const on = !(await onWatchlist(it));
      const ok = await desktop.tvWatchlistSet(plexId, on).catch(() => false);
      toast(ok ? (on ? tr("Added to your Watchlist") : tr("Removed from your Watchlist")) : tr("Couldn't change your Watchlist"));
    } });
  }
  b.push({ icon: "star", label: tr("Rate"), action: () => Dialog.open({
    layout: "list", title: tr("Rate {title}", { title: it.type === "episode" ? it.epTitle : it.title }), focus: Math.max(0, Math.round(((it.raw && it.raw.userRating) || 0) / 2) - 1),
    items: [1, 2, 3, 4, 5].map((n) => ({ label: "★".repeat(n) + "☆".repeat(5 - n), action: async () => {
      await api("/:/rate", { key: it.key, identifier: "com.plexapp.plugins.library", rating: n * 2 }).catch(() => {});
      toast(tr("Rated {n} of 5", { n })); after();
    } })).concat([{ label: tr("Clear rating"), action: async () => { await api("/:/rate", { key: it.key, identifier: "com.plexapp.plugins.library", rating: -1 }).catch(() => {}); after(); } }]),
  }) });
  const isW = watched(it);
  b.push({ icon: isW ? "checked" : "check", label: isW ? tr("Mark as unwatched") : tr("Mark as watched"),
    action: async () => { await setWatched(it, !isW); after(); } });
  b.push({ icon: "dots", label: tr("More"), action: () => Dialog.open({
    layout: "list", title: it.type === "episode" ? `${it.title} · ${it.epTitle}` : it.title,
    items: [
      ...(it.offset ? [{ label: tr("Play from start"), action: () => playItem(it, false) }] : []),
      { label: tr("Audio & subtitles"), action: () => tracksDialog(it, after) },
      { label: tr("Add to Playlist"), action: () => showPage(addToPlaylistPage(it), { push: true }) },
      ...(it.type === "episode" && it.showKey ? [{ label: tr("Go to show"), action: () => showPage(showPage_(it.showKey), { push: true }) }] : []),
    ],
  }) });
  return b;
}
async function onWatchlist(it) {
  const r = await desktop.tvWatchlist().catch(() => null);
  const g = String(it.guid || (it.raw && it.raw.guid) || "");
  return (mc(r).Metadata || []).some((m) => m.guid === g);
}
// Quality, audio and subtitles of what will play (right of the buttons, like Plex).
function mediaChips(m) {
  const media = m && m.Media && m.Media[0];
  if (!media) return [];
  const res = String(media.videoResolution || "");
  const video = ((media.Part && media.Part[0] && media.Part[0].Stream) || []).find((s) => s.streamType === 1);
  const streams = (media.Part && media.Part[0] && media.Part[0].Stream) || [];
  const audio = streams.find((s) => s.streamType === 2 && s.selected) || streams.find((s) => s.streamType === 2);
  const sub = streams.find((s) => s.streamType === 3 && s.selected);
  return [
    video && (video.extendedDisplayTitle || video.displayTitle) ? { text: video.extendedDisplayTitle || video.displayTitle } : res ? { text: /^\d+$/.test(res) ? `${res}p` : res.toUpperCase() } : null,
    audio ? { icon: "audio", text: audio.displayTitle || audio.language || tr("Audio") } : null,
    { icon: "subs", text: sub ? (sub.displayTitle || sub.language) : tr("Off") },
  ].filter(Boolean);
}

// ---- a movie ---------------------------------------------------------------------------
function moviePage(item) {
  const p = makePage({ heroItem: item, pinned: false, pinFrom: 1 });
  let more = null;
  const refresh = async () => {
    const raw = (mc(await api(`/library/metadata/${item.key}`)).Metadata || [])[0] || item.raw;
    const full = norm(raw);
    if (!more) more = await extraRows(raw).catch(() => []);
    p.heroItem = { ...full, details: true };
    const keepRow = p.rows.length ? p.row : 0;
    p.rows = [{ kind: "buttons", col: 0, items: detailButtons(full, refresh), chips: mediaChips(raw) }, ...more];
    p.row = Math.min(keepRow, p.rows.length - 1);
    if (page === p) { p.rendered = false; drawPage(p); }
  };
  busy(true);
  refresh().catch(() => showError(tr("Couldn't load this movie."))).finally(() => busy(false));
  p.refresh = refresh;
  return p;
}

// ---- a show: season tabs, episode strip, buttons ------------------------------------
function showPage_(showKey, { seasonKey = null, episodeKey = null } = {}) {
  const tabs = { kind: "tabs", items: [], col: 0, selected: 0 };
  const p = makePage({ tabs, pinned: false, pinFrom: 2 });
  let show = null, seasons = [], more = [];
  const epRow = { kind: "wide", col: 0, items: [] };
  const btnRow = { kind: "buttons", col: 0, items: [] };
  const focusedEpisode = () => epRow.items[epRow.col];
  const makeButtons = () => {
    const ep = focusedEpisode();
    if (!ep) { btnRow.items = []; return; }
    const b = detailButtons({ ...ep, title: show ? show.title : ep.title }, () => loadSeason(tabs.selected, ep.key));
    btnRow.chips = mediaChips(ep.raw);
    btnRow.items = b;
    btnRow.col = Math.min(btnRow.col, b.length - 1);
  };
  async function loadSeason(i, focusKey) {
    const season = seasons[i];
    if (!season) return;
    const eps = (mc(await api(`/library/metadata/${season.key}/children`)).Metadata || []).map(norm);
    epRow.items = eps;
    // Focus: the asked-for episode, else the first one not watched yet.
    let col = focusKey ? eps.findIndex((e) => e.key === focusKey) : -1;
    if (col < 0) col = eps.findIndex((e) => !watched(e));
    epRow.col = Math.max(0, col);
    makeButtons();
    p.rows = [epRow, btnRow, ...more];
    if (page === p) { p.rendered = false; drawPage(p); }
  }
  p.onTab = (i) => { p.row = 1; loadSeason(i).catch(() => {}); };
  // Back from the player: reload the season (progress / watched marks), same episode.
  p.refresh = () => { const ep = focusedEpisode(); return loadSeason(tabs.selected, ep && ep.key).catch(() => {}); };
  // The hero follows the focused episode; the buttons act on it.
  p.focused = function () {
    const r = this.allRows()[this.row];
    if (r === epRow || r === btnRow) { const ep = focusedEpisode(); return ep ? { ...ep, title: show ? show.title : ep.title, sub: ep.epTitle, details: true } : null; }
    return null;
  };
  const baseDraw = p.draw;
  p.draw = function () {
    if (this.allRows()[this.row] === epRow) { const before = btnRow.items.map((b) => b.label).join(); makeButtons(); if (btnRow.items.map((b) => b.label).join() !== before) this.rendered = false; }
    baseDraw.call(this);
  };
  busy(true);
  (async () => {
    const [meta, kids] = await Promise.all([
      api(`/library/metadata/${showKey}`, { includeOnDeck: 1 }),
      api(`/library/metadata/${showKey}/children`),
    ]);
    const m = (mc(meta).Metadata || [])[0];
    show = m ? norm(m) : null;
    p.heroItem = show ? { ...show, details: true } : null;
    if (m) more = await extraRows(m).catch(() => []);
    if (m && m.theme && page === p) playTheme(showKey, m.theme);
    p.themeFor = showKey;
    seasons = (mc(kids).Metadata || []).filter((s) => s.type === "season").map(norm);
    tabs.items = seasons.map((s) => ({ label: s.sub || s.epTitle || tr("Season {n}", { n: s.raw.index }) }));
    // Which season: the asked-for one, else the On Deck episode's, else the first.
    let si = seasonKey ? seasons.findIndex((s) => s.key === String(seasonKey)) : -1;
    let focusKey = episodeKey;
    const deck = m && m.OnDeck && m.OnDeck.Metadata && m.OnDeck.Metadata[0];
    if (si < 0 && deck) { si = seasons.findIndex((s) => s.key === String(deck.parentRatingKey)); focusKey = focusKey || deck.ratingKey; }
    if (si < 0) si = seasons.findIndex((s) => s.raw.index > 0);
    si = Math.max(0, si);
    tabs.col = tabs.selected = si;
    p.row = 1;
    await loadSeason(si, focusKey ? String(focusKey) : null);
  })().catch(() => showError(tr("Couldn't load this show."))).finally(() => busy(false));
  return p;
}

// ---- music -----------------------------------------------------------------------------
function trackRows(tracks) {
  return tracks.map((t, i) => ({
    kind: "track", col: 0,
    items: [{ n: t.index || i + 1, title: t.title, len: fmtDuration(t.duration), action: () => Music.playQueue(tracks, i) }],
  }));
}
function albumPage(item) {
  const p = makePage({ heroItem: item, pinned: false, pinFrom: 2 });
  loadInto(p, async () => {
    const tracks = mc(await api(`/library/metadata/${item.key}/children`)).Metadata || [];
    return [
      { kind: "buttons", col: 0, items: [
        { icon: "play", label: tr("Play"), action: () => Music.playQueue(tracks, 0) },
        { icon: "shuffle", label: tr("Shuffle"), action: () => Music.playQueue(tracks, 0, { shuffle: true }) },
      ] },
      ...trackRows(tracks),
    ];
  });
  return p;
}
function artistPage(item) {
  const p = makePage({ heroItem: item, pinned: false, pinFrom: 1 });
  loadInto(p, async () => {
    const albums = (mc(await api(`/library/metadata/${item.key}/children`)).Metadata || []).map(norm);
    const all = async () => mc(await api(`/library/metadata/${item.key}/allLeaves`)).Metadata || [];
    return [
      { kind: "buttons", col: 0, items: [
        { icon: "play", label: tr("Play all"), action: async () => Music.playQueue(await all(), 0) },
        { icon: "shuffle", label: tr("Shuffle"), action: async () => Music.playQueue(await all(), 0, { shuffle: true }) },
      ] },
      { kind: "posters", title: tr("Albums"), col: 0, items: albums },
    ];
  });
  return p;
}

// ---- photos: full screen, ←/→ through the photos on the page, B to close ---------------
const Photos = (() => {
  let list = [], i = 0, open_ = false, slide = null;
  function show() {
    const it = list[i];
    $("photoImg").src = img(it.raw.thumb || it.poster, 1920, 1080);
    $("photoCap").textContent = `${it.title || ""}   ${i + 1} / ${list.length}   ·   ${slide ? tr("A: stop slideshow") : tr("A: start slideshow")}`;
  }
  return {
    open(pg, it) {
      list = pg.rows.flatMap((r) => r.items).filter((x) => x.type === "photo");
      i = Math.max(0, list.findIndex((x) => x.key === it.key));
      open_ = true; $("photo").hidden = false; show();
    },
    act(name) {
      if (!open_) return false;
      if (name === "Left") i = (i - 1 + list.length) % list.length;
      else if (name === "Right") i = (i + 1) % list.length;
      else if (name === "OK") {
        // A starts / stops a slideshow (every 6 seconds).
        if (slide) { clearInterval(slide); slide = null; } else slide = setInterval(() => { i = (i + 1) % list.length; show(); }, 6000);
      }
      else if (name === "Back") { clearInterval(slide); slide = null; open_ = false; $("photo").hidden = true; return true; }
      show();
      return true;
    },
  };
})();

// ---- Watchlist (from your Plex account; opens the copy on your server) ------------------
function watchlistPage() {
  const p = makePage({});
  loadInto(p, async () => {
    const r = mc(await desktop.tvWatchlist());
    // Only what's on your server: look each one up there, show your server's copy.
    const found = await Promise.all((r.Metadata || []).map(async (m) => {
      try { return (mc(await api("/library/all", { guid: m.guid })).Metadata || [])[0] || null; } catch { return null; }
    }));
    const items = found.filter(Boolean).map(norm);
    return items.length ? gridRows(items, tr("Watchlist · on your server")) : [{ kind: "posters", title: tr("Nothing on your Watchlist is on your server yet"), col: 0, items: [] }];
  });
  return p;
}
async function openWatchlistItem(it) {
  busy(true);
  try {
    const found = (mc(await api("/library/all", { guid: it.guid })).Metadata || [])[0];
    if (found) openItem(norm(found));
    else showError(tr("\"{title}\" isn't on your Plex server yet.", { title: it.title }), tr("OK"), () => {});
  } finally { busy(false); }
}

// ---- who's watching: your Plex Home users, the PIN pad under the chosen one (like Plex) -----
// Cards in a row, the focused one bigger and centred with its name; a lock for users with a PIN,
// a crown for the admin. A protected user's number pad sits right under its card. Shown at start
// (Settings → "Ask who's watching at start") and from your profile → Switch user.
const PIN_PAD = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], [null, "0", null]];
const LOCK_SVG = '<svg viewBox="0 0 24 24"><path d="M7 10V7a5 5 0 0110 0v3h.5A1.5 1.5 0 0119 11.5v8a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 015 19.5v-8A1.5 1.5 0 016.5 10zm2 0h6V7a3 3 0 00-6 0z"/></svg>';
const CROWN_SVG = '<svg viewBox="0 0 24 24"><path d="M3 8.5l4.6 3.8L12 5.5l4.4 6.8L21 8.5 19.2 18H4.8zM5 19.5h14V21H5z"/></svg>';
function openUserPicker({ atStart = false, focusUser = null } = {}) {
  showPage(userPickerPage(atStart, focusUser), { push: !atStart });
}
function userPickerPage(atStart, focusUser = null) {
  const p = makePage({});
  p.noMenu = true; p.isPicker = true;
  let users = [], at = 0, zone = "cards", r = 0, c = 0, pin = "", wrong = false;
  const me = () => (S && S.user && S.user.name) || "";
  const cur = () => users[at];
  const choose = (u, code) => {
    if (!u) return;
    if (!u.protected && u.title === me()) { leave(); return; }   // already you
    switchTo(u, code || "");
  };
  const leave = () => {   // back to where you were (Home at start)
    if (stack.length) { back(); return; }
    currentMenuId = "home"; stack.length = 0; menuPage("home", homePage); drawMenu();
  };
  const press = (k) => {
    const u = cur();
    if (!u || !u.protected) return;
    if (k === "⌫") pin = pin.slice(0, -1);
    else if (pin.length < 4) { pin += k; wrong = false; }
    p.drawHero();
    if (pin.length === 4) choose(u, pin);
  };
  p.type = (k) => { if (cur() && cur().protected) { zone = "pad"; press(k); } };
  p.wrong = () => {
    pin = ""; wrong = true; p.drawHero();
    const n = document.querySelector(".wc.focus .wname"); if (n) { n.classList.remove("shake"); void n.offsetWidth; n.classList.add("shake"); }
  };
  p.onAct = (name) => {
    const u = cur();
    if (!u) return name !== "Back";
    if (zone === "cards") {
      if (name === "Left" || name === "Right") { const n = at + (name === "Left" ? -1 : 1); if (n >= 0 && n < users.length) { at = n; pin = ""; wrong = false; } }
      else if (name === "Down" && u.protected) { zone = "pad"; r = 0; c = 0; }
      else if (name === "OK") { if (u.protected) { zone = "pad"; r = 0; c = 0; } else choose(u); }
      else if (name === "Back") { if (atStart || stack.length) { leave(); return true; } return false; }
      else return true;
    } else {
      if (name === "Back") { zone = "cards"; }
      else if (name === "OK") { press(c === 3 ? "⌫" : PIN_PAD[r][c]); return true; }
      else if (name === "Up") { if (c === 3) zone = "cards"; else if (r === 0) zone = "cards"; else r--; }
      else if (name === "Down") { if (c < 3 && r < 3 && PIN_PAD[r + 1][c]) r++; else if (c < 3 && r === 2) { r = 3; c = 1; } }
      else if (name === "Left") { if (c === 3) { c = 2; if (!PIN_PAD[r][c]) c = 1; } else if (c > 0 && PIN_PAD[r][c - 1]) c--; }
      else if (name === "Right") { if (c < 2 && PIN_PAD[r][c + 1]) c++; else c = 3; }
    }
    p.drawHero();
    return true;
  };
  p.drawHero = () => {
    document.body.classList.add("who-mode");
    $("who").hidden = false;
    const face = (u) => (u.thumb ? (/^https?:/.test(u.thumb) ? u.thumb : img(u.thumb, 432, 432)) : "");
    $("whoTitle").textContent = tr("Who's watching?");
    $("whoRow").innerHTML = users.map((u, i) => {
      const f = face(u);
      const focus = i === at;
      return `<div class="wc ${focus ? "focus" : ""} ${focus && zone === "cards" ? "on" : ""}"><div class="wt">`
        + (f ? `<img class="wface" src="${esc(f)}" alt="">` : `<div class="wface none">${esc((u.title || "?").slice(0, 1).toUpperCase())}</div>`)
        + (u.protected ? `<i class="wlock">${LOCK_SVG}</i>` : "")
        + `</div><div class="wname">${esc(u.title)}</div></div>`;
    }).join("");
    // the row is centred on screen; too many users to fit → the focused one stays in the middle
    const row = $("whoRow"), el = row.children[at];
    const w = row.scrollWidth;
    let x = (STAGE_W - w) / 2;
    if (w > STAGE_W - 160 && el) x = STAGE_W / 2 - (el.offsetLeft + el.offsetWidth / 2);   // the chosen one in the middle
    row.style.transform = `translateX(${x}px)`;
    const pad = $("whoPad"), u = cur();
    pad.hidden = !(u && u.protected);
    if (!pad.hidden && el) {
      const centre = x + el.offsetLeft + el.offsetWidth / 2;
      pad.style.left = `${centre - 145}px`;
      const keys = [];
      for (let ri = 0; ri < 3; ri++) for (let ci = 0; ci < 3; ci++) keys.push(`<div class="pk ${zone === "pad" && ri === r && ci === c ? "focus" : ""}">${PIN_PAD[ri][ci]}</div>`);
      keys.push(`<div class="pk zero ${zone === "pad" && r === 3 && c < 3 ? "focus" : ""}">0</div>`);
      pad.innerHTML = `<div class="pfield ${wrong && !pin.length ? "wrong" : ""}">${wrong && !pin.length ? esc(tr("Wrong PIN")) : "●".repeat(pin.length)}</div>`
        + `<div class="pkeys">${keys.join("")}<div class="pk bk ${zone === "pad" && c === 3 ? "focus" : ""}"><svg viewBox="0 0 24 24"><path d="M21 5H8l-6 7 6 7h13zM17 9l-6 6M11 9l6 6"/></svg></div></div>`;
    }
  };
  busy(true);
  desktop.tvHomeUsers().then((list) => {
    users = list || [];
    at = Math.max(0, users.findIndex((u) => u.title === (focusUser || me())));
    if (!users.length) { leave(); return; }
    if (page === p) p.drawHero();
  }).catch(() => leave()).finally(() => busy(false));
  return p;
}
async function switchTo(user, pin) {
  busy(true);
  const r = await desktop.tvSwitchUser(user.uuid, pin).catch(() => null);
  busy(false);
  if (!r || !r.ok) {
    if (pin && page && page.isPicker) { page.wrong(); return; }   // shown on the card itself
    showError(pin ? tr("Wrong PIN — try again.") : tr("Couldn't switch user."), tr("OK"), () => {});
    return;
  }
  stack.length = 0;
  start(true, { picked: true });
}

// ---- Theme (same choices as the paintbrush in PC mode) ------------------------------
function looksPage() {
  const p = makePage({});
  p.drawHero = () => {
    $("heroTitle").textContent = tr("Theme");
    $("heroSub").textContent = tr("Pick a look — it changes everywhere at once");
    $("heroMeta").innerHTML = ""; $("heroLine").textContent = ""; $("heroSummary").textContent = ""; $("heroCast").textContent = "";
    $("artImg").classList.remove("on"); $("bg").style.background = "";
  };
  const build = () => {
    const themes = lastPrefs.themes || [];
    const items = themes.map((t) => ({
      title: t.label, on: t.id === lastPrefs.theme, swatch: t,
      open: () => { lastPrefs.theme = t.id; desktop.setSetting("theme", t.id); applyPrefs(lastPrefs); const keep = p.rows[0] ? p.rows[0].col : 0; build(); p.rows[0].col = keep; p.rendered = false; drawPage(p); },
    }));
    p.rows = [{ kind: "tiles", title: tr("Themes"), col: Math.max(0, items.findIndex((x) => x.on)), items }];
  };
  build();
  return p;
}

// ---- Live TV (Plex's free channels) and Discover (Plex's catalogue) -----------------------
const PROVIDER = {
  epg: { base: "https://epg.provider.plex.tv", title: "Live TV", provider: "tv.plex.provider.epg" },
  discover: { base: "https://discover.provider.plex.tv", title: "Discover", provider: "tv.plex.provider.discover" },
};
function providerPage(kind) {
  const P = PROVIDER[kind];
  const p = makePage({});
  p.online = true;
  loadInto(p, async () => {
    const home = mc(await desktop.tvProvider(`${P.base}/hubs/sections/home?count=20`));
    const hubs = (home.Hub || []).slice(0, 10);
    const filled = await Promise.all(hubs.map(async (h) => {
      if (h.Metadata && h.Metadata.length) return h;
      if (!h.key) return h;
      try { const r = mc(await desktop.tvProvider(`${P.base}${h.key}${h.key.includes("?") ? "&" : "?"}count=20`)); return { ...h, Metadata: r.Metadata || [] }; } catch { return h; }
    }));
    return filled.filter((h) => h.Metadata && h.Metadata.length).map((h) => ({
      kind: kind === "epg" ? "landscape" : "posters", title: h.title, col: 0,
      items: h.Metadata.map((m) => {
        const it = norm(m);
        if (kind === "epg") {
          const med = (m.Media || [])[0] || {};
          const end = med.endsAt ? new Date(med.endsAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
          it.title = m.grandparentTitle || m.title;
          it.sub = m.grandparentTitle ? m.title : "";
          it.still = m.thumb || m.grandparentThumb || med.channelArt;
          it.art = m.grandparentArt || m.art || med.channelArt;
          it.summary = (med.onAir ? `${end ? tr("On now · until {time}.", { time: end }) : tr("On now.")} ` : "") + (m.summary || "");
        }
        it.cloud = true;
        it.open = () => (kind === "epg"
          ? desktop.tvPlayProvider(`#!/provider/${P.provider}/details?key=${encodeURIComponent(m.key)}`)
          : openDiscoverItem(m));
        return it;
      }),
    }));
  });
  return p;
}
// Discover: your server's copy if you have it, else Plex's page for it (PC mode).
async function openDiscoverItem(m) {
  busy(true);
  try {
    const found = m.guid && (mc(await api("/library/all", { guid: m.guid })).Metadata || [])[0];
    if (found) return openItem(norm(found));
    desktop.tvOpenPc(`#!/provider/tv.plex.provider.discover/details?key=${encodeURIComponent(m.key)}`);
  } finally { busy(false); }
}

// ---- theme music on show pages ---------------------------------------------------------
const themeAudio = new Audio();
themeAudio.loop = false;
let themeFor = null, themeFade = null;
// Theme Music Volume: Plex's own levels (its TV apps have Quiet … Loud), as a share of PlexDeck's
// sound in Windows. Theme tunes are often mastered loud and Plex doesn't level them out.
const THEME_LEVELS = [{ v: 15, l: N_("Quiet") }, { v: 30, l: N_("Medium") }, { v: 50, l: N_("High") }, { v: 80, l: N_("Loud") }];
const themeVol = () => Math.max(5, Math.min(100, Number(lastPrefs.themeVolume) || 30)) / 100;
function fadeTo(target, then) {
  clearInterval(themeFade);
  themeFade = setInterval(() => {
    const v = themeAudio.volume + (target > themeAudio.volume ? 0.03 : -0.03);
    themeAudio.volume = Math.max(0, Math.min(1, v));
    if (Math.abs(themeAudio.volume - target) < 0.035) { themeAudio.volume = target; clearInterval(themeFade); if (then) then(); }
  }, 60);
}
function playTheme(showKey, path) {
  // not under a video (the show can finish loading after you've pressed play) or while hidden
  if (!lastPrefs.themeMusic || !path || Music.isActive() || Player.isActive() || nativePlaying || document.hidden) return;
  if (themeFor === showKey && !themeAudio.paused) return;
  themeFor = showKey;
  themeAudio.src = `${S.uri}${path}?X-Plex-Token=${S.token}`;
  themeAudio.volume = 0;
  themeAudio.play().then(() => fadeTo(themeVol())).catch(() => {});
}
function stopTheme() {
  if (themeAudio.paused) { themeFor = null; return; }
  themeFor = null;
  fadeTo(0, () => themeAudio.pause());
}
// TV mode hidden (PC mode, the tray): the tune stops too
document.addEventListener("visibilitychange", () => { if (document.hidden) stopTheme(); });

// ---- playlists: add to one, make a new one, remove items -------------------------------
const itemUri = (key) => `server://${S.machineId}/com.plexapp.plugins.library/library/metadata/${key}`;
function addToPlaylistPage(item) {
  const p = makePage({ heroItem: item });
  loadInto(p, async () => {
    const lists = (mc(await api("/playlists", { playlistType: "video" })).Metadata || []).filter((x) => !x.smart);
    const opts = [
      { label: tr("+ New playlist"), action: () => showPage(newPlaylistPage(item), { push: true }) },
      ...lists.map((pl) => ({ label: pl.title, action: async () => {
        await desktop.tvApiSend("PUT", `/playlists/${pl.ratingKey}/items`, { uri: itemUri(item.key) }).catch(() => null);
        toast(tr("Added to \"{name}\"", { name: pl.title })); back();
      } })),
    ];
    return [{ kind: "options", col: 0, items: opts.slice(0, 1) }, ...chunk(opts.slice(1), 4).map((g) => ({ kind: "options", grid: true, col: 0, items: g }))];   // grid: Up / Down keep the column
  });
  return p;
}
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
function newPlaylistPage(item) {
  const p = makePage({});
  p.isSearch = true;   // the keyboard types here too
  p.query = "";
  const keys = { kind: "keys", col: 0, items: [
    ...KEY_CHARS.map((c) => ({ label: c.toUpperCase(), action: () => p.type(c) })),
    { label: tr("Space"), wide: true, action: () => p.type(" ") },
    { label: "⌫", wide: true, action: () => p.erase() },
    { label: tr("Create"), wide: true, action: create },
  ] };
  p.rows = [keys];
  p.type = (t) => { p.query += t; p.drawHero(); };
  p.erase = () => { p.query = p.query.slice(0, -1); p.drawHero(); };
  p.drawHero = () => {
    $("heroTitle").textContent = p.query ? p.query : tr("New playlist");
    $("heroSub").textContent = p.query ? tr("Press Create when the name is right") : tr("Type a name with the letters below (or your keyboard)");
    $("heroMeta").innerHTML = ""; $("heroLine").textContent = ""; $("heroSummary").textContent = ""; $("heroCast").textContent = "";
  };
  async function create() {
    const title = p.query.trim();
    if (!title) return;
    const r = await desktop.tvApiSend("POST", "/playlists", { type: "video", title, smart: 0, uri: itemUri(item.key) }).catch(() => null);
    toast(r ? tr("Made \"{name}\"", { name: title }) : tr("Couldn't make the playlist"));
    back(); back();
  }
  return p;
}
// A playlist's page: Y / Delete removes the focused item.
function playlistPage(pl) {
  const p = listPage(pl.title, `/playlists/${pl.key}/items`, pl);
  p.onY = async (it) => {
    const id = it.raw && it.raw.playlistItemID;
    if (!id) return;
    await desktop.tvApiSend("DELETE", `/playlists/${pl.key}/items/${id}`).catch(() => null);
    toast(tr("Removed \"{name}\"", { name: it.title }));
    const fresh = playlistPage(pl); fresh.row = p.row; page = fresh; fresh.rendered = false; drawPage(fresh);
  };
  return p;
}
let toastTimer = null;
function toast(text) {
  const box = $("message");
  if (box.classList.contains("error")) return;
  $("messageText").textContent = text; $("messageButton").hidden = true;
  box.classList.add("toast"); box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.classList.remove("toast"); box.hidden = true; }, 1600);
}

// ---- screensaver: your artwork, slowly, with the time --------------------------------
// Which libraries: your choice (Settings → Experience), per profile. Until you choose:
// the movie / TV libraries pinned in the side menu, so unpinned ones never show up.
const saverChoices = () => sections.filter((s) => s.type === "movie" || s.type === "show");
function saverLibs() {
  let chosen = null;
  try { const v = localStorage.getItem(userKey("tvSaverLibs")); if (v !== null) chosen = JSON.parse(v); } catch {}
  const keys = saverChoices().map((s) => s.key);
  if (Array.isArray(chosen)) return chosen.filter((k) => keys.includes(k));
  const hidden = readList("tvMenuHidden");
  return keys.filter((k) => !hidden.includes(`lib-${k}`));
}
function toggleSaverLib(key) {
  const now = saverLibs();
  writeList("tvSaverLibs", now.includes(key) ? now.filter((k) => k !== key) : [...now, key]);
  saverItems = [];   // pick new artwork next time
  drawProfPanel();
}
let nativePlaying = false;   // the native (mpv) player is open on top
let lastInput = Date.now(), saverOn = false, saverTimer = null, saverItems = [], saverI = 0, saverFlip = false;
async function startSaver() {
  if (saverOn) return;
  saverOn = true;
  $("saver").hidden = false;
  if (!saverItems.length) {
    const chosen = saverLibs();
    const libs = saverChoices().filter((s) => chosen.includes(s.key));
    const picks = await Promise.all(libs.map((s) => api(`/library/sections/${s.key}/all`, { sort: "random", "X-Plex-Container-Size": 12 }).catch(() => null)));
    saverItems = picks.flatMap((r) => mc(r).Metadata || []).filter((m) => m.art);
  }
  const step = () => {
    if (!saverItems.length) return;
    const m = saverItems[saverI++ % saverItems.length];
    const show = saverFlip ? $("saverA") : $("saverB"), hide = saverFlip ? $("saverB") : $("saverA");
    saverFlip = !saverFlip;
    show.onload = () => { show.classList.add("on"); hide.classList.remove("on"); };
    show.classList.remove("on");
    show.src = img(m.art, 1920, 1080);
    $("saverTitle").textContent = m.title + (m.year ? ` (${m.year})` : "");
    $("saverClock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  step();
  saverTimer = setInterval(step, 12000);
}
function stopSaver() {
  if (!saverOn) return false;
  saverOn = false;
  clearInterval(saverTimer);
  $("saver").hidden = true;
  $("saverA").classList.remove("on"); $("saverB").classList.remove("on");
  return true;
}
setInterval(() => {
  const mins = Number(lastPrefs.screensaver);
  if (!mins || saverOn || !S || nativePlaying || Player.isActive() || Music.isScreen() || overlayOpen || document.hidden) return;
  if (Date.now() - lastInput > mins * 60000) startSaver();
}, 15000);

// ---- Search: your own media only (your Plex server, not Plex's online catalogue) ------
const KEY_CHARS = "abcdefghijklmnopqrstuvwxyz1234567890".split("");
function searchPage() {
  const p = makePage({});
  p.isSearch = true;
  p.query = "";
  let timer = null, token = 0;
  const keysRow = { kind: "keys", col: 0, items: [] };
  const type = (t) => { p.query += t; changed(); };
  const erase = () => { p.query = p.query.slice(0, -1); changed(); };
  keysRow.items = [
    ...KEY_CHARS.map((c) => ({ label: c.toUpperCase(), action: () => type(c) })),
    { label: tr("Space"), wide: true, action: () => type(" ") },
    { label: "⌫", wide: true, action: erase },
    { label: tr("Clear"), wide: true, action: () => { p.query = ""; changed(); } },
  ];
  p.rows = [keysRow];
  p.drawHero = () => {
    $("heroTitle").textContent = p.query ? p.query : tr("Search your media");
    $("heroSub").textContent = p.query ? "" : tr("Type with the letters below (or your keyboard)");
    $("heroMeta").innerHTML = ""; $("heroLine").textContent = ""; $("heroSummary").textContent = p.results != null ? (p.results ? "" : tr("Nothing found on your server.")) : "";
    $("heroCast").textContent = "";
    $("artImg").classList.remove("on"); $("bg").style.background = "";
  };
  p.type = type; p.erase = erase;
  function changed() {
    clearTimeout(timer);
    p.drawHero();
    timer = setTimeout(run, 450);
  }
  async function run() {
    const q = p.query.trim();
    const my = ++token;
    if (!q) { p.rows = [keysRow]; p.results = null; p.rendered = false; if (page === p) drawPage(p); return; }
    const r = mc(await api("/hubs/search", { query: q, limit: 20, includeCollections: 0 }).catch(() => null));
    if (my !== token) return;
    const rows = hubRows((r.Hub || []).filter((h) => ["movie", "show", "season", "episode"].includes(h.type)));
    p.results = rows.length;
    const keepRow = p.row;
    p.rows = [keysRow, ...rows];
    p.row = Math.min(keepRow, p.rows.length - 1);
    p.rendered = false;
    if (page === p) drawPage(p);
  }
  return p;
}

// ---- messages ------------------------------------------------------------------------
// Loading: a small spinner in the corner, and only when it takes a while — quick loads show nothing.
let busyCount = 0, busyTimer = null;
function busy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  if (!busyCount) { clearTimeout(busyTimer); busyTimer = null; $("loading").hidden = true; }
  else if (!busyTimer && $("loading").hidden) busyTimer = setTimeout(() => { busyTimer = null; if (busyCount) $("loading").hidden = false; }, 400);
}
function showError(text, button, action) {
  const box = $("message");
  box.classList.add("error");
  box.hidden = false;
  $("messageText").textContent = text;
  const b = $("messageButton");
  b.hidden = !button;
  b.textContent = button || "";
  errorAction = action || null;
}
let errorAction = null;
function clearError() { $("message").classList.remove("error"); $("message").hidden = true; errorAction = null; }

// ---- input: keyboard, controller, mouse ----------------------------------------------
function act(name) {
  lastInput = Date.now();
  if (stopSaver()) return;
  if (overlayOpen) return;
  if (nativePlaying) return;   // mpv's player is on top and has the controls: a stray key here must not start a second video
  if (Player.isActive()) { document.body.classList.remove("mouse"); Player.act(name); return; }
  if (Photos.act(name)) return;
  if (Music.act(name)) return;
  if ($("message").classList.contains("error")) {
    if (name === "OK" && errorAction) { const a = errorAction; clearError(); a(); }
    else if (name === "Back") clearError();
    return;
  }
  document.body.classList.remove("mouse");
  if (Dialog.isOpen()) return Dialog.act(name);
  // Start / Options: TV mode's own Settings (profile → Settings), again to close — it opened the
  // PC settings window (that one is still there: Settings → All PlexDeck Settings)
  if (name === "Start") { if (menuOpen && profPanel) closeMenu(); else openTvSettings(); return; }
  if (menuOpen && profPanel) return profPanelAct(name);
  if (menuOpen && menuKey(name)) return;
  if (!menuOpen && page && page.onAct && page.onAct(name)) return;   // pages with their own layout (the PIN pad)
  if (name === "Up" || name === "Down" || name === "Left" || name === "Right") move(name);
  else if (name === "OK") ok();
  else if (name === "Y" && page && page.onY && !menuOpen) { const r = page.allRows()[page.row]; if (r && r.items[r.col]) page.onY(r.items[r.col]); }
  else if (name === "Back") back();
}
function openTvSettings() {
  if (page && page.noMenu) return;   // who's watching / the PIN pad: no menu there
  if (!menuOpen) openMenu();
  if (!menuOpen) return;
  openProfile();
  pushPanel(SETTINGS_PANEL());
}
const KEYS = { Delete: "Y", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Enter: "OK", " ": "OK", Escape: "Back", Backspace: "Back", BrowserBack: "Back",
  MediaPlayPause: "OK", MediaTrackNext: "R1", MediaTrackPrevious: "L1", MediaFastForward: "R2", MediaRewind: "L2" };
addEventListener("keydown", (e) => {
  lastInput = Date.now();
  if (page && page.isPicker && !menuOpen && !overlayOpen && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); page.type(e.key); return; }
    if (e.key === "Backspace") { e.preventDefault(); page.type("⌫"); return; }
  }
  if (page && page.isSearch && !menuOpen && !overlayOpen && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (e.key.length === 1 && /[\p{L}\p{N} '&:.-]/u.test(e.key)) { e.preventDefault(); page.type(e.key.toLowerCase()); return; }
    if (e.key === "Backspace" && page.query) { e.preventDefault(); page.erase(); return; }
  }
  const name = KEYS[e.key];
  if (!name || e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  act(name);
});

// Controller: same names as the PC-mode layer (A = OK, B = Back, Start = settings).
const held = new Map();
let padPrimed = false;
function padLoop() {
  const pads = desktop.padState();
  const now = performance.now();
  const down = new Set(pads.flatMap((p) => p.pressed));
  // Buttons already down when this page opens belong to whatever opened it (A on Play opens
  // the player's controls with A still held, which paused it at 0:00): they only count once
  // they're let go and pressed again. The pad can show up a moment after the page opens.
  if (!padPrimed && pads.length) { padPrimed = true; if (now < 1500) for (const n of down) held.set(n, Infinity); }
  // Another app in front (MediaDeck, a game): the pad isn't ours. What's held when PlexDeck comes
  // back only counts once it's let go and pressed again.
  if (!desktop.appFocused()) {
    for (const n of down) held.set(n, Infinity);
    for (const n of [...held.keys()]) if (!down.has(n)) held.delete(n);
    requestAnimationFrame(padLoop);
    return;
  }
  for (const n of down) {
    const name = n === "A" ? "OK" : n === "B" || n === "Back" ? "Back" : n;
    const vol = n === "VolUp" || n === "VolDown";   // the right stick: held, the volume keeps moving
    if (!held.has(n)) { held.set(n, now + (vol ? 300 : 380)); act(name); }
    else if ((vol || ["Up", "Down", "Left", "Right"].includes(n)) && now >= held.get(n)) { held.set(n, now + (vol ? 80 : 110)); act(name); }
  }
  for (const n of [...held.keys()]) if (!down.has(n)) held.delete(n);
  requestAnimationFrame(padLoop);
}
requestAnimationFrame(padLoop);

// Using the mouse here switches back to PC mode (the app decides, see settings).
let mouseStart = null;
addEventListener("mousemove", (e) => {
  if (!mouseStart) { mouseStart = [e.screenX, e.screenY, Date.now()]; return; }
  if (Date.now() - mouseStart[2] > 600) { mouseStart = [e.screenX, e.screenY, Date.now()]; return; }
  if (Math.abs(e.screenX - mouseStart[0]) + Math.abs(e.screenY - mouseStart[1]) > 80) {
    mouseStart = null; document.body.classList.add("mouse"); desktop.tvMouseUsed();
  }
});
addEventListener("mousedown", () => { document.body.classList.add("mouse"); desktop.tvMouseUsed(); });

desktop.onTv("tv:overlay", (open) => { overlayOpen = !!open; held.clear(); });
desktop.onTv("tv:prefs", (s) => applyPrefs(s));
desktop.onTv("tv:refresh", () => {
  nativePlaying = false;
  lastInput = Date.now();
  // Back from the player: progress has changed — reload the page you're on now, and again a
  // moment later (the server may not have saved where you stopped yet; Continue Watching
  // would still show the old spot). Pages further back reload when you return to them.
  afterPlayback();
});
let afterPlayTimer = null;
function afterPlayback() {
  watchedChanged();
  clearTimeout(afterPlayTimer);
  afterPlayTimer = setTimeout(watchedChanged, 4000);
}
// Back from PC mode (you may have watched something there): bring the page up to date.
desktop.onTv("tv:shown", () => { if (S) watchedChanged(); });
// Sitting on a page: refresh it quietly every 2 minutes (things watched on other devices,
// new episodes) — only while TV mode is on screen and nothing plays.
setInterval(() => {
  if (!S || !page || page.online || document.hidden || nativePlaying || Player.isActive() || saverOn || menuOpen) return;
  freshen(page);
}, 120000);
let homePageRef = null;
let lastPrefs = {};
function applyPrefs(s) {
  if (!s || !s.themes) return;
  lastPrefs = s;
  const t = s.themes.find((x) => x.id === s.theme);
  if (t) document.documentElement.style.setProperty("--accent", t.accent);
  // Theme Music switched off, or a new level: at once (you hear it while you choose)
  if (!s.themeMusic) stopTheme();
  else if (themeFor && !themeAudio.paused) fadeTo(themeVol());
  // Text Size: refit the stage, then rebuild what's on screen (grids count their cards again)
  const ts = Math.max(0.7, Math.min(1.6, Number(s.tvTextSize) || 1));
  if (ts !== textScale) {
    textScale = ts;
    fit();
    if (page && S) resizePage(page);
    if (typeof drawMenu === "function" && S) drawMenu();
  }
}

// ---- start ----------------------------------------------------------------------------
let askedWho = false;   // "Who's watching" is asked once, when TV mode starts
let sentToSignIn = false;   // not signed in: PC mode's Plex sign-in opened by itself once
async function start(force = false, { picked = false } = {}) {
  if (picked) askedWho = true;
  saverItems = [];   // another profile may see other libraries
  clearError();
  busy(true);
  $("messageText").textContent = tr("Connecting to your Plex server…");
  $("messageButton").hidden = true;
  $("message").hidden = false;
  pageCache.clear();   // another user's libraries
  try {
    const s = await desktop.tvSession(force);
    if (!s || !s.ok) {
      busy(false);
      // Not signed in (a new PlexDeck): Plex's sign-in is in PC mode - go there once by itself, and the button
      // takes you there again
      if (s && s.error === "signin") {
        showError(tr("Sign in to Plex in PC mode first, then come back to TV mode."), tr("Sign in"), () => desktop.tvOpenPc(""));
        if (!sentToSignIn) { sentToSignIn = true; desktop.tvOpenPc(""); }
        return;
      }
      const why = s && s.error === "noserver" ? tr("No Plex server found on your account.")
        : tr("Couldn't reach your Plex server.");
      showError(why, tr("Try again"), () => start(true));
      return;
    }
    S = s;
    Music.init({ S, api, img, prefs: () => lastPrefs, onChange: () => { const id = menuItems[menuIndex] && menuItems[menuIndex].id; buildMenu(); const i = menuItems.findIndex((m) => m.id === id); if (i >= 0) menuIndex = i; drawMenu(); } });
    Player.init({
      S, api, put: (p, q) => desktop.tvApiPut(p, q), prefs: () => lastPrefs,
      // Back from the player: progress changed, so reload the page you're on.
      onClose: () => afterPlayback(),   // same as after the native player (see tv:refresh)
      // Couldn't play it here: hand it to Plex's own player instead.
      fallback: (it) => desktop.tvPlay({ ratingKey: it.ratingKey, resume: true }),
    });
    if (S.user) {
      $("userName").textContent = S.user.name;
      if (S.user.thumb) $("avatar").src = S.user.thumb;
    }
    const secs = mc(await api("/library/sections"));
    sections = (secs.Directory || []).map((d) => ({ key: d.key, title: d.title, type: d.type }));
    buildMenu();
    currentMenuId = "home";
    menuOpen = true;
    menuIndex = menuItems.findIndex((m) => m.id === "home");
    homePageRef = homePage();
    pageCache.set("home", homePageRef);
    showPage(homePageRef);
    drawMenu();
    // Like Plex (with "Sign in automatically" off): who's watching, when there's more than one of you.
    if (!askedWho && lastPrefs.askUserAtStart !== false) {
      askedWho = true;
      const users = await desktop.tvHomeUsers().catch(() => null);
      if (users && users.length > 1) { menuOpen = false; drawMenu(); openUserPicker({ atStart: true }); }
    }
  } catch (err) {
    showError(tr("Couldn't reach your Plex server."), tr("Try again"), () => start(true));
  } finally {
    busy(false);
    if (!$("message").classList.contains("error")) $("message").hidden = true;
  }
}
desktop.getSettings().then(applyPrefs).catch(() => {});
// The native player's controls layer: just the player, see-through, over mpv.
const OSD = new URLSearchParams(location.search).get("osd") === "1";
if (OSD) {
  document.body.classList.add("osd-mode");
  (async () => {
    const s = await desktop.tvSession();
    if (!s || !s.ok) { desktop.nativeClose(false); return; }
    S = s;
    Player.init({ S, api, put: (p, q) => desktop.tvApiPut(p, q), prefs: () => lastPrefs, onClose: () => {}, fallback: () => {} });
    const q = new URLSearchParams(location.search);
    const at = q.get("at");
    Player.open({ key: q.get("key") }, { resume: q.get("resume") === "1", at: at ? Number(at) : null, native: true });
  })();
} else start();
