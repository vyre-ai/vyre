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
async function dial(/** @type {{ key: any, entry: string, dir?: string, personKey?: any, identity?: string, hello?: () => Promise<any>, name?: string }} */ o) {
  const p = mac.pairing;
  const dir = o.dir || fs.mkdtempSync(path.join(out, "dev-"));
  const crypto2 = nodeCrypto(), keyStore = fileKeyStore(path.join(dir, "k.json"));
  const personKey = o.personKey || crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const presenceKey = { public_key: personKey.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, storage: "software" };
  const conn = connect({ presenceKey, relay: p.relay, route: p.route, box: p.box, name: o.name || "chain-device", crypto: crypto2, keyStore,
    chainHello: o.hello || (async (/** @type {Uint8Array | undefined} */ given) => { const h = await chainHello({ sha256, devicePub: given, box: String(p.box), identity: o.identity || mac.identity.id, entry: o.entry, sign: (m) => o.key.sign(m), presencePublicKey: presenceKey.public_key, name: o.name || "chain-device" }); const { deviceId } = await import("../core/relay/index.js"); lastChannel = h.channel; console.log(`DIAG client hello channel ${h.channel}, relay.deviceId(devicePub)=${given ? deviceId(Buffer.from(given)) : "-"}, keystore pub ${Buffer.from((await keyStore.get()).publicKey).toString("base64url").slice(0, 8)},  devicePub ${given ? Buffer.from(given).toString("base64url").slice(0, 8) : "undefined"}, ts ${h.ts}, sig ${h.sig.length} chars`); return h; }) });
  /** @type {any} */ (conn).personKey = personKey; /** @type {any} */ (conn).dir = dir;
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
  const sd = JSON.parse(sp.text).data || {}; const token = sd.token;
  if (!token) throw new Error(`no session: ${sp.status} ${sp.text}`);
  const fn = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const url = `/v1/tools/${tool}`, body = JSON.stringify(input);
    const proof = await proofWith(async (m) => sgn(new TextEncoder().encode(m)), { method: "POST", url, body });
    const r = await conn.fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Vyre ${token}`, "x-vyre-proof": proof }, body });
    return { status: r.status, text: String(await r.text()).slice(0, 600) };
  };
  fn.sessionId = sd.id; fn.expires = sd.expires; return fn;
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

  /** @type {any} */ let newKey = null;
  await step("0c. a second chain entry (a newcomer) is added to the identity chain BEFORE any dial", async () => {
    newKey = await generateDeviceKey({ forceSoftware: true });
    await enrolDevice({ name: mac.identity.name, eid: mac.identity.key.eid, pin: mac.identity.pin, base: ins.names, sign: (/** @type {Uint8Array} */ m) => mac.identity.key.sign(m), entry: { publicKey: newKey.publicKey } });
    return `entry ${newKey.eid}`;
  });
  const spaces = await mac.callTool("spaces.list"); const space = (spaces.data || spaces)[0].id;
  const mem = createApp({ label: "Member Mac", dir: path.join(out, "member"), directory: ins.names, relay: ins.relay });
  const mres = await mem.reserve("member" + Math.random().toString(36).slice(2, 6));
  await mem.becomeYourself({ name: mres.name, code: mres.code });
  await srv.team.grantMember(space, mac.identity.id, mem.identity.id, "member");
  const memDial = (/** @type {any} */ extra = {}) => dial({ key: mem.identity.key, entry: mem.identity.key.eid, identity: mem.identity.id, name: mem.identity.name, ...extra });
  /** @type {any} */ let mc = null, mcall = null;
  await step("a. a member's chain device with a live session: presence.person.status shows HER identity; the OWNER's session list does not list her session as his", async () => {
    mc = await memDial(); mcall = await signIn(mc);
    const st = await mcall("presence.person.status");
    const rl = await mcall("records.list", { type: "contact" });
    const sl = await mcall("presence.person.sessions");
    const own = await mac.callTool("presence.person.sessions");
    console.log(`DIAG member status ${st.status} ${st.text.slice(0, 200)} | records.list ${rl.status} ${rl.text.slice(0, 160)} | member sessions ${sl.status} ${sl.text.slice(0, 200)}`);
    console.log(`DIAG owner sessions ${JSON.stringify(own).slice(0, 500)} | her session id ${mcall.sessionId}`);
    assert.ok(st.status === 200 && st.text.includes(mem.identity.id), `status names HER identity (${mem.identity.id}): ${st.text}`);
    assert.ok(!JSON.stringify(own).includes(String(mcall.sessionId)), `the owner's session list does not show her session ${mcall.sessionId}`);
    return `status: ${st.text.slice(0, 160)}; owner list excludes her session`;
  });
  await step("d. a chain-born session lasts at most an hour", async () => {
    const secs = (Number(mcall.expires) - Date.now()) / 1000;
    assert.ok(secs > 0 && secs <= 3600 + 5, `expires in ${Math.round(secs)} s (raw ${mcall.expires})`);
    return `expires in ${Math.round(secs)} s`;
  });
  await step("e. reconnecting in a loop mints a grant at most once per 30 s: the owner ends her session, her device reconnects at once and gets no grant (the relay log says so)", async () => {
    const rv = await mac.callTool("presence.person.revoke", { id: mcall.sessionId });
    console.log(`DIAG revoke ${JSON.stringify(rv).slice(0, 200)}`);
    const mark = srv.logs.length;
    try { mc.close(); } catch { /* closed */ }
    const again = await memDial({ dir: mc.dir, personKey: mc.personKey });
    const r1 = await callAs(again, "presence.person.pair-challenge");
    let said = ""; try { await signIn(again); said = "SIGNED IN"; } catch (e) { said = String(/** @type {any} */ (e).message).slice(0, 200); }
    const hit = srv.logs.slice(mark).filter((/** @type {string} */ l) => /grant|just now|wait half/i.test(l));
    console.log(`DIAG reconnect pair-challenge ${r1.status} ${r1.text.slice(0, 100)} | sign-in: ${said} | relay log: ${hit.join(" // ").slice(0, 300)}`);
    assert.ok(!/SIGNED IN/.test(said), `no second session inside 30 s: ${said}`);
    return `sign-in: ${said.slice(0, 100)}; relay log: ${hit.join(" // ").slice(0, 200)}`;
  });
  await step("b. key swap: another presence key is put on a chain device's row; a fresh chain-grant is refused", async () => {
    const dev = await memDial({ name: mem.identity.name });
    await callAs(dev, "presence.person.pair-challenge");
    const device = lastChannel;
    const k2 = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const enr = await srv.operator("presence.enroll", { kind: "device", name: "swap", public_key: k2.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
    const keyId = String((enr.data || enr).keyId || (enr.data || enr).id || "");
    assert.ok(keyId, `enrolled: ${JSON.stringify(enr).slice(0, 200)}`);
    const { DatabaseSync } = await import("node:sqlite");
    /** @type {string[]} */ const found = [];
    const walkDir = (/** @type {string} */ p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walkDir(q); else if (/\.(db|sqlite)$/.test(e.name)) found.push(q); } };
    walkDir(path.join(out, "server", ".vyre"));
    let changed = 0;
    for (const f of found) { try { const db = new DatabaseSync(f); const has = db.prepare("SELECT name FROM sqlite_master WHERE name='relay_devices'").get(); if (has) changed += Number(db.prepare("UPDATE relay_devices SET presence_key = ? WHERE id = ?").run(keyId, device).changes); db.close(); } catch { /* not it */ } }
    assert.ok(changed > 0, `the row ${device} was changed in ${found.length} db files`);
    await new Promise((res) => setTimeout(res, 31_000));
    const g = await srv.registry.call("presence.person.chain-grant", { device }, "module:relay");
    console.log(`DIAG chain-grant after swap ${JSON.stringify(g).slice(0, 300)}`);
    assert.ok(g && g.error && /not the one its identity signed for/.test(JSON.stringify(g)), `a fresh grant is refused with the key reason: ${JSON.stringify(g).slice(0, 300)}`);
    return `refused: ${JSON.stringify(g).slice(0, 200)}`;
  });
  await step("c. removal inside the grant window (needs --wait-refresh): get a grant, take the entry off the chain, let the refresh pass, then start-paired is refused", async () => {
    if (!argv.includes("--wait-refresh")) throw new Error("not run (needs --wait-refresh)");
    const nd = await dial({ key: newKey, entry: newKey.eid, name: "newcomer" });
    const ch = JSON.parse((await callAs(nd, "presence.person.pair-challenge")).text);
    assert.ok((ch.data || {}).challenge, `a challenge: ${JSON.stringify(ch)}`);
    const r = await appendOp({ type: "remove", target: newKey.eid });
    assert.ok(r.status < 400, `the directory took the remove: ${r.status}`);
    await new Promise((res) => setTimeout(res, 5.5 * 60_000));
    let said = ""; try { await signIn(nd); said = "SIGNED IN"; } catch (e) { said = String(/** @type {any} */ (e).message).slice(0, 220); }
    console.log(`DIAG after removal, start-paired: ${said}`);
    assert.ok(!/SIGNED IN/.test(said), `start-paired refused: ${said}`);
    return said.slice(0, 200);
  });
} finally {
  if (srv) for (const l of srv.logs.filter((/** @type {string} */ x) => /chain|hello|relay|admit|bad_proof|box/i.test(x)).slice(-25)) console.log("SERVERLOG " + l.slice(0, 260));
  console.log(`DONE ${passed} passed, ${failed} failed`);
  try { mac.close(); } catch { /* closed */ }
  try { await srv?.stop?.(); } catch { /* stopped */ }
  await ins.stop();
  process.exit(failed ? 1 : 0);
}
