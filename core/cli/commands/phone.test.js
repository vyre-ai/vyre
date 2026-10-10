// @ts-check
// `vyre phone` against a real vyred in a temp home: a pairing offer from the real relay module (a Node relay on 127.0.0.1, the person's yes typed by a fake
// terminal through the real presence verifier), a fake push service on 127.0.0.1, and a phone played by the test (push.subscribe and
// presence.enroll as the Deck would send them). adb is a fake binary. No network, no dialogs.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { Presence } from "../../presence/index.js";
import { callAsPerson } from "../presence.js";
import { createRelay } from "../../../relay/node/server.js";
import { setJson, setView } from "../kit.js";
import { strip } from "../style.js";
import { tempHome } from "../../../test/helpers.js";
import phone, { add, android, listPhones, remove, testPush, evaluate, adbDevices, appManifest } from "./phone.js";

const BOX = "https://vyre.tail0000.ts.net";
/** A box that serves no Android app: nothing leaves 127.0.0.1. */
const noApp = /** @type {any} */ (async () => ({ ok: false, status: 404, json: async () => ({}) }));

/** A push service that answers 201 and records what it was sent (paths in `got`, bodies in `bodies`). */
async function fakeService(t) {
  const got = [], bodies = new Map();
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on("data", c => parts.push(c));
    req.on("end", () => { got.push(req.url); bodies.set(req.url, Buffer.concat(parts)); res.writeHead(201); res.end(); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }));
  return { got, bodies, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

/** A box vyred with the real verifier: no Touch ID, codes written to `screen`. */
async function box(t, { relay: withRelay = true } = {}) {
  const root = tempHome(t);
  const svc = await fakeService(t);
  const relay = createRelay();
  const relayUrl = await relay.listen();
  t.after(() => relay.close());
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn", ...(withRelay ? [] : ["relay"])] }, relay: { enabled: withRelay, url: relayUrl }, push: { hosts: ["127.0.0.1"], allow_http: true }, network: { address: BOX } }));
  const screen = [];
  const d = await start({ root, log: () => {}, person: async () => null, presence: deps => new Presence({ ...deps,
    touchid: { available: async () => false, authenticate: async () => ({ ok: false, reason: "unavailable" }) },
    who: async () => ["ttys007"], statTty: () => ({ uid: process.getuid?.() ?? 0, isCharacterDevice: () => true }),
    writeTty: (file, text) => screen.push({ file, text }) }) });
  t.after(() => d.stop());
  /** The person at the terminal: reads the code vyred wrote there and types it back. */
  const io = { openTty: () => 99, ttyName: () => "/dev/ttys007", print() {}, close() {},
    prompt: async () => /type this code[^:]*: ([A-Z0-9]+)/i.exec(screen.at(-1)?.text || "")?.[1] || "" };
  return { root, svc, io, d };
}

/** Everything the command prints, without colour. */
function capture(t) {
  const lines = [];
  t.mock.method(console, "log", (...a) => { lines.push(strip(a.join(" "))); });
  const write = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk, ...rest) => {
    if (String(chunk).startsWith("{")) { lines.push(String(chunk).trim()); return true; }
    return write(chunk, ...rest);
  });
  return lines;
}

const until = async (fn, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await new Promise(r => setTimeout(r, 25)); }
};

/**
 * Emit until it shows: the command opens its stream a moment after the line the test waits on, and
 * an event before that is not replayed (since=latest). Emitting again is harmless.
 */
const keep = async (emit, fn, what) => {
  const end = Date.now() + 8000;
  for (;;) { emit(); const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out: " + what); await new Promise(r => setTimeout(r, 200)); }
};

/** A browser's push subscription: a real P-256 key, so push.test can encrypt to it and the phone can read it. */
const phones = new Map();
const subscription = endpoint => {
  const e = crypto.createECDH("prime256v1");
  e.generateKeys();
  const auth = crypto.randomBytes(16);
  phones.set(new URL(endpoint).pathname, { e, auth });
  return { endpoint, keys: { p256dh: e.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
};

/** What a phone reads from an aes128gcm push body (RFC 8291, RFC 8188): the notification's JSON. */
function read(pathname, body) {
  const { e, auth } = /** @type {any} */ (phones.get(pathname));
  const salt = body.subarray(0, 16), idlen = body[20];
  const as = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const hkdf = (salt, ikm, info, n) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, n));
  const ikm = hkdf(auth, e.computeSecret(as), Buffer.concat([Buffer.from("WebPush: info\0"), e.getPublicKey(), as]), 32);
  const d = crypto.createDecipheriv("aes-128-gcm", hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12));
  d.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
  return JSON.parse(plain.subarray(0, -1).toString());
}

