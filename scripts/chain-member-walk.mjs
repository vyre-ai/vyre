// @ts-check
// Design B journey (multi-server asked, rc.4 branch work/rc4-space-list): a device the person's identity chain lists dials a server it was never paired with, with a signed chain hello (relay/client/chainhello.js), and
// is admitted as a device marked via_chain. One identity, one real vyred (the daemon rig of scripts/lib/proof/server-daemon.mjs, in this process), the names-directory stand-in holding the chain, the headless app
// (scripts/lib/proof/app.mjs) as the owner. The calls are plain relay requests as the chain device (no sign-in, the way a paired device calls).
//   node scripts/chain-device-walk.mjs [--out DIR] [--wait-refresh]     (--wait-refresh waits the 5 minute chain refresh to show item 5)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { proofWith } from "../apps/app/src/auth/person.ts";
import { createApp } from "./lib/proof/app.mjs";
import { startStandins } from "./lib/proof/standins.mjs";
import { startDaemonServer } from "./lib/proof/server-daemon.mjs";
import { chainHello } from "../relay/client/chainhello.js";
import { connect } from "../relay/client/client.js";
import { nodeCrypto, fileKeyStore } from "../relay/client/nodecrypto.js";
import { generateDeviceKey } from "../apps/app/src/identity/keys.js";
import { enrolDevice } from "../apps/app/src/identity/enrol-device.js";
import * as C from "../kernel/identity/chain.js";

const argv = process.argv.slice(2);
const out = path.resolve(argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : fs.mkdtempSync(path.join(os.tmpdir(), "chain-device-")));
fs.mkdirSync(out, { recursive: true });
let failed = 0, passed = 0;
/** @param {string} name @param {() => Promise<any>} fn */
async function step(name, fn) {
  try { const r = await fn(); passed++; console.log(`PASS  ${name}${r ? `: ${String(r).slice(0, 800)}` : ""}`); }
  catch (e) { failed++; console.log(`FAIL  ${name}: ${String(/** @type {any} */ (e)?.message || e).slice(0, 800)}`); }
}
const sha256 = async (/** @type {Uint8Array} */ b) => new Uint8Array(crypto.createHash("sha256").update(b).digest());
const ins = await startStandins({ out });
const mac = createApp({ label: "Proof Mac", dir: path.join(out, "mac"), directory: ins.names, relay: ins.relay });
/** @type {any} */ let srv = null;

/** Dial the server as a chain device and run `calls`. `key` signs the hello; `hello` can be fixed to replay one. Resolves { conn } or throws what the server said. */
async function dial(/** @type {{ key: any, entry: string, identity?: string, hello?: () => Promise<any>, name?: string }} */ o) {
  const p = mac.pairing;
  const dir = fs.mkdtempSync(path.join(out, "dev-"));
  const crypto2 = nodeCrypto(), keyStore = fileKeyStore(path.join(dir, "k.json"));
  const personKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: personKey.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" };
  const conn = connect({ presenceKey, relay: p.relay, route: p.route, box: p.box, name: o.name || "chain-device", crypto: crypto2, keyStore,
    chainHello: o.hello || (async (/** @type {Uint8Array | undefined} */ given) => { const h = await chainHello({ sha256, devicePub: given, box: String(p.box), identity: o.identity || mac.identity.id, entry: o.entry, sign: (m) => o.key.sign(m), presencePublicKey: presenceKey.public_key, name: o.name || "chain-device" }); const { deviceId } = await import("../core/relay/index.js"); lastChannel = h.channel; console.log(`DIAG client hello channel ${h.channel}, relay.deviceId(devicePub)=${given ? deviceId(Buffer.from(given)) : "-"}, keystore pub ${Buffer.from((await keyStore.get()).publicKey).toString("base64url").slice(0, 8)},  devicePub ${given ? Buffer.from(given).toString("base64url").slice(0, 8) : "undefined"}, ts ${h.ts}, sig ${h.sig.length} chars`); return h; }) });
  /** @type {any} */ (conn).personKey = personKey;
  return conn;
}
/** Sign the device in as a fresh device does (pair-challenge, then start-paired with its presence key) and give a caller that sends the token and a signed proof. */
async function signIn(/** @type {any} */ conn) {
  const sgn = (/** @type {Uint8Array} */ m) => new Uint8Array(crypto.sign("sha256", Buffer.from(m), { key: conn.personKey.privateKey, dsaEncoding: "ieee-p1363" }));
  const ch = JSON.parse((await callAs(conn, "presence.person.pair-challenge")).text);
  const challenge = (ch.data || {}).challenge;
  if (!challenge) throw new Error(`no challenge: ${JSON.stringify(ch).slice(0, 200)}`);
  const sig = sgn(new TextEncoder().encode(`paired-start\n${lastChannel}\n${challenge}`));
  const sp = await callAs(conn, "presence.person.start-paired", { sig: Buffer.from(sig).toString("base64url"), label: "chain-device" });
  const token = (JSON.parse(sp.text).data || {}).token;
  if (!token) throw new Error(`no session: ${sp.status} ${sp.text}`);
  return async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const url = `/v1/tools/${tool}`, body = JSON.stringify(input);
    const proof = await proofWith(async (m) => sgn(new TextEncoder().encode(m)), { method: "POST", url, body });
    const r = await conn.fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Vyre ${token}`, "x-vyre-proof": proof }, body });
    return { status: r.status, text: String(await r.text()).slice(0, 300) };
  };
}
/** One tool call as that device: { status, text }. */
async function callAs(/** @type {any} */ conn, /** @type {string} */ tool, /** @type {any} */ input = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  try {
    const r = await conn.fetch(`/v1/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), signal: ac.signal });
    return { status: r.status, text: String(await r.text()).slice(0, 300) };
  } catch (e) {
    // a refused hello makes the client dial again and again; the server's last word is on the connection
    throw new Error(`no answer in 20 s; the connection's last error: ${String(conn.lastError && conn.lastError.message || /** @type {any} */ (e).message).slice(0, 220)}`);
  } finally { clearTimeout(timer); try { if (ac.signal.aborted) conn.close(); } catch { /* closed */ } }
}
const channelOf = (/** @type {any} */ c) => String((c && (c.deviceId || (c.o && c.o.deviceId))) || lastChannel);
let lastChannel = "";
const rowsOf = () => String(srv.logs.length) && srv.registry.call("relay.devices", {}, "cli").then((/** @type {any} */ r) => r && r.data);
async function appendOp(/** @type {any} */ body) {
  const name = mac.identity.name;
  const r = await (await fetch(`${ins.names}/v1/ids/resolve?name=${encodeURIComponent(name)}`)).json();
  const state = await C.verifyChain(r.data.ops, { now: Date.now() + C.SKEW_MS });
  const op = await C.makeOp(state, body, { by: mac.identity.key.eid, ts: Math.max(Date.now(), state.ts), sign: (/** @type {Uint8Array} */ m) => mac.identity.key.sign(m) });
  const res = await fetch(`${ins.names}/v1/ids/append`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, ops: [op] }) });
  return { status: res.status, body: await res.text() };
}

