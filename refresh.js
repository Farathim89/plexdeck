// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// The screen while a video plays, like the TV boxes (Shield, Apple TV):
//  - its refresh rate matched to the video, so motion doesn't judder (a 24 fps
//    film at 24/48/120 Hz, PAL at 50 Hz…);
//  - its full resolution (a 4K TV the PC runs at 1080p plays at 4K);
//  - Windows HDR on for HDR videos.
// Only the screen PlexDeck is on, only while something plays, then it's put back.
// Uses Windows' own display settings through PowerShell (no extra files).
// ===========================================================================
const { spawn } = require("child_process");

const CS = `
Add-Type @"
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public class PPDisp {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency,
      dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct MONITORINFOEX {
    public int cbSize, l, t, r, b, wl, wt, wr, wb; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string szDevice; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string d, int m, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string d, ref DEVMODE dm, IntPtr h, int f, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX mi);
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint f, out uint np, out uint nm);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint f, ref uint np, IntPtr paths, ref uint nm, IntPtr modes, IntPtr topo);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr p);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(IntPtr p);

  // "DISPLAY1" → "\\.\DISPLAY1" (built here: backslashes don't survive PowerShell's command line)
  static string Dev(string d) { string b = ((char)92).ToString(); return d.StartsWith(b) ? d : b + b + "." + b + d; }
  static DEVMODE Dm() { var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm); return dm; }
  public static DEVMODE Cur() { var dm = Dm(); EnumDisplaySettings(null, -1, ref dm); return dm; }
  // The screen a window is on ("\\\\.\\DISPLAY1").
  public static string Screen(long hwnd) {
    var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(mi);
    return GetMonitorInfo(MonitorFromWindow(new IntPtr(hwnd), 2), ref mi) ? mi.szDevice : "";
  }
  // Its mode now, every mode it offers, and Windows HDR (1 on, 0 off, -1 not possible).
  public static string State(string dev) {
    dev = Dev(dev); var c = Dm(); EnumDisplaySettings(dev, -1, ref c);
    var seen = new HashSet<string>(); var sb = new StringBuilder(); var dm = Dm(); int i = 0;
    while (EnumDisplaySettings(dev, i++, ref dm)) {
      if (dm.dmBitsPerPel != 32 || (dm.dmDisplayFlags & 2) != 0) continue;   // not interlaced
      string k = dm.dmPelsWidth + "," + dm.dmPelsHeight + "," + dm.dmDisplayFrequency;
      if (seen.Add(k)) sb.Append((sb.Length > 0 ? "," : "") + "[" + k + "]");
    }
    return "{\\"dev\\":\\"" + dev.Replace("\\\\", "\\\\\\\\") + "\\",\\"w\\":" + c.dmPelsWidth + ",\\"h\\":" + c.dmPelsHeight + ",\\"hz\\":" + c.dmDisplayFrequency
      + ",\\"hdr\\":" + Hdr(dev, -1) + ",\\"modes\\":[" + sb + "]}";
  }
  // Only for now: not saved, so a restart of Windows puts the screen back by itself.
  public static int SetMode(string dev, int w, int h, int hz) {
    dev = Dev(dev); var dm = Dm(); EnumDisplaySettings(dev, -1, ref dm);
    dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmDisplayFrequency = hz; dm.dmFields = 0x80000 | 0x100000 | 0x400000;
    return ChangeDisplaySettingsEx(dev, ref dm, IntPtr.Zero, 0, IntPtr.Zero);
  }
  static IntPtr Packet(int type, int size, int lo, int hi, int id) {
    IntPtr b = Marshal.AllocHGlobal(size);
    for (int i = 0; i < size; i++) Marshal.WriteByte(b, i, 0);
    Marshal.WriteInt32(b, 0, type); Marshal.WriteInt32(b, 4, size); Marshal.WriteInt32(b, 8, lo); Marshal.WriteInt32(b, 12, hi); Marshal.WriteInt32(b, 16, id);
    return b;
  }
  // Windows HDR for a screen: set -1 only reads it; 0 / 1 switch it off / on.
  // Returns 1 on, 0 off, -1 when the screen can't do HDR (or it didn't work).
  public static int Hdr(string dev, int set) {
    dev = Dev(dev); uint np, nm;
    if (GetDisplayConfigBufferSizes(2, out np, out nm) != 0) return -1;   // QDC_ONLY_ACTIVE_PATHS
    IntPtr paths = Marshal.AllocHGlobal((int)np * 72), modes = Marshal.AllocHGlobal((int)nm * 64);
    try {
      if (QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return -1;
      for (int i = 0; i < np; i++) {
        IntPtr p = paths + i * 72;
        // which screen this path is (DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME)
        IntPtr q = Packet(1, 84, Marshal.ReadInt32(p, 0), Marshal.ReadInt32(p, 4), Marshal.ReadInt32(p, 8));
        string name = DisplayConfigGetDeviceInfo(q) == 0 ? Marshal.PtrToStringUni(q + 20) : "";
        Marshal.FreeHGlobal(q);
        if (name != dev) continue;
        int lo = Marshal.ReadInt32(p, 20), hi = Marshal.ReadInt32(p, 24), id = Marshal.ReadInt32(p, 28);
        int supported, on, setType;
        // Windows 11 24H2+: HDR on its own (GET_ADVANCED_COLOR_INFO_2 / SET_HDR_STATE) …
        IntPtr g = Packet(15, 36, lo, hi, id);
        if (DisplayConfigGetDeviceInfo(g) == 0) {
          uint v = (uint)Marshal.ReadInt32(g, 20);
          supported = (int)((v >> 4) & 1); on = Marshal.ReadInt32(g, 32) == 2 ? 1 : 0; setType = 16;
        } else {
          // … older Windows: "advanced colour" is HDR (GET_ADVANCED_COLOR_INFO / SET_ADVANCED_COLOR_STATE)
          Marshal.FreeHGlobal(g); g = Packet(9, 32, lo, hi, id);
          if (DisplayConfigGetDeviceInfo(g) != 0) { Marshal.FreeHGlobal(g); return -1; }
          uint v = (uint)Marshal.ReadInt32(g, 20);
          supported = (int)(v & 1); on = (int)((v >> 1) & 1); setType = 10;
        }
        Marshal.FreeHGlobal(g);
        if (supported == 0) return -1;
        if (set < 0 || set == on) return on;
        IntPtr s = Packet(setType, 24, lo, hi, id);
        Marshal.WriteInt32(s, 20, set);
        int r = DisplayConfigSetDeviceInfo(s);
        Marshal.FreeHGlobal(s);
        return r == 0 ? set : -1;
      }
      return -1;
    } finally { Marshal.FreeHGlobal(paths); Marshal.FreeHGlobal(modes); }
  }
  // The main screen's rates at its current resolution (Match refresh rate without a known screen).
  public static string Modes() {
    var c = Cur(); var set = new SortedSet<int>(); int i = 0;
    var dm = Dm();
    while (EnumDisplaySettings(null, i++, ref dm)) { if (dm.dmPelsWidth == c.dmPelsWidth && dm.dmPelsHeight == c.dmPelsHeight) set.Add(dm.dmDisplayFrequency); }
    return "{\\"current\\":" + c.dmDisplayFrequency + ",\\"rates\\":[" + string.Join(",", set) + "]}";
  }
}
"@
`;
function ps(body) {
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", CS + body], { windowsHide: true });
    let out = "";
    // a display call that hangs mustn't hold up the video (or the screen being put back)
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve(out.trim()); }, 15000);
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => { clearTimeout(t); resolve(out.trim()); });
    p.on("error", () => { clearTimeout(t); resolve(""); });
  });
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;   // a PowerShell string
const qd = (dev) => q(String(dev).replace(/^[\\.]+/, ""));   // a screen as "DISPLAY1" (see Dev() above)

