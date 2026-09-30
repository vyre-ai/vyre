// @ts-check
// vyre-core phase 2a, vyred's side: on a core-linked Mac the registry passes a `core` tool's
// proof through untouched (core checks and spends it, never vyred first), and the vault module
// forwards to core, refuses plain values outside the Capsule, and answers core_owned for every
// slice that hasn't moved. Its old store is never opened.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { startCore } from "./server.js";
import { coreLink } from "../../lib/vyre-core-client.js";
import { core as coreHolder, inputHash } from "../presence/index.js";
import { discover, Registry } from "../modules/index.js";
import { startForwarder } from "../vault/forward.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import { TEST_KDF } from "../vault/testing.js";
import { tempHome, writeModule } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";

const uid = typeof process.getuid === "function" ? process.getuid() : 0;

async function world(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vf-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socket = path.join(dir, "c.sock");
  const c = await startCore({ socket, dataDir: path.join(dir, "data"), ownerUid: uid, testKdf: TEST_KDF, peerCred: async () => ({ pid: process.pid, uid }) });
  t.after(() => c.close());
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyId = c.presence.enroll({ kind: "device", name: "alex-phone", public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 }).id;
  const proof = (tool, input) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    return { method: "device", key: keyId, ts, nonce, sig };
  };
  return { c, link: coreLink({ socket, uid }), proof };
}

test("vyre-core forward: the registry passes a core tool's proof through untouched, only when core is linked", async t => {
  const asked = [];
  const presence = { required: () => true, verify: async a => { asked.push(a.tool); return { ok: false, message: "vyred checked it", methods: [] }; } };
  const home = tempHome(t);
  const root = path.join(home, "mods");
  writeModule(root, "notes", { name: "notes", version: "0.1.0", does: { tools: ["notes.add"] } },
    `export default { async start(ctx) { ctx.tool("notes.add", { input: { type: "object" }, run: async (input, meta) => ({ proof: meta.coreProof ?? null }) }); return {}; } };`);
  // A module that isn't one of Vyre's own can't turn vyred's presence check off for its tool.
  writeModule(root, "evil", { name: "evil", version: "0.1.0", does: { tools: ["evil.take"] } },
    `export default { async start(ctx) { ctx.tool("evil.take", { core: true, run: async () => 1 }); return {}; } };`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, presence });
  await reg.start(discover([root]), { role: "local" });
  assert.equal((await reg.call("evil.take", {}, "cli")).error.code, "no_such_tool", "a third-party core tool never registers");
  // notes.add stands in for a first-party forwarder (the vault's, on a core Mac).
  reg.tools.get("notes.add").core = true;
  const proof = { method: "device", key: "k1", ts: "1", nonce: "abcdefgh", sig: "s" };
  // No core: vyred's own floor applies, as everywhere today.
  assert.equal((await reg.call("notes.add", {}, "cli", { proof })).error.code, "presence_required");
  assert.deepEqual(asked, ["notes.add"]);
  coreHolder.link = /** @type {any} */ ({ verify: async () => ({ ok: false }), keys: async () => [], challenge: async () => ({}), call: async () => ({}) });
  try {
    assert.deepEqual((await reg.call("notes.add", {}, "cli", { proof })).data, { proof: "device key=k1 ts=1 nonce=abcdefgh sig=s" });
    assert.deepEqual(asked, ["notes.add"], "vyred never checked (or spent) it");
  } finally { coreHolder.link = null; }
});

