// @ts-check
// The IMAP client (imap.js) against a fake server. What these prove: XOAUTH2 login and a
// headers-only fetch (BODY.PEEK of the five fields, never a body); old mail is not announced,
// new mail is, with encoded headers decoded; IDLE is ended and re-issued at the interval; a server
// without IDLE gets NOOP; a drop reconnects with backoff, asks for a fresh token each time and
// fetches what arrived meanwhile; a refused login ends the watch and is not retried; and no error
// or state carries the token.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { watch, parseHeaders, decodeWords, xoauth2, Reader } from "./imap.js";
import { startFakeImap } from "./testing/fake-imap.js";

const dial = port => async () => net.connect(port, "127.0.0.1");
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error("timed out waiting"); };

function rig(t, fake, extra = {}) {
  const mail = [], states = [], tokens = [];
  let n = 0;
  const w = watch({
    connect: dial(fake.port),
    auth: async () => { tokens.push(++n); return { user: "alex@harlowlegal.com", token: `tok-${n}-secretvalue` }; },
    onMail: m => mail.push(...m),
    onState: (s, i) => states.push({ s, ...(i || {}) }),
    backoffMs: 5, maxBackoffMs: 40, noopFloorMs: 0,
    ...extra,
  });
  t.after(async () => { w.stop(); await w.done; });
  return { w, mail, states, tokens };
}

test("imap: XOAUTH2 login, old mail not announced, new mail announced from headers only", async t => {
  const fake = await startFakeImap(t, { token: "tok-1-secretvalue" });
  fake.deliver({ id: "old@mail.example" });
  const r = rig(t, fake);
  await until(() => fake.idlers() === 1);
  assert.deepEqual(r.mail, [], "mail that was already there is not announced");
  fake.deliver({ id: "a1@mail.example", from: "=?utf-8?B?Sm9zw6k=?= <jose@northwind.example>", subject: "Order for Friday" });
  await until(() => r.mail.length === 1);
  assert.equal(r.mail[0].messageId, "<a1@mail.example>");
  assert.equal(r.mail[0].from, "José <jose@northwind.example>");
  assert.equal(r.mail[0].subject, "Order for Friday");
  assert.ok(r.states.some(x => x.s === "idle"));
  const fetches = fake.commands.filter(c => c.startsWith("UID FETCH"));
  assert.ok(fetches.length >= 2);
  for (const f of fetches) assert.match(f, /BODY\.PEEK\[HEADER\.FIELDS \(FROM TO SUBJECT DATE MESSAGE-ID\)\]/);
  assert.ok(!fake.commands.some(c => /STORE|COPY|EXPUNGE|BODY\[\]|RFC822/i.test(c)), "nothing but header reads");
});

test("imap: IDLE is ended and re-issued at the interval", async t => {
  const fake = await startFakeImap(t, { token: "tok-1-secretvalue" });
  rig(t, fake, { idleMs: 120 });
  await until(() => fake.commands.filter(c => c === "IDLE").length >= 3, 4000);
  assert.ok(fake.commands.filter(c => c === "DONE").length >= 2);
  assert.equal(fake.state.connections, 1, "the same socket is kept across re-IDLE");
});

test("imap: a server without IDLE gets NOOP, never faster than the floor", async t => {
  const fake = await startFakeImap(t, { idle: false, token: "tok-1-secretvalue" });
  const r = rig(t, fake, { noopMs: 40 });
  await until(() => r.states.some(x => x.s === "polling"));
  fake.deliver({ id: "n1@mail.example" });
  await until(() => r.mail.length === 1);
  assert.ok(!fake.commands.includes("IDLE"));
  assert.ok(fake.commands.includes("NOOP"));
});

test("imap: the NOOP floor is 60 s unless a test lowers it", async t => {
  const fake = await startFakeImap(t, { idle: false, token: "tok-1-secretvalue" });
  const mail = [];
  const w = watch({ connect: dial(fake.port), auth: async () => ({ user: "alex@harlowlegal.com", token: "tok-1-secretvalue" }), onMail: m => mail.push(...m), noopMs: 10 });
  t.after(async () => { w.stop(); await w.done; });
  await until(() => fake.commands.includes("CAPABILITY"));
  await new Promise(r => setTimeout(r, 300));
  assert.ok(!fake.commands.includes("NOOP"), "asked for 10 ms, held to 60 s");
});

