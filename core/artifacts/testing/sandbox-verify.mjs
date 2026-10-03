// AR-S2: what "the sandbox held" means. Pure: takes what the Deck stand-in and the top-level page
// reported, plus the server's own counts of who got through, and says what failed.

/**
 * @param {{ framed?: any[], outer?: any[], ua?: string } | null} report the Deck stand-in's report (framed run)
 * @param {{ results?: any[], ua?: string } | null} top the hostile page's own results when opened at the top level, or null when not run
 * @param {{ rule?: boolean, loads?: { path: string, accepted: boolean, ruleOk?: boolean, sf: string }[], accepted?: Record<string, boolean[]>, hits: Record<string, number>, cookies?: Record<string, string[]>, urls?: Record<string, { len: number, data: number, host: string, sf?: string }[]>, api: { via: string, cookie: boolean }[] }} server
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
  // FINDING, not a pass: a sandbox without allow-top-navigation still lets a frame navigate ITSELF (a meta refresh, a
  // script) and no header forbids it (the CSP navigate-to directive is gone). Whatever the page holds can leave in the
  // address. This prints exactly what arrives: how many requests, how long the address was, the destination host, and
  // which cookies went with it. The run fails only if the Strict session cookie goes along.
  const SELF_NAV = new Set(["navmeta", "navloc", "navext", "navanchor", "navdownload"]);
  const cookiesOf = (/** @type {string} */ k) => (server.cookies && server.cookies[k]) || [];
  const urlsOf = (/** @type {string} */ k) => (server.urls && server.urls[k]) || [];
  // The server's own rule (core/presence/person.js foreignFetch, when the tree has it): would it take each request as the person's?
  const acceptedOf = (/** @type {string} */ k) => (server.accepted && server.accepted[k]) || [];
  const RULE = server.rule === true;
  lines.push(`info the person-session rule (foreignFetch) is ${RULE ? "PRESENT: a request is the person's only if it carries the cookie and is not foreign" : "ABSENT on this tree: any request with the cookie counts"}`);
  for (const k of SELF_NAV) {
    const u = urlsOf(k)[0];
    const acc = acceptedOf(k);
    lines.push(`FINDING self-navigation ${k}: ${reached[k] || 0} request(s) reached the server${u ? `; address length ${u.len}, data carried ${u.data} bytes, destination host ${u.host}, Sec-Fetch ${u.sf || "not recorded"}` : ""}; cookies carried: ${cookiesOf(k).map(c => c || "none").join(" | ") || "n/a"}; taken as the person's: ${acc.length ? acc.map(a => (a ? "YES" : "no")).join(",") : "n/a"}`);
    if (acc.some(Boolean)) failures.push(`self-navigation ${k} would be taken as the person's session by the server${RULE ? " even with the rule" : " (the rule is absent on this tree)"}`);
  }
  // The Deck's own image request (how a media artifact is shown) must still be the person's, rule or no rule.
  { const l = (server.loads || []).find(x => x.path === "/v1/pic");
    if (l) { lines.push(`${l.accepted ? "ok  " : "FAIL"} the Deck's own image request for the person's media is still taken as theirs (Sec-Fetch ${l.sf})`); if (!l.accepted) failures.push(`the person's own image request was refused (Sec-Fetch ${l.sf})`); }
    else failures.push("the Deck's own image request never reached the server"); }
  // The rule must not break the Deck: its own frame load of the artifact, and the artifact opened directly, stay the person's.
  if (RULE) for (const want of ["/a/hostile?mode=framed", "/a/hostile?mode=top"]) {
    const l = (server.loads || []).find(x => x.path === want);
    if (!l) continue;
    // The rule alone decides here. The top-level load runs in a second browser launch that holds no session cookie (a session
    // cookie dies with the first launch), so `accepted` (cookie and rule) would fail on the missing cookie, not on the rule.
    const taken = typeof l.ruleOk === "boolean" ? l.ruleOk : l.accepted;
    lines.push(`${taken ? "ok  " : "FAIL"} the person's own load of ${want} is still taken as theirs by the rule (Sec-Fetch ${l.sf})`);
    if (!taken) failures.push(`the rule refuses the person's own load of ${want} (Sec-Fetch ${l.sf})`);
  }
  // The server's own count: nothing else the hostile page tried may have reached it, and nothing carried the cookie.
  const blocked = Object.entries(reached).filter(([via, n]) => n > 0 && !SELF_NAV.has(via) && !via.startsWith("ctl")).map(([via, n]) => `${via}=${n}`);
  if (blocked.length) failures.push(`the server was reached by: ${blocked.join(", ")}`);
  else lines.push("ok   server: nothing the hostile page tried reached it (fetch, xhr, beacon, ws, import, open, img, script, css, iframe, form post, popup by anchor and by form, download anchor, top and parent navigation)");
  if ((server.api || []).some(a => a.cookie && !a.via.startsWith("ctl"))) failures.push("a request to the Vyre API from the hostile page carried the session cookie");
  return { failures, lines };
}
