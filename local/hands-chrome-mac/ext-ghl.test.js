// @ts-check
// ghl capability: context parsing, tab reuse for sections, and one batch round trip per flow.
import test from "node:test";
import assert from "node:assert/strict";
import ghl, { parse, FLOWS, SECTIONS } from "./extension/caps/ghl.js";
import { dispatch } from "./extension/caps/index.js";

const LOC = "MRKcUjapWpnOvQslF3Pc";

test("parse reads host, location and section, and refuses other hosts", () => {
  const p = parse(`https://app.gohighlevel.com/v2/location/${LOC}/automation/workflows/abc`);
  assert.deepEqual([p.isGhl, p.locationId, p.section], [true, LOC, "workflows"]);
  assert.equal(parse("https://example.com/v2/location/" + LOC).isGhl, false);
  assert.equal(parse("nonsense").isGhl, false);
  assert.equal(parse("https://mail.google.com/").isGhl, false);
  assert.equal(parse("https://crm.harlow.example/v2/location/" + LOC + "/contacts", ["crm.harlow.example"]).section, "contacts");
});

const fakeCtx = (/** @type {any} */ o = {}) => {
  const calls = /** @type {any[]} */ ([]);
  return {
    calls,
    stopped: () => false,
    storage: { get: async () => o.hosts },
    tabs: {
      active: async () => o.active || { id: 1, url: "https://example.com/" },
      get: async (/** @type {number} */ id) => (o.tabs || []).find((/** @type {any} */ t) => t.id === id),
      query: async () => o.tabs || [],
    },
    call: async (/** @type {string} */ op, /** @type {any} */ a) => { calls.push([op, a]); return o.result || { ok: true, done: (a.steps || []).length, results: [] }; },
    floorAllows: async () => ({ allow: true }),
  };
};

test("ghl.section reuses the open GoHighLevel tab and never opens one", async () => {
  const ctx = fakeCtx({ tabs: [{ id: 7, url: `https://app.gohighlevel.com/v2/location/${LOC}/contacts` }, { id: 8, url: "https://example.com" }] });
  await ghl.ops["ghl.section"]({ section: "workflows" }, ctx);
  assert.deepEqual(ctx.calls[0], ["tabs.navigate", { tabId: 7, url: `https://app.gohighlevel.com/v2/location/${LOC}/${SECTIONS.workflows}`, asked: false }]);
  await assert.rejects(() => ghl.ops["ghl.section"]({ section: "workflows" }, fakeCtx({ tabs: [{ id: 8, url: "https://example.com" }] })), /no GoHighLevel tab is open/);
  await assert.rejects(() => ghl.ops["ghl.section"]({ section: "nope" }, ctx), /unknown section/);
});

test("ghl.run compiles a flow into ONE batch call and reports its timing", async () => {
  const ctx = fakeCtx();
  const r = await ghl.ops["ghl.run"]({ flow: "create-workflow", params: { name: "Welcome flow", trigger: "contact-created", actions: [{ type: "send-email", config: "hi" }, { type: "wait", config: "15" }] } }, ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0][0], "batch.run");
  assert.equal(ctx.calls[0][1].steps.length, 4 + 4 * 2 + 1);
  assert.equal(r.flow, "create-workflow");
  assert.equal(r.steps, 13);
  assert.ok(typeof r.ms === "number");
  const fill = ctx.calls[0][1].steps.find((/** @type {any} */ s) => s.op === "page.fill");
  assert.equal(fill.args.fields[0].value, "Welcome flow");
});

test("ghl.run takes inline steps with {param} templates, and refuses an unknown flow", async () => {
  const ctx = fakeCtx();
  await ghl.ops["ghl.run"]({ steps: [{ op: "page.fill", args: { fields: [{ selector: { name: "Tag" }, value: "{tag}" }] } }], params: { tag: "new-lead" } }, ctx);
  assert.equal(ctx.calls[0][1].steps[0].args.fields[0].value, "new-lead");
  await assert.rejects(() => ghl.ops["ghl.run"]({ flow: "nope" }, ctx), /no such flow/);
  assert.ok(Object.keys(FLOWS).length >= 2);
});

test("the registry knows the ghl ops and treats a run as acting", async () => {
  const stopped = { ...fakeCtx(), stopped: () => true };
  await assert.rejects(() => dispatch("ghl.run", { flow: "open-contact", params: { row: 0 } }, stopped), e => /** @type {any} */ (e).code === "stopped");
  const r = await dispatch("ghl.flows", {}, fakeCtx());
  assert.ok(r.flows.some((/** @type {any} */ f) => f.name === "create-workflow"));
});

test("dispatch gives every capability both spellings of the tab", async () => {
  const seen = /** @type {any[]} */ ([]);
  const { register } = await import("./extension/caps/index.js");
  register({ name: "spelltest", ops: { "spelltest.echo": async a => { seen.push(a); return {}; } } });
  await dispatch("spelltest.echo", { tab: 5 }, fakeCtx());
  await dispatch("spelltest.echo", { tabId: 6 }, fakeCtx());
  assert.deepEqual(seen.map(a => [a.tab, a.tabId]), [[5, 5], [6, 6]]);
});
