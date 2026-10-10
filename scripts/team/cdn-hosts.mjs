// @ts-check
// S2: shipped code loads nothing from a third-party CDN, font host or analytics host (vendor the file, pinned and hashed, and serve it from the box). One list, read by preflight (added lines) and by
// test/no-cdn.test.js (the whole shipped tree), so the two cannot drift.

export const CDN_HOSTS = Object.freeze([
  "unpkg.com", "cdn.jsdelivr.net", "esm.sh", "cdnjs.cloudflare.com", "cdn.tailwindcss.com", "cdn.skypack.dev", "ga.jspm.io", "cdn.sheetjs.com",
  "fonts.googleapis.com", "fonts.gstatic.com", "fonts.bunny.net", "use.fontawesome.com", "kit.fontawesome.com", "rsms.me",
  "ajax.googleapis.com", "code.jquery.com", "stackpath.bootstrapcdn.com", "maxcdn.bootstrapcdn.com", "cdn.datatables.net", "cdn.plot.ly", "d3js.org", "polyfill.io", "cdn.polyfill.io",
  "www.googletagmanager.com", "www.google-analytics.com", "ssl.google-analytics.com", "cdn.segment.com", "plausible.io", "static.cloudflareinsights.com", "cdn.rawgit.com", "rawcdn.githack.com",
]);

const escape = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PATTERN = new RegExp(`(?:https?:)?//(?:[A-Za-z0-9-]+\\.)*(?:${CDN_HOSTS.map(escape).join("|")})(?![A-Za-z0-9-])`, "i");

/** The CDN host a line names (in a URL, an import, a src or href, or a CSP source list), or "". @param {string} line @returns {string} */
export function cdnHit(line) {
  const m = PATTERN.exec(line);
  return m ? m[0].replace(/^(?:https?:)?\/\//i, "") : "";
}

/** Files S2 does not apply to: tests and their fixtures, docs, and packaging. @param {string} f */
export const s2Exempt = f => /(\.test\.|\/testing\/|^test\/|\/test\/|\.real\.test\.)/.test(f) || /\.md$|^docs\//.test(f) || /^packaging\//.test(f);
