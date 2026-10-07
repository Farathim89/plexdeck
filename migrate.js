// SPDX-License-Identifier: GPL-3.0-or-later
// One-time import of the settings from the older PlexPlayer (the Python/VLC
// version, ~/.plexplayer/config.json), so your extras carry straight over.
// Settings Plex Web has natively (quality, subtitles, audio language, auto-play
// next, library order, Home rows) live in Plex's own settings instead.

const fs = require("fs");
const os = require("os");
const path = require("path");

const OLD_CONFIG = path.join(os.homedir(), ".plexplayer", "config.json");

const DEFAULTS = {
  // "app" = app.plex.tv (everything Plex has); "server" = your server's own /web
  source: "app",
  serverUrl: "",
  autoSkipIntro: false,
  skipIntroDelay: 5,
  autoSkipCredits: false,
  skipCreditsDelay: 5,
  textSize: 1,
  fontFamily: "",            // "" = Plex's own font
  plexColours: true,         // ignore a Windows contrast theme (keeps sliders visible)
  keyboardNav: true,         // arrow keys move an orange focus ring between items
  controller: true,          // PS4/PS5/Xbox pads drive the same navigation
  startMaximized: true,
  theme: "plex",             // see THEMES in main.js
  closeToTray: true,         // ✕ hides to the tray, so music keeps playing
  startWithWindows: false,   // starts hidden in the tray when you sign in to Windows
  startMode: "last",         // "last" | "pc" | "tv"
  autoMode: true,            // controller → TV mode, mouse → PC mode by itself
  pcPlayerEngine: "mpv",     // PC mode: "mpv" hands your server's videos to the native player, "plex" keeps Plex's player
  playerEngine: "mpv",       // TV mode: "mpv" (native, plays everything) or "builtin"
  // Native player: picture & sound
  hdr: true,                 // send HDR to HDR screens (Windows HDR on)
  passthrough: "off",        // "off" | "dolby-dts" | "all" — surround straight to your receiver
  matchRefresh: false,       // switch the screen's refresh rate to the video's
  defaultVolume: 100,
  hwDecode: "auto",          // "auto" | "off" | "d3d11"
  // Subtitles (text subtitles like SRT; styled ASS subtitles keep their own look)
  subSize: "Normal",         // Small | Normal | Large | Huge
  subColor: "White",         // White | Yellow | Cyan | Green | Gray
  subPosition: "Bottom",     // Bottom | Raised
  subBackground: false,      // dark box behind the text
  // Languages (native player)
  preferredAudioLang: "Any",
  autoSubtitles: false,
  preferredSubtitleLang: "English",
  preferNonSdh: false,
  // TV mode extras
  themeMusic: true,          // a show's theme tune plays quietly on its page
  screensaver: 5,            // minutes idle before the artwork screensaver (0 = off)
  musicVisualiser: true,     // soft bars that move with the music on Now Playing (TV mode)
  language: "",              // PlexDeck's own menus: "" = like Windows, else "en", "sv", … (locales/)
};

function fromOldConfig() {
  let old;
  try { old = JSON.parse(fs.readFileSync(OLD_CONFIG, "utf8")); } catch { return {}; }
  const out = {};
  const bool = (k, to) => { if (typeof old[k] === "boolean") out[to] = old[k]; };
  const num = (k, to) => { if (Number.isFinite(Number(old[k]))) out[to] = Number(old[k]); };

  // The very first version had one switch for both.
  if (typeof old.auto_skip === "boolean") out.autoSkipIntro = out.autoSkipCredits = old.auto_skip;
  bool("auto_skip_intro", "autoSkipIntro");
  bool("auto_skip_credits", "autoSkipCredits");
  num("skip_intro_delay", "skipIntroDelay");
  num("skip_credits_delay", "skipCreditsDelay");
  bool("keyboard_nav", "keyboardNav");
  bool("controller_support", "controller");
  bool("start_maximized", "startMaximized");
  if (typeof old.high_contrast === "boolean") out.plexColours = !old.high_contrast;

  // UI scale "125%" → text size 1.25
  const scale = parseFloat(String(old.ui_scale || "").replace("%", ""));
  if (scale >= 50 && scale <= 300) out.textSize = scale / 100;

  // Segoe UI was the old app's default, so only carry over a font you picked.
  if (old.font_family && old.font_family !== "Segoe UI") out.fontFamily = String(old.font_family);

  if (old.base_url) out.serverUrl = String(old.base_url).replace(/\/+$/, "");
  const str = (k, to, allowed) => { if (typeof old[k] === "string" && (!allowed || allowed.includes(old[k]))) out[to] = old[k]; };
  str("sub_size", "subSize", ["Small", "Normal", "Large", "Huge"]);
  str("sub_color", "subColor", ["White", "Yellow", "Cyan", "Green", "Gray"]);
  str("hw_decode", "hwDecode", ["auto", "off", "d3d11"]);
  str("preferred_audio_lang", "preferredAudioLang");
  str("preferred_subtitle_lang", "preferredSubtitleLang");
  bool("auto_subtitles", "autoSubtitles");
  bool("prefer_non_sdh", "preferNonSdh");
  num("default_volume", "defaultVolume");
  return out;
}

module.exports = { DEFAULTS, OLD_CONFIG, fromOldConfig };
