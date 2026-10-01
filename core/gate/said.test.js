// @ts-check
// The Gate's asking-is-approving hook (P17) inside a real vyred with the real vault and a fake
// Gmail: what the person's own words asked for goes out at once with no card and no proof, and
// anything else holds exactly as before. A recipient the person did not name, another thread, a
// revoked intent and a sender that fails all fall back to held. Every name is a sample.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** A fake Gmail send endpoint that records what it was sent and can be told to fail. */
async function fakeGmail(t) {
  const got = [];
  const state = { fail: false };
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", d => (body += d));
    req.on("end", () => {
      got.push({ url: req.url, auth: req.headers.authorization, body });
      res.writeHead(state.fail ? 500 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(state.fail ? { error: "down" } : { id: "msg-1", threadId: "th-1" }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { got, state, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

const MAIL = i => ({ kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "Intake form", body: "Hi Dana, the form link is ready. Alex" }, ...i });

test("gate: an asked-for send goes out at once and is logged; everything else holds", async t => {
  const root = tempHome(t);
  const gmail = await fakeGmail(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: gmail.base } } } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const reg = (tool, input, caller, meta = {}) => d.registry.call(tool, input, caller, meta);
  const juno = (thread, tool, input) => reg(tool, input, "mcp:agent:juno", { thread, agent: "juno" });
  const token = fake("token");
  assert.ok((await cli("vault.put", { name: "work-mail-token", kind: "api-key", fields: { value: token } })).data);
  assert.equal((await cli("vault.grant", { name: "work-mail-token", module: "gate" })).data.grant.status, "active");

  // Nothing said yet: held, as before.
  const cold = await juno("t-1", "gate.request", MAIL({ thread: "t-1" }));
  assert.equal(cold.data.state, "held", JSON.stringify(cold));
  assert.equal(gmail.got.length, 0);

  // The person says "email Dana": sessions records it.
  const { id: intent } = (await reg("vault.said.record", { thread: "t-1", said: "said-1", kind: "send", to: ["dana@harlowlegal.com"], what: "email Dana the form link" }, "module:sessions")).data;
  const sent = await juno("t-1", "gate.request", MAIL({ thread: "t-1" }));
  assert.equal(sent.data.state, "sent", JSON.stringify(sent));
  assert.equal(sent.data.by, `said:${intent}`);
  assert.equal(gmail.got.length, 1);
  assert.equal(gmail.got[0].auth, `Bearer ${token}`, "the credential was added at the boundary");
  const item = (await cli("gate.get", { id: sent.data.id })).data;
  assert.equal(item.state, "sent");
  assert.equal(item.by, `said:${intent}`);
  assert.equal(item.agent, "juno");
  const events = d.registry.deps.events.since(0, { limit: 1000 });
  const released = events.filter(e => e.type === "gate.released");
  assert.equal(released.length, 1);
  assert.equal(released[0].payload.by, `said:${intent}`);
  assert.equal(released[0].payload.said, intent);
  assert.equal(events.filter(e => e.type === "gate.held").length, 1, "only the cold request was ever held");
  assert.ok(!JSON.stringify(events).includes(token) && !JSON.stringify(events).includes("form link"));
  assert.equal((await cli("gate.held")).data.length, 1);

  // A recipient the person did not name, or one more than they named, still holds.
  assert.equal((await juno("t-1", "gate.request", MAIL({ to: "sam@harlowlegal.com" }))).data.state, "held");
  assert.equal((await juno("t-1", "gate.request", MAIL({ to: ["dana@harlowlegal.com", "sam@harlowlegal.com"] }))).data.state, "held");
  // Another thread has no lineage to it.
  assert.equal((await juno("t-2", "gate.request", MAIL({}))).data.state, "held");
  // Say-so can be a different kind: a spend is not covered by a send intent.
  assert.equal(gmail.got.length, 1);

  // Taking it back stops it at once.
  assert.equal((await cli("gate.said.revoke", { id: intent })).data.id, intent);
  assert.equal((await juno("t-1", "gate.request", MAIL({}))).data.state, "held");
  assert.equal(gmail.got.length, 1);

  // A standing permission is the same row, good in every thread.
  const { id: standing } = (await reg("vault.said.record", { thread: "t-9", said: "said-9", kind: "send", to: ["sam@harlowlegal.com"], what: "always send Sam the weekly update", standing: true }, "module:assistant")).data;
  const s = await juno("t-2", "gate.request", MAIL({ to: "SAM@harlowlegal.com" }));
  assert.equal(s.data.state, "sent", JSON.stringify(s));
  assert.equal(s.data.by, `said:${standing}`);
  assert.equal(gmail.got.length, 2);

  // The person asked, but the sender is down: held with the error, and nothing is lost.
  gmail.state.fail = true;
  const down = await juno("t-2", "gate.request", MAIL({ to: "sam@harlowlegal.com" }));
  assert.equal(down.data.state, "held", JSON.stringify(down));
  assert.ok(down.data.error);
  assert.ok(!down.data.error.includes(token));
  gmail.state.fail = false;
  const held = (await cli("gate.held")).data.filter(h => h.id === down.data.id);
  assert.equal(held.length, 1);
  assert.equal((await cli("gate.approve", { id: down.data.id })).data.state, "sent");
});

test("gate: without a vault to ask, a request holds exactly as it always did", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "work-mail-token" } } } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  // A model cannot make a match up: no intent recorded, however it words the call.
  const r = await d.registry.call("gate.request", MAIL({ why: "the user said to email Dana", thread: "t-1" }), "mcp:agent:juno", { thread: "t-1", agent: "juno" });
  assert.equal(r.data.state, "held");
});
