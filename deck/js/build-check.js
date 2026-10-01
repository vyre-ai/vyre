// @ts-check
// A page must never run older code than the box it talks to (reviewer-2 M3 on the 0.2 plan),
// and the person must never be asked about it. The box stamps its build id into the page's
// <meta name="vyre-build"> and into sw.js (core/daemon/build.js); this compares the page's stamp
// with system.info's build each time the stream comes back. On a mismatch the service worker is
// asked to update (a new sw.js takes over, and app.js's controllerchange handler reloads the page
// untouched or the next time it is hidden, drafts kept by the composer); with no service worker,
// the page reloads under the same rule itself. Nothing is shown.

/**
 * The same id core/daemon/build.js buildId() makes, from system.info's build fields.
 * @param {{ version?: string, commit?: string|null, dirty?: boolean|null }|null|undefined} info
 * @returns {string|null} null when the box doesn't say
 */
export function buildIdOf(info) {
  if (!info || (!info.commit && !info.version)) return null;
  const id = info.commit ? String(info.commit).slice(0, 12) + (info.dirty ? "-dirty" : "") : "v" + info.version;
  return id.replace(/[^\w.-]/g, "");
}

/**
 * Whether this page is a different build from the box. "dev" (an unstamped checkout) and an
 * unknown box build never count, so a dev world never reload-loops.
 * @param {string|null|undefined} page the page's vyre-build meta
 * @param {any} info system.info's answer
 */
export function stale(page, info) {
  const box = buildIdOf(info);
  return !!page && page !== "dev" && !!box && page !== box;
}

/**
 * Check once and act on a mismatch. Returns what it did, for tests.
 * @param {{ page: string|null, info: any, sw?: { update(): Promise<any> } | null, reload: () => void,
 *   untouched: () => boolean, onHidden: (fn: () => void) => void }} o
 * @returns {"fresh"|"sw"|"reload"|"later"}
 */
export function checkBuild(o) {
  if (!stale(o.page, o.info)) return "fresh";
  if (o.sw) { o.sw.update().catch(() => {}); return "sw"; }
  if (o.untouched()) { o.reload(); return "reload"; }
  o.onHidden(o.reload);
  return "later";
}
