// @ts-check
// Web Push: the crypto checked against an independent reading of the RFCs (WebCrypto, as a
// browser would decrypt), and the module in a real vyred against a fake push service.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { vapidKeys, vapidAuth, encrypt } from "./webpush.js";
import { isQuiet } from "./index.js";

const subtle = crypto.webcrypto.subtle;
const u8 = b => new Uint8Array(b);

/** A browser's side of a subscription: a P-256 keypair and a 16-byte auth secret. */
async function browser() {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const raw = Buffer.from(await subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.randomBytes(16);
  return { pair, keys: { p256dh: raw.toString("base64url"), auth: auth.toString("base64url") }, raw, auth };
}

/** Decrypt an aes128gcm push body the way a browser does (RFC 8291 section 3.4, RFC 8188), with WebCrypto only. */
async function decrypt(b, body) {
  const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20];
  const as = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  const asKey = await subtle.importKey("raw", u8(as), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: asKey }, b.pair.privateKey, 256);
  const hkdf = async (salt, ikm, info, bits) => {
    const k = await subtle.importKey("raw", u8(ikm), "HKDF", false, ["deriveBits"]);
    return Buffer.from(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: u8(salt), info: u8(info) }, k, bits));
  };
  const ikm = await hkdf(b.auth, Buffer.from(shared), Buffer.concat([Buffer.from("WebPush: info\0"), b.raw, as]), 256);
  const cek = await hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 96);
  const key = await subtle.importKey("raw", u8(cek), "AES-GCM", false, ["decrypt"]);
  const plain = Buffer.from(await subtle.decrypt({ name: "AES-GCM", iv: u8(nonce) }, key, u8(ct)));
  assert.equal(plain.at(-1), 2, "a single, last record ends with the 0x02 delimiter");
  return plain.subarray(0, -1);
}

/** Check a VAPID Authorization header: the JWT's signature against k, its audience and expiry. */
function checkVapid(header, endpoint, publicKey) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, header);
  assert.equal(m[2], publicKey);
  const [h, c, s] = m[1].split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 86400, "expires within a day");
  assert.match(claims.sub, /^(mailto:|https:)/);
  const raw = Buffer.from(publicKey, "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")), "the JWT verifies with k");
}

