#!/usr/bin/env node
// app-walk-paired-device: a device PAIRED to a box through a relay (the caller `device:<id>`, as a paired browser is), asking for the owner's yes with the app's own code (apps/app/src/real/approvals.js) and answered by the
// STAND-IN PHONE (scripts/standin-phone.mjs). TEST ONLY. Node only: the device is the relay client library (relay/client) with a throwaway key kept in memory.
//
//   node scripts/app-walk-paired-device.mjs --socket <home>/.vyre/vyred.sock
//
// Run it from an ssh login shell, in the foreground, on a development-kind home enrolled with scripts/dev-enrol-software-key.mjs (scripts/app-walk.README.md), whose relay is on and which holds a vault item.
// Steps: (1) pair by TYPED CODE: wink.phone.open shows the code, this device types it (addThisDevice({ code, presenceKey })), the owner types the ack back (wink.code.ack, signed with the software key), then the device
// opens its paired person session (the app's startPaired, signing with the P-256 presence key it reported); (2) the device's vault.totp answers presence_required; (3) the app's askYes opens the card and the stand-in
// phone approves; (4) the device SPENDS the approval and gets the code; (5) the same approval a second time is refused; (6) a second card the phone refuses ends "refused"; (7) records.define from the device,
// reported as it answers (what a paired device may do without a prompt).
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import nodeCrypto_ from "node:crypto";
import { connect } from "../relay/client/client.js";
import { addThisDevice } from "../relay/client/phonepair.js";
import { nodeCrypto } from "../relay/client/nodecrypto.js";
import { memoryKeyStore } from "../relay/client/webcrypto.js";
import { askYes, endLine, heldAsk } from "../apps/app/src/real/approvals.js";
import { startPaired } from "../apps/app/src/auth/paired.ts";
import { proofWith } from "../apps/app/src/auth/person.ts";

