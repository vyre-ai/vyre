// AR-S2: what "the sandbox held" means. Pure: takes what the Deck stand-in and the top-level page
// reported, plus the server's own counts of who got through, and says what failed.

/**
 * @param {{ framed?: any[], outer?: any[], ua?: string } | null} report the Deck stand-in's report (framed run)
 * @param {{ results?: any[], ua?: string } | null} top the hostile page's own results when opened at the top level, or null when not run
 * @param {{ hits: Record<string, number>, api: { via: string, cookie: boolean }[] }} server
 * @returns {{ failures: string[], lines: string[] }}
 */
export function verify(report, top, server) {
  const failures = [], lines = [];
  const check = (/** @type {string} */ where, /** @type {any[]} */ rs) => {
    for (const r of rs || []) { lines.push(`${r.ok ? "ok  " : "FAIL"} ${where}: ${r.name} (${r.detail})`); if (!r.ok) failures.push(`${where}: ${r.name}: ${r.detail}`); }
  };
  if (!report) failures.push("framed: the Deck stand-in never reported (the page did not load or the browser hung)");
  else {
    if (!report.framed || !report.framed.length) failures.push("framed: the hostile page never reported (its script did not run, or postMessage was blocked)");
    for (const f of report.framed || []) {
      if (f.origin !== "null") failures.push(`framed: the hostile page's messages come from origin ${f.origin}, not the opaque origin "null"`);
      check("framed", f.results);
    }
    check("outer", report.outer);
  }
  if (top) check("top-level", top.results);
  // The server's own count: nothing the hostile page tried may have reached it, and nothing carried the cookie.
  const reached = Object.entries(server.hits || {}).filter(([, n]) => n > 0).map(([via, n]) => `${via}=${n}`);
  if (reached.length) failures.push(`the server was reached by: ${reached.join(", ")}`);
  else lines.push("ok   server: no request from the hostile page reached it (fetch, xhr, beacon, ws, import, open, img, script, css, iframe, form, object, css url, top and parent navigation)");
  if ((server.api || []).some(a => a.cookie)) failures.push("a request to the Vyre API carried the session cookie");
  return { failures, lines };
}
