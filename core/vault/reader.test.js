// @ts-check
// The member reader path: what the owner shared with a member at Read and at Edit and rotate actually works, through the kernel, one level at a time. Fill in cannot reveal; Read reveals but cannot change;
// Edit and rotate reveals, changes and rotates; taking the share back stops each at once; an agent can never reach Read; every reveal and change says who did it; each asks for the person's yes.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Access } from "./access.js";
import { register } from "./tools/reader.js";
import { kernelRig, SPACE } from "./kernel-rig.js";
import { levelActions } from "../../kernel/seal/uses.js";
import { SCRATCH } from "../../test/scratch.mjs";

const BOB = "per_bob", EVE = "per_eve";

async function mk(/** @type {import("node:test").TestContext} */ t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-reader-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const rig = await kernelRig({ people: [BOB, EVE], agents: { kit: "agt_kit" } });
  /** @type {any[]} */ const audit = [], events = [];
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file" } }, emit: (type, p) => events.push({ type, p }), log: () => {}, clock: rig.clock });
  const realAudit = v.audit.bind(v);
  v.audit = (/** @type {any[]} */ ...a) => { audit.push(a); return /** @type {any} */ (realAudit)(...a); };
  v.access = new Access(v, rig.ctx);
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await v.put({ name: "stripe", kind: "api-key", fields: { value: "sk-live-0001" } }, "cli");
  await v.put({ name: "cred", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["x.example.test"] }), secret: "s3cret" } }, "cli");
  /** @type {Map<string, any>} */ const tools = new Map();
  const rotated = /** @type {string[]} */ ([]);
  register({ ctx: { kernel: rig.ctx.kernel, log: () => {}, events: { emit: (/** @type {string} */ type, /** @type {any} */ p) => events.push({ type, p }) } }, vault: v, rotateItem: async (/** @type {string} */ name, /** @type {string} */ who) => { rotated.push(`${name}:${who}`); return { rotated: true }; },
    tool: (name, callers, _d, _i, run, needs) => tools.set(name, { run, callers, needs }) });
  const meta = (/** @type {string} */ who, extra = {}) => ({ caller: "device:abcdefghijklmnop", chain: rig.person(who), ...extra });
  const ask = (/** @type {string} */ name, /** @type {any} */ input, /** @type {string} */ who, extra) => tools.get(name).run(input, meta(who, extra));
  const share = async (/** @type {string} */ level, /** @type {string} */ item = "stripe", who = BOB) => {
    const i = { subject: { kind: "actor", actor: { kind: "person", id: who, space: SPACE } }, actions: [...levelActions(level)], resource: { prefix: await v.access.urn(item) }, conditions: {}, source: "vault:share" };
    return rig.gw.grants.create(rig.owner(), i, { presence: { n: Math.random() } });
  };
  const row = () => /** @type {any} */ (v.row("stripe"));
  return { v, rig, tools, ask, share, audit, events, rotated, row };
}

const REVEAL = "vault.me.shared.reveal", UPDATE = "vault.me.shared.update", ROTATE = "vault.me.shared.rotate";

test("Fill in cannot reveal, change or rotate: the item is simply not there for those acts", async t => {
  const { ask, share, rotated } = await mk(t);
  await share("use");
  await assert.rejects(ask(REVEAL, { item: "stripe" }, BOB), { code: "not_found" });
  await assert.rejects(ask(UPDATE, { item: "stripe", fields: { value: "x" } }, BOB), { code: "not_found" });
  await assert.rejects(ask(ROTATE, { item: "stripe" }, BOB), { code: "not_found" });
  assert.equal(rotated.length, 0);
  await assert.rejects(ask(REVEAL, { item: "stripe" }, EVE), { code: "not_found" }, "and nothing at all for someone it was not shared with");
  await assert.rejects(ask(REVEAL, { item: "ghost" }, BOB), { code: "not_found" }, "same words as an item that does not exist");
});

test("Read reveals the value for a moment and cannot change or rotate it; the reveal says who", async t => {
  const { ask, share, audit, events, row } = await mk(t);
  await share("reveal");
  const r = await ask(REVEAL, { item: "stripe" }, BOB);
  assert.equal(r.value, "sk-live-0001"); assert.ok(r.concealAfter > 0 && r.concealAfter <= 60);
  await assert.rejects(ask(UPDATE, { item: "stripe", fields: { value: "x" } }, BOB), { code: "not_found" });
  await assert.rejects(ask(ROTATE, { item: "stripe" }, BOB), { code: "not_found" });
  assert.ok(audit.some(a => a[0] === "reveal" && a[1] === "stripe" && String(a[2]).includes(BOB) && a[3] === true), "the reveal is logged with the person");
  assert.ok(events.some(e => e.type === "vault.revealed" && e.p.name === "stripe" && e.p.by === BOB));
  assert.equal(row().ver, 1, "nothing changed");
});

