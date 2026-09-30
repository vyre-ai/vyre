// @ts-check
// config: the two things a STAGING build of the setup page may point elsewhere, read from an optional /setup/config.json that only
// scripts/stage-site.sh writes. Production never takes it: on vyre.run and www.vyre.run the file is ignored whatever it says, so
// nothing put on the production origin can change the install line the person pastes into a shell. Elsewhere the values are checked:
// a relay must be a plain wss:// host (with an optional port), the install URL a plain https:// address with no login, query or
// fragment, and must be on a host under vyre.run (the install URL may also be on vyre-site.pages.dev, the site's own project, and its preview
// subdomains, never another pages.dev name); anything else is ignored. A test
// runner's own machine is the one other place: ws:// to, and http:// on, a loopback address (127.0.0.1, localhost or [::1]).

const PRODUCTION = new Set(["vyre.run", "www.vyre.run"]);
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;
const under = (/** @type {string} */ host, /** @type {string[]} */ suffixes) => suffixes.some(s => host === s || host.endsWith("." + s));

/** @param {unknown} j @param {string} [hostname] the page's own hostname; production's is never overridden @returns {{ relay?: string, installUrl?: string }} */
export function setupOverrides(j, hostname = "") {
  /** @type {{ relay?: string, installUrl?: string }} */
  const out = {};
  if (PRODUCTION.has(String(hostname).toLowerCase())) return out;
  const o = j && typeof j === "object" ? /** @type {any} */ (j) : {};
  if (typeof o.relay === "string") {
    const w = /^wss:\/\/([A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:\d{1,5})?$/.exec(o.relay);
    const l = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.exec(o.relay);
    if ((w && under(w[1].toLowerCase(), ["vyre.run"])) || l) out.relay = o.relay;
  }
  if (typeof o.installUrl === "string" && o.installUrl.length <= 300) {
    try {
      const u = new URL(o.installUrl);
      const host = u.hostname.toLowerCase();
      const ok = (u.protocol === "https:" && !/^[\d.]+$|^\[/.test(host) && under(host, ["vyre.run", "vyre-site.pages.dev"])) || (u.protocol === "http:" && LOOPBACK.test(host));
      if (ok && !u.username && !u.password && !u.search && !u.hash) out.installUrl = u.href;
    } catch { /* not a URL */ }
  }
  return out;
}
