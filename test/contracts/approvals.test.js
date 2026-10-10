// @ts-check
// Contract test for team/contracts/approvals.md (v1): the real mappers over the owners' rows and the real queue on a real daemon, against the fixtures a consumer builds with.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { fromAsks, fromHeld, fromVault, fromAttention, fromStuckTasks, fromHealth, fromEvals, ITEM_KINDS } from "../../core/approvals/items.js";
import { tempHome, present, asOwner } from "../helpers.js";
import { owners as O, cards as C, pendingCard, itemsAnswer, kinds, shapeDiff } from "./approvals.fixtures.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("approvals v1: every owner's row becomes the card the fixtures show, and the kinds are the ones the contract lists", () => {
  assert.deepEqual([...ITEM_KINDS], kinds);
  assert.deepEqual(fromAsks([O.ask])[0], C.ask);
  assert.deepEqual(fromAsks([O.question])[0], C.question);
  assert.deepEqual(fromAsks([O.mac])[0], C.askOnAMac);
  assert.deepEqual(fromHeld([O.held])[0], C.draft);
  assert.deepEqual(fromVault(O.vault)[0], C.access);
  assert.deepEqual(fromAttention([O.attention])[0], C.run);
  assert.deepEqual(fromAttention([O.gate])[0], C.gate);
  assert.deepEqual(fromStuckTasks([O.stuck])[0], C.task);
  assert.deepEqual(fromHealth(O.health)[0], C.health);
  assert.deepEqual(fromEvals([O.eval])[0], C.eval);
  for (const c of Object.values(C)) assert.ok(kinds.includes(c.kind), c.id);
});

test("approvals v1: a title that looks like a secret is dropped, a card never carries the words of a draft, and a card names the owner's tool that settles it", () => {
  const [bad] = fromHeld([{ ...O.held, summary: "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }]);
  assert.match(bad.title, /^A send via mail$/, "the summary is dropped whole and the card says what it is");
  assert.equal(JSON.stringify(C.draft).includes("body"), false);
  for (const c of Object.values(C)) assert.ok(c.answer && ("tool" in c.answer) && Array.isArray(c.answer.fill), `${c.id} says how it is answered`);
});

test("approvals v1: the queue on a real daemon lists a yes waiting on the phone as an approval card, the phone's list shows what it signs, and the change is an event", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", modules: { disable: ["agents", "computers"] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli") => d.registry.call(tool, input, caller);
  /** @type {any[]} */ const heard = [];
  d.events.on("approvals.changed", (/** @type {any} */ e) => heard.push(e.payload));

  const asked = await call("approvals.ask", { moment: "vault", request: { op: "vault.reveal", fields: { name: "stripe" } } });
  assert.match(asked.data.id, /^ap_/);
  const items = await call("approvals.items", {});
  assert.equal(shapeDiff(items.data, { items: [C.approval], recent: [] }), "", JSON.stringify(items));
  assert.equal(items.data.items[0].id, asked.data.id);
  assert.deepEqual(items.data.items[0].answer, { tool: "approvals.answer", input: { id: asked.data.id }, fill: ["yes"] });
  assert.ok(items.data.items.every((/** @type {any} */ c) => kinds.includes(c.kind)));
  assert.deepEqual(Object.keys(itemsAnswer).sort(), ["items", "recent"]);

  const pending = await call("approvals.pending", {});
  assert.equal(shapeDiff(pending.data.approvals[0], pendingCard), "", JSON.stringify(pending));
  assert.equal(pending.data.approvals[0].id, asked.data.id);
  assert.equal(pending.data.approvals[0].moment, "vault");

  // an agent held at the gate of an outward tool: a card with a plain title, never the digest or the words of the message
  const held = await call("mail.send", { to: "a@example.com", subject: "Hello", body: "the words of the message" }, "mcp:agent:kit");
  assert.equal(held.error.code, "held_for_approval");
  const again = await call("approvals.items", {});
  const hold = again.data.items.find((/** @type {any} */ c) => c.id === held.error.approval);
  assert.equal(hold.title, "An assistant (kit) wants to run mail.send");
  assert.ok(!JSON.stringify(hold).includes("the words of the message"));
  assert.ok((await call("approvals.items", {}, "mcp")).error, "a model does not list a person's waiting cards");

  await new Promise(r => setTimeout(r, 400));
  assert.ok(heard.length >= 1 && heard.every(p => Number.isInteger(p.count)), JSON.stringify(heard));
  assert.equal(heard[heard.length - 1].count, 2);
});
