// SPDX-License-Identifier: GPL-3.0-or-later
// TV mode's key bindings, shared by TV mode (tv.js: Settings → Key Bindings) and the settings
// window (settings.js: Remote & controller). Every action TV mode has (a controller button each,
// plus the quit menu) with its default keys; the keys you change are the setting tvKeys:
// { action: [keys] } (only what differs from the defaults). Letters are kept in lower case.
// Load it after i18n-dom.js (N_, tr).
const TvKeys = (() => {
  const ACTIONS = [
    { id: "Up", label: N_("Up"), pad: N_("D-pad up"), keys: ["ArrowUp"] },
    { id: "Down", label: N_("Down"), pad: N_("D-pad down"), keys: ["ArrowDown"] },
    { id: "Left", label: N_("Left"), pad: N_("D-pad left"), keys: ["ArrowLeft"] },
    { id: "Right", label: N_("Right"), pad: N_("D-pad right"), keys: ["ArrowRight"] },
    { id: "OK", label: N_("Select"), pad: "Cross / A", keys: ["Enter", " ", "MediaPlayPause"] },
    { id: "Back", label: N_("Back"), pad: "Circle / B", keys: ["Backspace", "BrowserBack"] },
    { id: "Quit", label: N_("The quit menu"), pad: N_("Back on Home in the sidebar"), keys: ["Escape"] },
    { id: "Y", label: N_("A title's menu"), pad: "Triangle / Y", keys: ["c", "Delete", "ContextMenu"] },
    { id: "Start", label: N_("Settings"), pad: "Options / Start", keys: ["m"] },
    { id: "L1", label: N_("Player: previous episode"), pad: "L1 / LB", keys: ["PageUp", "MediaTrackPrevious"] },
    { id: "R1", label: N_("Player: next episode"), pad: "R1 / RB", keys: ["PageDown", "MediaTrackNext"] },
    { id: "L2", label: N_("Player: skip back"), pad: "L2 / LT", keys: [",", "MediaRewind"] },
    { id: "R2", label: N_("Player: skip forward"), pad: "R2 / RT", keys: [".", "MediaFastForward"] },
    { id: "VolUp", label: N_("Player: volume up"), pad: N_("Right stick up"), keys: ["+", "="] },
    { id: "VolDown", label: N_("Player: volume down"), pad: N_("Right stick down"), keys: ["-"] },
  ];
  // PlexDeck's own keys (reload, PC | TV, full screen): they can't do anything else
  const RESERVED = ["F5", "F10", "F11"];
  // keys that aren't keys on their own (wait for the real one)
  const IGNORE = ["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "Dead", "Unidentified", "Process"];
  const name = (k) => (k.length === 1 ? k.toLowerCase() : k);
  const defaultsOf = (id) => ACTIONS.find((a) => a.id === id).keys;
  function keysFor(saved, id) {
    const mine = saved && saved[id];
    return Array.isArray(mine) ? mine.filter((k) => typeof k === "string" && k) : defaultsOf(id);
  }
  // key → action (the first action that has a key wins)
  function map(saved) {
    const m = new Map();
    for (const a of ACTIONS) for (const k of keysFor(saved, a.id)) if (!m.has(k)) m.set(k, a.id);
    return m;
  }
  // A key as it's written on the keyboard (a few in words, in your language)
  const WORDS = { " ": N_("Space"), ContextMenu: N_("Menu key"), BrowserBack: N_("Browser Back"), MediaPlayPause: N_("Play/Pause"),
    MediaTrackNext: N_("Next track"), MediaTrackPrevious: N_("Previous track"), MediaFastForward: N_("Fast-forward"), MediaRewind: N_("Rewind") };
  const SIGNS = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", PageUp: "Page Up", PageDown: "Page Down" };
  const label = (k) => (WORDS[k] ? tr(WORDS[k]) : SIGNS[k] || (k.length === 1 ? k.toUpperCase() : k));
  // The saved bindings with one action's keys set (back to its defaults: forgotten)
  function withKeys(saved, id, keys) {
    const all = { ...(saved || {}) };
    const d = defaultsOf(id);
    if (keys.length === d.length && keys.every((k, i) => k === d[i])) delete all[id]; else all[id] = keys;
    return all;
  }
  // Binding key k to an action. A key does one thing: it leaves the action that had it.
  // → { saved, was: the action it came from (or undefined) }
  function bind(saved, id, k) {
    const was = ACTIONS.find((a) => a.id !== id && keysFor(saved, a.id).includes(k));
    let s = saved;
    if (was) s = withKeys(s, was.id, keysFor(s, was.id).filter((x) => x !== k));
    if (!keysFor(s, id).includes(k)) s = withKeys(s, id, [...keysFor(s, id), k]);
    return { saved: s, was };
  }
  const unbind = (saved, id, k) => withKeys(saved, id, keysFor(saved, id).filter((x) => x !== k));
  // An action's default keys back (taken from any action you gave them to)
  function defaults(saved, id) {
    const d = defaultsOf(id);
    let s = saved;
    for (const o of ACTIONS) if (o.id !== id && keysFor(s, o.id).some((k) => d.includes(k))) s = withKeys(s, o.id, keysFor(s, o.id).filter((k) => !d.includes(k)));
    return withKeys(s, id, [...d]);
  }
  return { ACTIONS, RESERVED, IGNORE, name, keysFor, map, label, bind, unbind, defaults };
})();
