// @ts-check
// Where the person is, told to cohesion's context (ADR 0036 part 2): context.report
// {surface: "deck" | "phone", project, thread} when the Deck lands on a page and when it comes back
// to the front, so no other surface has to guess the project or the thread. Only the shape of
// where they are, never what is on screen: no text, no selection, no field values, and no URL (the
// path's project and thread are all it takes). The device is left to the box, which knows the
// caller's own. Nothing polls: one report per page change or return, the same place twice sends
// once, and a hidden page sends nothing. A box without context is not asked again.

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
 *   surface: () => "deck" | "phone", path?: () => string, win?: Window, doc?: Document,
 * }} deps
 */
export function reportContext({ attempt, surface, path = () => location.pathname, win = window, doc = document }) {
  let off = false, last = "", lastAt = 0;
  const send = async (/** @type {boolean} */ again) => {
    if (off || doc.visibilityState === "hidden") return;
    const input = { surface: surface(), ...placeOf(path()) };
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