test("webpush: a payload a browser decrypts with WebCrypto, and a VAPID header that verifies", async () => {
  const b = await browser();
  const msg = Buffer.from(JSON.stringify({ kind: "ask", title: "t", path: "/needs/a1" }));
  const body = encrypt(b.keys, msg);
  assert.deepEqual(await decrypt(b, body), msg);
  assert.notDeepEqual(encrypt(b.keys, msg), body, "a fresh salt and key each time");
  const k = vapidKeys();
  assert.equal(Buffer.from(k.public, "base64url").length, 65);
  checkVapid(vapidAuth({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", privateKey: k.private, publicKey: k.public, subject: "https://vyre.sh" }),
    "https://fcm.googleapis.com/fcm/send/abc", k.public);
  assert.throws(() => encrypt({ p256dh: "AAAA", auth: b.keys.auth }, msg), /not a P-256/);
});

test("webpush: RFC 8291 Appendix A, byte for byte", () => {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url"));
  const body = encrypt({ p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    Buffer.from("When I grow up, I want to be a watermelon"), { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), ecdh });
  assert.equal(body.toString("base64url"), "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_" +
    "yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("push: quiet hours, across midnight and in a time zone", () => {
  const at = iso => Date.parse(iso);
  const q = { start: "22:00", end: "07:00", timezone: "UTC" };
  assert.equal(isQuiet(q, at("2026-09-26T23:30:00Z")), true);
  assert.equal(isQuiet(q, at("2026-09-26T06:59:00Z")), true);
  assert.equal(isQuiet(q, at("2026-09-26T07:00:00Z")), false);
  assert.equal(isQuiet(q, at("2026-09-26T12:00:00Z")), false);
  assert.equal(isQuiet({ start: "09:00", end: "17:00", timezone: "Asia/Karachi" }, at("2026-09-26T05:00:00Z")), true, "10:00 in Karachi");
  assert.equal(isQuiet(null), false);
});

/** A push service that records what it is sent. Paths ending in /gone answer 410. */
async function fakeService(t) {
  const got = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      got.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(String(req.url).endsWith("/gone") ? 410 : 201);
      res.end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }));
  return { got, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

test("push: devices subscribe, the moments reach them as kind, title and path only, and gone ones are dropped", async t => {
  const root = tempHome(t);
  const svc = await fakeService(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, push: { hosts: ["127.0.0.1"], allow_http: true } }));
  const lines = [];
  const d = await start({ root, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  const deck = as("deck");
  const until = async (fn, what) => { const end = Date.now() + 5000; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await new Promise(r => setTimeout(r, 20)); } };

  const { public_key } = (await deck("push.key")).data;
  assert.equal(Buffer.from(public_key, "base64url").length, 65);
  assert.equal((await as("mcp")("push.key")).error.code, "denied", "Claude does not manage notifications");
  const item = (await as("cli")("vault.list")).data.items.find(x => x.name === "push-vapid");
  assert.deepEqual(item.grants, [{ module: "push" }], "the private key is in the Vault, granted to push alone");

  const phone = await browser(), old = await browser();
  const endpoint = `${svc.base}/push/phone`;
  const sub = (await deck("push.subscribe", { subscription: { endpoint, keys: phone.keys, expirationTime: null }, label: "Phone" })).data;
  assert.match(sub.device, /^[A-Za-z0-9_-]{12}$/);
  await deck("push.subscribe", { subscription: { endpoint: `${svc.base}/push/gone`, keys: old.keys } });
  assert.match((await deck("push.subscribe", { subscription: { endpoint: "https://evil.example/collect", keys: phone.keys } })).error.message, /not a push service/);
  assert.equal((await as("mcp")("push.subscribe", { subscription: { endpoint, keys: phone.keys } })).error.code, "denied");
  assert.deepEqual((await deck("push.devices")).data.map(x => [x.label, x.service]), [["Phone", "127.0.0.1"], [null, "127.0.0.1"]]);
  assert.ok(!JSON.stringify((await deck("push.devices")).data).includes("/push/"), "the endpoint is never shown");

  // An ask: the phone is told there is one, and where; nothing of what it asks.
  d.events.emit("threads", "ask.raised", { ask: "a7k2", tool: "Bash", summary: "rm -rf ./client-files", destination: "/work/harlow" }, { thread: "t-1" });
  const first = await until(() => svc.got.find(g => g.path === "/push/phone"), "the push");
  checkVapid(String(first.headers.authorization), endpoint, public_key);
  assert.equal(first.headers["content-encoding"], "aes128gcm");
  assert.equal(first.headers.urgency, "high");
  const msg = JSON.parse((await decrypt(phone, first.body)).toString());
  assert.deepEqual({ ...msg, at: 0 }, { kind: "ask", title: "A session is waiting for your answer", path: "/needs/a7k2", tag: "ask-a7k2", at: 0 });
  await until(() => svc.got.some(g => g.path === "/push/gone"), "the gone device's 410");
  await until(async () => (await deck("push.devices")).data.length === 1, "a 410 to drop the device");
  assert.deepEqual((await deck("push.devices")).data.map(x => x.label), ["Phone"]);

  // A held draft: no summary, no recipient, no words.
  d.events.emit("gate", "gate.held", { id: "g_91", kind: "send", via: "mail", to: "dana@harlowlegal.com", summary: "Re: Intake form rebuild" }, { thread: "t-1" });
  const second = await until(() => svc.got.filter(g => g.path === "/push/phone")[1], "the draft push");
  const draft = JSON.parse((await decrypt(phone, second.body)).toString());
  assert.equal(draft.path, "/needs/g_91");
  assert.ok(!/dana|Intake|mail/.test(JSON.stringify(draft)), JSON.stringify(draft));

  // A kind switched off, and quiet hours, each keep the phone still; push.test ignores quiet hours.
  const settings = (await deck("push.settings", { kinds: { lesson: false } })).data;
  assert.equal(settings.kinds.lesson, false);
  assert.equal(settings.kinds.ask, true);
  d.events.emit("learn", "lesson.proposed", { lesson: 4, rule: "never use em dashes", checked: true }, {});
  const now = new Date();
  const hhmm = ms => new Date(ms).toISOString().slice(11, 16);
  assert.equal((await deck("push.settings", { quiet: { start: hhmm(now.getTime() - 3600_000), end: hhmm(now.getTime() + 3600_000), timezone: "UTC" } })).data.quiet_now, true);
  d.events.emit("threads", "thread.watched", { watch: "w1", reason: "finished", summary: "echo: done" }, { thread: "t-1" });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(svc.got.filter(g => g.path === "/push/phone").length, 2, "nothing while quiet or switched off");
  assert.deepEqual((await deck("push.test", {})).data, { sent: 1, failed: 0, dropped: 0 });
  assert.equal(JSON.parse((await decrypt(phone, svc.got.at(-1).body)).toString()).kind, "test");
  assert.match((await deck("push.settings", { quiet: { start: "late", end: "7" } })).error.message, /HH:MM/);
  assert.match((await deck("push.settings", { kinds: { everything: true } })).error.message, /no such kind/);

  assert.deepEqual((await deck("push.unsubscribe", { device: sub.device })).data, { removed: true });
  assert.deepEqual((await deck("push.devices")).data, []);

  // The private key is nowhere but the Vault.
  const priv = String(await d.registry.call("vault.release", { name: "push-vapid" }, "module:push").then(r => r.data && (r.data.value || r.data)));
  const everything = JSON.stringify([d.events.since(0, { limit: 5000 }), lines, svc.got.map(g => [g.path, g.headers])]);
  assert.ok(priv.length > 40 && !everything.includes(priv), "the VAPID private key leaked");
});

test("push: a planner firing reaches the phone as kind planner with a fixed title, never the label; alarms ring through quiet hours", async t => {
  const root = tempHome(t);
  const svc = await fakeService(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, push: { hosts: ["127.0.0.1"], allow_http: true } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const deck = (tool, input = {}) => call(tool, input, { root, caller: "deck" });
  const until = async (fn, what) => { const end = Date.now() + 5000; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await new Promise(r => setTimeout(r, 20)); } };
  const phone = await browser();
  await deck("push.subscribe", { subscription: { endpoint: `${svc.base}/push/phone`, keys: phone.keys } });
  const fire = (firing, kind, title) => d.events.emit("planner", "planner.fired", { firing, item: "i_1", kind, title, due: Date.now(), ring: 1, missed: false, actions: ["done", "snooze"] }, {});

  fire("f_alarm", "alarm", "Pick up juno from Northwind Bakery");
  const got = await until(() => svc.got[0], "the alarm push");
  assert.equal(got.headers.urgency, "high");
  const msg = JSON.parse((await decrypt(phone, got.body)).toString());
  assert.deepEqual({ ...msg, at: 0 }, { kind: "planner", title: "Alarm", path: "/planner/f_alarm", tag: "planner-f_alarm", actions: ["done", "snooze"], at: 0 });
  assert.ok(!/juno|Northwind|loud/.test(JSON.stringify(msg)), "the label never crosses the push service");

  // Quiet now: a timer still rings; a reminder and a todo wait.
  const now = Date.now(), hhmm = ms => new Date(ms).toISOString().slice(11, 16);
  await deck("push.settings", { quiet: { start: hhmm(now - 3600_000), end: hhmm(now + 3600_000), timezone: "UTC" } });
  fire("f_rem", "reminder", "Call Harlow Legal");
  fire("f_todo", "todo", "File the return");
  fire("f_timer", "timer", "Pasta");
  await until(() => svc.got[1], "the timer push");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(svc.got.length, 2, "only the timer rang in quiet hours");
  const timer = JSON.parse((await decrypt(phone, svc.got[1].body)).toString());
  assert.equal(timer.title, "Timer finished");
  assert.equal(timer.tag, "planner-f_timer");
  // Out of quiet hours, each kind has its own fixed word.
  await deck("push.settings", { quiet: null });
  fire("f_ev", "event", "Harlow Legal intake call");
  fire("f_todo2", "todo", "Draft the proposal");
  fire("f_rem2", "reminder", "Call kit");
  await until(() => svc.got.length === 5, "three more");
  const titles = await Promise.all(svc.got.slice(2).map(async g => JSON.parse((await decrypt(phone, g.body)).toString()).title));
  assert.deepEqual(titles.sort(), ["Reminder", "Starting soon", "Todo due"]);

  // Done elsewhere closes the notification on every device: a push with the tag and nothing else.
  // A firing that was never pushed sends nothing.
  const ack = firing => d.events.emit("planner", "planner.acked", { firing, item: "i_1", action: "done", by: "deck" }, {});
  ack("f_unpushed");
  ack("f_alarm");
  await until(() => svc.got.length === 6, "the ack push");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(svc.got.length, 6, "only the pushed firing's ack went out");
  assert.deepEqual({ ...JSON.parse((await decrypt(phone, svc.got[5].body)).toString()), at: 0 }, { kind: "planner-ack", tag: "planner-f_alarm", at: 0 });
  assert.equal(svc.got[5].headers.urgency, "normal");
  ack("f_alarm");
  await new Promise(r => setTimeout(r, 200));
  assert.equal(svc.got.length, 6, "once per firing");

  // The lock-screen label is the user's choice, off until they turn it on.
  assert.equal((await deck("push.settings", {})).data.planner_label, false);
  assert.equal((await deck("push.settings", { planner_label: true })).data.planner_label, true);
  fire("f_lab", "reminder", "Call kit");
  await until(() => svc.got.length === 7, "the labelled push");
  const labelled = JSON.parse((await decrypt(phone, svc.got[6].body)).toString());
  assert.deepEqual([labelled.title, labelled.body], ["Reminder", "Call kit"]);
  assert.equal((await deck("push.settings", { kinds: { planner: false } })).data.kinds.planner, false);
});