const args = process.argv.slice(2);
const SOCKET = args[args.indexOf("--socket") + 1] ?? "";
if (!SOCKET || !args.includes("--socket")) { console.error("app-walk-paired-device: give --socket <home>/.vyre/vyred.sock"); process.exit(2); }
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
function phone(answer, seconds) {
  const p = spawn(process.execPath, [path.join(here, "standin-phone.mjs"), "--home", HOME, "--answer", answer, "--seconds", String(seconds), "--once"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  return { kill: () => p.kill(), done: new Promise((r) => p.on("exit", () => r({ out: out.trim(), err: err.trim() }))) };
}
const results = [];
const check = async (name, fn) => {
  try { const note = await fn(); results.push({ name, ok: true }); console.log(`PASS ${name}${note ? ` | ${note}` : ""}`); }
  catch (e) { results.push({ name, ok: false, why: String(e.message).slice(0, 400) }); console.log(`FAIL ${name}: ${String(e.message).slice(0, 400)}`); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

await box("relay.status", {}, { "x-vyre-presence": "stand-in" }); // trusts this login (dev stand-in)
// vault.reveal is not asked about on a development home with the hand-made stand-in file (the stand-in answers a reveal that offers no proof, STAND_IN_AUTO), so the walk asks for a one-time code (vault.totp), which is
// a vault moment tool the stand-in does not cover. The item is made here (vault.put IS covered by the stand-in).
const WALK_ITEM = "walk-totp";
if (!(await box("vault.list")).data?.items?.some((i) => i.name === WALK_ITEM)) {
  const put = await box("vault.put", { name: WALK_ITEM, kind: "login", fields: { username: "walk", password: "walk-pw-123", totp: "JBSWY3DPEHPK3PXP" } }, { "x-vyre-presence": "stand-in" });
  if (put.error) { console.error(`app-walk-paired-device: could not make the walk's item: ${JSON.stringify(put.error).slice(0, 200)}`); process.exit(2); }
}
const item = { name: WALK_ITEM };
const TOOL = "vault.totp";

let conn, session = null, pkey = null;
const b64 = (u8) => Buffer.from(u8).toString("base64url");
/** One tool call as the paired device, with its person session (the paired-start token and a signed proof per request) once it has one. */
const dev = async (tool, input = {}, headers = {}) => {
  const body = JSON.stringify(input);
  const url = `/v1/tools/${tool}`;
  const auth = session ? { authorization: `Vyre ${session}`, "x-vyre-proof": await proofWith(async (m) => new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pkey.privateKey, new TextEncoder().encode(m))), { method: "POST", url, body }) } : {};
  const r = await conn.fetch(url, { method: "POST", headers: { "content-type": "application/json", ...auth, ...headers }, body });
  const j = await r.json().catch(() => ({}));
  return j;
};
const call = async (t, i) => { const x = await dev(t, i); if (x.error) throw Object.assign(new Error(x.error.message), { code: x.error.code }); return x.data; };

await check("pair: a device is paired by a typed code and opens its person session", async () => {
  // Pair by TYPED CODE, as the owner would: wink.phone.open shows WINK-NNPP-PPPP; this device types it (addThisDevice({ code })), shows the ack, and the owner types the ack back (wink.code.ack, a yes moment,
  // signed here with the software key). The owner's ack is what makes the pairing "confirmed by its owner", which a person session needs.
  const o = await withYes("wink.phone.open", {});
  assert(o.data?.code, `no typed code: ${JSON.stringify(o.error ?? o).slice(0, 200)}`);
  const crypto = nodeCrypto(), keyStore = memoryKeyStore(), crypto_ = globalThis.crypto;
  pkey = await crypto_.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = b64(new Uint8Array(await crypto_.subtle.exportKey("spki", pkey.publicKey)));
  const idk = nodeCrypto_.generateKeyPairSync("ed25519");
  const idpub = idk.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  const r = await addThisDevice({ code: o.data.code, relay: o.data.qr ? new URL(o.data.qr.replace("vyre://", "http://")).searchParams.get("r") : undefined, key: { publicKey: idpub, label: "walk phone" }, name: "walk device", crypto, keyStore,
    presenceKey: { public_key: spki, alg: -7, storage: "software" },
    onAck: async (ack) => { const a = await withYes("wink.code.ack", { offer: o.data.code_offer, typed: ack }); if (a.error) console.log("  ack refused:", JSON.stringify(a.error).slice(0, 200)); } });
  conn = connect({ relay: r.relay, route: r.route, box: r.box, name: "walk device", crypto, keyStore });
  // The paired person session (presence.person.start-paired, the app's own startPaired): the device signs the box's challenge with the key it reported at pairing.
  const rawCall = async (t, i) => { const x = await conn.fetch(`/v1/tools/${t}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(i) }); return x.json().catch(() => ({})); };
  const st = await startPaired({ device: r.device, call: rawCall, privateKey: pkey.privateKey, label: "walk device" }).catch((e) => ({ error: e.message }));
  if (st.token) session = st.token;
  const me = await dev("records.me", {});
  assert(!me.error || me.error.code !== "unreachable", `the device cannot reach the box: ${JSON.stringify(me.error)}`);
  return `typed-code pairing, device ${String(r.device).slice(0, 8)}; session: ${session ? "yes" : "no (" + st.error + ")"}; records.me: ${me.error ? me.error.code : "ok"}`;
});

const input = { name: item.name };
const reveal = async (answer, limit) => {
  const first = await dev(TOOL, input);
  assert(first.error?.code === "presence_required", `the first reveal should answer presence_required: ${JSON.stringify(first).slice(0, 200)}`);
  const held = heldAsk(first.error, TOOL, input);
  assert(held, "the app did not turn it into a card");
  const ph = phone(answer, 60);
  const out = await askYes(call, { moment: held.moment, request: held.request, pollMs: 500, limitMs: limit });
  const said = await ph.done;
  return { out, said };
};
let approval;
await check("yes: the app's ask opens a card and the stand-in phone approves it", async () => {
  const { out, said } = await reveal("yes", 60000);
  assert("approval" in out, `not approved: ${JSON.stringify(out)} ${said.err}`);
  approval = out.approval;
  return `phone: ${said.out.slice(0, 120)}`;
});
await check("spend: the paired device reveals with the approval and gets the field", async () => {
  assert(approval, "no approval to spend");
  const r = await dev(TOOL, { ...input, approval });
  assert(!r.error, `the approved reveal was refused: ${JSON.stringify(r.error)}`);
  return `got ${Object.keys(r.data ?? {}).join(",") || "data"}`;
});
await check("an approval is spent once: the same approval a second time is refused", async () => {
  const r = await dev(TOOL, { ...input, approval });
  assert(r.error, "the approval was spent twice");
  return r.error.code;
});
await check("no: the stand-in phone refuses and the app says so", async () => {
  const { out } = await reveal("no", 60000);
  assert("ended" in out && out.ended === "refused", `expected refused: ${JSON.stringify(out)}`);
  return endLine(out.ended);
});
await check("records.define from the paired device (reported as it answers)", async () => {
  const r = await dev("records.define", { diff: { add_types: [{ name: "walk_note", label: "Walk note", fields: [{ name: "title", label: "Title", kind: "text" }] }] } });
  return r.error ? `refused: ${r.error.code}: ${String(r.error.message).slice(0, 140)}` : "accepted without a prompt";
});
try { conn?.close(); } catch {}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length} pass, ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
