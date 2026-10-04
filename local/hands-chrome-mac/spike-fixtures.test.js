// The fixture server for the Chrome proof and bench: pages served, auth enforced (bearer header AND
// session cookie), workflows created. Binds an ephemeral 127.0.0.1 port only. No Chrome.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { startFixtureServer, TOKEN, SESSION } from "./bench/fixtures/server.mjs";

const auth = { Authorization: `Bearer ${TOKEN}`, Cookie: `sid=${SESSION}` };

test("fixture server serves both pages and sets the session cookie on /ghl", async () => {
  const s = await startFixtureServer();
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(s.port, 7300);
    const c = await fetch(`${s.url}/checkout`);
    assert.equal(c.status, 200);
    const html = await c.text();
    assert.equal((html.match(/<(input|select)\b/g) || []).length, 12);
    assert.match(html, /id="place-order"/);
    const g = await fetch(`${s.url}/ghl`);
    assert.equal(g.status, 200);
    assert.match(g.headers.get("set-cookie") || "", new RegExp(`sid=${SESSION}`));
    assert.match(await g.text(), /Create workflow/);
    assert.equal((await fetch(`${s.url}/healthz`)).status, 200);
    assert.equal((await fetch(`${s.url}/nope`)).status, 404);
  } finally { await s.close(); }
});

test("the API needs the bearer header and the cookie together", async () => {
  const s = await startFixtureServer();
  try {
    for (const h of [{}, { Authorization: auth.Authorization }, { Cookie: auth.Cookie }, { Authorization: "Bearer wrong", Cookie: auth.Cookie }]) {
      const r = await fetch(`${s.url}/api/contacts`, { headers: h });
      assert.equal(r.status, 401);
      assert.deepEqual(await r.json(), { error: "unauthorized" });
    }
    const ok = await fetch(`${s.url}/api/contacts?limit=5&page=2`, { headers: auth });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.data.length, 5);
    assert.equal(body.meta.page, 2);
    const one = await fetch(`${s.url}/api/contacts/${body.data[0].id}`, { headers: auth });
    assert.equal((await one.json()).data.id, body.data[0].id);
    assert.ok(s.stats.denied >= 4);
  } finally { await s.close(); }
});

test("POST /api/workflows creates one that GET can read back", async () => {
  const s = await startFixtureServer();
  try {
    const post = await fetch(`${s.url}/api/workflows`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Welcome flow", trigger: "Contact Created", actions: [{ type: "Wait", config: "15" }] }) });
    assert.equal(post.status, 201);
    const wf = (await post.json()).data;
    assert.match(wf.id, /^wf_[0-9a-f]{10}$/);
    const list = await (await fetch(`${s.url}/api/workflows`, { headers: auth })).json();
    assert.equal(list.data.length, 1);
    const one = await fetch(`${s.url}/api/workflows/${wf.id}`, { headers: auth });
    assert.equal((await one.json()).data.name, "Welcome flow");
    const bad = await fetch(`${s.url}/api/workflows`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});
