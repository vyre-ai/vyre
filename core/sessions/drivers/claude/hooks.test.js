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
