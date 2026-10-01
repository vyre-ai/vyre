// The AR-S2 harness itself, without a browser: a browser that holds passes, one that leaks fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "./sandbox-verify.mjs";
import { startServer, hostilePage, SECRET_COOKIE } from "./sandbox-server.mjs";

const ok = name => ({ name, ok: true, detail: "blocked: SecurityError" });
const HELD = { framed: [{ origin: "null", mode: "framed", results: [ok("read document.cookie"), ok("fetch the Vyre API with cookies")] }], outer: [ok("outer reads the frame's document")], ua: "Safari" };

test("verify: a held sandbox passes, and every kind of leak is named", () => {
  const held = verify(HELD, { results: [ok("read document.cookie")] }, { hits: {}, api: [] });
  assert.deepEqual(held.failures, []);
  assert.match(held.lines.join("\n"), /no request from the hostile page reached it/);
  const leaky = verify({ ...HELD, framed: [{ origin: "http://127.0.0.1:8123", results: [{ name: "read document.cookie", ok: false, detail: "LEAKED vyre_session" }] }] }, null, { hits: { fetch: 1, hijack: 1 }, api: [{ via: "fetch", cookie: true }] });
  assert.equal(leaky.failures.length, 4);
  assert.match(leaky.failures.join("\n"), /not the opaque origin/);
  assert.match(leaky.failures.join("\n"), /read document\.cookie: LEAKED/);
  assert.match(leaky.failures.join("\n"), /reached by: fetch=1, hijack=1/);
  assert.match(leaky.failures.join("\n"), /carried the session cookie/);
  assert.match(verify(null, null, { hits: {}, api: [] }).failures.join(), /never reported/);
  assert.match(verify({ framed: [], outer: [] }, null, { hits: {}, api: [] }).failures.join(), /never reported \(its script/);
});

test("the hostile page is served with the real artifact headers, and the server counts who reaches it", async t => {
  const h = hostilePage();
  const csp = h.headers["content-security-policy"];
  for (const part of ["sandbox allow-scripts", "default-src 'none'", "connect-src 'none'", "form-action 'none'", "frame-ancestors 'self'"]) assert.ok(csp.includes(part), part);
  assert.ok(!/allow-same-origin/.test(csp), "never allow-same-origin");
  assert.match(h.body, /document\.cookie/);
  const srv = await startServer();
  t.after(() => srv.close());
  const deck = await fetch(srv.url + "/");
  assert.equal(deck.headers.get("set-cookie").split(";")[0], SECRET_COOKIE);
  assert.match(await deck.text(), /sandbox="allow-scripts"/);
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
