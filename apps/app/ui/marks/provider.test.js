import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { badgeLabel, badgeSize, providerIcon, providerMono, providerName, providerOfModel, providerVendor } from "./provider.js";

// the icon set's names, read from the generated module (the one icon family every Icon draws from)
const family = new Set([...fs.readFileSync(new URL("../../src/ui/icons.generated.ts", import.meta.url), "utf8").matchAll(/^\s*\|\s*"([a-z0-9-]+)"/gm)].map((m) => m[1]));

test("every provider's mark is in the app's icon set; an unknown one has a monogram and none has nothing", () => {
  const want = { claude: "logo-claude", codex: "logo-openai", grok: "logo-grok", openrouter: "logo-openrouter", "openai-compatible": "key" };
  for (const [p, icon] of Object.entries(want)) {
    assert.equal(providerIcon(p), icon, p);
    assert.ok(family.has(icon), `${icon} is in src/ui/icons.generated.ts`);
  }
  assert.deepEqual(["claude", "codex", "grok", "openrouter", "openai-compatible"].map(providerVendor), ["Anthropic", "OpenAI", "xAI", "OpenRouter", "Any key"]);
  assert.equal(providerName("openai-compatible"), "OpenAI-compatible");
  assert.equal(providerIcon("opencode"), "spark");
  assert.ok(family.has("spark"));
  assert.equal(providerName("opencode"), "OpenCode");
  assert.equal(providerVendor("opencode"), "OpenCode");
  assert.equal(providerIcon("mistral"), null);
  assert.equal(providerIcon(null), null);
  assert.equal(providerMono("mistral"), "Mi");
  assert.equal(providerMono("codex"), "Cx");
  assert.equal(providerName("codex"), "Codex");
  assert.equal(providerName(""), "");
});

test("a model's name says its provider only when it really does", () => {
  assert.equal(providerOfModel("Sonnet 5.5"), "claude");
  assert.equal(providerOfModel("gpt-5"), "codex");
  assert.equal(providerOfModel("Grok 4"), "grok");
  assert.equal(providerOfModel("Local"), null);
  assert.equal(providerOfModel(null), null);
});

test("the badge is 55 percent of the avatar, never under 12, and says who wrote the reply", () => {
  assert.equal(badgeSize(32), 18);
  assert.equal(badgeSize(16), 12);
  assert.equal(badgeLabel("claude", "Sonnet 5.5"), "Written by Claude, Sonnet 5.5");
});
