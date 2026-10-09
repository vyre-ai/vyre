// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { capsFromInit, fit, CAPS } from "../lib/harness-caps.js";

const CLAUDE_INIT = { type: "system", subtype: "init", claude_code_version: "2.2.0", tools: ["Bash", "Read", "Task", "Skill", "ExitPlanMode", "mcp__vyre__tools_find"], skills: ["use-the-vault"], plugins: [{ name: "vyre" }], mcp_servers: [{ name: "vyre", status: "connected" }], slash_commands: ["vyre:vyre"] };
const ACP_INIT = { type: "system", subtype: "init", harness: { agent: { name: "codex-acp", version: "2.1.0" }, caps: { loadSession: true, image: true, mcpHttp: false, mcpSse: false }, auth: ["chat-gpt", "api-key"] } };

test("capsFromInit: Claude Code's init shows skills, plugins, MCP, subagents and plan mode; only names and counts are kept", () => {
  const c = /** @type {any} */ (capsFromInit("claude", CLAUDE_INIT));
  assert.equal(c.version, "2.2.0");
  assert.deepEqual([c.caps.skills, c.caps.plugins, c.caps.mcp, c.caps.subagents, c.caps.plan_mode], [true, true, true, true, true]);
  assert.equal(c.caps.hooks, null, "not shown, not assumed");
  assert.deepEqual(c.counts, { tools: 6, skills: 1, plugins: 1, mcp_servers: 1, commands: 1 });
  assert.deepEqual(Object.keys(c.caps).sort(), [...CAPS].sort());
});

test("capsFromInit: an ACP harness shows what its initialize answer showed, and says false where it said no", () => {
  const c = /** @type {any} */ (capsFromInit("codex", ACP_INIT));
  assert.equal(c.version, "2.1.0");
  assert.deepEqual([c.caps.images, c.caps.resume, c.caps.mcp, c.caps.skills], [true, true, false, null]);
  assert.deepEqual(c.auth, ["chat-gpt", "api-key"]);
  assert.equal(capsFromInit("grok", { type: "system", subtype: "init", model: "x" }), null, "an init that says nothing about the harness stores nothing");
  assert.equal(capsFromInit("grok", null), null);
});

test("fit: a need the harness showed it lacks hides the skill with a plain reason, or degrades it when it says how; an unknown need is not held against it", () => {
  const caps = { skills: true, subagents: false, mcp: null };
  assert.deepEqual(fit(undefined, caps), { works: true, missing: [] });
  assert.deepEqual(fit(["skills"], caps), { works: true, missing: [] });
  assert.deepEqual(fit(["mcp"], caps), { works: true, missing: [] }, "null is unknown, not missing");
  const hidden = fit(["subagents", "skills"], caps, { harness: "Codex" });
  assert.equal(hidden.works, false);
  assert.equal(hidden.reason, "needs subagents; Codex does not offer subagents");
  const soft = fit(["subagents"], caps, { harness: "Grok", degrade: "it does the steps one after another" });
  assert.equal(soft.works, "degraded");
  assert.match(soft.reason || "", /Grok does not offer subagents; without it: it does the steps one after another/);
  assert.deepEqual(fit(["subagents"], null), { works: true, missing: [] }, "a harness never seen hides nothing");
});
