// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redact.js";

test("known token shapes and whatever was just typed are hidden; plain words stay", () => {
  assert.equal(redact("Bad credentials"), "Bad credentials");
  assert.equal(redact("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 was refused"), "token [hidden] was refused");
  assert.equal(redact("github_pat_11ABCDEFG0123456789_abcdefghijklmnop failed"), "[hidden] failed");
  assert.equal(redact("sent Authorization: Bearer abcdef0123456789abcdef0123"), "sent Authorization: Bearer [hidden]");
  assert.equal(redact("xoxb-123456789012-abcdefghij"), "[hidden]");
  assert.equal(redact("the value hunter2-secret was echoed", ["hunter2-secret"]), "the value [hidden] was echoed");
  assert.equal(redact("short", ["abc"]), "short", "a very short string is not treated as a secret to hide");
  assert.equal(redact(null), "");
});
