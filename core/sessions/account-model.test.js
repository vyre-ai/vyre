// @ts-check
// An OpenRouter account is kept with a model (its driver never picks one); every other provider keeps only what was named.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { accountModel, OPENROUTER_DEFAULT_MODEL } from "./account-model.js";
import { accountModel as viaProviders } from "./providers.js";

test("the model an account is kept with: the one named, else OpenRouter's default, else none", () => {
  assert.equal(OPENROUTER_DEFAULT_MODEL, "anthropic/claude-sonnet-4.5");
  assert.equal(accountModel("openrouter", undefined), OPENROUTER_DEFAULT_MODEL);
  assert.equal(accountModel("openrouter", ""), OPENROUTER_DEFAULT_MODEL);
  assert.equal(accountModel("openrouter", "openai/gpt-4o-mini"), "openai/gpt-4o-mini");
  assert.equal(accountModel("claude", undefined), undefined);
  assert.equal(accountModel("openai-compatible", undefined), undefined);
  assert.equal(accountModel("openai-compatible", "gpt-x"), "gpt-x");
  assert.equal(accountModel("openrouter", "m".repeat(300)).length, 100);
  assert.equal(viaProviders, accountModel, "the Switchboard reaches it through providers.js");
});
