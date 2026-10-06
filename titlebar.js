// SPDX-License-Identifier: GPL-3.0-or-later
// Custom title bar: page title, focus dimming, back/forward, menus and the settings gear.
const desktop = window.ppDesktop;
const titleEl = document.getElementById("title");

const setTitle = (t) => { titleEl.textContent = t || "PlexDeck"; };
desktop.getTitle().then(setTitle);
desktop.onTitle(setTitle);
desktop.onFocus((focused) => document.body.classList.toggle("blurred", !focused));

document.getElementById("back").addEventListener("click", () => desktop.nav(-1));
document.getElementById("forward").addEventListener("click", () => desktop.nav(1));
document.getElementById("settings").addEventListener("click", () => desktop.toggleSettings());

// Each menu button opens its menu just below itself.
document.querySelectorAll(".menus button").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const r = btn.getBoundingClientRect();
    btn.classList.add("open");
    try {
      await desktop.showMenu(Number(btn.dataset.menu), r.left, r.bottom);
    } finally {
      btn.classList.remove("open");
    }
  });
});

// PC | TV switch.
const modeButtons = document.querySelectorAll(".mode");
function showMode(m) { modeButtons.forEach((b) => b.classList.toggle("on", b.dataset.mode === m)); }
modeButtons.forEach((b) => b.addEventListener("click", () => desktop.setMode(b.dataset.mode)));
desktop.onMode(showMode);
showMode("pc");

// "Update x.y.z" pill: shown when GitHub has a newer PlexDeck.
const updateBtn = document.getElementById("update");
desktop.onUpdate((u) => {
  updateBtn.classList.toggle("hidden", !u);
  if (u) { updateBtn.textContent = u.label; updateBtn.title = u.tip || ""; }
});
updateBtn.addEventListener("click", () => desktop.openUpdate());
