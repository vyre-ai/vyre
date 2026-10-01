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

// ---- generated media: how each provider delivers an image (captured once, one real turn each, 1 Oct 2026)

const media = (name, file = "stream.ndjson") => fs.readFileSync(path.join(dir, "media", name, file), "utf8").trim().split("\n").map(l => JSON.parse(l));
const updates = wire => wire.filter(x => x.dir === "in" && x.msg.params && x.msg.params.update).map(x => x.msg.params.update);

test("codex $imagegen: the image arrives IN the stream as an image content block (base64 and a uri in the account's own folder), with its revised prompt and saved path", () => {
  const done = updates(media("codex-image")).find(u => u.sessionUpdate === "tool_call_update" && Array.isArray(u.content) && u.content.some(c => c.content && c.content.type === "image"));
  assert.ok(done, "a completed tool call carrying an image block");
  assert.equal(done.status, "completed");
  const img = done.content.map(c => c.content).find(c => c.type === "image");
  assert.equal(img.mimeType, "image/png");
  assert.equal(Buffer.from(img.data, "base64").subarray(1, 4).toString(), "PNG", "the bytes are a PNG");
  assert.match(img.uri, /^<ACCOUNT_HOME>\/\.codex\/generated_images\/[0-9a-f-]+\/exec-[0-9a-f-]+\.png$/);
  assert.match(done.content.find(c => c.content.type === "text").content.text, /^Revised prompt: /);
  assert.equal(done.rawOutput.savedPath, img.uri);
  assert.ok(done.rawOutput.revisedPrompt);
});

test("grok /bundled:imagine: the image is a file under the account's session folder, named by the tool result; there is no image block, no bytes and no URL in the stream; it is asked about first", () => {
  const wire = media("grok-image");
  const ups = updates(wire);
  const call = ups.find(u => u.sessionUpdate === "tool_call");
  assert.equal(call.title, "image_gen");
  assert.equal(call._meta["x.ai/tool"].kind, "image_gen");
  const q = wire.find(x => x.dir === "in" && x.msg.method === "session/request_permission").msg.params;
  assert.equal(q.toolCall.rawInput.variant, "ImageGen");
  assert.deepEqual(q.options.map(o => o.kind).slice(0, 2), ["allow_once", "reject_once"]);
  const done = ups.find(u => u.sessionUpdate === "tool_call_update" && u.status === "completed");
  const out = JSON.parse(done.content[0].content.text);
  assert.match(out.path, /^<ACCOUNT_HOME>\/\.grok\/sessions\/[^/]+\/[0-9a-f-]+\/images\/1\.jpg$/);
  assert.equal(out.filename, "1.jpg");
  assert.equal(done.rawOutput.type, "ImageGen");
  assert.equal(done.rawOutput.path, out.path);
  assert.ok(!JSON.stringify(wire).includes('"type":"image"'), "no image content block");
  assert.deepEqual([...fs.readFileSync(path.join(dir, "media", "grok-image", "image.jpg")).subarray(0, 2)], [0xff, 0xd8], "the saved image, a JPEG");
});

test("grok video: the tools exist (reference_to_video) but the account's zero data retention refuses them, as a failed tool call; codex has no video tool at all", () => {
  const all = JSON.stringify(media("grok-video-refused"));
  assert.match(all, /reference_to_video/);
  assert.match(all, /zero data retention \(ZDR\)/);
});

test("the media fixtures carry nothing of the machine or the account either", () => {
  for (const d of fs.readdirSync(path.join(dir, "media"))) {
    const text = fs.readFileSync(path.join(dir, "media", d, "stream.ndjson"), "utf8");
    assert.doesNotMatch(text, /\/home\/(?!user\b)[a-z]|%2Fhome%2F|\/Users\/|\/srv\/|Bearer (?!\[token\])[A-Za-z0-9]|\bsk-[A-Za-z0-9]{12,}|"hostname":"(?!<HOST>")/, d);
    // The machine's own names, built so this file does not contain them.
    assert.doesNotMatch(text, new RegExp(["sim" + "ba", "irf" + "ad"].join("|"), "i"), d);
    assert.ok(!/"[A-Za-z0-9+/=]{2000,}"/.test(text), `${d}: no large inline payload`);
  }
});
