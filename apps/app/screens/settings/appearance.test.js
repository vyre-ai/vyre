// @ts-check
// Appearance's theme on the real box against a fake box shaped like settings.get and settings.set.
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

/** @param {any} [o] */
function box(o = {}) {
  /** @type {{ tool: string, input: any }[]} */
  const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { seen.push({ tool, input }); return o[tool] ?? { data: { key: "appearance.scheme", value: "system", source: "default" } }; };
  return { call, seen };
}

test("the scheme is read as the app's theme, and an unknown value is system", { skip: !strip }, async () => {
  const { appearanceSource } = await import("./appearance-source.ts");
  const m = await import("./appearance-model.ts");
  const b = box({ "settings.get": { data: { value: "paper", source: "account" } } });
  const r = await appearanceSource(b.call).scheme();
  assert.deepEqual(b.seen, [{ tool: "settings.get", input: { key: "appearance.scheme" } }]);
  assert.equal(m.themeFrom(r.value), "paper");
  assert.deepEqual([m.themeFrom("neon"), m.themeFrom(undefined), m.themeFrom("dark")], ["system", "system", "dark"]);
  assert.match(m.themeNote("account"), /every device follows it/);
  assert.match(m.themeNote("default"), /Following the default/);
});

test("choosing a theme is one settings.set at account level; a refusal keeps its code", { skip: !strip }, async () => {
  const { appearanceSource } = await import("./appearance-source.ts");
  const m = await import("./appearance-model.ts");
  const b = box();
  await appearanceSource(b.call).setScheme("dark");
  assert.deepEqual(b.seen, [{ tool: "settings.set", input: { key: "appearance.scheme", value: "dark", level: "account" } }]);
  const bad = box({ "settings.set": { error: { code: "bad_input", message: "x" } } });
  await assert.rejects(appearanceSource(bad.call).setScheme("dark"), (/** @type {any} */ e) => e.code === "bad_input" && /not a theme/.test(m.appearanceRefusal(e.code, e.message)));
});
