// @ts-check
// Kits on the real box against a fake box shaped like flows.kit.list.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const ROWS = [{ id: "pi-intake", version: 2, status: "installed", by: "per_a", at: 1_790_000_000_000 }, { id: "estate-planning", version: 3, status: "installed", by: "per_a", at: 1_790_100_000_000 }, { id: "old", version: 1, status: "removed" }, { id: "wait", version: 1, status: "pending" }];

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] ?? (tool === "flows.kit.list" ? { data: ROWS } : { data: { removed: input.id } }); };
  return { call, seen };
}

test("installed Kits are listed first, a removed one is not, with plain names", { skip: !strip }, async () => {
  const { kitsSource } = await import("./kits-source.ts");
  const m = await import("./kits-model.ts");
  const b = box();
  const rows = m.listed(await kitsSource(b.call).list());
  assert.deepEqual(b.seen, [{ tool: "flows.kit.list", input: {} }]);
  assert.deepEqual(rows.map((k) => [m.kitName(k.id), m.statusWord(k.status)]), [["Estate planning", "Installed"], ["Pi intake", "Installed"], ["Wait", "Waiting for a yes"]]);
  assert.match(m.kitLine(ROWS[0]), /^v2 · by per_a · .*2026$/);
  assert.equal(m.kitLine({ id: "x", version: 1, status: "installed" }), "v1");
});

test("Remove is flows.kit.remove by id, and a refusal gets plain words", { skip: !strip }, async () => {
  const { kitsSource } = await import("./kits-source.ts");
  const m = await import("./kits-model.ts");
  const b = box();
  await kitsSource(b.call).remove("pi-intake");
  assert.deepEqual(b.seen, [{ tool: "flows.kit.remove", input: { id: "pi-intake" } }]);
  const bad = box({ "flows.kit.remove": { error: { code: "chain_not_person", message: "x" } } });
  await assert.rejects(kitsSource(bad.call).remove("a"), (/** @type {any} */ e) => e.code === "chain_not_person" && /Only a person/.test(m.kitRefusal(e.code, e.message)));
});

test("an empty box lists nothing", { skip: !strip }, async () => {
  const { kitsSource } = await import("./kits-source.ts");
  assert.deepEqual(await kitsSource(box({ "flows.kit.list": { data: [] } }).call).list(), []);
});

test("the library lists what the box offers and nothing when the box has no such tool; the card then the proposal are two calls", { skip: !strip }, async () => {
  const { kitsSource } = await import("./kits-source.ts");
  const m = await import("./kits-model.ts");
  const none = box({ "records.kits.library": { error: { code: "no_such_tool", message: "x" } }, "flows.kit.library": { error: { code: "no_such_tool", message: "x" } } });
  assert.equal(await kitsSource(none.call).library(), null);
  const lib = [{ id: "estate-planning", name: "Estate planning", adds: { types: [1, 2], flows: [1] } }, { id: "pi-intake", adds: {} }];
  const b = box({ "records.kits.library": { data: lib }, "records.kits.get": { data: { id: "estate-planning", version: 1 } }, "flows.kit.card": { data: { kit: { name: "Estate planning", version: 1 }, ok: true, adds: { types: [{ label: "Matter", fields: 4, sealed: ["ssn"] }], flows: [{ label: "Intake", outward: [1] }] }, notes: ["Sealed fields are in play."] } }, "flows.kit.propose": { data: { ok: true } } });
  const s = kitsSource(b.call);
  assert.deepEqual(m.available(await s.library(), [{ id: "pi-intake", version: 1, status: "installed" }]).map((k) => k.id), ["estate-planning"]);
  assert.equal(m.addsLine(lib[0]), "2 types, 1 Flow");
  const { kit, card } = await s.card("estate-planning");
  assert.deepEqual(b.seen.slice(-2), [{ tool: "records.kits.get", input: { id: "estate-planning" } }, { tool: "flows.kit.card", input: { kit: { id: "estate-planning", version: 1 } } }]);
  assert.deepEqual(m.cardLines(/** @type {any} */ (card)).lines, ["Record type Matter, 4 fields, 1 sealed", "Flow Intake, sends or publishes"]);
  await s.propose(kit);
  assert.deepEqual(b.seen.at(-1), { tool: "flows.kit.propose", input: { kit: { id: "estate-planning", version: 1 } } });
  assert.deepEqual(m.proposeNote({ ok: false, errors: [{ path: "version", message: "version 2 is already installed" }] }), { ok: false, text: "version: version 2 is already installed" });
});
