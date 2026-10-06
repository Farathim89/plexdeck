// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// Audio & subtitle tool — like PASTA (pastatool.com), built in.
// Pick the exact audio / subtitle track from one episode (e.g. "English SRT · CC"
// vs "English ASS · Forced") and set it on a whole season, show or movie.
// Shared by TV mode (tv.js) and the PC-mode window (tracks.js).
// Talks to your server through window.ppDesktop.tvApi (GET) / tvApiPut (PUT).
// ===========================================================================
/* exported Tracks */
const Tracks = (() => {
  const api = (p, q) => window.ppDesktop.tvApi(p, q);
  const put = (p, q) => window.ppDesktop.tvApiPut(p, q);
  const mc = (r) => (r && r.MediaContainer) || {};
  const CH = { 1: "Mono", 2: "Stereo", 6: "5.1", 8: "7.1" };

  // The audio and subtitle tracks of one movie / episode.
  async function streams(ratingKey) {
    const m = (mc(await api(`/library/metadata/${ratingKey}`)).Metadata || [])[0];
    const part = m && m.Media && m.Media[0] && m.Media[0].Part && m.Media[0].Part[0];
    if (!part) return { partId: null, audio: [], subtitle: [] };
    const all = part.Stream || [];
    const pick = (s) => ({
      id: s.id,
      language: s.language || s.languageTag || s.languageCode || "Unknown",
      languageCode: (s.languageCode || "").toLowerCase(),
      codec: (s.codec || "").toUpperCase(),
      channels: s.channels,
      title: s.title || "",
      display: s.extendedDisplayTitle || s.displayTitle || "",
      forced: !!s.forced,
      sdh: !!s.hearingImpaired,
      default: !!s.default,
      selected: !!s.selected,
    });
    return {
      partId: part.id,
      audio: all.filter((s) => s.streamType === 2).map(pick),
      subtitle: all.filter((s) => s.streamType === 3).map(pick),
    };
  }

  function audioLabel(a) {
    if (a.display) return a.display + (a.selected ? "  ✓" : "");
    const extra = [a.codec, CH[a.channels] || (a.channels ? `${a.channels}ch` : "")].filter(Boolean).join(" ");
    return `${a.language}${extra ? ` (${extra})` : ""}${a.title ? ` · ${a.title}` : ""}${a.selected ? "  ✓" : ""}`;
  }
  function subLabel(s) {
    const tags = [s.forced && "Forced", s.sdh && "SDH"].filter(Boolean);
    const base = s.display || `${s.language}${s.codec ? ` (${s.codec})` : ""}${s.title ? ` · ${s.title}` : ""}`;
    return base + (tags.length && !s.display ? ` [${tags.join(" · ")}]` : "") + (s.selected ? "  ✓" : "");
  }

  // How well a track matches the one you picked: the language must match, then
  // forced / SDH / codec / title decide between same-language tracks (like PASTA).
  function score(st, crit, isSub) {
    const sl = (st.language || "").toLowerCase(), sc = st.languageCode;
    const cl = (crit.language || "").toLowerCase(), cc = crit.languageCode;
    const langOk = (cl && (sl === cl || sc === cl)) || (cc && (sc === cc || sl === cc));
    if (!langOk) return -1;
    let n = 10;
    if (isSub) {
      n += st.forced === crit.forced ? 4 : -5;
      n += st.sdh === crit.sdh ? 4 : -5;
    }
    if (crit.codec && st.codec === crit.codec) n += 2;
    const ct = (crit.title || "").toLowerCase(), stt = (st.title || "").toLowerCase();
    if (ct) n += stt === ct ? 5 : (stt.includes(ct) || ct.includes(stt)) && stt ? 2 : 0;
    return n;
  }
  function best(list, crit, isSub) {
    let b = null, bs = 0;
    for (const st of list) { const n = score(st, crit, isSub); if (n > bs) { b = st; bs = n; } }
    return b;
  }

  // Episodes / the movie a choice applies to.
  async function targets(scope) {
    if (scope.type === "movie" || scope.type === "episode") return [scope.key];
    const path = scope.type === "show" ? `/library/metadata/${scope.key}/allLeaves` : `/library/metadata/${scope.key}/children`;
    return (mc(await api(path)).Metadata || []).map((m) => m.ratingKey);
  }
  // One episode to read the track list from.
  async function sample(scope) {
    if (scope.type === "movie" || scope.type === "episode") return scope.key;
    const keys = await targets(scope);
    return keys[0] || null;
  }

  // Apply to every target. audio: track or null; sub: track, "off" or null.
  async function apply(scope, audio, sub, onProgress) {
    const keys = await targets(scope);
    let changed = 0;
    for (let i = 0; i < keys.length; i++) {
      try {
        const s = await streams(keys[i]);
        if (s.partId) {
          let did = false;
          if (audio) {
            const b = best(s.audio, audio, false);
            if (b) { await put(`/library/parts/${s.partId}`, { audioStreamID: b.id, allParts: 1 }); did = true; }
          }
          if (sub === "off") { await put(`/library/parts/${s.partId}`, { subtitleStreamID: 0, allParts: 1 }); did = true; }
          else if (sub) {
            const b = best(s.subtitle, sub, true);
            if (b) { await put(`/library/parts/${s.partId}`, { subtitleStreamID: b.id, allParts: 1 }); did = true; }
          }
          if (did) changed++;
        }
      } catch {}
      if (onProgress) onProgress(i + 1, keys.length);
    }
    return { changed, total: keys.length };
  }

  return { streams, audioLabel, subLabel, targets, sample, apply };
})();
