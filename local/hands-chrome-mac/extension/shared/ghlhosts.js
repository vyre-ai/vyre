// @ts-check
// ghlhosts: the white-label domains the person said their GoHighLevel runs on (standalone: `vyre-chrome
// config ghl-host <host>`). gohighlevel.com and leadconnectorhq.com always count. Nothing about a page's
// own content or traffic can add a host: only the person's configuration does.

/** @type {string[]} */
let extra = [];

/** @param {unknown} list */
export function setGhlHosts(list) {
  extra = Array.isArray(list) ? list.map(h => String(h).toLowerCase().trim()).filter(h => /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h)).slice(0, 20) : [];
}
export const getGhlHosts = () => extra.slice();

/** Is this hostname GoHighLevel's own, or one the person listed? @param {string} host */
export function isGhlHost(host) {
  const h = String(host || "").toLowerCase();
  return /(^|\.)(gohighlevel\.com|leadconnectorhq\.com)$/.test(h) || extra.some(x => h === x || h.endsWith("." + x));
}