test("Edit and rotate reveals, changes and rotates, and every change says who did it", async t => {
  const { ask, share, audit, rotated, v } = await mk(t);
  await share("edit");
  assert.equal((await ask(REVEAL, { item: "stripe" }, BOB)).value, "sk-live-0001");
  await ask(UPDATE, { item: "stripe", fields: { value: "sk-live-0002", note: "rotated by hand" }, description: "Stripe live" }, BOB);
  assert.equal((await ask(REVEAL, { item: "stripe" }, BOB)).value, "sk-live-0002", "the new value is what she and the owner see");
  assert.equal((/** @type {any} */ (await v.fields(v.row("stripe")))).note, "rotated by hand", "a field she added is kept");
  assert.equal((await ask(ROTATE, { item: "stripe" }, BOB)).rotated, true);
  assert.deepEqual(rotated, [`stripe:person:${BOB}`], "rotation runs as her, not as the owner");
  assert.ok(audit.some(a => a[0] === "edit" && a[1] === "stripe" && String(a[2]).includes(BOB)), "the change is logged with the person");
});

test("taking the share back stops each act at once, and lowering it from Edit to Read stops the change but not the reveal", async t => {
  const { ask, share, rig } = await mk(t);
  const g = await share("edit");
  await ask(UPDATE, { item: "stripe", fields: { value: "sk-live-0003" } }, BOB);
  await rig.gw.grants.revoke(rig.owner(), g.id, "test", { presence: { n: 1 } });
  for (const [tool, input] of [[REVEAL, { item: "stripe" }], [UPDATE, { item: "stripe", fields: { value: "x" } }], [ROTATE, { item: "stripe" }]]) await assert.rejects(ask(/** @type {string} */ (tool), input, BOB), { code: "not_found" }, String(tool));
  const g2 = await share("reveal");
  assert.equal((await ask(REVEAL, { item: "stripe" }, BOB)).value, "sk-live-0003");
  await assert.rejects(ask(UPDATE, { item: "stripe", fields: { value: "x" } }, BOB), { code: "not_found" });
  await rig.gw.grants.revoke(rig.owner(), g2.id, "test", { presence: { n: 2 } });
  await assert.rejects(ask(REVEAL, { item: "stripe" }, BOB), { code: "not_found" });
});

test("an agent can never reach Read: the kernel refuses a grant of it, and the tools refuse a chain with an agent in it, whatever the person holds", async t => {
  const { ask, share, rig } = await mk(t);
  const agent = { kind: "actor", actor: { kind: "agent", id: rig.uid("kit"), space: SPACE } };
  for (const level of ["reveal", "edit"]) {
    const i = { subject: agent, actions: [...levelActions(level)], resource: { prefix: `vyre://${SPACE}/vault/x` }, conditions: {}, source: "vault:share" };
    await assert.rejects(rig.gw.grants.create(rig.owner(), i, { presence: { n: Math.random() } }), { code: "bad_input" }, level);
  }
  await share("edit");
  for (const tool of [REVEAL, UPDATE, ROTATE]) await assert.rejects(ask(tool, { item: "stripe", fields: { value: "x" } }, BOB, { chain: rig.assistant(rig.uid("kit"), BOB) }), /member's own vault|denied/, tool);
});

test("an api credential is never shown, changed or rotated through this path, whatever the level; the owner is not served here; each act asks for the person's yes", async t => {
  const { ask, share, tools } = await mk(t);
  await share("edit", "cred");
  for (const tool of [REVEAL, UPDATE, ROTATE]) await assert.rejects(ask(tool, { item: "cred", fields: { value: "x" } }, BOB), { code: "not_found" }, tool);
  await assert.rejects(ask(REVEAL, { item: "stripe" }, "per_owner"), /member's own vault|denied/);
  for (const tool of [REVEAL, UPDATE, ROTATE]) assert.ok(tools.get(tool).needs && typeof tools.get(tool).needs.summary === "function", `${tool} asks for presence`);
  for (const tool of [REVEAL, UPDATE, ROTATE]) for (const c of ["module", "mcp", "harness", "tailnet"]) assert.ok(!tools.get(tool).callers.includes(c), `${tool} not for ${c}`);
});