let modes = null;        // { current, rates: [..] } for the main screen
let original = null;     // { dev, w, h, hz } before we switched (dev null = the main screen)
let hdrDev = null;       // the screen we switched Windows HDR on for
let switchedTo = null;   // { w, h, hz } we switched it to

// The refresh rates the main screen offers at its current resolution.
async function listModes() {
  const out = await ps("[PPDisp]::Modes()");
  try { modes = JSON.parse(out); } catch { modes = null; }
  return modes;
}
// Windows reports 23.976 Hz as "23", 59.94 as "59" and so on.
const actual = (r) => ([23, 29, 47, 59, 119].includes(r) ? (r + 1) / 1.001 : r);

// The best rate for a video's frame rate: a whole multiple of it — the video's own rate, like a
// TV box (23.976 Hz for a film: the TV then knows it's a film and its motion smoothing / de-judder
// works), or ("near") the one closest to the current rate. A screen without the video's own
// rate gets its smallest multiple (48 / 72 Hz…).
function pick(fps, m, prefer = "own") {
  if (!m || !fps) return null;
  const err = (r) => { const k = actual(r) / fps; return Math.abs(k - Math.round(k)) / Math.round(k); };
  const fits = m.rates.filter((r) => actual(r) / fps >= 0.99 && err(r) < 0.0008);
  if (!fits.length) return null;
  // The exact fit first (59.94 over 60 for 29.97 fps), then the one closest to the current rate.
  // (errors this close are the same fit: Plex's 23.976 is rounded, so 23.976 and 119.88 Hz differ a hair)
  const pref = prefer === "near" ? (r) => Math.abs(r - m.current) : (r) => r;
  fits.sort((a, b) => (Math.abs(err(a) - err(b)) > 0.0001 ? err(a) - err(b) : 0) || (pref(a) - pref(b)));
  return fits[0];
}
async function setRate(hz) {
  const out = await ps(`$dm = [PPDisp]::Cur(); $dm.dmDisplayFrequency = ${Math.round(hz)}; $dm.dmFields = 0x400000; [PPDisp]::ChangeDisplaySettingsEx($null, [ref]$dm, [IntPtr]::Zero, 0, [IntPtr]::Zero)`);
  return out === "0";   // DISP_CHANGE_SUCCESSFUL
}

