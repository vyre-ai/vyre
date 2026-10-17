// @ts-check
// The file preview of a Flow's email step reads each file as the person who STARTED the run too, not only as the approver: a member who starts a run cannot send, through a Flow, a file she could not open
// herself. On a real vyred with the kernel on: the owner files Rota/week1.pdf and a Flow whose email step carries it; the owner's run reaches its question (the preview read the file for the owner), and a run
// started by a member who is not allowed that file stops at the preview with the plain error and asks nobody. Nothing is sent in either case.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "./index.js";
import { tempHome, present } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const until = async (/** @type {() => any} */ fn, /** @type {string} */ what, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("a run started by a member who may not read an attached file stops at the preview with the plain error; the owner's run asks its question", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const chain = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  await K.gateway.grants.setRole(chain(OWNER), { person: BEN, role: "member" }, { presence: proof() });
  const as = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await K.surfaces.open(chain(who), {})).token });
  const ok = async (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await as(who, tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };

  await ok(OWNER, "vault.put", { name: "comms-sending", kind: "env-set", fields: { service: "resend", api_key: "re_live_TEST_KEY_0002", from: "Juniper Studio <hello@juniper.example>", domain: "juniper.example" } });
  await ok(OWNER, "vault.grant", { name: "comms-sending", module: "comms" });
  await ok(OWNER, "files.drive.upload", { path: "Rota/week1.pdf", base64: Buffer.from("%PDF-ROTA-WEEK-1").toString("base64") });

  const mail = { id: "mail", kind: "call", action: "comms.email", resource: "vyre://space/comms", approve: true,
    input: { to: "dana@northwind-bakery.example", subject: "The rota", text: "Attached.", attachments: [{ path: "Rota/week1.pdf", name: "Rota week 1.pdf" }] } };
  const def = await ok(OWNER, "flows.define", { flow: { format: 1, name: "send_rota", label: "send_rota", authorship: "human", trigger: { on: "manual" }, steps: [mail] } });
  assert.ok(def.ok, JSON.stringify(def.errors || def));
  const host = /** @type {any} */ (d.registry.deps).flowsHost.get(K.id.space);
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.id, version: def.version, hash: def.hash });
  // Ben may run the Flow, but the file is not his to read
  await ok(OWNER, "flows.access.set", { id: def.id, subject: BEN, level: "use" });

  const questions = async () => (await K.gateway.ask.list(chain(OWNER), { state: ["needs_check"] })).filter((/** @type {any} */ x) => x.form && x.form.kind === "held_act");
  const finalState = async (/** @type {string} */ who, /** @type {string} */ run) => until(async () => { const r = (await ok(who, "flows.run", { run })).run; return ["done", "failed"].includes(r.state) || r.state === "waiting" ? r : null; }, "the run to settle");

  const mine = await ok(BEN, "flows.start", { id: def.id });
  const benRun = String(mine.id || (mine.run && mine.run.id) || mine.run);
  const ben = await finalState(OWNER, benRun);
  assert.equal(ben.state, "failed", JSON.stringify(ben));
  assert.match(JSON.stringify(ben), /Rota\/week1\.pdf cannot be attached: it is not in your Files, or you may not read it/, "the plain error, from the preview as the starter");
  assert.deepEqual(await questions(), [], "nobody was asked about a file the starter could not read");

  const theirs = await ok(OWNER, "flows.start", { id: def.id });
  const ownerRun = String(theirs.id || (theirs.run && theirs.run.id) || theirs.run);
  const q = await until(async () => (await questions()).find((/** @type {any} */ x) => x.form.run === ownerRun), "the owner's run to ask its question");
  assert.ok(q, "the owner's run passed the preview and asked");
});
