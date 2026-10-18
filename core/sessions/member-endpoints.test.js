import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { memberAccountBases, memberBaseOk, memberBases } from "./member-endpoints.js";

test("a member may name no address, or the kind's own, or xAI's one for an OpenAI-style key, and nothing else", () => {
  const ok = (kind, url) => memberBaseOk(url, memberBases(kind));
  assert.equal(ok("openai-compatible", undefined), true);
  assert.equal(ok("openai-compatible", ""), true);
  assert.equal(ok("openai-compatible", "https://api.openai.com/v1"), true);
  assert.equal(ok("openai-compatible", "https://API.openai.com/v1/"), true);
  assert.equal(ok("openai-compatible", "https://api.x.ai/v1"), true);
  assert.equal(ok("anthropic-compatible", "https://api.anthropic.com"), true);
  assert.equal(ok("anthropic-compatible", "https://api.x.ai/v1"), false, "xAI's address is only for an OpenAI-style key");
  for (const kind of ["openai-compatible", "anthropic-compatible", "openrouter"]) {
    for (const bad of ["http://127.0.0.1:8080/v1", "http://localhost/v1", "https://evil.example/v1", "https://api.openai.com.evil.example/v1", "http://[::1]/v1", "https://10.0.0.1/v1"]) assert.equal(ok(kind, bad), false, `${kind} ${bad}`);
  }
  assert.equal(ok("openrouter", "https://api.x.ai/v1"), false);
  assert.deepEqual(memberBases("mystery"), []);
});

test("a member's account may name only the addresses of its provider", () => {
  assert.equal(memberBaseOk("https://api.x.ai/v1", memberAccountBases("openai-compatible")), true);
  assert.equal(memberBaseOk("https://api.anthropic.com", memberAccountBases("claude")), true);
  assert.equal(memberBaseOk("https://api.x.ai/v1", memberAccountBases("claude")), false);
  assert.equal(memberBaseOk("http://127.0.0.1:9/v1", memberAccountBases("openai-compatible")), false);
  assert.equal(memberBaseOk("https://anything.example", memberAccountBases("grok")), false);
  assert.equal(memberBaseOk(undefined, memberAccountBases("grok")), true);
});
