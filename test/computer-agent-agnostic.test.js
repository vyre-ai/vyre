// @ts-check
// Browser and computer tools are agent-agnostic: the same resolve for every adapter caller shape.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_ADAPTER_CALLER_SHAPES, resolveComputerAgent, modelSessionMustClaimAgent } from "../lib/computer-agent.js";
import { findInSource } from "./source-files.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const kindOf = async (name) => (name === "juno" ? "assistant" : "agent");

test("resolveComputerAgent: every adapter shape resolves to the named agent", async () => {
  for (const shape of AGENT_ADAPTER_CALLER_SHAPES) {
    const caller = shape.replace("<name>", "kit");
    assert.equal(await resolveComputerAgent({ agent: "kit" }, caller, kindOf), "kit", caller);
    assert.equal(await resolveComputerAgent({}, caller, kindOf), "kit", `${caller} self`);
  }
});

test("resolveComputerAgent: assistant may name another agent; ordinary agents may not", async () => {
  await assert.rejects(resolveComputerAgent({ agent: "pax" }, "mcp:agent:kit", kindOf), /only use its own computer/);
  assert.equal(await resolveComputerAgent({ agent: "pax" }, "mcp:agent:juno", kindOf), "pax");
});

test("resolveComputerAgent: bare mcp/harness without agent claim is denied", async () => {
  for (const caller of ["mcp", "harness", "mcp:thread:th-1", "harness:thread:th-1"]) {
    await assert.rejects(resolveComputerAgent({ agent: "kit" }, caller, kindOf), e => /** @type {any} */ (e).code === "denied", caller);
    assert.throws(() => modelSessionMustClaimAgent(caller), e => /** @type {any} */ (e).code === "denied", caller);
  }
});

/** Vyred paths that pick an agent for Chrome must import the shared resolver (no vendor forks). */
const MUST_USE_SHARED = new Map([
  ["core/computers/index.js", "computers tools"],
  ["modules/hands-chrome/index.js", "chrome tools on the box"],
  ["modules/hands-desktop/index.js", "desktop hands"],
]);

test("browser entry points use lib/computer-agent.js, not a private resolve", () => {
  for (const [rel, why] of MUST_USE_SHARED) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(text, /computer-agent\.js/, `${rel} (${why}) must use resolveComputerAgent`);
    assert.match(text, /resolveComputerAgent/, `${rel} must call the shared resolver`);
    assert.doesNotMatch(text, /can only use its own computer, not/, `${rel} must not embed its own agent-resolve fork`);
  }
});

const VENDOR_IN_BROWSER = [/\bclaude\b/i, /\bcodex\b/i, /\bgrok\b/i, /\banthropic\b/i, /\bopenai\b/i, /\bxai\b/i];
const VENDOR_ALLOWED = new Map([
  ["core/computers/computers.test.js", "fake claude binary for switchboard tests"],
  ["core/computers/driver/policy.js", "comments about future container split"],
]);

test("no vendor-specific branches in browser/computer tool code", () => {
  const found = findInSource(VENDOR_IN_BROWSER, new Map([
    ...VENDOR_ALLOWED,
    ["lib/computer-agent.js", "documents that vendors are not named"],
    ["test/computer-agent-agnostic.test.js", "this test"],
  ])).filter(l => /^(core\/computers|modules\/hands-chrome|modules\/hands-desktop|lib\/browser-access)/.test(l)
    && !l.startsWith("core/computers/image/"));
  assert.deepEqual(found, [], "browser paths must not branch on Claude/Codex/Grok");
});
