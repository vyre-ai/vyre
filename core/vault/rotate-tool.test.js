// @ts-check
// vault.rotate through vyred: the new token is stored as a new version before the old one is
// dropped, the reminder for it is done, a guided provider returns its page, and no value is said.
// A fake GitLab on loopback stands in for the real one.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { recorded } from "./testing.js";

const hex = n => crypto.randomBytes(n).toString("hex");

test("vault.rotate: GitLab self-rotation stores the new token as a new version; guided for GitHub", async t => {
  const old = "glpat-" + hex(10), next = "glpat-" + hex(10);
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, token: req.headers["private-token"] });
    if (req.method === "POST" && req.url === "/api/v4/personal_access_tokens/self/rotate" && req.headers["private-token"] === old) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: 42, name: "vyre", token: next, expires_at: "2026-12-26", active: true }));
    } else { res.writeHead(401); res.end("{}"); }
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(null)));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;

  const done = [];
  const call = async (tool, input) => {
    if (tool === "planner.add") return { data: { id: "p1" } };
    if (tool === "planner.done") { done.push(input.item); return { data: {} }; }
    if (tool === "planner.get") return { data: { item: { state: "open" } } };
    return { error: { code: "no_such_tool", message: "no" } };
  };
  const { run, db, events } = await recorded(t, { reminders: false, rotate_endpoints: { gitlab: base } }, { call });
  await run("vault.put", { name: "kit-gitlab", kind: "pat", value: old, details: { provider: "gitlab", expires: Date.now() - 1000 } });
  await run("vault.remind.run", {});
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vault_reminders WHERE name = 'kit-gitlab'").get().n, 1);

  assert.deepEqual(await run("vault.rotation", { name: "kit-gitlab" }), { provider: "gitlab", auto: true, url: (await import("./rotate.js")).PROVIDERS.gitlab.url, steps: (await import("./rotate.js")).PROVIDERS.gitlab.steps });
  const r = await run("vault.rotate", { name: "kit-gitlab" });
  assert.equal(r.rotated, true);
  assert.equal(r.revoked, true);
  assert.equal(new Date(r.expires).toISOString().slice(0, 10), "2026-12-26");
  assert.deepEqual(seen.map(s => [s.method, s.url]), [["POST", "/api/v4/personal_access_tokens/self/rotate"]]);
  assert.equal((await run("vault.inject", { items: [{ name: "kit-gitlab", env: "T" }] })).env.T, next);
  // The old token is a version in history, and the expired reminder is done.
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM vault_history WHERE name = 'kit-gitlab'").get().n >= 1);
  assert.deepEqual(done, ["p1"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vault_reminders WHERE name = 'kit-gitlab'").get().n, 0);

  // A refused token: nothing changes.
  await run("vault.put", { name: "juno-gitlab", kind: "pat", value: "glpat-" + hex(10), details: { provider: "gitlab" } });
  await assert.rejects(run("vault.rotate", { name: "juno-gitlab" }), /^Error: GitLab: /);

  // GitHub has no API for it: the page and the steps.
  await run("vault.put", { name: "alex-github", kind: "pat", value: ["ghp", hex(18)].join("_"), details: { provider: "github" } });
  const g = await run("vault.rotate", { name: "alex-github" });
  assert.equal(g.rotated, false);
  assert.equal(g.guided.provider, "github");
  assert.match(g.guided.url, /^https:\/\/github\.com\//);
  await run("vault.put", { name: "plain", kind: "secret", value: hex(12) });
  await assert.rejects(run("vault.rotate", { name: "plain" }), /names no provider/);

  const said = JSON.stringify([r, g, events, db.prepare("SELECT * FROM vault_audit").all()]);
  for (const v of [old, next]) assert.ok(!said.includes(v), "a value leaked");
});
