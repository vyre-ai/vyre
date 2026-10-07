// J5 (agent half): pairing a phone, on a CI runner. A real vyred in a temp home, the real relay server, and a phone that is the
// shared relay client (relay/client) with a P-256 push subscription of its own. It covers the steps an agent can: 5.1 the pairing QR,
// 5.6 a Needs-you item reaching a phone as a push, 5.9 removing a device. The steps that need a person with a phone (Face ID, the
// fingerprint, the camera, airplane mode, a real approval) are rows marked "by-hand"; "both phones show it" needs the simulator and
// emulator lanes (J0) and is "skip" here, never faked. The box is in-process with the presence floor relaxed to a test proof, so the
// Touch ID prompt itself is not exercised (5.3, 5.5 stay by-hand).
//
//   node scripts/matrix/j5.mjs <out-dir>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { start } from "../../core/daemon/index.js";
import { HUMAN_ONLY } from "../../core/presence/index.js";
import { createRelay } from "../../relay/node/server.js";
import { parsePairUrl } from "../../core/relay/pairing.js";
import { pairOffer, connect } from "../../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../../relay/client/nodecrypto.js";
import { fromBase64url } from "../../relay/client/bytes.js";
import { qr } from "../../core/cli/qr.js";
import jsQR from "../../web/vendor/jsqr/jsqr.js";
import { recorder } from "./lib/results.mjs";

if (!process.env.CI) { console.error("j5: runs on a CI runner only (CI is unset)"); process.exit(2); }
const out = path.resolve(process.argv[2] || "results");
const r = recorder(out, "J5", `${process.platform}-relay`);
const PROOF = { proof: { method: "passkey", id: "j5" } };
const lenient = {
  required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
  verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
  challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }),
  summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }),
};
const sleep = ms => new Promise(res => setTimeout(res, ms));
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(50); } };

