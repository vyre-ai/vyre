// @ts-check
// A timing trace for the Deck's navigation: per route, the time from the click to each step (the route starting, the frame on screen, the view's
// stylesheet and code arriving, the view finishing its first draw) and every tool call it made with how long each took. Off unless the address
// has ?trace=1 (or localStorage vyre.trace is 1), so a normal page pays one boolean check. ?lag=250 adds that many milliseconds to every tool call,
// to feel and measure a far-away server. The last routes are on window.__deckTrace and a table goes to the console when a route settles.
// Nothing leaves the page.

const on = (() => {
  try { return /[?&]trace=1\b/.test(globalThis.location?.search || "") || globalThis.localStorage?.getItem("vyre.trace") === "1"; } catch { return false; }
})();
/** Added to every tool call, from ?lag=<ms>, while tracing. */
export const lagMs = (() => { try { return on ? Math.max(0, Math.min(2000, Number(/[?&]lag=(\d+)/.exec(globalThis.location?.search || "")?.[1] || 0))) : 0; } catch { return 0; } })();
export const enabled = on;

const now = () => (globalThis.performance?.now?.() ?? Date.now());
/** @type {{ key: string, name: string, t0: number, marks: [string, number][], calls: { tool: string, from: number, ms: number, ok: boolean }[], settled: boolean }[]} */
const routes = [];
let clickAt = 0, cur = /** @type {(typeof routes)[number]|null} */ (null), idleT = /** @type {any} */ (null);

/** A click or a touch on a link: the start the person feels. */
export function pressed() { if (on) clickAt = now(); }

/** @param {string} key @param {string} name */
export function routeStart(key, name) {
  if (!on) return;
  const t0 = now();
  cur = { key, name, t0: clickAt && t0 - clickAt < 2000 ? clickAt : t0, marks: [], calls: [], settled: false };
  clickAt = 0;
  routes.push(cur); if (routes.length > 30) routes.shift();
  /** @type {any} */ (globalThis).__deckTrace = routes;
  mark("route");
}

/** @param {string} label */
export function mark(label) { if (on && cur && !cur.marks.some(m => m[0] === label)) { cur.marks.push([label, Math.round(now() - cur.t0)]); settleSoon(); } }

/** A tool call began; call the returned function when it ends. @param {string} tool @returns {(ok: boolean) => void} */
export function callStart(tool) {
  if (!on || !cur) return () => {};
  const r = cur, from = now();
  return ok => { r.calls.push({ tool, from: Math.round(from - r.t0), ms: Math.round(now() - from), ok }); if (r.calls.length === 1) mark("data"); settleSoon(); };
}

function settleSoon() {
  clearTimeout(idleT);
  idleT = setTimeout(() => {
    const r = cur; if (!r || r.settled) return;
    r.settled = true;
    try {
      console.groupCollapsed?.(`route ${r.key}: ${r.marks.map(m => `${m[0]} ${m[1]}ms`).join(", ")}`);
      console.table?.(r.calls);
      console.groupEnd?.();
    } catch { /* no console */ }
  }, 400);
}

/** The route's numbers, for a test or a budget check. */
export const lastRoute = () => routes[routes.length - 1] || null;
