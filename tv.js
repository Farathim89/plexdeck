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

// ---- the 1920-wide stage, scaled to the window --------------------------------
function fit() {
  const scale = innerWidth / 1920;
  stage.style.transform = `scale(${scale})`;
  stage.style.height = `${innerHeight / scale}px`;
}
addEventListener("resize", fit);
fit();

// ---- clock ----------------------------------------------------------------------
function tick() { $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
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
  $("heroTitle").textContent = it.title || "";
  $("heroSub").textContent = it.sub || "";
  const meta = [];
  if (it.type === "episode") {
    meta.push(`S${it.seasonNo ?? "?"} • E${it.epNo ?? "?"}`);
    if (it.date) meta.push(fmtDate(it.date));
  } else if (it.year) meta.push(it.year);
  if (it.duration) meta.push(fmtDuration(it.duration));
  if (it.rating) meta.push(it.rating);
  if (it.type === "show" && it.childCount) meta.push(it.childCount > 1 ? tr("{n} seasons", { n: it.childCount }) : tr("1 season"));
  let chips = "";
  if (it.offset && it.duration) chips = `<span class="chip"><i class="ring"></i>${esc(tr("{time} left", { time: fmtDuration(it.duration - it.offset) }))}</span>`;
  else if (watched(it)) chips = `<span class="chip">✓ ${esc(tr("Watched"))}</span>`;
  $("heroMeta").innerHTML = meta.map((x) => `<span>${esc(x)}</span>`).join("") + chips;
  $("heroLine").textContent = it.genres.join(", ");
  $("heroSummary").textContent = it.summary;
  $("heroCast").textContent = it.cast.join(", ");
  setArt(it);
}
function setArt(it) {
  const my = ++artToken;
  const im = $("artImg");
  const src = img(it.art, 1340, 780);
  if (it.blur) {
    const c = it.blur;
    $("bg").style.background = `linear-gradient(135deg, #${c.topLeft} 0%, #${c.bottomRight} 100%)`;
    $("bg").style.filter = "brightness(.42) saturate(1.1)";
  } else {
    $("bg").style.background = ""; $("bg").style.filter = "";
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
  music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  shuffle: '<svg viewBox="0 0 24 24"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>',
  playlist: '<svg viewBox="0 0 24 24"><path d="M4 6h12M4 11h12M4 16h7"/><path d="M16 14v6l5-3z"/></svg>',
  tracks: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15h4M13 15h4M7 11h10"/></svg>',
};

// ---- the side menu -------------------------------------------------------------------
function buildMenu() {
  menuItems = [
    { id: "profile", label: S && S.user ? tr("{name} · switch", { name: S.user.name }) : tr("Switch user"), icon: "user", open: () => { currentMenuId = "profile"; stack.length = 0; showPage(profilesPage()); closeMenu(); } },
    ...(Music.isActive() ? [{ id: "nowplaying", label: tr("Now playing"), icon: "music", open: () => { closeMenu(); Music.showScreen(); } }] : []),
    { id: "looks", label: tr("Theme"), icon: "brush", open: () => { currentMenuId = "looks"; stack.length = 0; showPage(looksPage()); closeMenu(); } },
    { id: "search", label: tr("Search"), icon: "search", open: () => { currentMenuId = "search"; stack.length = 0; showPage(searchPage()); } },
    { id: "home", label: tr("Home"), icon: "home", live: true, open: () => showPage(homePage()) },
    { id: "livetv", label: tr("Live TV"), icon: "live", live: true, open: () => showPage(providerPage("epg")) },
    { id: "discover", label: tr("Discover"), icon: "discover", live: true, open: () => showPage(providerPage("discover")) },
    { id: "watchlist", label: tr("Watchlist"), icon: "watchlist", live: true, open: () => showPage(watchlistPage()) },
    { id: "playlists", label: tr("Playlists"), icon: "playlist", live: true, open: () => showPage(listPage(tr("Playlists"), "/playlists", null, { playlistType: "video" })) },
    ...sections.map((s) => ({
      id: `lib-${s.key}`, label: s.title, live: true,
      icon: s.type === "show" ? "show" : s.type === "artist" ? "artist" : s.type === "photo" ? "photo" : "movie",
      open: () => showPage(libraryPage(s)),
    })),
  ];
  const keep = menuItems.length && menuItems[menuIndex] ? menuItems[menuIndex].id : null;
  $("menuItems").innerHTML = menuItems.map((m, i) => `<div class="mi" data-i="${i}">${ICON[m.icon]}<span>${esc(m.label)}</span></div>`).join("");
  drawMenu();
}
function drawMenu() {
  document.body.classList.toggle("menu-open", menuOpen);
  const list = $("menuItems");
  $("profile").hidden = true;
  [...list.children].forEach((el, i) => {
    el.classList.toggle("focus", menuOpen && i === menuIndex);
    el.classList.toggle("current", menuItems[i].id === currentMenuId);
  });
  // Long menus scroll: keep the selected entry (and one more) on screen.
  const sel = list.children[menuOpen ? menuIndex : Math.max(0, menuItems.findIndex((m) => m.id === currentMenuId))];
  if (sel) {
    const stageH = innerHeight / (innerWidth / 1920);
    const viewH = stageH - list.offsetTop - 30;
    const itemH = sel.offsetHeight + 8;
    let shift = menuScroll;
    if (sel.offsetTop - shift < itemH) shift = Math.max(0, sel.offsetTop - itemH);
    if (sel.offsetTop + itemH * 2 - shift > viewH) shift = sel.offsetTop + itemH * 2 - viewH;
    shift = Math.max(0, Math.min(shift, list.scrollHeight - viewH));
    menuScroll = shift;
    list.style.transform = `translateY(${-shift}px)`;
    list.style.clipPath = `inset(${shift}px -40px -4000px -40px)`;   // entries scrolled up vanish under the profile
  }
  if (page) page.draw();   // positions follow the menu width
}
let liveTimer = null;
function menuMove(delta) {
  const next = Math.max(0, Math.min(menuItems.length - 1, menuIndex + delta));
  if (next === menuIndex) return;
  menuIndex = next;
  drawMenu();
  // Like the TV app: libraries load live behind the menu as you move.
  clearTimeout(liveTimer);
  const m = menuItems[menuIndex];
  if (m.live && m.id !== currentMenuId) liveTimer = setTimeout(() => { if (menuItems[menuIndex] === m) { currentMenuId = m.id; stack.length = 0; m.open(); drawMenu(); } }, 380);
}
function openMenu() {
  menuOpen = true;
  const i = menuItems.findIndex((m) => m.id === currentMenuId);
  menuIndex = i >= 0 ? i : 1;
  drawMenu();
}
function closeMenu() { menuOpen = false; drawMenu(); }
function menuOk() {
  clearTimeout(liveTimer);
  const m = menuItems[menuIndex];
  if (!m.live) { m.open(); if (m.id === "search") closeMenu(); return; }
  if (m.id !== currentMenuId) { currentMenuId = m.id; stack.length = 0; m.open(); }
  closeMenu();
}
function menuBack() {
  // Back in the menu: Home; on Home it stays put.
  const home = menuItems.findIndex((m) => m.id === "home");
  if (currentMenuId !== "home") { menuIndex = home; currentMenuId = "home"; stack.length = 0; menuItems[home].open(); }
  else menuIndex = home;
  drawMenu();
}

// ---- pages: rows of items ----------------------------------------------------------
// A page is a list of rows; a row is { kind: "posters"|"wide"|"tabs"|"buttons", title, items, col }.
// Pages keep their own focus, so Back returns to exactly where you were.
function makePage({ rows = [], tabs = null, heroItem = null, pinned = true, onTab = null, loadMore = null, pinFrom = null }) {
  const p = {
    rows, tabs, heroItem, pinned, onTab, loadMore, pinFrom,
    row: tabs ? 1 : 0,                 // row 0 is the tab bar when there is one
    draw() { drawPage(this); },
    focused() { const r = this.allRows()[this.row]; return r && r.items[r.col]; },
    allRows() { return this.tabs ? [this.tabs, ...this.rows] : this.rows; },
  };
  return p;
}
function cardHtml(it, kind) {
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
  const badge = watched(it) ? `<div class="badge">✓</div>` : "";
  const art = it.poster ? `<img src="${esc(img(it.poster, 330, it.square ? 330 : 495))}" alt="" loading="lazy">` : `<div class="fallback">${esc(it.title)}</div>`;
  const label = it.labelBelow || (it.square ? it.title : "");
  return `<div class="card ${it.square ? "sq" : ""}"><div class="img">${art}${badge}${prog}</div><div class="label">${esc(label)}</div></div>`;
}
function buttonHtml(b) {
  return `<div class="btn ${b.on ? "on" : ""}">${ICON[b.icon] || ""}<span>${esc(b.label)}</span></div>`;
}
function renderRows(p) {
  const box = $("rows");
  box.innerHTML = p.rows.map((r, i) => {
    if (r.kind === "buttons") return `<div class="row" data-r="${i}"><div class="buttons">${r.items.map(buttonHtml).join("")}</div></div>`;
    if (r.kind === "options") return `<div class="row" data-r="${i}"><div class="buttons opts">${r.items.map((b) => `<div class="btn opt"><span>${esc(b.label)}</span></div>`).join("")}</div></div>`;
    if (r.kind === "track") { const t = r.items[0]; return `<div class="row trkrow" data-r="${i}"><div class="trk"><span class="n">${esc(t.n)}</span><span class="t">${esc(t.title)}</span><span class="d">${esc(t.len)}</span></div></div>`; }
    if (r.kind === "keys") return `<div class="row" data-r="${i}"><div class="strip keys">${r.items.map((k) => `<div class="key ${k.wide ? "wide" : ""}">${esc(k.label)}</div>`).join("")}</div></div>`;
    const title = r.title ? `<h3>${esc(r.title)}</h3>` : "";
    return `<div class="row ${r.grid ? "grid" : ""}" data-r="${i}">${title}<div class="strip">${r.items.map((it) => cardHtml(it, r.kind)).join("")}</div></div>`;
  }).join("");
  box.querySelectorAll(".progress i").forEach((i) => { i.style.width = `${i.dataset.w}%`; });
  p.rows.forEach((r, ri) => r.items.forEach((it, ci) => {
    if (!it.swatch) return;
    const el = box.children[ri] && box.children[ri].querySelectorAll(".card")[ci];
    if (!el) return;
    el.querySelector(".img").style.background = it.swatch.page;
    el.querySelector(".sw-bar").style.background = it.swatch.title;
    el.querySelector(".sw-acc").style.background = it.swatch.accent;
  }));
  $("tabs").innerHTML = p.tabs ? p.tabs.items.map((t) => `<div class="tab">${esc(t.label)}</div>`).join("") : "";
  p.rendered = true;
}
function drawPage(p) {
  if (!p.rendered) renderRows(p);
  const all = p.allRows();
  const rowEls = [...$("rows").children];
  // tabs
  if (p.tabs) [...$("tabs").children].forEach((el, i) => {
    el.classList.toggle("selected", i === p.tabs.selected);
    el.classList.toggle("focus", !menuOpen && p.row === 0 && i === p.tabs.col);
  });
  // focus marks
  p.rows.forEach((r, ri) => {
    const el = rowEls[ri];
    if (!el) return;
    const items = r.kind === "track" ? el.querySelectorAll(".trk") : r.kind === "buttons" || r.kind === "options" ? el.querySelectorAll(".btn") : r.kind === "keys" ? el.querySelectorAll(".key") : el.querySelectorAll(".card");
    const isFocusRow = !menuOpen && all[p.row] === r;
    items.forEach((c, ci) => c.classList.toggle("focus", isFocusRow && ci === r.col));
    el.classList.toggle("dim", !isFocusRow);
    // keep the focused card in view: the row slides left once you pass the middle
    if (r.kind !== "buttons" && r.kind !== "options" && r.kind !== "track") {
      const step = r.kind === "wide" || r.kind === "landscape" || r.kind === "tiles" ? 368 : r.kind === "keys" ? 76 : 248;
      const contentX = menuOpen ? 400 : 112;
      const visible = Math.floor((1920 - contentX - 120) / step);
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
}
function showPage(p, { push = false } = {}) {
  if (push && page) stack.push(page);
  if (!p.themeFor || p.themeFor !== themeFor) stopTheme();
  page = p;
  page.rendered = false;
  drawPage(page);
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
    if (r.col > 0) { r.col--; if (r === page.tabs) switchTab(); }
    else if (r.kind !== "buttons" || r.col === 0) openMenu();
  } else if (dir === "Right") {
    if (r.col < r.items.length - 1) { r.col++; if (r === page.tabs) switchTab(); }
  } else {
    const next = page.row + (dir === "Down" ? 1 : -1);
    if (next >= 0 && next < all.length && all[next].items.length) page.row = next;
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
  if (stack.length) { const prev = stack.pop(); if (prev.themeFor !== themeFor) stopTheme(); page = prev; prev.rendered = false; drawPage(prev); return; }
  if (!page) return openMenu();
  // On Home / a library: first back to the top row, then the menu.
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
desktop.onNativeFailed((it) => { if (it && it.key) Player.open(it, { resume: !!it.resume }); });
async function setWatched(it, on) {
  await api(on ? "/:/scrobble" : "/:/unscrobble", { key: it.key, identifier: "com.plexapp.plugins.library" }).catch(() => {});
}

// ---- Home ------------------------------------------------------------------------------
function hubRows(hubs) {
  return hubs.filter((h) => h.Metadata && h.Metadata.length).map((h) => ({
    kind: "posters", title: h.title, col: 0,
    items: h.Metadata.map(norm).map((it) => ({ ...it, labelBelow: it.type === "episode" ? `S${it.seasonNo} · E${it.epNo}` : "" })),
  }));
}
function homePage() {
  const p = makePage({});
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

// Rows of 7 posters (a grid you move through like rows).
function gridRows(items, title) {
  const rows = [];
  for (let i = 0; i < items.length; i += 7) rows.push({ kind: "posters", grid: true, title: i === 0 ? title : "", col: 0, items: items.slice(i, i + 7) });
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
const SHOWS = [{ label: tr("All"), q: {} }, { label: tr("Unwatched"), q: { unwatched: 1 } }, { label: tr("In progress"), q: { inProgress: 1 } }];
function libraryPage(sec) {
  const tabs = { kind: "tabs", items: [{ label: tr("Recommended") }, { label: tr("Library") }, { label: tr("Collections") }, { label: tr("Categories") }], col: 0, selected: 0 };
  const p = makePage({ tabs });
  let sort = 0, show = 0;
  const loadRecommended = () => loadInto(p, async () => hubRows(mc(await api(`/hubs/sections/${sec.key}`, { count: 20 })).Hub || []));
  const loadLibrary = () => {
    let start = 0, total = Infinity, loading = false;
    const opts = {
      kind: "options", col: 0,
      items: [
        { label: tr("Sort: {value}", { value: SORTS[sort].label }), action: () => { sort = (sort + 1) % SORTS.length; loadLibrary(); } },
        { label: tr("Show: {value}", { value: SHOWS[show].label }), action: () => { show = (show + 1) % SHOWS.length; loadLibrary(); } },
      ],
    };
    p.rows = [opts]; p.row = 1; p.rendered = false;
    p.loadMore = async () => {
      if (loading || start >= total) return;
      loading = true;
      try {
        const r = mc(await api(`/library/sections/${sec.key}/all`, { "X-Plex-Container-Start": start, "X-Plex-Container-Size": 84, sort: SORTS[sort].v, ...SHOWS[show].q }));
        total = r.totalSize ?? r.size ?? 0;
        const items = (r.Metadata || []).map(norm);
        start += items.length;
        if (!items.length) total = start;
        for (let i = 0; i < items.length; i += 7) p.rows.push({ kind: "posters", grid: true, title: p.rows.length === 1 ? tr("{library} · {n} titles", { library: sec.title, n: total }) : "", col: 0, items: items.slice(i, i + 7) });
        if (page === p) { p.rendered = false; drawPage(p); }
      } finally { loading = false; }
    };
    if (page === p) drawPage(p);
    p.loadMore();
  };
  const loadCollections = () => loadInto(p, async () => {
    const items = (mc(await api(`/library/sections/${sec.key}/collections`)).Metadata || []).map(norm);
    return items.length ? gridRows(items, tr("Collections")) : [{ kind: "posters", title: tr("No collections in this library"), col: 0, items: [] }];
  });
  const loadCategories = () => loadInto(p, async () => {
    const genres = mc(await api(`/library/sections/${sec.key}/genre`)).Directory || [];
    const tiles = genres.map((g) => ({ title: g.title, open: () => showPage(listPage(g.title, `/library/sections/${sec.key}/all`, null, { genre: g.key, sort: "titleSort" }), { push: true }) }));
    const rows = [];
    for (let i = 0; i < tiles.length; i += 4) rows.push({ kind: "tiles", grid: true, title: i === 0 ? tr("Genres") : "", col: 0, items: tiles.slice(i, i + 4) });
    return rows;
  });
  p.onTab = (i) => {
    p.loadMore = null; p.rows = []; p.row = 0;
    [loadRecommended, loadLibrary, loadCollections, loadCategories][i]();
  };
  loadRecommended();
  return p;
}

// Load rows into a page (with a spinner while it loads).
async function loadInto(p, fetchRows) {
  busy(true);
  try {
    const rows = await fetchRows();
    p.rows = rows;
    if (p.row >= p.allRows().length) p.row = p.tabs ? 1 : 0;
    if (p.tabs && p.row === 0) p.row = rows.length ? 1 : 0;
    if (page === p) { p.rendered = false; drawPage(p); }
  } catch (err) {
    showError(tr("Couldn't load this from your Plex server."), tr("Try again"), () => loadInto(p, fetchRows));
    return;
  } finally { busy(false); }
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

// ---- a movie ---------------------------------------------------------------------------
function moviePage(item) {
  const p = makePage({ heroItem: item, pinned: false, pinFrom: 1 });
  let more = null;
  const refresh = async () => {
    const raw = (mc(await api(`/library/metadata/${item.key}`)).Metadata || [])[0] || item.raw;
    const full = norm(raw);
    if (!more) more = await extraRows(raw).catch(() => []);
    p.heroItem = full;
    const buttons = [];
    if (full.offset) {
      buttons.push({ icon: "play", label: tr("Resume"), action: () => playItem(full, true) });
      buttons.push({ icon: "restart", label: tr("Play from start"), action: () => playItem(full, false) });
    } else buttons.push({ icon: "play", label: tr("Play"), action: () => playItem(full, false) });
    const isW = watched(full);
    buttons.push({ icon: "check", label: isW ? tr("Mark as unwatched") : tr("Mark as watched"), on: isW,
      action: async () => { await setWatched(full, !isW); refresh(); } });
    buttons.push({ icon: "playlist", label: tr("Add to playlist"), action: () => showPage(addToPlaylistPage(full), { push: true }) });
    buttons.push({ icon: "tracks", label: tr("Audio & subtitles"), action: () => desktop.openTracks(full.key) });
    const keepRow = p.rows.length ? p.row : 0;
    p.rows = [{ kind: "buttons", col: 0, items: buttons }, ...more];
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
    const b = [];
    if (ep.offset) {
      b.push({ icon: "play", label: tr("Resume"), action: () => playItem(ep, true) });
      b.push({ icon: "restart", label: tr("Play from start"), action: () => playItem(ep, false) });
    } else b.push({ icon: "play", label: tr("Play"), action: () => playItem(ep, false) });
    const isW = watched(ep);
    b.push({ icon: "check", label: isW ? tr("Mark as unwatched") : tr("Mark as watched"), on: isW,
      action: async () => { await setWatched(ep, !isW); await loadSeason(tabs.selected, ep.key); } });
    b.push({ icon: "playlist", label: tr("Add to playlist"), action: () => showPage(addToPlaylistPage(ep), { push: true }) });
    b.push({ icon: "tracks", label: tr("Audio & subtitles"), action: () => desktop.openTracks(ep.key) });
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
    if (r === epRow || r === btnRow) { const ep = focusedEpisode(); return ep ? { ...ep, title: show ? show.title : ep.title, sub: ep.epTitle } : null; }
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
    p.heroItem = show;
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

// ---- profiles: switch Plex Home user (PIN if it has one) --------------------------------
function profilesPage() {
  const p = makePage({});
  p.drawHero = () => { $("heroTitle").textContent = tr("Who's watching?"); $("heroSub").textContent = ""; $("heroMeta").innerHTML = ""; $("heroLine").textContent = ""; $("heroSummary").textContent = ""; $("heroCast").textContent = ""; $("artImg").classList.remove("on"); };
  loadInto(p, async () => {
    const users = await desktop.tvHomeUsers();
    return [{ kind: "people", title: tr("Plex Home"), col: 0, items: (users || []).map((u) => ({
      title: u.title, role: u.protected ? "🔒 PIN" : (u.admin ? tr("Admin") : ""), thumb: u.thumb,
      open: () => (u.protected ? showPage(pinPage(u), { push: true }) : switchTo(u, "")),
    })) }];
  });
  return p;
}
function pinPage(user) {
  const p = makePage({});
  p.pin = "";
  const keys = { kind: "keys", col: 0, items: [
    ..."1234567890".split("").map((d) => ({ label: d, action: () => { if (p.pin.length < 4) { p.pin += d; p.drawHero(); if (p.pin.length === 4) switchTo(user, p.pin); } } })),
    { label: "⌫", wide: true, action: () => { p.pin = p.pin.slice(0, -1); p.drawHero(); } },
  ] };
  p.rows = [keys];
  p.drawHero = () => {
    $("heroTitle").textContent = tr("PIN for {name}", { name: user.title });
    $("heroSub").textContent = "●".repeat(p.pin.length) + "○".repeat(4 - p.pin.length);
    $("heroMeta").innerHTML = ""; $("heroLine").textContent = ""; $("heroSummary").textContent = ""; $("heroCast").textContent = "";
  };
  return p;
}
async function switchTo(user, pin) {
  busy(true);
  const r = await desktop.tvSwitchUser(user.uuid, pin).catch(() => null);
  busy(false);
  if (!r || !r.ok) { showError(pin ? tr("Wrong PIN — try again.") : tr("Couldn't switch user."), tr("OK"), () => { if (page && page.pin != null) { page.pin = ""; page.drawHero(); } }); return; }
  stack.length = 0;
  start(true);
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
function fadeTo(target, then) {
  clearInterval(themeFade);
  themeFade = setInterval(() => {
    const v = themeAudio.volume + (target > themeAudio.volume ? 0.03 : -0.03);
    themeAudio.volume = Math.max(0, Math.min(1, v));
    if (Math.abs(themeAudio.volume - target) < 0.035) { themeAudio.volume = target; clearInterval(themeFade); if (then) then(); }
  }, 60);
}
function playTheme(showKey, path) {
  if (!lastPrefs.themeMusic || !path || Music.isActive() || Player.isActive()) return;
  if (themeFor === showKey && !themeAudio.paused) return;
  themeFor = showKey;
  themeAudio.src = `${S.uri}${path}?X-Plex-Token=${S.token}`;
  themeAudio.volume = 0;
  themeAudio.play().then(() => fadeTo(0.3)).catch(() => {});
}
function stopTheme() {
  if (themeAudio.paused) { themeFor = null; return; }
  themeFor = null;
  fadeTo(0, () => themeAudio.pause());
}

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
    return [{ kind: "options", col: 0, items: opts.slice(0, 1) }, ...chunk(opts.slice(1), 4).map((g) => ({ kind: "options", col: 0, items: g }))];
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
  toastTimer = setTimeout(() => { box.classList.remove("toast"); box.hidden = busyCount === 0; }, 1600);
}

// ---- screensaver: your artwork, slowly, with the time --------------------------------
let nativePlaying = false;   // the native (mpv) player is open on top
let lastInput = Date.now(), saverOn = false, saverTimer = null, saverItems = [], saverI = 0, saverFlip = false;
async function startSaver() {
  if (saverOn) return;
  saverOn = true;
  $("saver").hidden = false;
  if (!saverItems.length) {
    const libs = sections.filter((s) => s.type === "movie" || s.type === "show");
    const picks = await Promise.all(libs.slice(0, 6).map((s) => api(`/library/sections/${s.key}/all`, { sort: "random", "X-Plex-Container-Size": 12 }).catch(() => null)));
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
let busyCount = 0;
function busy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  const box = $("message");
  if (box.classList.contains("error")) return;
  box.hidden = busyCount === 0;
  $("messageText").textContent = busyCount ? tr("Loading…") : "";
  $("messageButton").hidden = true;
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
function clearError() { $("message").classList.remove("error"); $("message").hidden = busyCount === 0; errorAction = null; }

// ---- input: keyboard, controller, mouse ----------------------------------------------
function act(name) {
  lastInput = Date.now();
  if (stopSaver()) return;
  if (overlayOpen) return;
  if (Player.isActive()) { document.body.classList.remove("mouse"); Player.act(name); return; }
  if (Photos.act(name)) return;
  if (Music.act(name)) return;
  if ($("message").classList.contains("error")) {
    if (name === "OK" && errorAction) { const a = errorAction; clearError(); a(); }
    else if (name === "Back") clearError();
    return;
  }
  document.body.classList.remove("mouse");
  if (name === "Up" || name === "Down" || name === "Left" || name === "Right") move(name);
  else if (name === "OK") ok();
  else if (name === "Y" && page && page.onY && !menuOpen) { const r = page.allRows()[page.row]; if (r && r.items[r.col]) page.onY(r.items[r.col]); }
  else if (name === "Back") back();
  else if (name === "Start") desktop.tvSettings();
}
const KEYS = { Delete: "Y", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Enter: "OK", " ": "OK", Escape: "Back", Backspace: "Back", BrowserBack: "Back",
  MediaPlayPause: "OK", MediaTrackNext: "R1", MediaTrackPrevious: "L1", MediaFastForward: "R2", MediaRewind: "L2" };
addEventListener("keydown", (e) => {
  lastInput = Date.now();
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
function padLoop() {
  const pads = desktop.padState();
  const now = performance.now();
  const down = new Set(pads.flatMap((p) => p.pressed));
  for (const n of down) {
    const name = n === "A" ? "OK" : n === "B" || n === "Back" ? "Back" : n;
    if (!held.has(n)) { held.set(n, now + 380); act(name); }
    else if (["Up", "Down", "Left", "Right"].includes(n) && now >= held.get(n)) { held.set(n, now + 110); act(name); }
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
  // Back from the player: progress has changed — reload the page you're on.
  if (page && page.refresh) page.refresh();
  else if (page && page.reload) page.reload();
  else if (page === homePageRef) { const p = homePage(); p.row = page.row; showPage(p); homePageRef = p; }
});
let homePageRef = null;
let lastPrefs = {};
function applyPrefs(s) {
  if (!s || !s.themes) return;
  lastPrefs = s;
  const t = s.themes.find((x) => x.id === s.theme);
  if (t) document.documentElement.style.setProperty("--accent", t.accent);
}

// ---- start ----------------------------------------------------------------------------
async function start(force = false) {
  clearError();
  busy(true);
  $("messageText").textContent = tr("Connecting to your Plex server…");
  try {
    const s = await desktop.tvSession(force);
    if (!s || !s.ok) {
      busy(false);
      const why = s && s.error === "signin" ? tr("Sign in to Plex in PC mode first, then come back to TV mode.")
        : s && s.error === "noserver" ? tr("No Plex server found on your account.")
        : tr("Couldn't reach your Plex server.");
      showError(why, tr("Try again"), () => start(true));
      return;
    }
    S = s;
    Music.init({ S, api, img, prefs: () => lastPrefs, onChange: () => { const id = menuItems[menuIndex] && menuItems[menuIndex].id; buildMenu(); const i = menuItems.findIndex((m) => m.id === id); if (i >= 0) menuIndex = i; drawMenu(); } });
    Player.init({
      S, api, put: (p, q) => desktop.tvApiPut(p, q), prefs: () => lastPrefs,
      // Back from the player: progress changed, so reload the page you're on.
      onClose: () => { if (page && page.refresh) page.refresh(); else if (page === homePageRef) { const hp = homePage(); hp.row = page.row; showPage(hp); homePageRef = hp; } },
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
    showPage(homePageRef);
    drawMenu();
  } catch (err) {
    showError(tr("Couldn't reach your Plex server."), tr("Try again"), () => start(true));
  } finally {
    busy(false);
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
