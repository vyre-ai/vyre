// @ts-check
// The raw ACP streams of real Codex (codex-acp 2.1.0) and Grok Build (1.0.46) turns, captured once on the test box with
// scripts/provider-tool-proof.mjs --real-home <home> --capture <dir>, then scrubbed: the handshake and each turn as ndjson of
// {t, dir ("out" to the agent, "in" from it), msg}. Rendering and the driver are built and tested against these, not against a new real turn.
// What is here is what exists: the handshake, a plain reply, a command outside the workspace, a Vyre MCP tool, a plan-and-edit turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const dir = path.dirname(new URL(import.meta.url).pathname);
const load = (prov, file) => fs.readFileSync(path.join(dir, prov, file), "utf8").trim().split("\n").map(l => JSON.parse(l));

for (const prov of ["codex", "grok"]) {
  test(`${prov}: every captured stream parses, starts with the handshake and ends each turn with a prompt result`, () => {
    const files = fs.readdirSync(path.join(dir, prov)).filter(f => f.endsWith(".ndjson")).sort();
    assert.deepEqual(files.map(f => f.replace(/^\d+-/, "").replace(".ndjson", "")), ["handshake", "turn-plain", "turn-command-outside-workspace", "turn-vyre-mcp-tool", "turn-plan-and-edit", ...(prov === "codex" ? ["turn-plan-mode"] : [])]);
    const hs = load(prov, files[0]);
    assert.equal(hs[0].dir, "out");
    assert.equal(hs[0].msg.method, "initialize");
    assert.ok(hs.some(x => x.dir === "in" && x.msg.result && x.msg.result.agentCapabilities), "initialize answered");
    assert.ok(hs.some(x => x.dir === "in" && x.msg.result && x.msg.result.sessionId), "session/new answered");
    for (const f of files.slice(1)) {
      const turn = load(prov, f);
      assert.equal(turn[0].msg.method, f.includes("plan-mode") ? "session/set_config_option" : "session/prompt", f);
      assert.ok(turn.some(x => x.dir === "in" && x.msg.result && x.msg.result.stopReason), `${f} ends in a prompt result`);
      assert.ok(turn.every((x, i) => i === 0 || x.t >= turn[i - 1].t), `${f} is in time order`);
    }
  });

  test(`${prov}: nothing of the machine or the account is in the fixtures`, () => {
    const all = fs.readdirSync(path.join(dir, prov)).filter(f => f.endsWith(".ndjson")).map(f => fs.readFileSync(path.join(dir, prov, f), "utf8")).join("\n");
    assert.doesNotMatch(all, /ChatGPT (Plus|Pro|Team|Business|Enterprise|Free)|"email":"[^"]*","plan":"(?!plan")|"(agentId|agentInstanceId|instanceId|userId|accountId)":"(?!0{8}-)/);
    // The placeholders stay placeholders on a re-capture: no real host name, agent or instance id, or account plan.
    assert.doesNotMatch(all, /"hostname":"(?!<HOST>")/);
    assert.ok(!/"authStatus":\{"kind"/.test(all) || /"label":"ChatGPT","account":\{"email":"user@example\.org","plan":"plan"\}/.test(all), "the account's label and plan are generic");
    assert.doesNotMatch(all, /\/home\/(?!user\b)[a-z]|\/Users\/|\/srv\/|Bearer (?!\[token\])[A-Za-z0-9]|\bsk-[A-Za-z0-9]{12,}|eyJ[A-Za-z0-9_-]{10,}\./);
  });
}

test("what each CLI shows for a plan-and-edit turn that Vyre can draw: Grok's diff content and edit kind, Codex's terminal content", () => {
  const blocks = u => (Array.isArray(u.content) ? u.content : []);
  const grok = load("grok", "04-turn-plan-and-edit.ndjson").map(x => x.msg.params && x.msg.params.update).filter(Boolean);
  const diff = grok.flatMap(blocks).find(c => c.type === "diff");
  assert.ok(diff && diff.newText === "hello\n" && diff.oldText === "", "a diff block with old and new text");
  assert.ok(grok.some(u => u.kind === "edit"), "an edit tool call");
  const codex = load("codex", "02-turn-command-outside-workspace.ndjson").map(x => x.msg.params && x.msg.params.update).filter(Boolean);
  assert.ok(codex.some(u => blocks(u).some(c => c.type === "terminal")), "a terminal content block");
});

test("codex in plan collaboration mode: the plan is one agent message plus a switch_mode permission question, never a `plan` session update", () => {
  const wire = load("codex", "05-turn-plan-mode.ndjson");
  const updates = wire.filter(x => x.dir === "in" && x.msg.params && x.msg.params.update).map(x => x.msg.params.update);
  assert.ok(!updates.some(u => u.sessionUpdate === "plan"), "no plan update");
  assert.ok(updates.some(u => u.sessionUpdate === "agent_message_chunk" && /-plan$/.test(u.messageId)), "the plan arrives as a message whose id ends in -plan");
  const q = wire.find(x => x.dir === "in" && x.msg.method === "session/request_permission").msg.params;
  assert.equal(q.toolCall.kind, "switch_mode");
  assert.equal(q.toolCall.title, "Implement this plan?");
  assert.match(q.toolCall.rawInput.plan, /hello\.txt/);
  assert.deepEqual(q.options.map(o => [o.optionId, o.kind]), [["implement_plan", "allow_once"], ["revise_plan", "reject_once"]]);
});
