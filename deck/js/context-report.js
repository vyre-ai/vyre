// @ts-check
// Where the person is, told to cohesion's context (ADR 0036 part 2): context.report
// {surface: "deck" | "phone", project, thread} when the Deck lands on a page and when it comes back
// to the front, so no other surface has to guess the project or the thread. Only the shape of
// where they are, never what is on screen: no text, no selection, no field values, and no URL (the
// path's project and thread are all it takes). The device is the one settings.snapshot echoed
// (js/theme-live.js deviceId), sent only once the hub has named it. Nothing polls: one report per page change or return, the same place twice sends
// once, and a hidden page sends nothing. A box without context is not asked again.
// The device's own time zone rides along (tz, an IANA name such as Asia/Karachi, never the clock): the Planner reads "6pm" in it, not in the box's zone.

/** The project and thread a Deck path names, or nulls. @param {string} path */
export function placeOf(path) {
  const p = String(path || "").split(/[?#]/)[0].split("/").filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  if (p[0] === "projects" && p[1]) return { project: p[1], thread: p[2] || null };
  if (p[0] === "threads" && p[1]) return { project: null, thread: p[1] };
  if (p[0] === "chat" && p[1] === "thread" && p[2]) return { project: null, thread: p[2] };
  if (p[0] === "chat" && p[1]) return { project: p[1], thread: p[2] || null };
  return { project: null, thread: null };
}

/**
 * Report on navigation and on coming back. Returns stop().
 * @param {{
 *   attempt: (name: string, input?: Record<string, any>) => Promise<{ data?: any, error?: any }>,
 *   surface: () => "deck" | "phone", path?: () => string, device?: () => string | null, zone?: () => string | null, win?: Window, doc?: Document,
 * }} deps
 */
export function reportContext({ attempt, surface, path = () => location.pathname, device = () => null, zone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } }, win = window, doc = document }) {
  let off = false, last = "", lastAt = 0;
  const send = async (/** @type {boolean} */ again) => {
    if (off || doc.visibilityState === "hidden") return;
    // The device settings.snapshot echoed, when it did: the box names none for a tailnet caller,
    // and push rings the device in use from it.
    const d = device();
    const tz = zone();
    const input = { surface: surface(), ...placeOf(path()), ...(d ? { device: d } : {}), ...(tz ? { tz } : {}) };
    const key = JSON.stringify(input);
    // A page change to the same place sends nothing; coming back to the front says it again.
    // focus and visibilitychange both fire on one return: that is one report.
    if (key === last && (!again || Date.now() - lastAt < 1000)) return;
    last = key; lastAt = Date.now();
    const r = await attempt("context.report", input);
    if (r.error && (r.error.code === "no_such_tool" || r.error.code === "unknown_tool")) off = true;
  };
  const moved = () => { void send(false); };
  const back = () => { if (doc.visibilityState !== "hidden") void send(true); };
  win.addEventListener("deck:navigate", moved);
  win.addEventListener("popstate", moved);
  win.addEventListener("focus", back);
  doc.addEventListener("visibilitychange", back);
  void send(false);
  return () => {
    off = true;
    win.removeEventListener("deck:navigate", moved); win.removeEventListener("popstate", moved);
    win.removeEventListener("focus", back); doc.removeEventListener("visibilitychange", back);
  };
}
