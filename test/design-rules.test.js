// @ts-check
// One product, one look (design-language): a screen takes its colours, type sizes and spacing from the tokens and its layout from the blocks. apps/app/scripts/check-design.mjs counts the
// raw ones per file; apps/app/scripts/design-baseline.json is what the code carried when the check began and can only go down. This test is the check, so preflight and CI run it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, measure, problems, readBaseline, scan } from "../apps/app/scripts/check-design.mjs";

test("design rules: each kind of raw value is found, and a token, a comment or a marked line is not", () => {
  assert.deepEqual(scan(`const c = { color: "#1a2b3c", background: 'rgba(0,0,0,.4)' };`), { colour: 1 });
  assert.deepEqual(scan(`<View style={{ padding: 12, gap: 8, borderRadius: 6 }} />`), { space: 1 });
  assert.deepEqual(scan(`const s = { fontSize: 15, lineHeight: 20 };`), { type: 1 });
  assert.deepEqual(scan(`<View className="w-[320px] p-s3" />`), { arbitrary: 1 });
  assert.deepEqual(scan(`const s = StyleSheet.create({});`), { sheet: 1 });
  assert.deepEqual(scan(`<View className="gap-s3 bg-surface-2 rounded-card" /><Text size="caption" tone="label">#3 in line</Text>`), {});
  assert.deepEqual(scan(`// padding: 12 and "#fff" in a comment\n * fontSize: 15`), {});
  assert.deepEqual(scan(`// design-ok: the brand mark is a fixed picture\nconst c = "#ff0000";\nconst d = "#00ff00"; // design-ok: same`), {});
  assert.deepEqual(Object.keys(RULES), ["colour", "type", "space", "arbitrary", "sheet"]);
});

test("design rules: the allowance only goes down, in both directions", () => {
  assert.deepEqual(problems({ "a.tsx": { colour: 1 } }, { "a.tsx": { colour: 1 } }), []);
  assert.match(problems({ "a.tsx": { colour: 2 } }, { "a.tsx": { colour: 1 } })[0], /a\.tsx: 2 x colour \(allowed 1\)/);
  assert.match(problems({ "b.tsx": { space: 1 } }, {})[0], /b\.tsx: 1 x space \(allowed 0\)/, "a new file starts with nothing allowed");
  assert.match(problems({}, { "c.tsx": { type: 3 } })[0], /c\.tsx: type is down to 0 .*--write/, "a gain is locked in, not left as room");
});

test("design rules: no screen is over its allowance (use the token or block, or say why with design-ok)", () => {
  const bad = problems(measure(), readBaseline());
  assert.deepEqual(bad, [], `\n${bad.join("\n")}\n`);
});
