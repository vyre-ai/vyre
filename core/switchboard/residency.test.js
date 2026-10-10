// @ts-check
// The person's vendor policy: one check for every provider (core/switchboard/residency.js).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { allowedSet, refusal, checkResidency, SETTING } from "./residency.js";

test("an empty or missing policy allows every vendor; a list allows only those, by provider or by vendor name", () => {
  for (const v of [undefined, null, [], "", "  ", [" "]]) for (const p of ["claude", "codex", "grok", "openrouter"]) assert.equal(refusal(p, v), null, `${JSON.stringify(v)} ${p}`);
  assert.equal(refusal("claude", ["claude"]), null);
  assert.match(String(refusal("codex", ["claude"])), /OpenAI \(Codex\).*Anthropic \(Claude\)/);
  assert.match(String(refusal("grok", ["claude", "codex"])), /xAI \(Grok\)/);
  assert.equal(refusal("codex", ["Anthropic", "OpenAI"]), null, "vendor names and case are read");
  assert.equal(refusal("grok", "claude, xai"), null, "a comma list is read");
  assert.ok(refusal("some-new-provider", ["claude"]), "a provider the policy does not name is refused");
  assert.deepEqual([...(allowedSet(["anthropic", "xAI"]) || [])].sort(), ["claude", "grok"]);
});

test("checkResidency refuses with code residency for each provider the policy leaves out, and reads the policy live", async () => {
  let value = ["claude"];
  const asked = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { asked.push([tool, input.key]); return { data: { value } }; };
  await checkResidency(call, "claude");
  for (const p of ["codex", "grok", "openrouter", "openai-compatible"]) await assert.rejects(() => checkResidency(call, p), e => /** @type {any} */ (e).code === "residency" && /do not allow/.test(/** @type {any} */ (e).message), p);
  value = [];
  await checkResidency(call, "grok");
  assert.ok(asked.every(a => a[0] === "settings.get" && a[1] === SETTING));
});

test("a policy that cannot be read is not guessed: a settings module that fails refuses; one that is not there is no policy", async () => {
  await assert.rejects(() => checkResidency(async () => ({ error: { code: "failed", message: "boom" } }), "codex"), e => /** @type {any} */ (e).code === "residency" && /could not read/.test(/** @type {any} */ (e).message));
  await assert.rejects(() => checkResidency(async () => { throw new Error("socket closed"); }, "grok"), e => /** @type {any} */ (e).code === "residency");
  await checkResidency(async () => ({ error: { code: "no_such_tool", message: "no settings module" } }), "codex");
});
