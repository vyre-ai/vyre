// @ts-check
// `vyre phone` against a real vyred in a temp home: the box's address, a code minted through the
// real presence verifier (the code it writes to the login terminal, typed back by a fake
// terminal), a fake push service on 127.0.0.1, and a phone played by the test (push.subscribe and
// presence.enroll as the Deck would send them). adb is a fake binary. No network, no dialogs.

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
import { setJson } from "../kit.js";
import { strip } from "../style.js";
import { tempHome } from "../../../test/helpers.js";
import phone, { add, android, listPhones, remove, testPush, evaluate, adbDevices } from "./phone.js";

const BOX = "https://vyre.tail0000.ts.net";

/** A push service that answers 201 and records what it was sent. */
async function fakeService(t) {
  const got = [];
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { got.push(req.url); res.writeHead(201); res.end(); }); });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { server.close(() => r(undefined)); server.closeAllConnections(); }));
  return { got, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

/** A box vyred with the real verifier: no Touch ID, codes written to `screen`. */
async function box(t) {
  const root = tempHome(t);
  const svc = await fakeService(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], vault: { keystore: "file" },
    modules: { enable: [], disable: ["recall", "memory", "learn"] }, push: { hosts: ["127.0.0.1"], allow_http: true }, network: { tailscale: false, address: BOX } }));
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

