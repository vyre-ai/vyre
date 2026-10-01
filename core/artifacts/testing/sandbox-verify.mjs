// AR-S2: what "the sandbox held" means. Pure: takes what the Deck stand-in and the top-level page
// reported, plus the server's own counts of who got through, and says what failed.

/**
 * @param {{ framed?: any[], outer?: any[], ua?: string } | null} report the Deck stand-in's report (framed run)
 * @param {{ results?: any[], ua?: string } | null} top the hostile page's own results when opened at the top level, or null when not run
 * @param {{ hits: Record<string, number>, cookies?: Record<string, string[]>, api: { via: string, cookie: boolean }[] }} server
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
  // The negative control: the sandbox OFF reaches the server and reads the cookie, so zero below means "blocked".
  const ctl = report && report.control;
  const reached = server.hits || {};
  if (!ctl) failures.push("control: the unsandboxed control page never reported, so a zero count could mean unreachable");
  else {
    const ok = (/** @type {boolean} */ c, /** @type {string} */ msg) => { lines.push(`${c ? "ok  " : "FAIL"} control: ${msg}`); if (!c) failures.push("control: " + msg); };
    ok(/S3CRET-COOKIE/.test(String(ctl.cookie)), `with the sandbox off the page reads the cookie (${String(ctl.cookie).replace(/S3CRET[^;]*/g, "<secret>").slice(0, 60)})`);
    ok(ctl.storage === "S3CRET-STORAGE", "with the sandbox off the page reads localStorage");
    ok(ctl.fetch === "S3CRET-API", "with the sandbox off fetch reaches the Vyre API");
    ok((reached.ctlfetch || 0) >= 1 && (reached.ctlimg || 0) >= 1 && (reached.ctlbeacon || 0) >= 1, `with the sandbox off fetch, img and beacon reach the server (${["ctlfetch", "ctlimg", "ctlbeacon"].map(k => `${k}=${reached[k] || 0}`).join(", ")})`);
  }
  // The pages that navigate themselves away are the one thing a sandbox without allow-top-navigation permits and
  // no header forbids: the server IS reached, and what must hold is that the session cookie does not go with it.
  const SELF_NAV = new Set(["navmeta", "navloc"]);
  const cookiesOf = (/** @type {string} */ k) => (server.cookies && server.cookies[k]) || [];
  for (const k of SELF_NAV) {
    lines.push(`info self-navigation ${k}: ${reached[k] || 0} request(s), cookies carried: ${cookiesOf(k).map(c => c || "none").join(" | ") || "n/a"}`);
    if (cookiesOf(k).some(c => /vyre_session/.test(c))) failures.push(`self-navigation ${k} carried the Strict session cookie`);
  }
  // The server's own count: nothing else the hostile page tried may have reached it, and nothing carried the cookie.
  const blocked = Object.entries(reached).filter(([via, n]) => n > 0 && !SELF_NAV.has(via) && !via.startsWith("ctl")).map(([via, n]) => `${via}=${n}`);
  if (blocked.length) failures.push(`the server was reached by: ${blocked.join(", ")}`);
  else lines.push("ok   server: nothing the hostile page tried reached it (fetch, xhr, beacon, ws, import, open, img, script, css, iframe, form post, popup by anchor and by form, download anchor, top and parent navigation)");
  if ((server.api || []).some(a => a.cookie && !a.via.startsWith("ctl"))) failures.push("a request to the Vyre API from the hostile page carried the session cookie");
  return { failures, lines };
}
