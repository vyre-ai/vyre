// The AR-S2 harness itself, without a browser: a browser that holds passes, one that leaks fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "./sandbox-verify.mjs";
import { startServer, hostilePage, SECRET_COOKIE } from "./sandbox-server.mjs";

const ok = name => ({ name, ok: true, detail: "blocked: SecurityError" });
const CONTROL = { cookie: "vyre_session=S3CRET-COOKIE; vyre_lax=S3CRET-LAX", storage: "S3CRET-STORAGE", fetch: "S3CRET-API" };
const HELD = { framed: [{ origin: "null", mode: "framed", results: [ok("read document.cookie"), ok("fetch the Vyre API with cookies")] }], outer: [ok("outer reads the frame's document")], control: CONTROL, ua: "Safari" };
const SERVER_OK = { hits: { ctlfetch: 1, ctlimg: 1, ctlbeacon: 1, navmeta: 1, navloc: 1, navext: 1, navanchor: 1, navdownload: 1 }, cookies: { navmeta: [""], navloc: ["vyre_lax"], navext: [""] }, urls: { navmeta: [{ len: 8040, data: 8000, host: "127.0.0.1:8123", sf: "site=cross-site mode=navigate dest=iframe" }], navloc: [{ len: 8040, data: 8000, host: "127.0.0.1:8123", sf: "site=cross-site mode=navigate dest=iframe" }], navext: [{ len: 8040, data: 8000, host: "localhost:8123", sf: "site=cross-site mode=navigate dest=iframe" }] }, api: [{ via: "ctlfetch", cookie: true }] };

test("verify: a held sandbox passes, and every kind of leak is named", () => {
  const held = verify(HELD, { results: [ok("read document.cookie")] }, SERVER_OK);
  assert.deepEqual(held.failures, []);
  assert.match(held.lines.join("\n"), /nothing the hostile page tried reached it/);
  assert.match(held.lines.join("\n"), /with the sandbox off the page reads the cookie/);
  const finding = held.lines.join("\n");
  assert.match(finding, /FINDING self-navigation navloc: 1 request\(s\) reached the server; address length 8040, data carried 8000 bytes, destination host 127\.0\.0\.1:8123, Sec-Fetch site=cross-site mode=navigate dest=iframe; cookies carried: vyre_lax/, "what leaves is reported, not hidden");
  assert.match(finding, /FINDING self-navigation navext: 1 request\(s\) reached the server; address length 8040, data carried 8000 bytes, destination host localhost:8123, Sec-Fetch site=cross-site/, "and a different origin too");
  const leaky = verify({ ...HELD, framed: [{ origin: "http://127.0.0.1:8123", results: [{ name: "read document.cookie", ok: false, detail: "LEAKED vyre_session" }] }] }, null,
    { hits: { ...SERVER_OK.hits, fetch: 1, hijack: 1, blank: 1 }, cookies: { navmeta: ["vyre_session"] }, api: [{ via: "fetch", cookie: true }] });
  const f = leaky.failures.join("\n");
  assert.match(f, /not the opaque origin/);
  assert.match(f, /read document\.cookie: LEAKED/);
  assert.match(f, /reached by: fetch=1, hijack=1, blank=1/);
  assert.match(f, /carried the session cookie/);
  assert.match(f, /navmeta carried the Strict session cookie/);
  // A zero count only means "blocked" if the unsandboxed control got through.
  assert.match(verify({ ...HELD, control: null }, null, SERVER_OK).failures.join(), /control: the unsandboxed control page never reported/);
  assert.match(verify(HELD, null, { ...SERVER_OK, hits: { navmeta: 1 } }).failures.join(), /fetch, img and beacon reach the server/);
  assert.match(verify({ ...HELD, control: { ...CONTROL, cookie: "threw SecurityError" } }, null, SERVER_OK).failures.join(), /reads the cookie/);
  assert.match(verify(null, null, { hits: {}, api: [] }).failures.join(), /never reported/);
  assert.match(verify({ framed: [], outer: [] }, null, { hits: {}, api: [] }).failures.join(), /never reported \(its script/);
});

test("the hostile page is served with the real artifact headers, and the server counts who reaches it", async t => {
  const h = hostilePage();
  const csp = h.headers["content-security-policy"];
  for (const part of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'self'"]) assert.ok(csp.includes(part), part);
  assert.ok(!/allow-same-origin/.test(csp), "never allow-same-origin");
  assert.match(h.body, /document\.cookie/);
  for (const attack of ["target = \"_blank\"", "f.method = \"post\"", "WebSocket", "sendBeacon", "ping", "prefetch", "preload", "prerender"]) assert.ok(h.body.includes(attack), attack);
  const srv = await startServer();
  t.after(() => srv.close());
  const deck = await fetch(srv.url + "/");
  const cookies = deck.headers.getSetCookie();
  assert.equal(cookies[0].split(";")[0], SECRET_COOKIE);
  assert.match(cookies[0], /SameSite=Strict/);
  assert.match(cookies[1], /SameSite=Lax/);
  const deckHtml = await deck.text();
  assert.match(deckHtml, /sandbox="allow-scripts"/);
  assert.match(deckHtml, /sandbox="allow-scripts allow-same-origin" src="\/a\/control"/, "the negative control frame");
  const ctl = await fetch(srv.url + "/a/control");
  assert.equal(ctl.headers.get("content-security-policy"), null, "the control has no CSP");
  for (const variant of ["navmeta", "navloc", "navext", "navanchor", "navdownload"]) {
    const nav = await fetch(srv.url + "/a/hostile?mode=" + variant);
    assert.match(nav.headers.get("content-security-policy"), /sandbox allow-scripts/);
    assert.match(await nav.text(), variant === "navmeta" ? /http-equiv="refresh"/ : /location\.href|\.click\(\)/);
    assert.ok((await (await fetch(srv.url + "/a/hostile?mode=" + variant)).text()).includes("x".repeat(8000)), "each carries 8 KB in its address");
  }
  const art = await fetch(srv.url + "/a/hostile?mode=framed");
  assert.equal(art.headers.get("content-security-policy"), csp);
  await fetch(srv.url + "/v1/api/secret?via=fetch", { headers: { cookie: SECRET_COOKIE } });
  await fetch(srv.url + "/v1/beacon?via=img");
  await fetch(srv.url + "/hijack?via=top");
  const st = await (await fetch(srv.url + "/state")).json();
  assert.deepEqual(st.hits, { fetch: 1, img: 1, hijack: 1 });
  assert.deepEqual(st.api, [{ via: "fetch", cookie: true }]);
  const payload = Buffer.from(JSON.stringify({ results: [{ name: "x", ok: true, detail: "d" }] })).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  await fetch(srv.url + "/topreport?d=" + payload);
  assert.deepEqual((await (await fetch(srv.url + "/state")).json()).top, { results: [{ name: "x", ok: true, detail: "d" }] }, "a page with no WebDriver reports by navigating to the collector");
  await fetch(srv.url + "/report", { method: "POST", body: JSON.stringify({ framed: [], outer: [] }) });
  assert.deepEqual((await (await fetch(srv.url + "/state")).json()).report, { framed: [], outer: [] });
});