/** A browser's push subscription: a real P-256 key, so push.test can encrypt to it. */
const subscription = endpoint => {
  const e = crypto.createECDH("prime256v1");
  e.generateKeys();
  return { endpoint, keys: { p256dh: e.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
};

test("phone add: steps, a code from the verifier, then the checks pass as the phone subscribes and enrolls; list, test and remove", async t => {
  const { root, svc, io } = await box(t);
  const deck = (tool, input = {}, headers = {}) => call(tool, input, { root, caller: "deck", headers });
  // A laptop already getting notifications is not the new phone.
  const laptop = (await deck("push.subscribe", { subscription: subscription(`${svc.base}/push/laptop`), label: "Northwind laptop" })).data.device;
  const lines = capture(t);
  const input = new PassThrough();
  // life: a failed assertion still ends the watch, so the file never hangs.
  const run = add({}, { io, input, tty: false, life: 20_000 });

  const code = await until(() => lines.map(l => /type ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(l)).find(Boolean)?.[1], "the code");
  const text = lines.join("\n");
  assert.match(text, /Pairing a phone with the box \(vyre\.tail0000\.ts\.net\)/);
  assert.match(text, /Network\s+Tailscale, tailnet tail0000/);
  assert.match(text, /the relay is coming/, "no relay tool on this box");
  assert.match(text, new RegExp(`Open Vyre\\s+${BOX.replace(/\./g, "\\.")}`));
  assert.match(text, /Type this address on the phone/, "no QR code into a pipe");
  assert.match(text, /iPhone: Safari: Share, then Add to Home Screen/);
  assert.match(text, /Android: Chrome/);
  assert.match(text, /· Phone reached the box/);
  assert.doesNotMatch(text, /✓/, "nothing passes before the phone does anything");

  // The phone turns on notifications; Enter makes the laptop look again, and the new device gets a test.
  const phoneDevice = (await deck("push.subscribe", { subscription: subscription(`${svc.base}/push/phone`), label: "alex's iPhone" })).data.device;
  input.write("\n");
  await until(() => svc.got.includes("/push/phone"), "the test notification");
  assert.ok(!svc.got.includes("/push/laptop"), "only the new phone is tested");
  await until(() => lines.some(l => /✓ Test notification sent/.test(l)), "the push check");
  assert.ok(lines.some(l => /✓ Phone reached the box/.test(l)));
  assert.ok(lines.some(l => /✓ Secure address works \(HTTPS\)/.test(l)));
  assert.ok(lines.some(l => /\? Opened as an app, not a browser tab/.test(l)), "the box cannot tell app from tab on this service");

  // The phone adds its passkey with the code: presence.enrolled on the stream ends the watch.
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = await deck("presence.enroll", { kind: "passkey", name: "alex's iPhone", public_key: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    alg: -7, rp_id: "vyre.tail0000.ts.net", credential_id: crypto.randomBytes(16).toString("base64url") }, { "x-vyre-presence": `code code=${code}` });
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
  const code = await add({ iphone: true }, { io, input: null, tty: false, life: 400 });
  assert.equal(code, 1);
  const text = lines.join("\n");
  assert.doesNotMatch(text, /Android:/, "--iphone shows the iPhone step only");
  assert.match(text, /the code ran out before: phone reached the box, secure address works \(https\), test notification sent, face id key saved/i);
  assert.match(text, /next: vyre phone add again/);
});

test("phone add --json: the address, the code and the steps as one value, without watching", async t => {
  const { io } = await box(t);
  const lines = capture(t);
  setJson(true);
  t.after(() => setJson(false));
  assert.equal(await add({}, { io }), 0);
  const v = JSON.parse(lines.at(-1));
  assert.equal(v.box, BOX);
  assert.equal(v.url, BOX + "/");
  assert.match(v.code, /^[A-Z0-9]{8}$/);
  assert.ok(v.expires > Date.now() + 9 * 60_000, "the code lasts 10 minutes");
  assert.deepEqual(v.network, { kind: "tailscale", tailnet: "tail0000", login: null, relay: null });
  assert.deepEqual(v.checks.map(c => [c.id, c.state]), [["reached", "wait"], ["https", "wait"], ["app", "wait"], ["push", "wait"], ["passkey", "wait"]]);
});

test("phone add: without a person at a terminal the code is refused, exit 3", async t => {
  await box(t);
  capture(t);
  const noTty = { openTty: () => { throw new Error("no tty"); }, ttyName: () => "", prompt: async () => "", print() {} };
  assert.equal(await add({}, { io: noTty, input: null, tty: false }), 3);
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

test("phone add --android: names adb and the phone, then says the box has no APK yet, exit 1; never a real adb", async t => {
  const dir = tempHome(t);
  const fake = path.join(dir, "adb");
  fs.writeFileSync(fake, `#!${process.execPath}\nconst a = process.argv.slice(2);\nif (a[0] === "version") { console.log("Android Debug Bridge version 1.0.41"); process.exit(0); }\n`
    + `if (a[0] === "devices") { process.stdout.write("List of devices attached\\n1A2B3C4D device usb:1-1 product:husky model:Pixel_8 transport_id:1\\n\\n"); process.exit(0); }\nprocess.exit(1);\n`, { mode: 0o755 });
  const prev = process.env.VYRE_ADB_BIN;
  t.after(() => { if (prev === undefined) delete process.env.VYRE_ADB_BIN; else process.env.VYRE_ADB_BIN = prev; });
  const lines = capture(t);

  process.env.VYRE_ADB_BIN = path.join(dir, "no-adb");
  assert.equal(await android({}), 1);
  assert.match(lines.join("\n"), /adb is not installed[\s\S]*next: install Android platform-tools/);

  process.env.VYRE_ADB_BIN = fake;
  lines.length = 0;
  assert.equal(await android({}), 1);
  assert.match(lines.join("\n"), /Found Pixel 8 over USB[\s\S]*the box has no Android app to serve yet[\s\S]*next: vyre phone add for the web app/);
  lines.length = 0;
  assert.equal(await android({ wireless: true }), 1);
  assert.match(lines.join("\n"), /Pair with Wireless debugging/, "the USB phone is not a wireless one");

  setJson(true);
  t.after(() => setJson(false));
  lines.length = 0;
  assert.equal(await android({}), 1);
  assert.equal(JSON.parse(lines.at(-1)).error.code, "no_apk");
});

test("phone: usage mistakes exit 2 before asking vyred", async t => {
  const lines = capture(t);
  for (const args of [["add", "--usb"], ["add", "--android", "--usb", "--wireless"], ["add", "--iphone", "--android"], ["frob"], ["remove"], ["add", "extra"]]) {
    assert.equal(await phone.run(args), 2, `vyre phone ${args.join(" ")}`);
  }
  assert.ok(lines.some(l => /next: /.test(l)));
  await assert.rejects(phone.run(["add", "--bogus"]), /--bogus is not a flag of vyre phone/);
});

test("phone: a device new on the relay counts as reached, and says it came through the relay", async () => {
  const { evaluate } = await import("./phone.js");
  const before = { devices: [], keys: [], relay: [{ id: "d_old", path: null }] };
  const now = { devices: [], keys: [], relay: [{ id: "d_old", path: null }, { id: "d_new", kind: "web", path: "relay", online: true }] };
  const reached = evaluate(before, now, { address: "https://vyre.tail0000.ts.net" }).find(c => c.id === "reached");
  assert.equal(reached?.state, "ok");
  assert.match(String(reached?.note), /through the relay/);
  assert.equal(evaluate(before, before, {}).find(c => c.id === "reached")?.state, "wait", "a device already there is not new");
});
