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

test("an update: the library's newer version is offered, flows.kit.diff reads it without proposing, and its parts become diff lines", { skip: !strip }, async () => {
  const { kitsSource } = await import("./kits-source.ts");
  const m = await import("./kits-model.ts");
  const diff = { installed: true, from: 3, to: 4, newer: true, diff: { added: [{ kind: "flow", name: "weekly_digest" }], changed: [{ kind: "template", name: "welcome" }], removed: [{ kind: "role", name: "intern" }], widenings: [{ part: "flow weekly_digest", what: "now email.send" }], risks: [{ part: "type matter", what: "the field email is removed (its values stay in the store)" }], widening: true } };
  const lib = [{ id: "estate-planning", version: 4 }, { id: "pi-intake", version: 2 }, { id: "wait", version: 9 }, { id: "old", version: 9 }];
  assert.deepEqual(m.updatesOf(ROWS, lib), { "estate-planning": 4 }, "equal version, pending and removed Kits get no update");
  const b = box({ "flows.kit.library.get": { data: { kit: { id: "estate-planning", version: 4 } } }, "flows.kit.diff": { data: diff } });
  const s = kitsSource(b.call);
  const kit = await s.libraryKit("estate-planning");
  const d = await s.diff(kit);
  assert.deepEqual(b.seen, [{ tool: "flows.kit.library.get", input: { id: "estate-planning" } }, { tool: "flows.kit.diff", input: { kit: { id: "estate-planning", version: 4 } } }]);
  assert.ok(!b.seen.some((x) => x.tool === "flows.kit.propose"), "reading the diff asks nobody");
  assert.deepEqual(m.diffLines(d), [{ t: "a", s: "Flow weekly_digest" }, { t: "c", s: "Template welcome changes" }, { t: "d", s: "Role intern" }]);
  assert.equal(m.versionLine(d), "v3 to v4");
  assert.equal(m.widenings(d)[0].what, "now email.send");
  assert.match(m.risks(d)[0].what, /email is removed/);
  assert.equal(m.hasChanges(d), true);
  assert.equal(m.hasChanges({ installed: true, from: 4, to: 4, newer: false, diff: { ...diff.diff, added: [], changed: [], removed: [], widenings: [] } }), false);
  assert.equal(m.hasChanges({ installed: false, from: null, to: 4, newer: false, diff: null }), false);
  assert.equal(m.versionLine({ installed: false, from: null, to: 4, newer: false, diff: null }), "Not installed. v4 is on offer.");
});

test("the library Kit falls back to records.kits.get on a box without the flows name", { skip: !strip }, async () => {
  const { kitsSource } = await import("./kits-source.ts");
  const b = box({ "flows.kit.library.get": { error: { code: "no_such_tool", message: "x" } }, "records.kits.get": { data: { kit: { id: "a", version: 2 } } } });
  assert.deepEqual(await kitsSource(b.call).libraryKit("a"), { id: "a", version: 2 });
  const gone = box({ "flows.kit.library.get": { error: { code: "not_found", message: "no Kit a in the library" } } });
  await assert.rejects(kitsSource(gone.call).libraryKit("a"), (/** @type {any} */ e) => e.code === "not_found");
});

test("kits lists: an installed Kit offers Update (when newer) and a held Remove; one still pending shows its state; an available one offers Read the card", { skip: !strip }, async () => {
  const { installedRows, availableRows } = await import("./kits-model.ts");
  const rows = installedRows([{ id: "estate-planning", version: 3, status: "installed", by: "Chris" }, { id: "billing", version: 2, status: "pending" }, { id: "intake", version: 1, status: "installed" }], { "estate-planning": 4 });
  assert.deepEqual(rows[0].actions, [{ id: "update", title: "Update to v4", kind: "primary" }, { id: "remove", title: "Remove", kind: "hold" }]);
  assert.deepEqual(rows[2].actions, [{ id: "remove", title: "Remove", kind: "hold" }]);
  assert.deepEqual([rows[1].actions, rows[1].accessories], [undefined, [{ label: "Waiting for a yes" }]]);
  assert.equal(rows[0].title, "Estate planning");
  const avail = availableRows([{ id: "probate", name: "Probate", description: "Estates." }], "");
  assert.deepEqual(avail[0].actions, [{ id: "read", title: "Read the card", kind: "primary" }]);
  assert.equal(availableRows([{ id: "probate", name: "Probate" }], "probate")[0].actions[0].title, "Reading");
});
