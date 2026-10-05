// @ts-check
// Memory's Sites tab against a fake box: the list, detail, forget and its Undo, and the lines the screen shows.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const LIST = {
  sites: [
    { key: "https://app.example.com", names: ["Example App"], kind: "origin", family: "family:example", updated: 5, verified: "2026-09-01T00:00:00Z", counts: { controls: 12, flows: 1, notes: 2 }, used_to_work: 1 },
    { key: "family:example", names: [], kind: "family", counts: {} },
    { nonsense: true },
  ],
  forgotten: [
    { kind: "row", key: "https://app.example.com", name: "Example App", part: "flows", id: 7, label: "Login", at: 9, expires_at: 99 },
    { kind: "row", key: "k", name: "K" },
    { kind: "site", key: "https://old.example.com", name: "Old", at: 8, expires_at: 98 },
  ],
};

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    seen.push({ tool, input });
    if (tool === "memory.site.list") return { data: LIST };
    if (tool === "memory.site.detail") return { data: { found: true, parts: { flows: [{ id: 7, label: "Login", runs: 4, fails: 1 }], api: [{ id: 1, label: "GET /me", quarantined: true, verified: "2026-09-01T00:00:00Z" }], notes: [] } } };
    if (tool === "memory.site.restore") return { data: { restored: o.restored ?? 1 } };
    return { data: {} };
  };
  return { call, seen };
}

test("list: sites and what can still be brought back; junk rows are dropped", { skip: !strip }, async () => {
  const { chromeSitesSource } = await import("./chrome-sites-source.ts");
  const d = await chromeSitesSource(box().call).list();
  assert.deepEqual(d.sites.map((s) => [s.key, s.name, s.kind]), [["https://app.example.com", "Example App", "origin"], ["family:example", "family:example", "family"]]);
  assert.equal(d.sites[0].usedToWork, 1);
  assert.deepEqual(d.forgotten.map((f) => [f.kind, f.part, f.id]), [["row", "flows", "7"], ["site", null, null], ["site", null, null]]);
});

test("forget and restore: tool names and inputs", { skip: !strip }, async () => {
  const { chromeSitesSource } = await import("./chrome-sites-source.ts");
  const b = box();
  const s = chromeSitesSource(b.call);
  await s.forgetSite("https://a"); await s.forgetAll(); await s.forgetRow("https://a", "flows", "7");
  assert.equal(await s.restore({ key: "https://a" }), true);
  assert.equal(await s.restore({ key: "https://a", part: "flows", id: "7" }), true);
  assert.deepEqual(b.seen.map((x) => [x.tool, x.input]), [
    ["memory.site.forget", { key: "https://a" }], ["memory.site.forget", { all: true }], ["memory.site.forget", { key: "https://a", part: "flows", id: "7" }],
    ["memory.site.restore", { key: "https://a" }], ["memory.site.restore", { key: "https://a", part: "flows", id: "7" }]]);
  assert.equal(await chromeSitesSource(box({ restored: 0 }).call).restore({ key: "x" }), false);
});

test("detail: parts with something in them, in order, with the line under each row", { skip: !strip }, async () => {
  const { chromeSitesSource } = await import("./chrome-sites-source.ts");
  const { partsOf, itemMeta } = await import("./chrome-sites-model.ts");
  const d = await chromeSitesSource(box().call).detail("https://app.example.com");
  const parts = partsOf(d);
  assert.deepEqual(parts.map((p) => p.part), ["flows", "api"]);
  assert.equal(itemMeta("flows", parts[0].items[0]), "4 runs, 1 failed");
  assert.match(itemMeta("api", parts[1].items[0]), /^stopped working, \d+ days ago$/);
  assert.equal(itemMeta("controls", { id: 1, conf: 0.834 }), "83% sure");
});

test("words: counts, host, age, tokens, errors", { skip: !strip }, async () => {
  const { countsLine, hostOf, ago, tokenOf, forgottenLine, errWords } = await import("./chrome-sites-model.ts");
  assert.equal(countsLine({ controls: 12, flows: 1, notes: 2 }), "12 controls, 1 flow, 2 notes");
  assert.equal(countsLine({}), "Nothing kept yet");
  assert.equal(hostOf("https://app.example.com/x"), "app.example.com");
  assert.equal(hostOf("family:example"), "example");
  const now = Date.parse("2026-10-05T12:00:00Z");
  assert.equal(ago("2026-10-05T01:00:00Z", now), "today");
  assert.equal(ago(now - 86400_000, now), "yesterday");
  assert.equal(ago("2026-09-23T12:00:00Z", now), "12 days ago");
  assert.equal(ago(null, now), "");
  assert.equal(tokenOf({ key: "k" }), "k");
  assert.equal(tokenOf({ key: "k", part: "flows", id: "7" }), "k|flows|7");
  assert.equal(forgottenLine({ kind: "row", key: "k", name: "Example App", part: "flows", id: "7", label: "Login", at: 0, expires_at: 0 }), "Login from Example App");
  assert.equal(errWords({ code: "no_such_tool" }), "Vyre Memory is not running on your server.");
});