test("imap: a drop reconnects with backoff, a fresh token each time, and mail from the gap is fetched", async t => {
  let current = "tok-1-secretvalue";
  const fake = await startFakeImap(t, { token: () => current });
  const waits = [];
  const r = rig(t, fake, { sleep: async ms => { waits.push(ms); current = `tok-${r.tokens.length + 1}-secretvalue`; await new Promise(x => setTimeout(x, 5)); } });
  await until(() => fake.idlers() === 1);
  fake.dropAll();
  await until(() => waits.length >= 1);
  fake.deliver({ id: "gap@mail.example" });
  await until(() => r.mail.length === 1);
  assert.equal(r.mail[0].messageId, "<gap@mail.example>");
  assert.equal(r.tokens.length, 2, "auth() runs for every connection");
  assert.equal(waits[0], 5);
  assert.ok(r.states.some(x => x.s === "lost"));
});

test("imap: backoff doubles up to the cap while the server stays away, and a busy server waits the longest", async t => {
  const fake = await startFakeImap(t, { token: "tok-1-secretvalue", busy: true });
  const waits = [];
  rig(t, fake, { sleep: async ms => { waits.push(ms); await new Promise(x => setTimeout(x, 2)); } });
  await until(() => waits.length >= 3);
  assert.deepEqual(new Set(waits), new Set([40]), "too many connections waits at the cap, not in a tight loop");
});

test("imap: a refused login ends the watch with code auth, is not retried, and carries no token", async t => {
  const fake = await startFakeImap(t, { token: "some-other-token" });
  const r = rig(t, fake);
  const end = await r.w.done;
  assert.equal(end.code, "auth");
  assert.equal(fake.state.authAttempts, 1, "one try, not a loop");
  const failed = r.states.find(x => x.s === "failed");
  assert.ok(failed);
  const all = JSON.stringify([end, r.states]);
  assert.ok(!all.includes("secretvalue") && !all.includes(xoauth2("alex@harlowlegal.com", "tok-1-secretvalue")));
});

test("imap: an auth() that cannot mint a token for good ends the watch; one that could not reach the endpoint is retried", async t => {
  const fake = await startFakeImap(t, { token: "tok-2" });
  let n = 0;
  const w = watch({ connect: dial(fake.port), backoffMs: 2, maxBackoffMs: 4,
    auth: async () => { n++; if (n === 1) throw Object.assign(new Error("offline"), { code: "network" }); return { user: "alex@harlowlegal.com", token: "tok-2" }; },
    onMail: () => {} });
  t.after(async () => { w.stop(); await w.done; });
  await until(() => fake.idlers() === 1);
  assert.equal(n, 2);
  const g = watch({ auth: async () => { throw Object.assign(new Error("gone"), { code: "refused", oauthError: "invalid_grant" }); }, onMail: () => {} });
  assert.deepEqual((await g.done).code, "refused");
});

test("imap: header parsing unfolds, decodes and cuts; the reader handles literals split across chunks", () => {
  assert.deepEqual(parseHeaders("From: a@b.example\r\nSubject: one\r\n two\r\nMessage-ID: <x@y>\r\nX-Other: no\r\n"), { from: "a@b.example", subject: "one two", "message-id": "<x@y>" });
  assert.equal(decodeWords("=?utf-8?Q?caf=C3=A9_menu?="), "café menu");
  const got = [];
  const rd = new Reader(r => got.push(r));
  const wire = Buffer.from("* 1 FETCH (UID 5 BODY[HEADER.FIELDS (FROM)] {14}\r\nFrom: a@b.ex\r\n)\r\na1 OK done\r\n");
  for (let i = 0; i < wire.length; i += 7) rd.push(wire.subarray(i, i + 7));
  assert.equal(got.length, 2);
  assert.equal(got[0].literals[0].toString(), "From: a@b.ex\r\n");
  assert.match(got[1].line, /^a1 OK/);
});

test("imap: on a server that advertises X-GM-EXT-1 a message carries its Gmail API id (X-GM-MSGID in hex); on any other server it is never asked for", async t => {
  const gmail = await startFakeImap(t, { token: "tok-1-secretvalue", gmail: true });
  gmail.deliver({ id: "old@mail.example" });
  const r = rig(t, gmail);
  await until(() => gmail.idlers() === 1);
  gmail.deliver({ id: "g1@mail.example", subject: "Order" });
  await until(() => r.mail.length === 1);
  assert.equal(r.mail[0].gmailId, (1700000000000000000n + BigInt(r.mail[0].uid)).toString(16), "the API's id is the hex of the decimal X-GM-MSGID");
  assert.ok(gmail.commands.some(c => /X-GM-MSGID/.test(c)), "asked for it");

  const plain = await startFakeImap(t, { token: "tok-1-secretvalue" });
  plain.deliver({ id: "old2@mail.example" });
  const p = rig(t, plain);
  await until(() => plain.idlers() === 1);
  plain.deliver({ id: "p1@mail.example" });
  await until(() => p.mail.length === 1);
  assert.equal(p.mail[0].gmailId, undefined);
  assert.ok(!plain.commands.some(c => /X-GM-MSGID/.test(c)), "a server without the extension is never sent it");
});