// Match refresh rate on the main screen, once the video has told its frame rate.
async function match(fps) {
  if (original && original.dev) return { switched: false };   // prepare() has the screen already
  const m = await listModes();
  const r = pick(fps, m);
  if (!r || r === m.current) return { switched: false, rate: m && m.current };
  if (original == null) original = { dev: null, hz: m.current };
  const ok = await setRate(r);
  return { switched: ok, rate: ok ? r : m.current };
}

// ---- before a video starts ------------------------------------------------------------
// The screen a window is on, and how it is now (look() runs while the player opens).
async function look(hwnd) {
  const out = await ps(`$d = [PPDisp]::Screen(${Number(hwnd)}); if ($d) { [PPDisp]::State($d) }`);
  try { return JSON.parse(out); } catch { return null; }
}
// How a screen is now ("\\.\DISPLAY1").
async function stateOf(dev) {
  try { return JSON.parse(await ps(`[PPDisp]::State(${qd(dev)})`)); } catch { return null; }
}
// What to switch for this video: { w, h, hz, hdr } (null = leave the screen as it is).
//   native: the screen's full resolution · matchRate: a rate that fits the frame rate
//   hdrVideo + autoHdr: Windows HDR on
function plan(s, { fps, hdrVideo, native, matchRate, autoHdr }) {
  if (!s || !s.modes || !s.modes.length) return null;
  let w = s.w, h = s.h;
  if (native) {
    // the biggest of the same shape (a TV's 4096×2160 cinema mode isn't its 3840×2160)
    const same = s.modes.filter((m) => Math.abs(m[0] / m[1] - s.w / s.h) < 0.01);
    const best = same.reduce((a, m) => (m[0] * m[1] > a[0] * a[1] ? m : a), [s.w, s.h]);
    if (best[0] * best[1] > s.w * s.h) [w, h] = best;
  }
  const rates = [...new Set(s.modes.filter((m) => m[0] === w && m[1] === h).map((m) => m[2]))];
  let hz = s.hz;
  if (w !== s.w || h !== s.h) {
    // a new resolution needs a rate anyway: one that fits the video (its own with Refresh Rate
    // Switching, else the one nearest to now), else as close to now as it gets
    hz = pick(fps, { current: s.hz, rates }, matchRate ? "own" : "near") || rates.sort((a, b) => Math.abs(a - s.hz) - Math.abs(b - s.hz))[0] || s.hz;
  } else if (matchRate) hz = pick(fps, { current: s.hz, rates }) || s.hz;
  const hdr = autoHdr && hdrVideo && s.hdr === 0;
  if (w === s.w && h === s.h && hz === s.hz && !hdr) return null;
  return { w, h, hz, hdr };
}
// Switch the screen for this video. Returns what it did ({ mode, hdr }) or null.
// The next episode calls it again: an SDR one after an HDR one turns HDR back off.
async function prepare(s, opts) {
  if (!s) return null;
  const p = plan(s, opts) || { w: s.w, h: s.h, hz: s.hz, hdr: false };
  const hdrOn = !!p.hdr, hdrOff = !opts.hdrVideo && hdrDev === s.dev && s.hdr === 1;
  // Switching HDR makes Windows put the screen's saved mode back (it undid a refresh rate set
  // just before): so HDR goes first, and the mode is set after it unless it's that saved one.
  const base = hdrOn || hdrOff ? original || s : s;
  const setMode = p.w !== base.w || p.h !== base.h || p.hz !== base.hz;
  if (!hdrOn && !hdrOff && !setMode) return null;
  if (setMode && !original) original = { dev: s.dev, w: s.w, h: s.h, hz: s.hz };
  const cmds = [];
  if (hdrOn) cmds.push(`"hdr=" + [PPDisp]::Hdr(${qd(s.dev)}, 1)`);
  if (hdrOff) cmds.push(`"hdroff=" + [PPDisp]::Hdr(${qd(s.dev)}, 0)`);
  if (setMode) cmds.push(`"mode=" + [PPDisp]::SetMode(${qd(s.dev)}, ${p.w}, ${p.h}, ${p.hz})`);
  const out = await ps(cmds.join("; "));
  const modeOk = setMode && /mode=0/.test(out), hdrOk = hdrOn && /hdr=1/.test(out), offOk = hdrOff && /hdroff=0/.test(out);
  // what the screen is now, so the next episode compares with it
  const now = modeOk ? { w: p.w, h: p.h, hz: p.hz } : { w: base.w, h: base.h, hz: base.hz };
  Object.assign(s, now);
  if (hdrOk) { s.hdr = 1; hdrDev = s.dev; }
  if (offOk) { s.hdr = 0; hdrDev = null; }
  switchedTo = now;
  if (original && now.w === original.w && now.h === original.h && now.hz === original.hz) { original = null; switchedTo = null; }   // back at its own mode
  return modeOk || hdrOk || offOk ? { mode: modeOk ? now : null, hdr: hdrOk } : null;
}
// What has to be put back (kept in a file while switched, so a crash can be undone next start).
const pending = () => (original || hdrDev ? { original, hdrDev, now: switchedTo } : null);

