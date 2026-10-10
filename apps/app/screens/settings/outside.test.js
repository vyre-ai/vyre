// @ts-check
// Outside agents (core/outside): the rows as drawn, the words for each state, what is sent to give access, over a fake box.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const DAY = 86_400_000, NOW = 1_800_000_000_000;
const LIST = { agents: [
  { id: "k3m9x2q7pw4t", name: "Muse", note: "writes our newsletter", reach: "reads contact; asks to add or change them", gives: [{ id: "rc_1", kind: "records", types: ["contact", "matter"], write: true }, { id: "rc_2", kind: "memory", projects: ["Harlow"] }], expires: NOW + 3 * DAY, lastUsed: NOW - 30 * 60_000, uses: 4, status: "active" },
  { id: "a2", name: "Hermes", expires: NOW - DAY, lastUsed: null, uses: 0, status: "expired" },
  { id: "a3", name: "Old", expires: NOW + DAY, lastUsed: NOW - 5 * DAY, status: "revoked" },
  { nope: 1 }, null,
] };

test("outside agents: the rows keep only what is drawn, and each state is said in words", { skip: !strip }, async () => {
  const m = await import("./outside-model.ts");
  const rows = m.agentsOf(LIST);
  assert.deepEqual(rows.map((r) => r.id), ["k3m9x2q7pw4t", "a2", "a3"], "a row with no id or name is dropped");
  assert.deepEqual(rows.map((r) => m.endsLine(r, NOW)), ["Ends in 3 days", "Expired, so it needs a new token", "Ended"]);
  assert.deepEqual(rows.map((r) => m.usedLine(r, NOW)), ["Last connected 30 minutes ago", "Has not connected yet", "Last connected 5 days ago"]);
  assert.deepEqual(rows[0].gives.map(m.givesLine), ["contact and matter, and may ask to change them", "The memory of Harlow"]);
  assert.equal(rows[1].reach, "");
  assert.equal(m.usedLine({ ...rows[0], lastUsed: NOW - 20_000 }, NOW), "Connected just now");
  assert.equal(m.endsLine({ ...rows[0], expires: NOW + 3_600_000 }, NOW), "Ends today");
});

test("outside agents: giving record access sends only the types picked, once each, and write only when ticked", { skip: !strip }, async () => {
  const m = await import("./outside-model.ts");
  assert.equal(m.recordsGrant([], true), null, "nothing picked gives nothing");
  assert.deepEqual(m.recordsGrant(["contact", "contact", "matter"], false), { kind: "records", types: ["contact", "matter"] });
  assert.deepEqual(m.recordsGrant(["contact"], true), { kind: "records", types: ["contact"], write: true });
  assert.deepEqual(m.typesOf({ types: [{ name: "contact", label: "Contact" }, { name: "flow-run", system: true }, { name: "matter" }, null] }), [{ name: "contact", label: "Contact" }, { name: "matter", label: "matter" }]);
});

test("outside agents: the source calls the box's tools and surfaces a refusal in the box's words", { skip: !strip }, async () => {
  const { outsideSource } = await import("./outside-source.ts");
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (tool === "outside.revoke") return { error: { code: "denied", message: "only a person does this" } };
    if (tool === "outside.register") return { data: { id: "x", name: input.name, token: "vext_t", url: "", lines: { claude: "c", codex: "d" } } };
    return { data: tool === "outside.list" ? LIST : {} };
  };
  const o = outsideSource(/** @type {any} */ (call));
  assert.equal((await o.list()).length, 3);
  assert.equal((await o.register("Muse", "news")).token, "vext_t");
  await o.grant("x", { kind: "records", types: ["contact"] });
  await o.ungrant("x", "rc_1");
  await assert.rejects(o.revoke("x"), /only a person does this/);
  assert.deepEqual(seen.map((s) => s.tool), ["outside.list", "outside.register", "outside.grant", "outside.ungrant", "outside.revoke"]);
  assert.deepEqual(seen[1].input, { name: "Muse", note: "news" });
  assert.deepEqual(seen[2].input, { id: "x", what: { kind: "records", types: ["contact"] } });
});
