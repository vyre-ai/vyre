// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { toolNamer, nameTools, RUNTIMES } from "../core/sessions/agent-brief.js";
import { ENGINEER } from "../core/agents/index.js";

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

test("nameTools writes a reachable tool the way it is called, leaves a call alone, and leaves a tool the caller cannot reach as written", () => {
  const namer = toolNamer(["flows.define", "flows.propose", "docs.find", "memory.ask"]);
  const out = nameTools("Use flows.define then flows.propose; read docs.find; tools_call flows.get stays; chrome.send is not here; memory.ask.", namer);
  assert.equal(out, "Use flows_define then tools_call flows.propose; read docs_find; tools_call flows.get stays; chrome.send is not here; memory_ask.");
});

test("the Engineer's own words name every tool it uses the way it can call it", () => {
  const raw = ENGINEER.instructions;
  for (const n of ["flows.compile-text", "flows.propose", "flows.kit.propose", "work.template.define", "skills.draft"]) {
    assert.ok(raw.includes(`tools_call ${n}`), `${n} is written as a call`);
    assert.ok(!new RegExp(`(?<!tools_call )(?<![A-Za-z0-9_.-])${n.replace(/[.]/g, "\\.")}(?![A-Za-z0-9_-])`).test(raw), `${n} is not written bare`);
  }
});
