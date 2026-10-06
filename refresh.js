// SPDX-License-Identifier: GPL-3.0-or-later
// ===========================================================================
// Match the screen's refresh rate to the video (like the TV apps): a 24 fps
// film plays at 24/48/120 Hz, PAL at 50 Hz, and so on, so motion doesn't
// judder. Switches the main screen only while something plays, then puts it
// back. Uses Windows' own display settings through PowerShell (no extra files).
// ===========================================================================
const { spawn } = require("child_process");

const CS = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class PPDisp {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields;
    public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
    public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency,
      dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool EnumDisplaySettings(string d, int m, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string d, ref DEVMODE dm, IntPtr h, int f, IntPtr l);
  public static DEVMODE Cur() { var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm); EnumDisplaySettings(null, -1, ref dm); return dm; }
  public static string Modes() {
    var c = Cur(); var set = new System.Collections.Generic.SortedSet<int>(); int i = 0;
    var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(dm);
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
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
}

let modes = null;        // { current, rates: [..] } for the main screen
let original = null;     // the rate before we switched

// The refresh rates the main screen offers at its current resolution.
async function listModes() {
  const out = await ps("[PPDisp]::Modes()");
  try { modes = JSON.parse(out); } catch { modes = null; }
  return modes;
}
// Windows reports 23.976 Hz as "23", 59.94 as "59" and so on.
const actual = (r) => ([23, 29, 47, 59, 119].includes(r) ? (r + 1) / 1.001 : r);

// The best rate for a video's frame rate: a whole multiple of it, closest to the current rate.
function pick(fps, m) {
  if (!m || !fps) return null;
  const err = (r) => { const k = actual(r) / fps; return Math.abs(k - Math.round(k)) / Math.round(k); };
  const fits = m.rates.filter((r) => actual(r) / fps >= 0.99 && err(r) < 0.0008);
  if (!fits.length) return null;
  // The exact fit first (59.94 over 60 for 29.97 fps), then the one closest to the current rate.
  fits.sort((a, b) => (err(a) - err(b)) || (Math.abs(a - m.current) - Math.abs(b - m.current)));
  return fits[0];
}
async function setRate(hz) {
  const out = await ps(`$dm = [PPDisp]::Cur(); $dm.dmDisplayFrequency = ${Math.round(hz)}; $dm.dmFields = 0x400000; [PPDisp]::ChangeDisplaySettingsEx($null, [ref]$dm, [IntPtr]::Zero, 0, [IntPtr]::Zero)`);
  return out === "0";   // DISP_CHANGE_SUCCESSFUL
}

// Switch for this video (no-op when nothing fits or it already matches).
async function match(fps) {
  const m = await listModes();
  const r = pick(fps, m);
  if (!r || r === m.current) return { switched: false, rate: m && m.current };
  if (original == null) original = m.current;
  const ok = await setRate(r);
  return { switched: ok, rate: ok ? r : m.current };
}
// Back to how it was.
async function restore() {
  if (original == null) return;
  const r = original;
  original = null;
  await setRate(r);
}

module.exports = { listModes, pick, match, restore };
