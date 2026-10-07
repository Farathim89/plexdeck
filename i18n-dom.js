// SPDX-License-Identifier: GPL-3.0-or-later
// Puts a page's text into your language (see i18n.js). Load it before the page's own
// script. Texts and tooltips are looked up as they are; an element with data-i18n is
// translated as a whole (for sentences with <b>bold</b> parts in them).
// It also gives the page's scripts tr("text", { vars }) and N_("text") (marks a text that
// gets translated later, where it's shown).
window.tr = window.ppDesktop && window.ppDesktop.t ? window.ppDesktop.t : (s) => s;
window.N_ = (s) => s;
(() => {
  const desktop = window.ppDesktop;
  if (!desktop || !desktop.t) return;
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  function translate(root) {
    for (const el of root.querySelectorAll("[data-i18n]")) {
      const key = norm(el.innerHTML);
      const out = desktop.t(key);
      if (out !== key) el.innerHTML = out;
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && !n.parentElement.closest("script, style, [data-i18n], [translate=no]") && /[A-Za-z]/.test(n.nodeValue)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const key = norm(n.nodeValue);
      const out = desktop.t(key);
      if (out !== key) n.nodeValue = n.nodeValue.replace(/^(\s*)[\s\S]*?(\s*)$/, (_m, a, b) => a + out + b);
    }
    for (const attr of ["title", "placeholder", "aria-label"]) {
      for (const el of root.querySelectorAll(`[${attr}]`)) {
        const key = norm(el.getAttribute(attr));
        const out = desktop.t(key);
        if (out !== key) el.setAttribute(attr, out);
      }
    }
  }
  document.documentElement.lang = desktop.lang || "en";
  document.title = desktop.t(document.title);
  translate(document.body);
})();
