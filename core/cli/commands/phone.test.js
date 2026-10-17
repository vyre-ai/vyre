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
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { Presence } from "../../presence/index.js";
import { callAsPerson } from "../presence.js";
import { createRelay } from "../../../relay/node/server.js";
import { setJson } from "../kit.js";
import { strip } from "../style.js";
import { tempHome } from "../../../test/helpers.js";
import phone, { android, listPhones, remove, testPush, adbDevices, appManifest } from "./phone.js";

const BOX = "https://vyre.tail0000.wink.example";
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

const until = async (fn, what, ms = 20_000) => {   // (a command starting beside a dozen others on a loaded runner takes seconds to print its first line)
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

/**
 * Wait for something the push module does on a subscribe: the command opens its event stream a moment after the lines the test waits on, and push.subscribed before that is not replayed (since=latest), so on a
 * loaded runner the first subscribe can land before anyone listens. A person cannot subscribe in that gap, and the command re-reads every 60 s anyway; the test subscribes again (harmless) until it shows.
 */
const resubscribe = async (sub, fn, what) => {
  for (let i = 0; i < 8; i++) { try { return await until(fn, what, 4000); } catch { await sub(); } }
  return until(fn, what, 10_000);
};

/** A browser's push subscription: a real P-256 key, so push.test can encrypt to it and the phone can read it. */
const phones = new Map();
const subscription = endpoint => {
  // one phone has one key: subscribing again (a retry, or the same browser again) keeps it, so a notification sent before the second subscribe still reads
  const have = phones.get(new URL(endpoint).pathname);
  const e = have ? have.e : crypto.createECDH("prime256v1");
  if (!have) e.generateKeys();
  const auth = have ? have.auth : crypto.randomBytes(16);
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

test("phone list, test and remove: a notification device and a passkey, as JSON", async t => {
  const { root, svc, io } = await box(t);
  const deck = (tool, input = {}, headers = {}) => call(tool, input, { root, caller: "deck", headers });
  const lines = capture(t);
  const laptop = (await deck("push.subscribe", { subscription: subscription(`${svc.base}/push/laptop`), label: "Northwind laptop" })).data.device;
  const phoneDevice = (await deck("push.subscribe", { subscription: subscription(`${svc.base}/push/phone`), label: "alex's iPhone" })).data.device;
  // The phone adds its passkey with a code the person's terminal gives.
  const code = /** @type {any} */ ((await callAsPerson("presence.code", {}, { io })).data);
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = await deck("presence.enroll", { kind: "passkey", name: "alex's iPhone", public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    alg: -7, rp_id: "vyre.tail0000.wink.example", credential_id: crypto.randomBytes(16).toString("base64url") }, { "x-vyre-presence": `code code=${typeof code === "string" ? code : code.code}` });
  assert.ok(key.data, JSON.stringify(key));

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

test("phone add --android --usb: downloads, checks, installs with adb -r, then says to sign in on the phone; nothing is opened or paired", async t => {
  const { root } = await box(t);
  const adb = fakeAdb(t, { under: root });
  const srv = await appServer(t, { value: good() });
  const lines = capture(t);
  assert.equal(await android({}, { base: srv.base }), 0);
  const text = lines.join("\n");
  assert.match(text, /Found Pixel 8 over USB\n\s+Installing Vyre 0\.14\.2 \(adb, no store needed\)\n\s+Open Vyre on the phone and sign in with your name; approve it from a device you already use: Devices, Add a device/);
  const argv = adb.argv();
  const install = argv.find(a => a.includes("install"));
  assert.deepEqual(install?.slice(0, 4), ["-s", "1A2B3C4D", "install", "-r"]);
  assert.match(String(install?.[4]), /vyre-0\.14\.2-abcdef1\.apk$/);
  assert.ok(!fs.existsSync(String(install?.[4])), "the temp file is gone");
  assert.deepEqual(fs.readdirSync(adb.tmp), [], "and its folder");
  assert.ok(!argv.some(a => a.includes("am")), "no pairing offer, so nothing is opened on the phone");
  assert.ok(argv.some(a => a.join(" ") === "-s 1A2B3C4D shell getprop ro.build.version.sdk"), "the API level was checked");
});

test("phone add --android --usb: --json is one object that says to sign in", async t => {
  const adb = fakeAdb(t);
  const srv = await appServer(t, { value: good() });
  const lines = capture(t);
  const deps = { base: srv.base, target: fakeTarget() };
  setJson(true);
  t.after(() => setJson(false));
  assert.equal(await android({}, { ...deps, target: fakeTarget(false) }), 0, "a Mac: installs");
  const v = JSON.parse(lines.at(-1));
  assert.deepEqual([v.installed, v.version, v.phone.model, v.phone.via], [true, "0.14.2", "Pixel 8", "usb"]);
  assert.match(v.pair, /sign in with your name/);
  assert.ok(adb.argv().some(a => a.includes("install")));
  assert.ok(!adb.argv().some(a => a.includes("am")), "nothing is opened on the phone");
});

test("phone add (no --android): refuses with words and names Devices, Add a device", async t => {
  const lines = capture(t);
  assert.equal(await phone.run(["add"]), 1);
  const text = lines.join("\n");
  assert.match(text, /not added from here any more/);
  assert.match(text, /Devices, Add a device/);
  lines.length = 0;
  assert.equal(await phone.run(["pair"]), 1, "the old verb name refuses the same way");
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

test("phone: the app manifest is checked whole", async t => {
  const srv = await appServer(t, { value: good() });
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
  assert.deepEqual(addVerb.flags.map(f => f.name), ["android", "usb", "wireless"], "the flags the verb lists");
  assert.equal(addVerb.read, false);
  assert.deepEqual(verbs.find(v => v.verb === "remove").args, [{ name: "id", required: true, repeat: true }]);
  assert.equal(verbs.find(v => v.verb === "list").read, true);
});

