#!/usr/bin/env node
// Probe: pair a Node device to the box by a TYPED code (wink.phone.open -> addThisDevice({code}) -> wink.code.ack), then try the paired person session. TEST ONLY; run from an ssh login shell.
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { addThisDevice } from "../relay/client/phonepair.js";
import { nodeCrypto } from "../relay/client/nodecrypto.js";
import { memoryKeyStore } from "../relay/client/webcrypto.js";
import { connect } from "../relay/client/client.js";

const SOCKET = process.argv[process.argv.indexOf("--socket") + 1];
const HOME = path.dirname(SOCKET);
const here = path.dirname(fileURLToPath(import.meta.url));
const box = (tool, input = {}, headers = {}) => new Promise((resolve) => {
  const body = JSON.stringify(input);
  const r = http.request({ socketPath: SOCKET, path: `/v1/tools/${tool}`, method: "POST", headers: { host: "localhost", "x-vyre-caller": "cli", "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (x) => { let s = ""; x.on("data", (c) => (s += c)); x.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({ error: { code: "bad_reply", message: s.slice(0, 100) } }); } }); });
  r.on("error", (e) => resolve({ error: { code: "unreachable", message: String(e.message) } })); r.end(body);
});
const withYes = (tool, input) => {
  const p = spawnSync(process.execPath, [path.join(here, "dev-sign-proof.mjs"), "--home", HOME, "--yes", "pair", "--tool", tool, "--input", JSON.stringify(input), "--header"], { encoding: "utf8" });
  if (p.status !== 0) throw new Error(p.stderr.trim());
  return box(tool, input, { "x-vyre-presence": p.stdout.trim() });
};
await box("relay.status", {}, { "x-vyre-presence": "stand-in" });
const o = await withYes("wink.phone.open", {});
console.log("open:", JSON.stringify(o).slice(0, 400));
const code = o.data?.code, offer = o.data?.code_offer;
if (!code) process.exit(1);
const cr = nodeCrypto(), ks = memoryKeyStore();
const seed = crypto.randomBytes(32);
const kp = crypto.generateKeyPairSync("ed25519");
const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
let acked = false;
const p = addThisDevice({ code, relay: "ws://127.0.0.1:8791", key: { publicKey: pub, label: "walk phone" }, name: "walk phone", crypto: cr, keyStore: ks,
  onWords: (w) => console.log("words:", w),
  onAck: async (ack) => { console.log("ack:", ack); const a = await withYes("wink.code.ack", { offer, typed: ack }); console.log("ack answered:", JSON.stringify(a).slice(0, 300)); acked = true; } });
const r = await p.then((x) => x, (e) => ({ error: `${e.code}: ${e.message}` }));
console.log("paired:", JSON.stringify(r).slice(0, 400));
if (r.route) {
  const conn = connect({ relay: r.relay, route: r.route, box: r.box, name: "walk phone", crypto: cr, keyStore: ks });
  const f = async (t, i) => (await (await conn.fetch(`/v1/tools/${t}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(i) })).json());
  console.log("challenge:", JSON.stringify(await f("presence.person.pair-challenge", {})).slice(0, 200));
  console.log("records.me:", JSON.stringify(await f("records.me", {})).slice(0, 200));
  conn.close();
}
process.exit(0);
