// @ts-check
// The Gate inside a real vyred, in a temp home, with the real vault: an agent asks for an email,
// it is held, the user edits and approves it, and it reaches a fake Gmail with a token the agent
// never saw. The value never appears in an event, a log, or anything the Gate returns.

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

/** A fake Gmail send endpoint that records what it was sent. */
async function fakeGmail(t) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", d => (body += d));
    req.on("end", () => {
      got.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg-1", threadId: "th-1", labelIds: ["SENT"] }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { got, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

test("gate: an agent's email is held, edited and approved by the user, and sent with a credential it never saw", async t => {
  const root = tempHome(t);
  const gmail = await fakeGmail(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    name: "test-box", vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "work-mail-token", from: "alex@example.com", base: gmail.base } } },
  }));
  const lines = [];
  const d = await start({ root, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  const cli = as("cli"), local = as("local");
  // An agent's MCP server calls as "mcp:agent:juno" with its thread's key, which only the
  // Switchboard hands out; vyred refuses the name without it. So juno's calls go in-process.
  // With it, vyred tells the tool which thread the call came from; that is what juno gets here.
  const juno = (tool, input = {}) => d.registry.call(tool, input, "mcp:agent:juno", { thread: "t-1", agent: "juno" });
  assert.equal((await as("mcp:agent:juno")("gate.senders")).error.code, "denied", "no key, no agent");
  assert.equal(d.registry.status().find(m => m.name === "gate")?.state, "running");

  const value = fake("token");
  assert.ok((await cli("vault.put", { name: "work-mail-token", kind: "api-key", fields: { value } })).data);
  assert.equal((await cli("vault.grant", { name: "work-mail-token", module: "gate" })).data.grant.status, "active");

  const senders = (await juno("gate.senders")).data;
  assert.deepEqual(senders.map(s => s.name), ["mail"]);

  const held = await juno("gate.request", { kind: "send", via: "mail", to: "dana@harlowlegal.com",
    content: { subject: "Re: Intake form rebuild", body: "Hi Dana, the form is on staging. Call Thursday? Alex" }, thread: "t-1" });
  const id = held.data.id;
  assert.equal(held.data.state, "held");
  assert.equal(gmail.got.length, 0, "sent before approval");

  const list = (await local("gate.held")).data;
  assert.equal(list.length, 1);
  assert.equal(list[0].agent, "juno");
  assert.equal(list[0].summary, "Re: Intake form rebuild");

  // A model never approves: not the agent that asked, not plain Claude.
  assert.match((await juno("gate.approve", { id })).error.message, /not available to mcp callers/);
  assert.equal((await as("mcp")("gate.approve", { id })).error.code, "denied");
  assert.equal((await as("mcp")("gate.reject", { id })).error.code, "denied");
  assert.equal((await as("mcp")("gate.get", { id })).error.code, "denied");

  const body = "Hi Dana, the form is on staging. Could we do a 15-minute call on Friday? Alex";
  const out = await local("gate.approve", { id, edited: { body } });
  assert.equal(out.data.state, "sent", JSON.stringify(out));
  assert.equal(gmail.got.length, 1);
  assert.equal(gmail.got[0].url, "/gmail/v1/users/me/messages/send");
  assert.equal(gmail.got[0].auth, `Bearer ${value}`);
  const mail = Buffer.from(JSON.parse(gmail.got[0].body).raw, "base64url").toString("utf8");
  assert.match(mail, /^From: alex@example.com\r\nTo: dana@harlowlegal.com\r\nSubject: Re: Intake form rebuild\r\n/);
  assert.equal(Buffer.from(mail.split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString("utf8"), body);

  const item = (await local("gate.get", { id })).data;
  assert.equal(item.state, "sent");
  assert.deepEqual(item.diff, { removed: ["Call Thursday?"], added: ["Could we do a 15-minute call on Friday?"] });
  assert.equal((await local("gate.approve", { id })).error.message, `${id} is already sent`);

  // The promise: the value is nowhere but the one request that needed it.
  const events = d.registry.deps.events.since(0, { limit: 1000 });
  assert.ok(events.some(e => e.type === "gate.held") && events.some(e => e.type === "gate.released"));
  const released = events.find(e => e.type === "gate.released");
  assert.equal(released.payload.edited, true);
  assert.equal(released.thread, "t-1");
  const everything = JSON.stringify([events, lines, item, list, out, senders, held]);
  assert.ok(!everything.includes(value), "the credential leaked");
  assert.ok(!JSON.stringify(events).includes("staging"), "an event carried the content");
});

test("gate: a module not named in gate.approvers cannot approve", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { approvers: [], senders: { mail: { type: "gmail", vault: "work-mail-token" } } } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const { id } = (await call("gate.request", { kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "s", body: "b" } }, { root, caller: "mcp" })).data;
  const r = await d.registry.call("gate.approve", { id }, "module:chat");
  assert.match(r.error.message, /may not approve for the user/);
});