// ---- the world: a relay, a push service, a box
const relay = createRelay();
const relayUrl = await relay.listen();
const pushGot = [], pushBodies = [];
const pushSvc = http.createServer((req, res) => { const p = []; req.on("data", c => p.push(c)); req.on("end", () => { pushGot.push(req.url); pushBodies.push(Buffer.concat(p)); res.writeHead(201); res.end(); }); });
await new Promise(res => pushSvc.listen(0, "127.0.0.1", () => res(undefined)));
const pushBase = `http://127.0.0.1:${/** @type {any} */ (pushSvc.address()).port}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "j5-"));
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "j5-box", transcripts: [], vault: { keystore: "file" }, relay: { enabled: false, url: relayUrl },
  push: { hosts: ["127.0.0.1"], allow_http: true }, modules: { disable: ["names", "onboard", "recall", "memory", "learn"] } }));
const logs = [];
const d = await start({ presence: lenient, root, log: m => logs.push(String(m)) });
const done = async code => { try { await d.stop(); } catch {} relay.close(); pushSvc.close(); pushSvc.closeAllConnections?.(); process.exit(code); };

try {
  // ---- 5.1 the pairing screen's QR
  const first = await d.registry.call("relay.pair.first", {}, "onboard", PROOF);
  const url = first.data && first.data.url;
  const offer = url ? parsePairUrl(url) : null;
  if (!offer) { r.step("5.1-qr-decodes-to-a-vyre-link", false, { why: `no pairing link: ${JSON.stringify(first.error)}` }); await done(1); }
  const rows = qr(/** @type {string} */ (url)), quiet = 4, scale = 6, size = (rows.length + quiet * 2) * scale;
  const px = new Uint8ClampedArray(size * size * 4).fill(255);
  rows.forEach((row, y) => row.forEach((dark, x) => { if (dark) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const o = (((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx) * 4; px[o] = px[o + 1] = px[o + 2] = 0; } }));
  const decoded = jsQR(px, size, size);
  const secret = String(/** @type {any} */ (offer).secret);
  const everything = logs.join("\n") + JSON.stringify(d.events.since(0, { limit: 5000 }));
  const linkOk = /^(https:\/\/vyre\.run\/pair#|vyre:)/.test(String(url));
  const leak = everything.includes(secret) || everything.includes(String(url).split("#")[1] || "\u0000");
  r.step("5.1-qr-decodes-to-a-vyre-link", Boolean(decoded && decoded.data === url && linkOk) && !leak,
    { why: decoded ? `the QR decodes to ${String(url).split("#")[0]}#..., ${linkOk ? "a vyre.run or vyre link" : "NOT a vyre link"}; the pairing secret is ${leak ? "IN the logs or events" : "in no log or event"}` : "the QR did not decode" });
  for (const [s, why] of [["5.2-iphone-scan-and-add-to-home-screen", "U1: a real iPhone"], ["5.3-face-id-at-pairing", "U1: a real iPhone, Face ID"], ["5.4-android-scan-and-install", "U1: a real Android phone"],
    ["5.5-fingerprint-at-pairing", "U1: a real Android phone, fingerprint"], ["5.7-airplane-mode-60s", "U1: a real phone"], ["5.8-approve-a-held-send-from-the-iphone", "U1: a real iPhone, Face ID, a test inbox"]]) r.step(s, "by-hand", { why });

  // ---- the phone pairs over the relay (the shared client), and the box lists it
  const keyStore = fileKeyStore(path.join(root, "phone-key.json"));
  const paired = await pairOffer(offer, { crypto: nodeCrypto(), keyStore, name: "j5 phone" });
  const listed = (await d.registry.call("relay.devices.list", {}, "cli", PROOF)).data;
  const dev = listed && listed.devices.find(x => x.id === paired.device);
  const conn = connect({ relay: paired.relay, route: paired.route, box: fromBase64url(paired.box), crypto: nodeCrypto(), keyStore, backoff: { min: 30, max: 100 } });
  const states = []; conn.onstate = s => states.push(s);
  await until(() => conn.open, 10000);

  // ---- 5.6 a Needs-you item reaches the phone as a push
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: `${pushBase}/push/j5-phone`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
  const subbed = await d.registry.call("push.subscribe", { subscription: sub, label: "j5 phone" }, "deck", PROOF);
  await until(() => pushGot.length >= 1, 8000);          // the test notification a subscription starts with
  const before = pushGot.length;
  d.events.emit("gate", "gate.held", { id: "g_j5", kind: "send", via: "mail", to: "someone@example.com", summary: "a held draft" }, { thread: "t-j5" });
  const arrived = await until(() => pushGot.length > before, 20000);
  let msg = null;
  if (arrived) {
    const body = pushBodies.at(-1);
    const salt = body.subarray(0, 16), idlen = body[20], as = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const hk = (s, ikm, info, n) => Buffer.from(crypto.hkdfSync("sha256", ikm, s, info, n));
    const ikm = hk(auth, ecdh.computeSecret(as), Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), as]), 32);
    const dec = crypto.createDecipheriv("aes-128-gcm", hk(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hk(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12));
    dec.setAuthTag(ct.subarray(-16));
    msg = JSON.parse(Buffer.concat([dec.update(ct.subarray(0, -16)), dec.final()]).subarray(0, -1).toString());
  }
  const plain = msg && !/someone@example\.com|a held draft/.test(JSON.stringify(msg));
  r.step("5.6-needs-you-push-reaches-a-phone", Boolean(subbed.data && msg && msg.path === "/needs/g_j5" && plain),
    { why: msg ? `pushed to the phone's own subscription and decrypted with its key: "${msg.title}", opens ${msg.path}; no recipient or words in it` : `no push arrived (${JSON.stringify(subbed.error || "")})` });
  r.step("5.6b-both-phones-show-it", "skip", { why: "needs the iOS simulator and Android emulator lanes (J0) with a paired shell; this step proves the push the shells would show" });

  // ---- 5.9 remove the device: its channel closes at once and the phone is told
  const t0 = Date.now();
  const rm = await d.registry.call("relay.devices.remove", { id: paired.device }, "cli", PROOF);
  const told = await until(() => states.at(-1) === "relay_removed", 3000);
  const ms = Date.now() - t0;
  const after = (await d.registry.call("relay.devices.list", {}, "cli", PROOF)).data;
  const gone = !after.devices.some(x => x.id === paired.device);
  const keyStore2 = fileKeyStore(path.join(root, "phone-key.json"));
  const again = connect({ relay: paired.relay, route: paired.route, box: fromBase64url(paired.box), crypto: nodeCrypto(), keyStore: keyStore2, backoff: { min: 30, max: 100 } });
  const states2 = []; again.onstate = s => states2.push(s);
  const refused = await until(() => states2.at(-1) === "relay_removed", 5000);
  again.close();
  r.step("5.9-remove-closes-the-channel-and-the-phone-is-told", Boolean(dev && rm.data && told && gone && refused),
    { why: `listed before: ${Boolean(dev)}; removed; the phone's client reached "relay_removed" in ${ms} ms; gone from the list: ${gone}; a reconnect with the same key is refused the same way: ${Boolean(refused)}` });
  conn.close();
  await done(r.failed ? 1 : 0);
} catch (e) {
  r.step("j5-harness", false, { why: String(e && e.stack || e).slice(0, 300) });
  await done(1);
}
