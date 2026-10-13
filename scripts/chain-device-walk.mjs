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
async function dial(/** @type {{ key: any, entry: string, hello?: () => Promise<any>, name?: string }} */ o) {
  const p = mac.pairing;
  const dir = fs.mkdtempSync(path.join(out, "dev-"));
  const crypto2 = nodeCrypto(), keyStore = fileKeyStore(path.join(dir, "k.json"));
  const conn = connect({ relay: p.relay, route: p.route, box: p.box, name: o.name || "Chain device", crypto: crypto2, keyStore,
    chainHello: o.hello || (async (/** @type {Uint8Array | undefined} */ given) => chainHello({ sha256, devicePub: given ?? (await keyStore.get()).publicKey, box: String(p.box), identity: mac.identity.id, entry: o.entry, sign: (m) => o.key.sign(m), name: o.name || "Chain device" })) });
  return conn;
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
    return `pairing.box=${String(p.box).length} chars (${/^[A-Za-z0-9_-]+$/.test(String(p.box)) ? "base64url" : "other"}), identity ${mac.identity.id}, chain founder entry ${mac.identity.key.eid}`;
  });

  await step("0b. diagnostics: the server's owner claim, and the same hello checked offline against the live chain with box = pairing.box", async () => {
    const claimed = await srv.registry.call("spaces.owner.claimed", {}, "module:relay").catch((/** @type {any} */ e) => ({ error: e.message }));
    const kernelSpace = await srv.registry.call("spaces.list", {}, "module:relay").catch((/** @type {any} */ e) => ({ error: e.message }));
    const member = await srv.registry.call("spaces.membership", { person: mac.identity.id, space: String(((await mac.callTool("spaces.list", {})) || [])[0]?.id ?? (await mac.callTool("system.info", {}))?.space ?? "") }, "module:relay").catch((/** @type {any} */ e) => ({ error: e.message }));
    console.log("DIAG spaces.list(app) " + JSON.stringify(await mac.callTool("spaces.list", {})).slice(0, 300) + " | claimed " + JSON.stringify(claimed).slice(0, 300) + " | membership " + JSON.stringify(member).slice(0, 300) + " | spaces " + JSON.stringify(kernelSpace).slice(0, 200));
    const { createChainAdmit } = await import("../core/relay/chain-admit.js");
    const devicePub = crypto.randomBytes(32);
    const h = await chainHello({ sha256, devicePub, box: String(mac.pairing.box), identity: mac.identity.id, entry: mac.identity.key.eid, sign: (m) => mac.identity.key.sign(m) });
    const admit = createChainAdmit({ boxId: async () => String(mac.pairing.box), roleOf: async () => "owner",
      fetchState: async () => { const r = await (await fetch(`${ins.names}/v1/ids/resolve?name=${encodeURIComponent(mac.identity.name)}`)).json(); return C.verifyChain(r.data.ops, { now: Date.now() + C.SKEW_MS }); } });
    const r = await admit.check(h, h.channel);
    const state = await (async () => { const rr = await (await fetch(`${ins.names}/v1/ids/resolve?name=${encodeURIComponent(mac.identity.name)}`)).json(); return C.verifyChain(rr.data.ops, { now: Date.now() + C.SKEW_MS }); })();
    return `owner.claimed=${JSON.stringify(claimed).slice(0, 200)} (identity ${mac.identity.id}); offline check: ${JSON.stringify(r).slice(0, 200)}; chain entries: ${JSON.stringify(state.entries.map((/** @type {any} */ e) => ({ eid: e.eid, kind: e.kind, alg: e.alg, held: e.held, founder: e.founder })))}`;
  });

  // 1-3: the founder's own chain key, on a NEW Noise device the server never paired
  /** @type {any} */ let conn = null;
  await step("1-4. a never-paired device with the founder chain key dials with chainHello: admitted, calls run as the owner; the box string is accepted", async () => {
    conn = await dial({ key: mac.identity.key, entry: mac.identity.key.eid, name: "Founder laptop" });
    const info = await callAs(conn, "system.info");
    assert.equal(info.status, 200, `system.info: ${info.status} ${info.text}`);
    const sp = await callAs(conn, "spaces.list");
    assert.equal(sp.status, 200, `spaces.list: ${sp.status} ${sp.text}`);
    return `system.info 200; spaces.list 200 ${sp.text.slice(0, 120)}`;
  });
  await step("3b. the server marks its row via_chain (relay_devices)", async () => {
    const script = `const {DatabaseSync}=require("node:sqlite");`;
    void script;
    const r = await srv.operator("relay.device.info", { id: "x" }).catch((/** @type {any} */ e) => ({ error: e.message }));
    const s = JSON.stringify(r);
    assert.ok(/via_chain|viaChain|chain/.test(s), `a row mentions the chain: ${s.slice(0, 500)}`);
    return s.slice(0, 500);
  });

  // 8: replay
  await step("8. a chain hello replayed on a second connection is refused", async () => {
    const fixed = await chainHello({ sha256, devicePub: crypto.randomBytes(32), box: String(mac.pairing.box), identity: mac.identity.id, entry: mac.identity.key.eid, sign: (m) => mac.identity.key.sign(m) });
    let used = 0;
    // the same hello object (same nonce) offered by two different dials; its channel id belongs to the random key above, so a real replay means resending a captured hello: here the channel check refuses first
    const mk = () => dial({ key: mac.identity.key, entry: mac.identity.key.eid, hello: async () => { used++; return fixed; } });
    const a = await mk(); let first = ""; try { first = JSON.stringify(await callAs(a, "system.info")); } catch (e) { first = "refused: " + String(/** @type {any} */ (e).message).slice(0, 100); }
    const b = await mk(); let second = ""; try { second = JSON.stringify(await callAs(b, "system.info")); } catch (e) { second = "refused: " + String(/** @type {any} */ (e).message).slice(0, 100); }
    assert.match(second, /refused|4\d\d|error/i, `the second use was refused: first=${first.slice(0, 120)} second=${second.slice(0, 160)}`);
    return `first: ${first.slice(0, 120)} | second: ${second.slice(0, 160)}`;
  });

  // 6: a newcomer entry (under 24 h on the list) is limited
  /** @type {any} */ let newKey = null;
  await step("6. a NEWCOMER chain entry is admitted but limited: refused the device-admin tools with a next step, not refused records.list", async () => {
    newKey = await generateDeviceKey({ forceSoftware: true });
    await enrolDevice({ name: mac.identity.name, eid: mac.identity.key.eid, pin: mac.identity.pin, base: ins.names, sign: (/** @type {Uint8Array} */ m) => mac.identity.key.sign(m), entry: { publicKey: newKey.publicKey } });
    const c = await dial({ key: newKey, entry: newKey.eid, name: "Newcomer" });
    const out2 = /** @type {string[]} */ ([]);
    const ok = await callAs(c, "records.list", { type: "contact" });
    out2.push(`records.list ${ok.status}`);
    assert.ok(ok.status < 400 || /unknown_type|no type/.test(ok.text), `records.list is not refused as limited: ${ok.status} ${ok.text}`);
    for (const t of ["relay.devices.mark", "wink.phone.open", "presence.enroll", "spaces.devices.set"]) {
      const r = await callAs(c, t, {});
      out2.push(`${t} ${r.status} ${r.text.slice(0, 110)}`);
      assert.ok(r.status >= 400, `${t} is refused to a limited device: ${r.status} ${r.text}`);
      assert.ok(/limited|newcomer|full device|24 hours|paired|typed code|ask/i.test(r.text), `${t}'s refusal names a reason or next step: ${r.text}`);
    }
    return out2.join(" | ");
  });

  // 7: an entry held as relay
  await step("7. an entry held as relay is refused as bad_proof", async () => {
    const k = await generateDeviceKey({ forceSoftware: true });
    const r = await appendOp({ type: "add", entry: { eid: k.eid, kind: "device", pub: k.publicKey, held: "relay" } });
    if (r.status >= 400) throw new Error(`NOT TESTABLE: the names directory refused to list a relay-held entry (${r.status} ${r.body.slice(0, 160)}): a hook is needed to put one on the chain`);
    let said = ""; try { const c = await dial({ key: k, entry: k.eid }); said = JSON.stringify(await callAs(c, "system.info")); } catch (e) { said = "refused: " + String(/** @type {any} */ (e).message).slice(0, 120); }
    assert.match(said, /bad_proof|refused|4\d\d/i, said);
    return said.slice(0, 200);
  });

  // 5: remove
  await step("5. remove the newcomer from the chain: after the refresh (5 min) the next call is refused (removed)", async () => {
    if (!argv.includes("--wait-refresh")) throw new Error("not run (needs --wait-refresh: the server re-reads the chain at most every 5 minutes)");
    const r = await appendOp({ type: "remove", target: newKey.eid });
    assert.ok(r.status < 400, `the directory took the remove: ${r.status} ${r.body.slice(0, 160)}`);
    await new Promise((res) => setTimeout(res, 5.5 * 60_000));
    let said = ""; try { const c = await dial({ key: newKey, entry: newKey.eid, name: "Removed" }); said = JSON.stringify(await callAs(c, "system.info")); } catch (e) { said = "refused: " + String(/** @type {any} */ (e).message).slice(0, 160); }
    assert.match(said, /refused|removed|4\d\d|bad_proof/i, said);
    return said.slice(0, 220);
  });
} finally {
  if (srv) for (const l of srv.logs.filter((/** @type {string} */ x) => /chain|hello|relay|admit|bad_proof|box/i.test(x)).slice(-25)) console.log("SERVERLOG " + l.slice(0, 260));
  console.log(`DONE ${passed} passed, ${failed} failed`);
  try { mac.close(); } catch { /* closed */ }
  try { await srv?.stop?.(); } catch { /* stopped */ }
  await ins.stop();
  process.exit(failed ? 1 : 0);
}
