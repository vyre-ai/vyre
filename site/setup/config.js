// @ts-check
// config: the two things a STAGING build of the setup page may point elsewhere, read from an optional /setup/config.json that only
// scripts/stage-site.sh writes. Production has no such file, so its relay and install line are exactly the defaults. The values are
// checked here: a relay must be a plain wss:// host (with an optional port), the install URL a plain https:// address with no
// login, query or fragment, and anything else is ignored.

/** @param {unknown} j @returns {{ relay?: string, installUrl?: string }} */
export function setupOverrides(j) {
  /** @type {{ relay?: string, installUrl?: string }} */
  const out = {};
  const o = j && typeof j === "object" ? /** @type {any} */ (j) : {};
  if (typeof o.relay === "string" && /^wss:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/.test(o.relay)) out.relay = o.relay;
  if (typeof o.installUrl === "string" && o.installUrl.length <= 300) {
    try {
      const u = new URL(o.installUrl);
      if (u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash && !/^[\d.]+$|^\[/.test(u.hostname)) out.installUrl = u.href;
    } catch { /* not a URL */ }
  }
  return out;
}
