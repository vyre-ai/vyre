// @ts-check
// The Gate on its own, with fake senders and a fake vault: held, listed, edited, sent, discarded,
// failed and retried, and the two promises it rests on: nothing is sent unapproved, and no
// content or credential reaches an event.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Gate, MIGRATIONS, diff } from "./gate.js";
import { scrub, rfc822, allowedOrigin } from "./senders.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;

/** A fake sender type that records what it was given and can be told to fail. */
function fakeTypes() {
  const sent = [];
  let fail = null;
  const types = {
    fake: {
      kinds: ["send"], content: { subject: "string", body: "string" },
      check: (to, c) => { if (typeof c.body !== "string") throw new Error("needs a body"); },
      summary: (to, c) => String(c.subject || ""),
      send: async (to, c, s, deps) => {
        const token = await deps.fetchCredential(s.vault);
        if (fail) { const f = fail; fail = null; throw new Error(f); }
        sent.push({ to, c, token });
        return { ok: true };
      },
    },
  };
  return { types, sent, failNext: m => { fail = m; } };
}

function setup({ teach } = {}) {
  const db = new DatabaseSync(":memory:");
  for (const m of MIGRATIONS) db.exec(m);
  const events = [];
  const value = fake("token");
  const taught = [];
  const f = fakeTypes();
  const gate = new Gate({
    db, types: f.types, senders: { mail: { type: "fake", vault: "work-mail-token" } },
    emit: (type, payload, where) => events.push({ type, payload, where }),
    fetchCredential: async () => value, relay: async () => ({}),
    teach: teach === false ? undefined : async (kind, fact) => { taught.push({ kind, fact }); },
  });
  return { gate, events, value, taught, ...f };
}

const DRAFT = { subject: "Re: Intake form rebuild", body: "Hi Dana, the new intake form is on staging. Could we do a call on Thursday? Alex" };
const ask = (gate, extra = {}) => gate.request({ kind: "send", via: "mail", to: "dana@harlowlegal.com", content: DRAFT, why: "Dana asked for an update", thread: "t-1", project: "harlow-legal", ...extra }, { agent: "juno" });

test("gate: a request is held, listed and never sent on its own", async () => {
  const { gate, events, sent } = setup();
  const r = ask(gate);
  assert.equal(r.state, "held");
  assert.match(r.id, /^[0-9a-f]{18}$/);
  const held = gate.held();
  assert.equal(held.length, 1);
  assert.deepEqual({ ...held[0], at: 0 }, { id: r.id, kind: "send", via: "mail", to: ["dana@harlowlegal.com"], summary: "Re: Intake form rebuild",
    why: "Dana asked for an update", agent: "juno", thread: "t-1", project: "harlow-legal", at: 0 });
  assert.equal(gate.held({ thread: "other" }).length, 0);
  assert.equal(sent.length, 0);
  assert.equal(events[0].type, "gate.held");
  assert.deepEqual(events[0].where, { thread: "t-1", project: "harlow-legal" });
});

test("gate: unknown senders, wrong kinds and bad content are refused at request time", () => {
  const { gate } = setup();
  assert.throws(() => ask(gate, { via: "fax" }), /no sender "fax"; the senders are mail/);
  assert.throws(() => ask(gate, { kind: "spend" }), /does not spend/);
  assert.throws(() => ask(gate, { content: { subject: "x" } }), /needs a body/);
  assert.throws(() => ask(gate, { to: [] }), /where it is going/);
});

