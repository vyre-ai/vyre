// @ts-check
// An update that brings new record types to a slow Records store must not keep Flows and Kits answering "waiting" for its whole length: Flow tools answer as soon as the Flow record types
// exist, the core and Kit storage types are added after, in the background, and while the store is still adding an update's new types the words say so and that it finishes on its own.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_TYPES } from "../../records/core-types.js";
import { guardUntilReady, upgradeOf, flowsUpgrading, FLOWS_WAITING, FLOWS_STUCK, createFlowsHost } from "./flows-host.js";

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

test("guardUntilReady: while Records add an update's new types the words say how far and that it finishes on its own; stuck still wins; otherwise the old words", async () => {
  /** @type {any} */ let u = { done: 3, total: 13 };
  const tools = { "flows.list": async () => ["a"] };
  guardUntilReady(tools, () => false, () => false, () => u);
  await assert.rejects(() => tools["flows.list"](), (/** @type {any} */ e) => e.code === "unavailable" && e.message === "Records are being upgraded (3 of 13 new types). This finishes on its own.");
  assert.doesNotMatch(flowsUpgrading(u), /Try again/);
  u = null;
  await assert.rejects(() => tools["flows.list"](), { message: FLOWS_WAITING });
  const t2 = { "flows.list": async () => ["a"] };
  guardUntilReady(t2, () => false, () => true, () => ({ done: 1, total: 2 }));
  await assert.rejects(() => t2["flows.list"](), { message: FLOWS_STUCK });
});

test("upgradeOf: a store's { done, total }, or null for one with no upgrade or a broken answer", () => {
  assert.deepEqual(upgradeOf({ upgrade: () => ({ done: 1, total: 4, pending: ["a"] }) }), { done: 1, total: 4 });
  assert.equal(upgradeOf({ upgrade: () => null }), null);
  assert.equal(upgradeOf({}), null);
  assert.equal(upgradeOf({ upgrade: () => { throw new Error("x"); } }), null);
  assert.equal(upgradeOf(undefined), null);
});

test("Flow tools answer within a bounded time on a store whose core-type definitions take seconds: the core and Kit storage types are added after, in the background", async (t) => {
  const { newKernel, prepareKernel, OWNER, SPACE } = await import("../planner/testing.js");
  const k = await newKernel(null);
  await prepareKernel(k);
  // every define that adds a core type takes 1.5 s, as the record store's per-field cache rebuild does on a live server (scaled down)
  const core = new Set(CORE_TYPES.map((c) => c.name));
  const realDefine = k.store.define.bind(k.store);
  /** @type {string[][]} */ const seen = [];
  k.store.define = async (/** @type {any} */ diff) => { const adds = (diff.add_types || []).map((/** @type {any} */ x) => x.name); seen.push(adds); if (adds.some((/** @type {string} */ n) => core.has(n))) await sleep(1500); return realDefine(diff); };
  /** @type {string[]} */ const log = [];
  const host = createFlowsHost({ log: (m) => log.push(m), retryMs: 10, restWaitMs: 100 });
  t.after(() => host.stop());
  const t0 = Date.now();
  const h = await host.attach(SPACE, k, OWNER);
  const chain = k.chains.fromFacts({ kind: "device", device_key_id: "d", person: OWNER, path: "direct", session: "s" });
  await h.flows.tools["flows.list"](chain, {});
  const took = Date.now() - t0;
  assert.ok(took < 1500, `a Flow call answered ${took} ms after attach began, before the slow core types (1.5 s)`);
  assert.ok(seen.length && !seen[0].some((n) => core.has(n)), `the first define is the Flow and Kit types alone: ${JSON.stringify(seen[0])}`);
  const have = async () => new Set((await k.store.types()).map((/** @type {any} */ x) => x.name));
  assert.ok(!(await have()).has("contact"), "the core types are still being added");
  for (let i = 0; i < 300 && !log.some((l) => /other record types for .* are up to date/.test(l)); i++) await sleep(20);
  assert.ok((await have()).has("contact") && (await have()).has("template"), "the core types were added after, with no Flow call held for them");
  assert.ok(log.some((l) => /other record types for .* are up to date/.test(l)), log.join(" | "));
});