/** The phone shows the test notification and posts its receipt back, as the Deck's service worker does. */
async function shows(svc, root, pathname) {
  const msg = read(pathname, svc.bodies.get(pathname));
  assert.equal(typeof msg.receipt, "string", "push.test asked for a receipt");
  const r = await call("push.receipt", { receipt: msg.receipt }, { root, caller: "deck" });
  assert.ok(r.data, JSON.stringify(r));
}

test("phone add: steps, a code from the verifier, then the checks pass as the phone subscribes and enrolls; list, test and remove", async t => {
  const { root, svc, io } = await box(t);
  const deck = (tool, input = {}, headers = {}) => call(tool, input, { root, caller: "deck", headers });
  // A laptop already getting notifications is not the new phone.
  const laptop = (await deck("push.subscribe", { subscription: subscription(`${svc.base}/push/laptop`), label: "Northwind laptop" })).data.device;
  const lines = capture(t);
  const input = new PassThrough();
  // life: a failed assertion still ends the watch, so the file never hangs.
  const run = add({}, { io, input, tty: false, life: 20_000, fetch: noApp });

  await until(() => lines.some(l => /https:\/\/vyre\.run\/pair#/.test(l)), "the pairing offer");
  const text = lines.join("\n");
  assert.match(text, /Pairing a phone with the box \(vyre\.tail0000\.ts\.net\)/);
  assert.match(text, /Pair\s+scan with the phone's camera, or paste the long code/);
  assert.ok(!/tailscale|tailnet/i.test(text.replace("vyre.tail0000.ts.net", "")), "no step names another product");
  if (/Confirmed · the QR works once/.test(text)) assert.match(text, /This device can't sign in as you until you confirm it from Devices\./, "a pairing by the offer says it is not confirmed yet");
  assert.match(text, /iPhone: Safari: Share, then Add to Home Screen/);
  assert.match(text, /Android: Chrome/);
  assert.match(text, /· Phone reached the box/);
  assert.doesNotMatch(text, /✓/, "nothing passes before the phone does anything");

  // The phone turns on notifications; Enter makes the laptop look again, and the new device gets a test.
  const phoneDevice = (await deck("push.subscribe", { subscription: subscription(`${svc.base}/push/phone`), label: "alex's iPhone" })).data.device;
  input.write("\n");
  await until(() => svc.got.includes("/push/phone"), "the test notification");
  assert.ok(!svc.got.includes("/push/laptop"), "only the new phone is tested");
  await until(() => lines.some(l => /· Test notification arrived · sent, waiting for the phone/.test(l)), "sent, not yet shown");
  await shows(svc, root, "/push/phone");
  await until(() => lines.some(l => /✓ Test notification arrived/.test(l)), "the push check");
  assert.ok(lines.some(l => /✓ Phone reached the box/.test(l)));
  assert.ok(lines.some(l => /✓ Secure address works \(HTTPS\)/.test(l)));
  assert.ok(lines.some(l => /\? Opened as an app, not a browser tab/.test(l)), "the box cannot tell app from tab on this service");

  // The phone adds its passkey with a code the person's terminal gives: presence.enrolled on the stream ends the watch.
  const code = /** @type {any} */ ((await callAsPerson("presence.code", {}, { io })).data);
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = await deck("presence.enroll", { kind: "passkey", name: "alex's iPhone", public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    alg: -7, rp_id: "vyre.tail0000.ts.net", credential_id: crypto.randomBytes(16).toString("base64url") }, { "x-vyre-presence": `code code=${typeof code === "string" ? code : code.code}` });
  assert.ok(key.data, JSON.stringify(key));
  assert.equal(await run, 0);
  assert.ok(lines.some(l => /✓ Face ID key saved for approvals · alex's iPhone/.test(l)));
  assert.ok(lines.some(l => /alex's iPhone is ready · 4 of 5 checks passed/.test(l)), lines.join("\n"));

  // list, test and remove, as JSON.
  setJson(true);
  t.after(() => setJson(false));
  const at = lines.length;
  assert.equal(await listPhones(), 0);
  const listed = JSON.parse(lines[at]);
  assert.deepEqual(listed.devices.map(x => x.device).sort(), [laptop, phoneDevice].sort());
  assert.deepEqual(listed.passkeys.map(x => x.name), ["alex's iPhone"]);
  assert.ok(!lines[at].includes("/push/"), "never an endpoint");
  assert.equal(await testPush(phoneDevice), 0);
  assert.deepEqual(JSON.parse(lines[at + 1]), { sent: 1, failed: 0, dropped: 0 });
  assert.equal(await testPush("nope"), 1);
  assert.equal(JSON.parse(lines[at + 2]).error.message, "no notification device nope");
  assert.equal(await remove([phoneDevice, key.data.id], { io }), 0);
  assert.deepEqual(JSON.parse(lines[at + 3]), { removed: [{ id: phoneDevice, kind: "device" }, { id: key.data.id, kind: "passkey" }] });
  assert.equal(await remove(["gone"], { io }), 1);
  assert.equal(await listPhones(), 0);
  const after = JSON.parse(lines.at(-1));
  assert.deepEqual([after.devices.map(x => x.device), after.passkeys], [[laptop], []]);
});

test("phone add: the watch ends when the code runs out, naming what never arrived", async t => {
  const { io } = await box(t);
  const lines = capture(t);
  const code = await add({ iphone: true }, { io, input: null, tty: false, life: 400, fetch: noApp });
  assert.equal(code, 1);
  const text = lines.join("\n");
  assert.doesNotMatch(text, /Android:/, "--iphone shows the iPhone step only");
  assert.match(text, /the code ran out before: phone reached the box, secure address works \(https\), test notification arrived, face id key saved/i);
  assert.match(text, /next: vyre phone add again/);
});

test("phone add --json: the offer and the steps as one value, without watching", async t => {
  const { io } = await box(t);
  const lines = capture(t);
  setJson(true);
  t.after(() => setJson(false));
  assert.equal(await add({}, { io, fetch: noApp }), 0);
  const v = JSON.parse(lines.at(-1));
  assert.equal(v.box, BOX);
  assert.match(v.url, /^https:\/\/vyre\.run\/pair#/);
  assert.equal(v.code, null, "there is no typed code: the offer is the long code");
  assert.ok(v.expires > Date.now() + 4 * 60_000, "the offer lasts minutes");
  assert.equal(v.network, "relay");
  assert.ok(!("tailscale" in v));
  assert.deepEqual(v.checks.map(c => [c.id, c.state]), [["reached", "wait"], ["https", "wait"], ["app", "wait"], ["push", "wait"], ["passkey", "wait"]]);
});

test("phone add: a box with no relay says so and pairs nothing", async t => {
  const { io } = await box(t, { relay: false });
  const lines = capture(t);
  assert.equal(await add({}, { io, fetch: noApp }), 1);
  assert.match(lines.join("\n"), /no relay yet/);
});
test("phone add: without a person at a terminal the code is refused, exit 3", async t => {
  await box(t);
  capture(t);
  const noTty = { openTty: () => { throw new Error("no tty"); }, ttyName: () => "", prompt: async () => "", print() {} };
  assert.equal(await add({}, { io: noTty, input: null, tty: false, fetch: noApp }), 3);
});

test("phone: evaluate reads the five checks from what is new since the start", () => {
  const before = { devices: [{ device: "d-old", service: "fcm.googleapis.com" }], keys: [{ id: "k-old", kind: "passkey" }] };
  const ids = cs => Object.fromEntries(cs.map(c => [c.id, c.state]));
  assert.deepEqual(ids(evaluate(before, before, { address: BOX })), { reached: "wait", https: "wait", app: "wait", push: "wait", passkey: "wait" });
  const iphone = { devices: [...before.devices, { device: "d1", service: "web.push.apple.com" }], keys: before.keys };
  assert.deepEqual(ids(evaluate(before, iphone, { address: BOX, tested: { device: "d1", sent: 1, failed: 0 } })),
    { reached: "ok", https: "ok", app: "ok", push: "ok", passkey: "wait" }, "Apple sends web push to Home Screen apps only");
  const android = { devices: [...before.devices, { device: "d2", service: "fcm.googleapis.com" }], keys: [...before.keys, { id: "k1", kind: "passkey", name: "Pixel" }, { id: "c1", kind: "capsule" }] };
  const a = evaluate(before, android, { address: BOX, tested: { device: "d2", sent: 0, failed: 1 } });
  assert.deepEqual(ids(a), { reached: "ok", https: "ok", app: "unknown", push: "failed", passkey: "ok" });
  assert.match(String(a.find(c => c.id === "push")?.note), /vyre phone test d2/);
  assert.equal(ids(evaluate(before, before, { address: "http://127.0.0.1:7777" })).https, "failed");
});

test("phone: adb devices -l, by USB and by Wireless debugging", () => {
  const out = "List of devices attached\n1A2B3C4D       device usb:1-1 product:husky model:Pixel_8 device:husky transport_id:1\n"
    + "192.168.1.20:37105 device product:husky model:Pixel_8 device:husky transport_id:2\nZX1 unauthorized usb:1-2 transport_id:3\n\n";
  assert.deepEqual(adbDevices(out), [
    { serial: "1A2B3C4D", state: "device", model: "Pixel 8", wireless: false },
    { serial: "192.168.1.20:37105", state: "device", model: "Pixel 8", wireless: true },
    { serial: "ZX1", state: "unauthorized", model: null, wireless: false },
  ]);
});

test("phone: usage mistakes exit 2 before asking vyred", async t => {
  const lines = capture(t);
  for (const args of [["add", "--usb"], ["add", "--android", "--usb", "--wireless"], ["add", "--iphone", "--android"], ["frob"], ["remove"], ["add", "extra"]]) {
    assert.equal(await phone.run(args), 2, `vyre phone ${args.join(" ")}`);
  }
  assert.ok(lines.some(l => /next: /.test(l)));
  await assert.rejects(phone.run(["add", "--bogus"]), /--bogus is not a flag of vyre phone/);
});

test("phone: a device new on the relay counts as reached, and says it came through the relay", () => {
  const before = { devices: [], keys: [], relay: [{ id: "d_old", path: null }] };
  const now = { devices: [], keys: [], relay: [{ id: "d_old", path: null }, { id: "d_new", kind: "web", path: "relay", online: true }] };
  const reached = evaluate(before, now, { address: "https://vyre.tail0000.ts.net" }).find(c => c.id === "reached");
  assert.equal(reached?.state, "ok");
  assert.equal(reached?.note, "via relay");
  const timed = { ...now, relay: [now.relay[0], { ...now.relay[1], rtt: 80.4, presence: true, name: "alex's iPhone" }] };
  const checks = evaluate(before, timed, { address: "https://vyre.tail0000.ts.net" });
  assert.equal(checks.find(c => c.id === "reached")?.note, "via relay 80 ms");
  assert.deepEqual([checks.find(c => c.id === "passkey")?.state, checks.find(c => c.id === "passkey")?.note], ["ok", "alex's iPhone"], "the relay device's own presence key");
  const direct = { ...now, relay: [now.relay[0], { ...now.relay[1], path: "direct", rtt: 18, node: "alexs-iphone" }] };
  assert.equal(evaluate(before, direct, {}).find(c => c.id === "reached")?.note, "direct 18 ms", "a phone the relay has linked to its tailnet node");
  assert.equal(evaluate(before, before, {}).find(c => c.id === "reached")?.state, "wait", "a device already there is not new");
});

test("phone: evaluate waits for the test's receipt, and an installed app said so on the stream", () => {
  const before = { devices: [], keys: [] };
  const now = { devices: [{ device: "d1", service: "fcm.googleapis.com" }], keys: [] };
  const push = o => evaluate(before, now, { address: BOX, ...o }).find(c => c.id === "push");
  const app = o => evaluate(before, now, { address: BOX, ...o }).find(c => c.id === "app");
  assert.deepEqual([push({})?.label, push({})?.state], ["Test notification arrived", "wait"], "before the test: arrived is what it waits for");
  const tested = { device: "d1", sent: 1, failed: 0, receipt: "r-1" };
  assert.deepEqual([push({ tested })?.label, push({ tested })?.state, push({ tested })?.note], ["Test notification arrived", "wait", "sent, waiting for the phone"]);
  assert.deepEqual([push({ tested, delivered: true })?.state, push({ tested, delivered: true })?.note], ["ok", "the phone showed it"]);
  assert.equal(push({ tested: { ...tested, sent: 0, failed: 1 } })?.state, "failed", "refused is refused, receipt or not");
  const old = { device: "d1", sent: 1, failed: 0, receipt: null };
  assert.deepEqual([push({ tested: old })?.label, push({ tested: old })?.state], ["Test notification sent", "ok"], "a vyred without receipts: the push service took it");
  assert.equal(app({})?.state, "unknown", "an Android phone, and no push.seen");
  assert.deepEqual([app({ standalone: true })?.state, app({ standalone: true })?.note], ["ok", "Vyre said it runs installed"]);
  assert.equal(evaluate(before, before, { address: BOX, standalone: true }).find(c => c.id === "app")?.state, "ok", "push.seen alone is enough");
});

test("phone add: push.subscribed re-reads at once and push.seen from an installed app passes the app check, 5 of 5", async t => {
  const { root, svc, io, d } = await box(t);
  const deck = (tool, input = {}, headers = {}) => call(tool, input, { root, caller: "deck", headers });
  const lines = capture(t);
  // No Enter at all: only the events move the checks (and the 60 s re-read, too slow for this test).
  const run = add({ android: true }, { io, input: null, tty: false, life: 20_000, fetch: noApp });
  await until(() => lines.some(l => /https:\/\/vyre\.run\/pair#/.test(l)), "the pairing offer");
  const subscribe = async () => (await deck("push.subscribe", { subscription: subscription(`${svc.base}/push/pixel`), label: "alex's Pixel" })).data.device;
  const arrivals = () => svc.got.filter(p => p === "/push/pixel").length;
  const device = await subscribe();
  // push.subscribed from the push module moves the check, with no Enter. The command opens its event stream a moment after its code line and an event before that is not replayed, so a first
  // subscribe that lands early gets no test notification: subscribe again (harmless) until one comes.
  for (let tries = 0; !svc.got.includes("/push/pixel") && tries < 8; tries++) {
    try { await until(() => svc.got.includes("/push/pixel"), "the test notification, without Enter", 4_000); } catch { await subscribe(); }
  }
  await until(() => svc.got.includes("/push/pixel"), "the test notification, without Enter", 20_000);
  await shows(svc, root, "/push/pixel");
  // The command opens its event stream a moment after its code line, and an event before that is not
  // replayed, so on a slow runner the first subscribe can land before anyone listens: subscribe
  // again (harmless), and answer its new test notification, until the line says so.
  const arrived = () => lines.some(l => /✓ Test notification arrived/.test(l));
  for (let tries = 0; !arrived() && tries < 8; tries++) {
    try { await until(arrived, "the push check", 4_000); } catch {
      const before = arrivals();
      await subscribe();
      await until(() => arrivals() > before, "the next test notification", 10_000);
      await shows(svc, root, "/push/pixel");
    }
  }
  await until(arrived, "the push check", 20_000);
  assert.ok(lines.some(l => /\? Opened as an app/.test(l)));
  await keep(() => deck("push.seen", { surface: "now", standalone: true, device }), () => lines.some(l => /✓ Opened as an app, not a browser tab · Vyre said it runs installed/.test(l)), "the app check");
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  await deck("presence.enroll", { kind: "passkey", name: "alex's Pixel", public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    alg: -7, rp_id: "vyre.tail0000.ts.net", credential_id: crypto.randomBytes(16).toString("base64url") }, { "x-vyre-presence": `code code=${(c => typeof c === "string" ? c : c.code)(/** @type {any} */ ((await callAsPerson("presence.code", {}, { io })).data))}` });
  assert.equal(await run, 0);
  assert.ok(lines.some(l => /alex's Pixel is ready · 5 of 5 checks passed/.test(l)), lines.join("\n"));
});

// ------------------------------------------------------------ Android over adb

const APK = Buffer.from("PK\u0003\u0004 a pretend Vyre APK for the tests ".repeat(64));
const SHA = "abcdef1234567890";
const good = () => ({ version: "0.14.2", versionCode: 1402, sha: SHA, sha256: crypto.createHash("sha256").update(APK).digest("hex"), size: APK.length, minSdk: 26, built: "2026-09-27T00:00:00Z" });

/** The releases module's route on 127.0.0.1: the manifest (or a 404) and the APK by ?file=. */
async function appServer(t, manifest, { refuse = false } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (refuse && String(req.url).includes("?file=")) { res.writeHead(409, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { code: "release_mismatch" } })); }
    if (req.url === "/v1/releases/android" && manifest.value) { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); return res.end(JSON.stringify(manifest.value)); }
    if (req.url === `/v1/releases/android?file=vyre-0.14.2-${SHA.slice(0, 7)}.apk`) { res.writeHead(200, { "content-type": "application/vnd.android.package-archive" }); return res.end(APK); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }));
  return { hits, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

/**
 * A fake adb that logs each argv as a JSON line: one phone over USB (or what `devices` says), an
 * API level from `sdk`, an install that checks the file is there, and am start. Never a real adb.
 * `under`: a folder to keep it in, when the test already has a home (tempHome would move VYRE_HOME).
 */
function fakeAdb(t, { devices = "1A2B3C4D device usb:1-1 product:husky model:Pixel_8 transport_id:1", sdk = 34, under = "" } = {}) {
  const dir = under ? fs.mkdtempSync(path.join(under, "adb-")) : tempHome(t);
  const bin = path.join(dir, "adb.cjs"), log = path.join(dir, "adb.log"), tmp = path.join(dir, "tmp");
  fs.mkdirSync(tmp);
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require("fs"); const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const rest = a[0] === "-s" ? a.slice(2) : a;
if (rest[0] === "version") { console.log("Android Debug Bridge version 1.0.41"); process.exit(0); }
if (rest[0] === "devices") { process.stdout.write("List of devices attached\\n" + ${JSON.stringify(devices)} + "\\n\\n"); process.exit(0); }
if (rest[0] === "shell" && rest[1] === "getprop") { console.log(${JSON.stringify(String(sdk))}); process.exit(0); }
if (rest[0] === "install") { const f = rest[rest.length - 1]; if (!fs.existsSync(f)) { console.log("Failure [no file]"); process.exit(1); } console.log("Performing Streamed Install\\nSuccess"); process.exit(0); }
if (rest[0] === "shell" && rest[1] === "am") { console.log("Starting: Intent { act=android.intent.action.VIEW }"); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  const prev = { adb: process.env.VYRE_ADB_BIN, tmp: process.env.TMPDIR };
  process.env.VYRE_ADB_BIN = bin;
  // The download's temp folder lands here, so the test can see it is gone.
  process.env.TMPDIR = tmp;
  t.after(() => {
    if (prev.adb === undefined) delete process.env.VYRE_ADB_BIN; else process.env.VYRE_ADB_BIN = prev.adb;
    if (prev.tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prev.tmp;
  });
  const argv = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
  return { bin, argv, tmp, dir };
}

/** A box target without a vyred, for the paths that never reach the stream. */
const fakeTarget = (local = true) => async () => ({ local, address: BOX, tool: async () => ({ data: [] }) });

test("phone add --android --usb: downloads, checks, installs with adb -r, opens Vyre on the relay's offer, then Paired", async t => {
  const { d, root } = await box(t);
  const adb = fakeAdb(t, { under: root });
  const srv = await appServer(t, { value: good() });
  const lines = capture(t);
  const offer = "https://vyre.run/pair#off'er1";
  const run = android({}, { base: srv.base, pair: async () => ({ data: { url: offer, expiresAt: Date.now() + 60_000 } }), life: 15_000 });
  await until(() => adb.argv().some(a => a.includes("am")), "am start");
  let ended = false;
  run.then(() => { ended = true; });
  await keep(() => d.events.emit("relay", "device.paired", { id: "d_pixel", name: "alex's Pixel", kind: "android" }), () => ended, "Paired");
  assert.equal(await run, 0);
  const text = lines.join("\n");
  assert.match(text, /Found Pixel 8 over USB\n\s+Installing Vyre 0\.14\.2 \(adb, no store needed\)\n\s+Opened Vyre on the phone\n\s+● Paired · alex's Pixel/);
  const argv = adb.argv();
  const install = argv.find(a => a.includes("install"));
  assert.deepEqual(install?.slice(0, 4), ["-s", "1A2B3C4D", "install", "-r"]);
  assert.match(String(install?.[4]), /vyre-0\.14\.2-abcdef1\.apk$/);
  assert.ok(!fs.existsSync(String(install?.[4])), "the temp file is gone");
  assert.deepEqual(fs.readdirSync(adb.tmp), [], "and its folder");
  assert.deepEqual(argv.find(a => a.includes("am")), ["-s", "1A2B3C4D", "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d",
    `'vyre://pair?offer=${encodeURIComponent(offer).replace(/'/g, "%27")}'`, "sh.vyre.app"]);
  assert.ok(argv.some(a => a.join(" ") === "-s 1A2B3C4D shell getprop ro.build.version.sdk"), "the API level was checked");
});

test("phone add --android --usb: without the relay it installs and says how to pair, no am start; --json is one object", async t => {
  const adb = fakeAdb(t);
  const srv = await appServer(t, { value: good() });
  const lines = capture(t);
  const deps = { base: srv.base, target: fakeTarget(), pair: async () => ({ error: { code: "no_such_tool", message: "no such tool" } }) };
  assert.equal(await android({}, deps), 0);
  assert.match(lines.join("\n"), /Installing Vyre 0\.14\.2[\s\S]*Open Vyre on the phone and scan the pairing QR: vyre phone add on the box/);
  assert.ok(adb.argv().some(a => a.includes("install")));
  assert.ok(!adb.argv().some(a => a.includes("am")), "no offer, nothing to open");
  setJson(true);
  t.after(() => setJson(false));
  assert.equal(await android({}, { ...deps, target: fakeTarget(false) }), 0, "a Mac: installs, skips the handover");
  const v = JSON.parse(lines.at(-1));
  assert.deepEqual([v.installed, v.opened, v.version, v.phone.model, v.phone.via], [true, false, "0.14.2", "Pixel 8", "usb"]);
  assert.match(v.pair, /scan the pairing QR/);
});

test("phone add --android --usb: a sha256 or size that does not match is refused, the file deleted, nothing installed", async t => {
  const adb = fakeAdb(t);
  const manifest = { value: { ...good(), sha256: "0".repeat(64) } };
  const srv = await appServer(t, manifest);
  const lines = capture(t);
  assert.equal(await android({}, { base: srv.base, target: fakeTarget() }), 1);
  assert.match(lines.join("\n"), /the APK's sha256 is not what the box says: the download was not what the box says it built; nothing was installed/);
  assert.ok(srv.hits.some(h => h.endsWith(".apk")), "it did download");
  assert.deepEqual(fs.readdirSync(adb.tmp), [], "and deleted it");
  manifest.value = { ...good(), size: APK.length + 1 };
  lines.length = 0;
  assert.equal(await android({}, { base: srv.base, target: fakeTarget() }), 1);
  assert.match(lines.join("\n"), /the APK's size is not what the box says/);
  manifest.value = { ...good(), size: APK.length - 1 };
  lines.length = 0;
  assert.equal(await android({}, { base: srv.base, target: fakeTarget() }), 1);
  assert.match(lines.join("\n"), /the APK's size is not what the box says/, "a bigger file stops at the promised size");
  assert.deepEqual(fs.readdirSync(adb.tmp), []);
  assert.ok(!adb.argv().some(a => a.includes("install")), "never installed");
  // The box refuses its own copy (409 release_mismatch): said plainly, nothing installed.
  const refusing = await appServer(t, { value: good() }, { refuse: true });
  lines.length = 0;
  assert.equal(await android({}, { base: refusing.base, target: fakeTarget() }), 1);
  assert.match(lines.join("\n"), /the box's copy of the app does not match what CI built/);
  assert.deepEqual(fs.readdirSync(adb.tmp), []);
  assert.ok(!adb.argv().some(a => a.includes("install")), "never installed");
});

test("phone add --android: no manifest is no_apk, a phone too old is refused, adb missing is one hint; never a real adb", async t => {
  const adb = fakeAdb(t, { sdk: 23 });
  const manifest = { value: null };
  const srv = await appServer(t, manifest);
  const lines = capture(t);
  assert.equal(await android({}, { base: srv.base, target: fakeTarget() }), 1);
  assert.match(lines.join("\n"), /Found Pixel 8 over USB[\s\S]*the box has no Android app to serve yet[\s\S]*next: vyre phone add for the web app/);

  manifest.value = good();
  lines.length = 0;
  assert.equal(await android({}, { base: srv.base, target: fakeTarget() }), 1);
  assert.match(lines.join("\n"), /Pixel 8 runs Android API level 23, and Vyre 0\.14\.2 needs 26 or newer/);
  assert.ok(!srv.hits.some(h => h.endsWith(".apk")), "too old: not even downloaded");
  assert.ok(!adb.argv().some(a => a.includes("install")));

  lines.length = 0;
  assert.equal(await android({ wireless: true }, { base: srv.base, target: fakeTarget() }), 1);
  assert.match(lines.join("\n"), /no phone over Wireless debugging[\s\S]*Pair device with pairing code/, "the USB phone is not a wireless one");

  setJson(true);
  t.after(() => setJson(false));
  manifest.value = null;
  lines.length = 0;
  assert.equal(await android({}, { base: srv.base, target: fakeTarget() }), 1);
  assert.equal(JSON.parse(lines.at(-1)).error.code, "no_apk");
  setJson(false);

  process.env.VYRE_ADB_BIN = path.join(adb.dir, "no-adb");
  lines.length = 0;
  assert.equal(await android({}, { base: srv.base, target: fakeTarget() }), 1);
  const text = lines.join("\n");
  assert.match(text, /adb is not installed[\s\S]*next: install Android platform-tools \(brew install android-platform-tools\)/);
  assert.equal(text.split("next:").length - 1, 1, "one hint");
});

test("phone add --android: a phone that has not allowed this computer is told to tap Allow", async t => {
  fakeAdb(t, { devices: "ZX1 unauthorized usb:1-2 transport_id:3" });
  const lines = capture(t);
  assert.equal(await android({}, { target: fakeTarget() }), 1);
  assert.match(lines.join("\n"), /has not allowed this computer[\s\S]*next: tap Allow on the phone/);
});

test("phone add --json: a box that serves the Android app adds its address; the manifest is checked whole", async t => {
  const { io } = await box(t);
  const srv = await appServer(t, { value: good() });
  const lines = capture(t);
  setJson(true);
  t.after(() => setJson(false));
  assert.equal(await add({ android: true }, { io, base: srv.base }), 0);
  const v = JSON.parse(lines.at(-1));
  assert.deepEqual(v.app, { version: "0.14.2", url: `${BOX}/v1/releases/android?file=vyre-0.14.2-abcdef1.apk` });
  assert.deepEqual(await appManifest(srv.base), { manifest: good() });
  const bad = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ version: "1", sha256: "x", size: 1, sha: "abcdef1" }) }));
  assert.deepEqual(await appManifest(srv.base, bad), { missing: true }, "a sha256 that is not one");
  const odd = /** @type {any} */ (async () => ({ ok: true, json: async () => ({ ...good(), file: "../../etc/x.apk" }) }));
  assert.deepEqual(await appManifest(srv.base, odd), { missing: true }, "a file name with a path in it");
  assert.equal((await appManifest(srv.base, /** @type {any} */ (async () => { throw new Error("offline"); }))).error, "offline");
});

test("phone: vyre commands lists every verb run() handles, with aliases and flags", async () => {
  const { listing } = await import("./commands.js");
  const verbs = (await listing({ only: "phone" })).commands[0].verbs;
  assert.deepEqual(verbs.map(v => [v.verb, v.aliases || []]), [["add", ["pair"]], ["list", ["ls"]], ["remove", ["rm"]], ["test", []]]);
  const addVerb = verbs.find(v => v.verb === "add");
  assert.deepEqual(addVerb.flags.map(f => f.name), ["iphone", "android", "usb", "wireless", "relay"], "every flag run() parses");
  assert.deepEqual([addVerb.live, addVerb.person], [true, true]);
  assert.deepEqual(verbs.find(v => v.verb === "remove").args, [{ name: "id", required: true, repeat: true }]);
  assert.equal(verbs.find(v => v.verb === "list").read, true);
});

test("phone add --view: a qr frame with the --json data, then a checks frame per change until the phone is ready; stdin is never read", async t => {
  const { root, svc, io } = await box(t);
  const deck = (tool, input = {}, headers = {}) => call(tool, input, { root, caller: "deck", headers });
  const lines = capture(t);
  setView("phone add");
  t.after(() => setView(null));
  const stdin = t.mock.method(process.stdin, "on");
  // No input and no tty given: under --view the command decides those itself.
  const run = add({}, { io, life: 20_000, fetch: noApp });
  const frames = () => lines.filter(l => l.startsWith('{"v":1')).map(l => JSON.parse(l));
  const first = await until(() => frames()[0], "the qr frame", 20_000);
  assert.equal(first.cmd, "phone add");
  assert.equal(first.view.kind, "qr");
  assert.match(first.view.text, /^https:\/\/vyre\.run\/pair#/);
  assert.equal(first.view.text, first.data.url);
  assert.match(first.view.caption, /Scan this with the phone's camera, or paste the long code/);
  assert.deepEqual(Object.keys(first.data), ["box", "phone", "network", "url", "code", "expires", "install", "checks"], "the same value --json prints");
  const waiting = await until(() => frames().find(f => f.view.kind === "checks"), "the first checks frame", 20_000);
  assert.deepEqual(waiting.view.items.map(c => [c.id, c.state]), [["reached", "wait"], ["https", "wait"], ["app", "wait"], ["push", "wait"], ["passkey", "wait"]]);
  assert.equal(waiting.data, null);

  // The phone subscribes: push.subscribed makes it look at once, and a new frame says it reached the box.
  // The command opens its event stream a moment after its first frames, and an event before that is
  // not replayed, so on a slow runner one subscribe can land before anyone listens: subscribe again
  // (harmless) until the frame says so, and wait on the condition, not on a fixed time.
  const sub = () => deck("push.subscribe", { subscription: subscription(`${svc.base}/push/view-phone`), label: "kit's Android" });
  await sub();
  await until(() => svc.got.includes("/push/view-phone"), "the test notification", 20_000);
  let resent = 0;
  await until(async () => { if (frames().some(f => f.view.kind === "checks" && f.view.items[0].state === "ok")) return true; if (++resent % 20 === 0) await sub(); return false; }, "reached, in a frame", 30_000);
  await shows(svc, root, "/push/view-phone");
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = await deck("presence.enroll", { kind: "passkey", name: "kit's Android", public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    alg: -7, rp_id: "vyre.tail0000.ts.net", credential_id: crypto.randomBytes(16).toString("base64url") }, { "x-vyre-presence": `code code=${(c => typeof c === "string" ? c : c.code)(/** @type {any} */ ((await callAsPerson("presence.code", {}, { io })).data))}` });
  assert.ok(key.data, JSON.stringify(key));
  assert.equal(await run, 0);
  const checks = frames().filter(f => f.view.kind === "checks");
  const seen = checks.map(f => JSON.stringify(f.view.items));
  assert.equal(new Set(seen).size, seen.length, "a frame only when something changed");
  assert.deepEqual(checks.at(-1).view.items.map(c => [c.id, c.state]), [["reached", "ok"], ["https", "ok"], ["app", "unknown"], ["push", "ok"], ["passkey", "ok"]]);
  assert.equal(stdin.mock.calls.filter(c => c.arguments[0] === "data").length, 0, "nothing listened on stdin");
});
