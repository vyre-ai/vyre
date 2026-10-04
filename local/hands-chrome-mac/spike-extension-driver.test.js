// @ts-check
// The bench adapter that drives the real extension: CSS selectors become identifiers, tab ids come
// back in the bench's shape, and network capture starts when a tab is first used.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ExtensionDriver, toSelector, toProtoSteps } from "./bench/extension-driver.mjs";
import { allSelectors, WORKFLOW_STEPS } from "./bench/scenarios.mjs";

test("toSelector maps the fixtures' #id and data-testid to identifiers", () => {
  assert.deepEqual(toSelector("#f-first"), { identifier: "f-first" });
  assert.deepEqual(toSelector('[data-testid="create-workflow"]'), { identifier: "create-workflow" });
  assert.deepEqual(toSelector("Save"), { name: "Save" });
  for (const s of allSelectors()) assert.ok(toSelector(s).identifier, `${s} has an identifier`);
});

test("toProtoSteps produces real page.act and page.fill steps for the 20-step workflow", () => {
  const steps = toProtoSteps(WORKFLOW_STEPS, 9);
  assert.equal(steps.length, 20);
  assert.deepEqual(steps[0], { op: "page.act", args: { tabId: 9, selector: { identifier: "nav-automation" }, kind: "click" } });
  assert.equal(steps.find(s => s.op === "page.fill")?.args.fields[0].selector.identifier, "workflow-name");
});

test("the driver reshapes results and starts capture once per tab", async () => {
  /** @type {Array<[string, any]>} */ const calls = [];
  const bridge = { call: async (/** @type {string} */ op, /** @type {any} */ a) => {
    calls.push([op, a]);
    if (op === "tabs.use") return { id: 4, reused: true };
    if (op === "page.snapshot") return { controls: [{}, {}, {}] };
    if (op === "page.eval") return { ok: true, value: 12 };
    if (op === "net.list") return { requests: [{ url: "x" }] };
    if (op === "api.learn") return { entries: [{ id: "e1", method: "GET", pathTemplate: "/api/contacts", authKind: "bearer" }] };
    if (op === "api.catalog") return { entries: [{ id: "e1", method: "GET", pathTemplate: "/api/contacts" }] };
    if (op === "api.call") return { status: 200 };
    return { ok: true };
  } };
  const d = new ExtensionDriver(bridge);
  assert.deepEqual(await d.call("tabs.use", { url: "http://x/checkout", openIfMissing: true }), { tabId: 4, reused: true });
  await d.call("tabs.use", { url: "http://x/checkout" });
  assert.equal(calls.filter(([op]) => op === "net.start").length, 1);
  assert.equal((await d.call("page.snapshot", { tabId: 4 })).count, 3);
  assert.equal(await d.call("page.eval", { tabId: 4, expression: "1" }), 12);
  assert.equal((await d.call("net.list", { tabId: 4, filter: { urlIncludes: "/api/" } })).length, 1);
  const cat = await d.call("api.learn", { tabId: 4 });
  assert.equal(cat.entries[0].key, "GET /api/contacts");
  assert.equal(cat.entries[0].auth.kind, "bearer");
  assert.equal((await d.call("api.call", { tabId: 4, key: "GET /api/contacts", query: { limit: 5 } })).status, 200);
});

test("a failed step surfaces as an error, not a silent ok", async () => {
  const d = new ExtensionDriver({ call: async () => ({ ok: false, why: "nothing matches" }) });
  await assert.rejects(() => d.call("page.act", { tabId: 1, selector: "#nope" }), /nothing matches/);
});
