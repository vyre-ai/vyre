// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolNamer, RUNTIMES } from "../core/sessions/agent-brief.js";

test("a tool is named only if the caller can reach it, and the way that runtime calls it", () => {
  for (const rt of RUNTIMES) {
    const { tool } = toolNamer(["vault.request", "memory.ask", "threads.watch"], rt);
    assert.equal(tool("threads.watch"), "tools_call threads.watch", rt);
    assert.equal(tool("memory_ask"), "memory_ask", `${rt}: a core tool by its alias, from either spelling`);
    assert.equal(tool("vault.request"), "vault_request", rt);
    assert.equal(tool("chrome.send"), null, `${rt}: not reachable, so not named`);
  }
});

test("a sentence is dropped whole when any tool in it is unreachable", () => {
  const { sentence } = toolNamer(["vault.request"]);
  assert.equal(sentence(["vault.request"], v => `Ask with ${v}.`), "Ask with vault_request.");
  assert.equal(sentence(["vault.request", "vault.lease"], (a, b) => `${a} then ${b}`), "");
});

test("an unknown runtime is refused", () => {
  assert.throws(() => toolNamer([], "</x>"), /no runtime/);
});