test("gate: approve with edits sends the edited words, keeps the draft, and teaches the difference", async () => {
  const { gate, sent, events, taught, value } = setup();
  const { id } = ask(gate);
  const body = "Hi Dana, the new intake form is on staging. Could we do a 15-minute call on Friday? Alex";
  const out = await gate.approve({ id, edited: { body }, by: "local" });
  assert.deepEqual(out, { id, state: "sent", result: { ok: true } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].c.body, body);
  assert.equal(sent[0].c.subject, DRAFT.subject);
  assert.equal(sent[0].token, value);
  const item = gate.get({ id });
  assert.equal(item.state, "sent");
  assert.equal(item.draft.body, DRAFT.body);
  assert.equal(item.final.body, body);
  assert.deepEqual(item.diff, { removed: ["Thursday?"], added: ["15-minute", "Friday?"] });
  const rel = events.find(e => e.type === "gate.released");
  assert.equal(rel.payload.edited, true);
  assert.equal(rel.payload.by, "local");
  assert.equal(taught.length, 1);
  assert.equal(taught[0].kind, "draft.edited");
  assert.deepEqual(taught[0].fact.subject, { email: "dana@harlowlegal.com" });
  assert.equal(taught[0].fact.key, `gate:${id}`);
  assert.match(taught[0].fact.text, /juno's send via mail/);
  assert.equal(gate.held().length, 0);
});

test("gate: approving unchanged teaches nothing and says edited false", async () => {
  const { gate, events, taught } = setup();
  const { id } = ask(gate);
  await gate.approve({ id, edited: { body: DRAFT.body } });
  assert.equal(events.find(e => e.type === "gate.released").payload.edited, false);
  assert.equal(taught.length, 0);
});

test("gate: without Memory an edited approval still sends", async () => {
  const { gate, sent } = setup({ teach: false });
  const { id } = ask(gate);
  assert.equal((await gate.approve({ id, edited: { body: "Hi Dana. Alex" } })).state, "sent");
  assert.equal(sent.length, 1);
});

test("gate: a double approve sends once and the second is refused", async () => {
  const { gate, sent } = setup();
  const { id } = ask(gate);
  const [a, b] = await Promise.allSettled([gate.approve({ id }), gate.approve({ id })]);
  const ok = [a, b].filter(x => x.status === "fulfilled");
  assert.equal(ok.length, 1);
  assert.equal(sent.length, 1);
  await assert.rejects(gate.approve({ id }), /already sent/);
});

test("gate: reject discards, and a discarded item cannot be approved", async () => {
  const { gate, events, sent } = setup();
  const { id } = ask(gate);
  assert.deepEqual(gate.reject({ id, reason: "not now", by: "local" }), { id, state: "rejected" });
  assert.equal(events.at(-1).type, "gate.rejected");
  await assert.rejects(gate.approve({ id }), /already rejected/);
  assert.throws(() => gate.reject({ id }), /already rejected/);
  assert.equal(sent.length, 0);
});

test("gate: a failed send goes back to held with its error, keeps the edits, and can be retried", async () => {
  const { gate, events, sent, failNext } = setup();
  const { id } = ask(gate);
  failNext("gmail answered 503: try later");
  const out = await gate.approve({ id, edited: { body: "Hi Dana. Alex" } });
  assert.equal(out.state, "failed");
  assert.match(out.error, /503/);
  assert.equal(events.at(-1).type, "gate.failed");
  assert.equal(gate.held()[0].error, out.error);
  assert.equal((await gate.approve({ id })).state, "sent");
  assert.equal(sent[0].c.body, "Hi Dana. Alex");
});

test("gate: no event carries the content or the credential", async () => {
  const { gate, events, value } = setup();
  const { id } = ask(gate);
  await gate.approve({ id, edited: { body: "A private line only the user wrote. Alex" } });
  const { id: id2 } = ask(gate);
  gate.reject({ id: id2 });
  const all = JSON.stringify(events);
  assert.ok(!all.includes(value));
  assert.ok(!all.includes("on staging"));
  assert.ok(!all.includes("private line"));
});

test("gate: route denies a sending MCP tool inside an agent's thread and leaves the rest", () => {
  const { gate } = setup();
  const r = gate.route({ tool: "mcp__mail__send_message", agent: "juno" });
  assert.equal(r.decision, "deny");
  assert.match(r.reason, /gate_request with via one of: mail/);
  assert.deepEqual(gate.route({ tool: "mcp__mail__send_message" }), { decision: null });
  assert.deepEqual(gate.route({ tool: "mcp__mail__list_drafts", agent: "juno" }), { decision: null });
  assert.deepEqual(gate.route({ tool: "Bash", agent: "juno" }), { decision: null });
});

test("gate: diff is word level and capped", () => {
  assert.deepEqual(diff({ body: "a b c d" }, { body: "a x c d e" }), { removed: ["b"], added: ["x", "e"] });
  assert.deepEqual(diff({ subject: "same" }, { subject: "same" }), { removed: [], added: [] });
  const many = diff({ body: Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") }, { body: Array.from({ length: 40 }, (_, i) => i % 2 ? `w${i}` : `z${i}`).join(" ") });
  assert.ok(many.removed.length <= 12 && many.added.length <= 12);
});

test("senders: scrub removes a value and its encoded forms", () => {
  const v = "fixture+secret/value=1";
  const text = [v, Buffer.from(v).toString("base64"), Buffer.from(v).toString("base64url"), encodeURIComponent(v)].join(" | ");
  const out = scrub(text, [v]);
  assert.ok(!out.includes(v) && !out.includes(Buffer.from(v).toString("base64")) && !out.includes(encodeURIComponent(v)));
  assert.equal(out.split("<concealed by vyre>").length, 5);
});

test("senders: gmail refuses header injection and encodes a non-ASCII subject", async () => {
  const { TYPES } = await import("./senders.js");
  assert.throws(() => TYPES.gmail.check(["dana@harlowlegal.com"], { subject: "Hi\r\nBcc: x@example.com", body: "b" }, { type: "gmail" }), /line break/);
  assert.throws(() => TYPES.gmail.check(["not an address"], { subject: "s", body: "b" }, { type: "gmail" }), /email addresses/);
  const m = rfc822({ from: "alex@example.com", to: ["dana@harlowlegal.com"], subject: "Café", body: "Hi" });
  assert.match(m, /Subject: =\?UTF-8\?B\?/);
  assert.match(m, /\r\n\r\nSGk=$/);
});

test("senders: http origins match exactly and placeholders stay out of the url", async () => {
  const { TYPES } = await import("./senders.js");
  const s = { type: "http", vault: "billing-key", hosts: ["https://api.example.com"] };
  assert.equal(allowedOrigin("https://api.example.com/v1/charges", s.hosts), true);
  assert.equal(allowedOrigin("https://api.example.com.evil.test/", s.hosts), false);
  assert.equal(allowedOrigin("http://api.example.com/", s.hosts), false);
  assert.throws(() => TYPES.http.check([], { url: "https://api.example.com/?k={{vault}}" }, s), /cannot go in the url/);
  assert.throws(() => TYPES.http.check([], { url: "https://other.example.com/" }, s), /not one of this sender's hosts/);
});

test("senders: http adds the credential, never follows a redirect, and scrubs an echo", async t => {
  const { TYPES } = await import("./senders.js");
  const value = fake("key");
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", d => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (req.url === "/moved") { res.writeHead(302, { location: "https://elsewhere.example.com/" }); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ echoed: req.headers.authorization }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${/** @type {any} */ (server.address()).port}`;
  const s = { type: "http", vault: "billing-key", hosts: [origin] };
  const deps = { fetchCredential: async () => value, relay: async () => ({}) };
  const out = await TYPES.http.send([], { method: "POST", url: origin + "/charge", headers: { authorization: "Bearer {{vault}}" }, body: '{"amount":1200}' }, s, deps);
  assert.equal(seen[0].auth, `Bearer ${value}`);
  assert.equal(out.status, 200);
  assert.ok(!out.body.includes(value));
  await assert.rejects(TYPES.http.send([], { url: origin + "/moved", headers: { authorization: "Bearer {{vault}}" } }, s, deps), /answered 302/);
  assert.equal(seen.length, 2, "a redirect was followed");
});

test("senders: a pass-based sender goes through the relay with placeholders untouched", async () => {
  const { TYPES } = await import("./senders.js");
  const calls = [];
  const s = { type: "http", pass: { owner: "sam", item: "partner-api" }, hosts: ["https://api.partner.example"] };
  const deps = { fetchCredential: async () => { throw new Error("must not fetch"); }, relay: async input => { calls.push(input); return { status: 201, body: "{}" }; } };
  await TYPES.http.send([], { method: "POST", url: "https://api.partner.example/v1/orders", headers: { "x-api-key": "{{vault}}" }, body: "{}" }, s, deps);
  assert.deepEqual(calls[0], { item: "partner-api", owner: "sam", request: { method: "POST", url: "https://api.partner.example/v1/orders", headers: { "x-api-key": "{{vault}}" }, body: "{}" } });
});