try {
  const person = `chain${Math.random().toString(36).slice(2, 6)}`;
  const reservation = await mac.reserve(person);
  await mac.becomeYourself({ name: reservation.name, code: reservation.code });
  const flow = mac.addServer(); await flow.begin("plain");
  srv = await startDaemonServer({ dir: path.join(out, "server"), name: "chainbox", code: flow.state.code, relay: ins.relayForServer, directory: ins.namesForServer, store: "plain", ownerId: mac.identity.id });
  await mac.until(() => flow.state.stage === "found" || flow.state.stage === "stopped", 60_000, "the app to find the server");
  await flow.confirmWords(); assert.equal(flow.state.stage, "done");
  mac.setYes(srv.yesFor(mac.identity.id, undefined)); await mac.openSession(); await mac.callTool("system.info");

  await step("0. setup: the owner paired this server by the app; its box string and the chain key's form", async () => {
    const p = mac.pairing;
    return `pairing.box starts ${String(p.box).slice(0, 6)} (${typeof p.box}), pairing keys ${Object.keys(p).join(",")}; pairing.box=${String(p.box).length} chars (${/^[A-Za-z0-9_-]+$/.test(String(p.box)) ? "base64url" : "other"}), identity ${mac.identity.id}, chain founder entry ${mac.identity.key.eid}`;
  });

  await step("9. a MEMBER's identity (not the owner) gets a chain device that signs in with the member's role, and cannot do the owner's acts", async () => {
    const mem = createApp({ label: "Member Mac", dir: path.join(out, "member"), directory: ins.names, relay: ins.relay });
    const mres = await mem.reserve("member" + Math.random().toString(36).slice(2, 6));
    await mem.becomeYourself({ name: mres.name, code: mres.code });
    const sp0 = JSON.parse((await srv.operator("spaces.list", {}).then((/** @type {any} */ r) => JSON.stringify(r)).catch(() => "{}")) || "{}");
    const spaces = await mac.callTool("spaces.list"); const space = (spaces.data || spaces)[0].id;
    const add = await srv.team.grantMember(space, mac.identity.id, mem.identity.id, "member").catch((/** @type {any} */ e) => ({ error: String(e && e.message || e) }));
    console.log(`DIAG members.add ${JSON.stringify(add).slice(0, 240)}`);
    for (const who of [mac.identity.id, mem.identity.id]) { const st = await srv.registry.call("spaces.identity.state", { person: who }, "module:relay").catch((/** @type {any} */ e) => ({ thrown: String(e.message) })); console.log(`DIAG identity.state(${who === mac.identity.id ? "owner" : "member"}) ${JSON.stringify(st).slice(0, 300)}`); }
    console.log(`DIAG member name ${mem.identity.name} id ${mem.identity.id}`);
    const c = await dial({ key: mem.identity.key, entry: mem.identity.key.eid, identity: mem.identity.id, name: mem.identity.name });
    const info = await callAs(c, "system.info");
    assert.equal(info.status, 200, `member chain device admitted: ${info.status} ${info.text}`);
    const call = await signIn(c);
    const sp = await call("spaces.list");
    const rl = await call("records.list", { type: "contact" });
    const adm = await call("spaces.members.add", { space, person: mem.identity.id, role: "admin" });
    console.log(`DIAG member calls spaces.list ${sp.status} ${sp.text.slice(0, 200)} | records.list ${rl.status} | members.add(admin, self) ${adm.status} ${adm.text.slice(0, 160)}`);
    assert.equal(sp.status, 200, `spaces.list ${sp.status} ${sp.text}`);
    assert.ok(/"role":"member"/.test(sp.text), `the row says role member: ${sp.text}`);
    assert.ok(adm.status >= 400, `a member cannot promote themself: ${adm.status} ${adm.text}`);
    return `admitted, role member in spaces.list, records.list ${rl.status}, self-promotion refused ${adm.status}`;
  });
} finally {
  if (srv) for (const l of srv.logs.filter((/** @type {string} */ x) => /chain|hello|relay|admit|bad_proof|box/i.test(x)).slice(-25)) console.log("SERVERLOG " + l.slice(0, 260));
  console.log(`DONE ${passed} passed, ${failed} failed`);
  try { mac.close(); } catch { /* closed */ }
  try { await srv?.stop?.(); } catch { /* stopped */ }
  await ins.stop();
  process.exit(failed ? 1 : 0);
}