test("the Flows host leaves the core types an update is adding to the store, so they are not made twice in one long define", async (t) => {
  const { newKernel, prepareKernel, OWNER, SPACE } = await import("../planner/testing.js");
  const k = await newKernel(null);
  await prepareKernel(k);
  // an older Space: it has its contact type (so no base Kit), and its store is adding every other new core type
  await k.store.define({ add_types: CORE_TYPES.filter((c) => c.name === "contact") });
  const pending = CORE_TYPES.filter((c) => c.name !== "event" && c.name !== "contact").map((c) => c.name);
  /** @type {any} */ (k.store).upgrade = () => ({ done: 0, total: pending.length, pending });
  const realDefine = k.store.define.bind(k.store);
  /** @type {string[]} */ const added = [];
  k.store.define = async (/** @type {any} */ diff) => { for (const x of diff.add_types || []) added.push(x.name); return realDefine(diff); };
  /** @type {string[]} */ const log = [];
  const host = createFlowsHost({ log: (m) => log.push(m), retryMs: 10 });
  t.after(() => host.stop());
  await host.attach(SPACE, k, OWNER);
  for (let i = 0; i < 200 && !log.some((l) => /other record types for .* (are up to date|were not)/.test(l)); i++) await sleep(20);
  assert.ok(log.some((l) => /other record types for .* (are up to date|were not)/.test(l)), log.join(" | "));
  assert.deepEqual(added.filter((n) => pending.includes(n)), [], "the Flows host added none of the core types the store is adding");
  assert.ok(added.length > 0, "it still added the Flow, Kit and Kit storage types");
});

test("a Space made before 0.6.4 loses the base Kit's second Lead when it holds no record; a second Client that holds one, and a Lead a person changed, stay", async (t) => {
  const { newKernel, prepareKernel, OWNER, SPACE } = await import("../planner/testing.js");
  const k = await newKernel(null);
  await prepareKernel(k);
  const contact = CORE_TYPES.find((c) => c.name === "contact");
  const stage = (/** @type {string[]} */ o) => ({ name: "stage", kind: "stage", label: "Stage", options: o });
  const link = { name: "contact", kind: "link", label: "Contact", required: true, to: "contact" };
  // the base Kit's own Lead and Client as an older Space has them, with the core Contact (so the Kit is not installed again)
  const lead = { name: "lead", label: "Lead", fields: [link, { name: "source", kind: "choice", label: "Source", options: ["Website", "Other"] }, { name: "summary", kind: "rich_text", label: "What they need" }, stage(["New", "Lost"])], stages: [{ name: "New" }, { name: "Lost" }], role: { link: "contact", ended: ["Lost"] } };
  const client = { name: "client", label: "Client", fields: [link, { name: "since", kind: "date", label: "Client since" }, stage(["Active", "Closed"])], stages: [{ name: "Active" }, { name: "Closed" }], role: { link: "contact", ended: ["Closed"] } };
  await k.store.define({ add_types: [contact, lead, client] });
  const chain = k.chains.fromFacts({ kind: "device", device_key_id: "d", person: OWNER, path: "direct", session: "s" });
  const person = await k.gateway.records.create(chain, "contact", { name: "Sample Person" });
  await k.gateway.records.create(chain, "client", { contact: { urn: person.urn }, stage: "Active" });
  /** @type {string[]} */ const log = [];
  const host = createFlowsHost({ log: (m) => log.push(m), retryMs: 10 });
  t.after(() => host.stop());
  await host.attach(SPACE, k, OWNER);
  for (let i = 0; i < 300 && !log.some((l) => /other record types for .* (are up to date|were not)/.test(l)); i++) await sleep(20);
  const names = new Set((await k.store.types()).map((/** @type {any} */ x) => x.name));
  assert.ok(!names.has("lead"), `the empty second Lead is gone: ${log.join(" | ")}`);
  assert.ok(names.has("client"), "the second Client holds a record, so it stays");
  assert.ok(names.has("role-lead") && names.has("role-client"), "the Space's own roles stand");
  assert.ok(log.some((l) => /took away the base Kit's second lead/.test(l)), log.join(" | "));
});
