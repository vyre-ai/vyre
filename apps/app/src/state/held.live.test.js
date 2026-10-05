// @ts-check
// The held-send page against a real vyred in a temp home with the real vault and a fake Gmail: what the page reads (gate.get), what it sends back when the person edits (gate.revise, gate.approve with
// `edited`), and discard (gate.reject). The page's own words come from src/state/held.js; the box's answers are the box's.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { start } from "../../../../core/daemon/index.js";
import { call } from "../../../../core/daemon/client.js";
import { tempHome, present } from "../../../../test/helpers.js";
import { editedOf, fieldsOf, heldFor, sendOutcome } from "./held.js";

async function fakeGmail(t) {
  /** @type {{ url: string, auth?: string, body: string }[]} */ const got = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => { got.push({ url: String(req.url), auth: req.headers.authorization, body }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id: "m1", threadId: "t1" })); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise((r) => server.close(() => r(undefined))));
  return { got, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

test("held page: read in full, edit, save, send exactly the edit; discard sends nothing", async (t) => {
  const root = tempHome(t);
  const gmail = await fakeGmail(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: gmail.base } } } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const as = (caller) => (tool, input = {}) => call(tool, input, { root, caller });
  const cli = as("cli"), device = as("device");
  assert.ok((await cli("vault.put", { name: "work-mail-token", kind: "api-key", fields: { value: "fixture-token" } })).data);
  assert.equal((await cli("vault.grant", { name: "work-mail-token", module: "gate" })).data.grant.status, "active");
  const juno = (tool, input = {}) => d.registry.call(tool, input, "mcp:agent:juno", { thread: "t-1", agent: "juno" });
  const ask = async (subject, body) => (await juno("gate.request", { kind: "send", via: "mail", to: "dana@example.com", content: { subject, body }, thread: "t-1" })).data.id;

  const a = await ask("Intake form", "Hi Dana, the form is on staging. Call Thursday?");
  const item = (await device("gate.get", { id: a })).data;
  assert.deepEqual(fieldsOf(item).map((f) => [f.key, f.edit]), [["subject", true], ["body", true]]);
  assert.equal(fieldsOf(item)[1].value, "Hi Dana, the form is on staging. Call Thursday?", "the whole body, not a summary");
  const needs = [{ id: `gate:${a}`, source: "gate", thread: "t-1", title: "Send email to dana", detail: "Intake form", at: 1 }];
  assert.equal(heldFor({ subject: "Intake form" }, needs, "t-1"), `gate:${a}`);

  // Save an edit without sending: still held, and the page reads the edit back.
  const typed = { subject: "Intake form", body: "Hi Dana, could we do Friday?" };
  const edited = editedOf(item, typed, "dana@example.com, kim@example.com");
  assert.deepEqual(edited, { body: "Hi Dana, could we do Friday?", to: ["dana@example.com", "kim@example.com"] });
  assert.ok((await device("gate.revise", { id: a, edited })).data);
  const again = (await device("gate.get", { id: a })).data;
  assert.equal(again.state, "held");
  assert.equal(gmail.got.length, 0, "saving sends nothing");
  assert.equal(fieldsOf(again)[1].value, "Hi Dana, could we do Friday?");
  assert.equal(editedOf(again, { body: "Hi Dana, could we do Friday?" }), null, "nothing left to change");

  // Send: the edit goes out, to both, once.
  const sent = (await device("gate.approve", { id: a })).data;
  assert.deepEqual(sendOutcome(sent), { ok: true });
  assert.equal(gmail.got.length, 2, "one message per recipient");
  assert.match(Buffer.from(JSON.parse(gmail.got[0].body).raw, "base64url").toString("utf8"), /^From: alex@example.com\r\nTo: (dana|kim)@example.com\r\n/);
  assert.equal(gmail.got[0].auth, "Bearer fixture-token");

  // Discard: nothing goes.
  const b = await ask("Second", "Never mind");
  assert.ok((await device("gate.reject", { id: b })).data);
  assert.equal((await device("gate.get", { id: b })).data.state, "rejected");
  assert.equal(gmail.got.length, 2);
});
