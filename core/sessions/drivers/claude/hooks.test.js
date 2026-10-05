// The Claude adapter's hook protocol: what a hook is called with becomes neutral fields, and what the Harness answers becomes what Claude Code reads.
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EVENTS, knows, hookIn, hookOut } from "./hooks.js";
import { isOwnTranscript, startHint, startCommand, startArgs } from "./terminal.js";

test("hookIn: a hook's stdin becomes neutral fields; a field a release drops is absent", () => {
  const x = hookIn({ session_id: "s1", cwd: "/w", prompt_id: "p1", source: "resume", prompt: "hi", transcript_path: "/t/s1.jsonl", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tu1", error: "boom", is_interrupt: true, reason: "clear", last_assistant_message: "done", stop_hook_active: true });
  assert.deepEqual([x.session, x.cwd, x.turn, x.source, x.prompt, x.transcript], ["s1", "/w", "p1", "resume", "hi", "/t/s1.jsonl"]);
  assert.deepEqual(x.tool, { name: "Bash", input: { command: "ls" }, id: "tu1" });
  assert.deepEqual([x.error, x.interrupted, x.reason, x.lastText, x.stopActive], ["boom", true, "clear", "done", true]);
  const bare = hookIn({});
  assert.deepEqual([bare.prompt, bare.tool.name, bare.tool.id, bare.transcript, bare.stopActive], ["", "", undefined, undefined, false]);
  assert.deepEqual(hookIn(null).tool.input, {});
});

test("hookOut: each kind prints what Claude Code reads, and nothing when there is nothing to say", () => {
  assert.equal(knows("brief"), true);
  assert.equal(knows("nope"), false);
  assert.deepEqual(JSON.parse(hookOut("brief", { context: "About the project" })), { hookSpecificOutput: { hookEventName: EVENTS.brief, additionalContext: "About the project" } });
  assert.equal(hookOut("brief", {}), null);
  assert.deepEqual(JSON.parse(hookOut("enrich", { context: "memory", notice: "window 70% full" })), { systemMessage: "window 70% full", hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "memory" } });
  assert.deepEqual(JSON.parse(hookOut("enrich", { notice: "only a notice" })), { systemMessage: "only a notice" });
  assert.equal(hookOut("enrich", {}), null);
  assert.deepEqual(JSON.parse(hookOut("rules", { decision: "deny", reason: "no" })).hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" });
  assert.equal(JSON.parse(hookOut("rules", { decision: "ask" })).hookSpecificOutput.permissionDecisionReason, "Vyre security floor");
  assert.equal(hookOut("rules", {}), null);
  assert.deepEqual(JSON.parse(hookOut("stop", { decision: "block", reason: "keep going" })), { decision: "block", reason: "keep going" });
  assert.equal(hookOut("stop", { decision: "allow" }), null);
  assert.equal(hookOut("learn", { context: "x" }), null);
});

test("terminal: a transcript is a session's own by its name, and a fresh session is started under a given id", () => {
  assert.equal(isOwnTranscript("/x/y/abc.jsonl", "abc"), true);
  assert.equal(isOwnTranscript("/x/y/abc.jsonl", "abd"), false);
  assert.equal(isOwnTranscript("/x/y/abc.txt", "abc"), false);
  assert.equal(isOwnTranscript(undefined, "abc"), false);
  assert.equal(startHint("s9"), "claude --session-id s9");
  assert.equal(startCommand("s9", "/r/s9.md"), 'claude --session-id s9 "$(cat /r/s9.md)"');
  assert.deepEqual(startArgs("s9", "go"), ["--session-id", "s9", "go"]);
});

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { transcriptOf, readTranscript, nativeIdOf, usageOf } from "./memory-parts.js";

test("the reading side: a transcript is found by its native id, read as neutral turns, and its usage counted", () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-parts-"));
  try {
    const folder = path.join(tmp, "proj");
    fs.mkdirSync(folder, { recursive: true });
    fs.copyFileSync(path.join(dir, "rich.jsonl"), path.join(folder, "abc123.jsonl"));
    const found = transcriptOf("abc123", [tmp]);
    assert.equal(found && found.format, "claude-jsonl");
    assert.equal(transcriptOf("nope", [tmp]), null);
    const turns = readTranscript(found.file);
    assert.ok(turns.length > 0);
    assert.deepEqual(Object.keys(turns[0]).filter(k => ["turn", "who", "text", "tools", "at"].includes(k)).sort(), ["at", "text", "tools", "turn", "who"]);
    assert.ok(turns.every((t, i) => t.turn === i && (t.who === "user" || t.who === "assistant") && Array.isArray(t.tools)));
    assert.deepEqual(readTranscript(path.join(tmp, "missing.jsonl")), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  assert.equal(nativeIdOf({ id: "t1" }), "t1");
  assert.equal(nativeIdOf({ id: "t1", native: "n2" }), "n2");
  assert.deepEqual(usageOf({ usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 }, total_cost_usd: 0.01, model: "claude-sonnet-4-5" }), { tokens: 17, cost_usd: 0.01, limit: 200000 });
  assert.equal(usageOf({}), null);
  assert.equal(usageOf("/no/such/file.jsonl"), null);
});
