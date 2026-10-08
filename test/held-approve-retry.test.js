// @ts-check
// A held outward call that the person approves on the phone runs when the asker retries with the approval. Before 0.2.13 the card held for the registry named
// no asking device, so the retry was refused as a wrong request and nothing that waited for a yes could ever go out.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../core/modules/index.js";
import { Events } from "../kernel/bus.js";
import { open } from "../core/store/index.js";
import { configureYes } from "../lib/one-yes.js";
import { tempHome, writeModule } from "./helpers.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canon = (/** @type {any} */ o) => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));

test("an approved held call runs on the asker's retry, once, and only that call", async t => {
  /** @type {any[]} */ const sent = [];
  /** @type {any} */ (globalThis).__heldSent = sent;
  t.after(() => { delete (/** @type {any} */ (globalThis)).__heldSent; configureYes({ verify: null }); });
  configureYes({ softwareOk: () => true, verify: async ({ op, fields, proof }) => (proof && proof.ok === true && proof.for === canon({ op, fields: canon(fields) }) ? null : "bad_signature") });
  const home = tempHome(t), root = path.join(home, "mods");
  writeModule(root, "mail", { version: "0.1.0", vyre: "1", description: "Sends mail.", does: { tools: [{ name: "mail.send", reach: "anyone", outward: true, summary: "send an email" }] } },
    `export default { async start(ctx) { ctx.tool("mail.send", { callers: ["cli", "mcp", "harness", "module"], input: { type: "object" }, run: async (i) => { globalThis.__heldSent.push(i); return { sent: i.to }; } }); return {}; } };`);
  fs.mkdirSync(path.join(root, "approvals"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "core", "approvals", "module.json"), path.join(root, "approvals", "module.json"));
  fs.writeFileSync(path.join(root, "approvals", "index.js"), `export { default } from ${JSON.stringify(path.join(REPO, "core", "approvals", "index.js"))};`);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  const reg = new Registry({ db, events: new Events(db), config: { role: "local" }, log: () => {}, kernel: { proofFrom: (/** @type {any} */ m) => (m.proof ? { presence: m.proof } : undefined) } });
  reg.firstPartyRoots = [root];
  await reg.start(discover([root], { firstPartyRoots: [root] }), { role: "local" });
  const mail = { to: "Northwind", subject: "Invoice 1042 is overdue" };
  const held = await reg.call("mail.send", mail, "mcp:agent:kit");
  assert.equal(held.error && held.error.code, "held_for_approval", JSON.stringify(held));
  const card = (await reg.call("approvals.pending", {}, "cli")).data.approvals.find((/** @type {any} */ c) => c.id === held.error.approval);
  const proof = { ok: true, payload_hash: card.payload_hash, for: canon({ op: card.request.op, fields: canon(card.request.fields) }) };
  const ans = await reg.call("approvals.answer", { id: card.id, approve: true }, "cli", { proof });
  assert.ok(!ans.error, JSON.stringify(ans));
  const run = await reg.call("mail.send", mail, "mcp:agent:kit", { approval: card.id });
  assert.equal(run.data && run.data.sent, "Northwind", JSON.stringify(run));
  assert.equal(sent.length, 1);
  assert.equal((await reg.call("mail.send", mail, "mcp:agent:kit", { approval: card.id })).error.code, "approval_refused", "a yes is spent once");
  assert.equal((await reg.call("mail.send", { ...mail, to: "Eastgate" }, "mcp:agent:kit", { approval: card.id })).error.code, "approval_refused", "and covers only that call");
});