// Back to how it was. Returns what couldn't be put back (the screen off or gone — kept, so the
// next start tries again), or null.
async function restore(info = pending()) {
  if (!info) return null;
  const o = info.original, hd = info.hdrDev;
  original = null; hdrDev = null; switchedTo = null;
  const cmds = [];
  if (hd) cmds.push(`"hdr=" + [PPDisp]::Hdr(${qd(hd)}, 0)`);
  if (o && o.dev) cmds.push(`"mode=" + [PPDisp]::SetMode(${qd(o.dev)}, ${o.w}, ${o.h}, ${o.hz})`);
  const out = cmds.length ? await ps(cmds.join("; ")) : "";
  if (o && !o.dev) await setRate(o.hz);
  const left = { original: o && o.dev && !/mode=0/.test(out) ? o : null, hdrDev: hd && !/hdr=0/.test(out) ? hd : null, now: info.now };
  return left.original || left.hdrDev ? left : null;
}

// At the next start after PlexDeck closed while switched: only what's still ours (a mode you've
// changed since, or HDR you've switched off yourself, is left as it is).
async function restoreAfterCrash(info) {
  const o = info && info.original && info.original.dev ? info.original : null, hd = info && info.hdrDev;
  const dev = (o && o.dev) || hd;
  if (!dev) return;
  const s = await stateOf(dev);
  if (!s || !s.w) return info;   // the screen isn't there now (the TV off): later
  const n = info.now;
  return restore({ original: o && n && s.w === n.w && s.h === n.h && s.hz === n.hz ? o : null, hdrDev: hd && s.hdr === 1 ? hd : null, now: n });
}

module.exports = { listModes, pick, match, look, stateOf, plan, prepare, pending, restore, restoreAfterCrash };
