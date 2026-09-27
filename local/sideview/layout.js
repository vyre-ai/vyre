// @ts-check
// layout: where the side view puts each window. Pure, so every rule here is tested without a Mac.
//
// All frames are in accessibility coordinates (points, origin top left of the main display, y
// down), the space vyre-tile reports and takes.

/** Apps a session runs in: terminals, and the editors people run Claude Code inside. */
export const SESSION_APPS = [
  "com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty", "dev.warp.Warp-Stable",
  "dev.warp.Warp", "com.github.wez.wezterm", "org.alacritty", "io.alacritty", "net.kovidgoyal.kitty",
  "com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "com.todesktop.230313mzl4w4u92",
];

export const CHROME = "com.google.Chrome";

export const DEFAULT_RATIO = 0.29;

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {{ pid: number, bundle: string, app: string, index: number, title: string, frame: Rect, minimized: boolean, standard: boolean, z: number }} Win */
/** @typedef {{ frame: Rect, visible: Rect }} Screen */

/** The ratio asked for, clamped to 0.2-0.5, or the default. @param {unknown} r */
export function ratioOf(r) {
  const n = Number(r);
  if (r === undefined || r === null || r === "" || !Number.isFinite(n)) return DEFAULT_RATIO;
  return Math.min(0.5, Math.max(0.2, n));
}

/** Windows a person could mean: standard, not minimized, front to back. @param {Win[]} ws */
export function usable(ws) {
  return ws.filter(w => w.standard && !w.minimized && w.frame.w > 0 && w.frame.h > 0).sort((a, b) => a.z - b.z || a.index - b.index);
}

/**
 * The session window. "front": the front app's top window when the front app is one a session
 * runs in, otherwise the top terminal. "terminal": the top window of any session app. A bundle
 * or a pid: that app's top window.
 * @param {Win[]} ws @param {{ pid?: number, bundle?: string } | null} front
 * @param {"front"|"terminal"|{ bundle?: string, pid?: number }} session
 * @returns {Win|null}
 */
export function pickSession(ws, front, session = "front") {
  const all = usable(ws);
  if (session && typeof session === "object") {
    return all.find(w => (session.pid !== undefined && w.pid === session.pid) || (session.bundle && w.bundle === session.bundle)) || null;
  }
  const terms = all.filter(w => SESSION_APPS.includes(w.bundle));
  if (session === "front" && front && SESSION_APPS.includes(front.bundle || "")) {
    const mine = terms.find(w => w.pid === front.pid);
    if (mine) return mine;
  }
  return terms[0] || null;
}

/** The browser window: Chrome's top window. @param {Win[]} ws */
export function pickBrowser(ws) {
  return usable(ws).find(w => w.bundle === CHROME) || null;
}

/** The screen holding most of a window: the one its centre falls on, else the first. @param {Screen[]} screens @param {Rect} f */
export function screenOf(screens, f) {
  const cx = f.x + f.w / 2, cy = f.y + f.h / 2;
  return screens.find(s => cx >= s.frame.x && cx < s.frame.x + s.frame.w && cy >= s.frame.y && cy < s.frame.y + s.frame.h) || screens[0] || null;
}

/** The left frame: `ratio` of the area's width, its full height. @param {Rect} area @param {number} ratio @returns {Rect} */
export function leftFrame(area, ratio) {
  return { x: area.x, y: area.y, w: Math.round(area.w * ratio), h: area.h };
}

/**
 * The right frame: from where the left window actually ends to the area's right edge, so a
 * session app that refuses to get as narrow as asked pushes the browser over instead of
 * sitting under it.
 * @param {Rect} area @param {Rect} leftActual @returns {Rect}
 */
export function rightFrame(area, leftActual) {
  const edge = Math.min(Math.max(leftActual.x + leftActual.w, area.x), area.x + area.w - 200);
  return { x: edge, y: area.y, w: area.x + area.w - edge, h: area.h };
}