test("vyre-core forward: the vault module forwards to core, refuses plain values, and has no store of its own", async t => {
  const { c, link, proof } = await world(t);
  /** @type {Map<string, any>} */
  const tools = new Map();
  const ctx = { tool: (n, d) => tools.set(n, d), log: () => {} };
  startForwarder(ctx, link);
  const run = (tool, input, meta = {}) => tools.get(tool).run(input, meta);
  const header = (tool, input) => { const p = proof(tool, input); return `device key=${p.key} ts=${p.ts} nonce=${p.nonce} sig=${p.sig}`; };

  // Every tool the manifest declares is here, each marked for core.
  const declared = JSON.parse(fs.readFileSync(new URL("../vault/module.json", import.meta.url), "utf8")).does.tools;
  assert.deepEqual([...tools.keys()].sort(), [...declared].sort());
  assert.ok([...tools.values()].every(d => d.core === true));

  const put = await run("vault.put", { name: "orders-imap", kind: "secret", fields: { value: "imap-pass-1042" } });
  assert.equal(put.unverified, true, "no proof came with it: core marks it unverified");
  const verify = { name: "orders-imap" };
  await run("vault.verify", verify, { coreProof: header("vault.verify", verify) });
  const grant = { name: "orders-imap", module: "mail" };
  await run("vault.grant", grant, { coreProof: header("vault.grant", grant) });
  // A release names the module the registry vouched for; one named in the input is ignored.
  assert.deepEqual(await run("vault.release", { name: "orders-imap", module: "google" }, { caller: "module:mail" }), { value: "imap-pass-1042" });
  await assert.rejects(run("vault.release", { name: "orders-imap" }, { caller: "module:google" }), /not granted to google/);
  await assert.rejects(run("vault.release", { name: "orders-imap" }, { caller: "cli" }), /only modules/);
  // A terminal never gets a plain value here: the Capsule does.
  await assert.rejects(run("vault.reveal", { name: "orders-imap" }, { caller: "cli" }), e => /** @type {any} */ (e).code === "core_owned" && /only in the Capsule/.test(e.message));
  // A slice that hasn't moved says so plainly.
  await assert.rejects(run("vault.import", {}, { caller: "cli" }), e => /** @type {any} */ (e).code === "core_owned" && /on this Mac yet/.test(e.message));
  // Core's own store has it; nothing was opened on vyred's side.
  assert.ok(c.vault.exists("orders-imap"));
});

test("vyre-core forward: core's events reach vyred's log as core's and as information only", async t => {
  const { link } = await world(t);
  /** @type {Map<string, any>} */
  const tools = new Map();
  const seen = [];
  const ctx = { tool: (n, d) => tools.set(n, d), log: () => {}, events: { emit: (type, payload) => seen.push({ type, payload }) } };
  const f = startForwarder(ctx, link);
  t.after(() => f.stop());
  await tools.get("vault.put").run({ name: "orders-imap", kind: "secret", fields: { value: "imap-pass-1042" } }, {});
  for (let i = 0; i < 50 && !seen.some(e => e.type === "vault.item-added"); i++) await new Promise(r => setTimeout(r, 20));
  const ev = seen.find(e => e.type === "vault.item-added");
  assert.ok(ev, JSON.stringify(seen));
  assert.equal(ev.payload.name, "orders-imap");
  assert.equal(ev.payload.source, "vyre-core");
  assert.equal(ev.payload.informational, true);
  assert.ok(!JSON.stringify(seen).includes("imap-pass-1042"), "no value ever rides an event");
});

test("vyre-core forward: after core restarts (its count back at 0), vyred follows the new count", async t => {
  const calls = [];
  let n = 0;
  const link = /** @type {any} */ ({ call: async () => ({}), events: async after => {
    calls.push(after);
    n++;
    if (n === 1) return { events: [{ seq: 9, type: "vault.item-added", payload: { name: "a" } }], last: 9 };
    if (n === 2) return { events: [], last: 1 };                       // core came back
    if (n === 3) return { events: [{ seq: 1, type: "vault.item-added", payload: { name: "b" } }], last: 1 };
    await new Promise(r => setTimeout(r, 5));
    return { events: [], last: 1 };
  } });
  const seen = [];
  const f = startForwarder({ tool: () => {}, log: () => {}, events: { emit: (type, p) => seen.push(p.name) } }, link);
  for (let i = 0; i < 50 && !seen.includes("b"); i++) await new Promise(r => setTimeout(r, 10));
  await f.stop();
  assert.deepEqual(seen.slice(0, 2), ["a", "b"]);
  assert.deepEqual(calls.slice(0, 3), [0, 9, 0]);
});
