// @ts-check
// The switchboard's CLI without a daemon: the SSE parser, the event formatter, and that
// `vyre threads` resolves to the switchboard command while searches still reach the catalogue.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import threadsCmd, { parseSSE, formatEvent, catalogueCommand } from "./threads.js";
import projects from "./projects.js";
import agentsCmd, { agentFields } from "./agents.js";
import { commands } from "../index.js";

// Colour is off when stdout is not a terminal, which it is not under node --test; strip anyway.
const plain = s => (s == null ? s : s.replace(/\x1b\[[0-9;]*m/g, ""));

test("parseSSE: a frame split across chunks is held back until its blank line", () => {
  const a = parseSSE("id: 7\nevent: thread.text\nda");
  assert.deepEqual(a.frames, []);
  const b = parseSSE(a.rest + 'ta: {"n":1}\n\nid: 8\n');
  assert.deepEqual(b.frames, [{ id: "7", event: "thread.text", data: '{"n":1}' }]);
  assert.equal(b.rest, "id: 8\n");
  const c = parseSSE(b.rest + "event: lease.changed\ndata: {}\n\n");
  assert.deepEqual(c.frames, [{ id: "8", event: "lease.changed", data: "{}" }]);
  assert.equal(c.rest, "");
});

test("parseSSE: heartbeat comments are ignored, and so are frames of nothing but comments", () => {
  const r = parseSSE(": beat\n\nid: 1\n: mid-frame comment\ndata: x\n\n: beat\n\n");
  assert.deepEqual(r.frames, [{ id: "1", event: null, data: "x" }]);
  assert.equal(r.rest, "");
});

test("parseSSE: several data lines join with a newline; CRLF is accepted", () => {
  const r = parseSSE("data: one\r\ndata: two\r\ndata:three\r\n\r\n");
  assert.deepEqual(r.frames, [{ id: null, event: null, data: "one\ntwo\nthree" }]);
});

test("formatEvent: text deltas stream inline, and the final text only ends the line", () => {
  const seen = new Set();
  assert.equal(formatEvent({ type: "thread.text", payload: { message: "m1", delta: "Filing " } }, seen), "Filing ");
  assert.equal(formatEvent({ type: "thread.text", payload: { message: "m1", delta: "is due." } }, seen), "is due.");
  assert.equal(formatEvent({ type: "thread.text", payload: { message: "m1", text: "Filing is due.", done: true } }, seen), "\n");
  assert.equal(seen.size, 0);
});

test("formatEvent: a final text that never streamed is printed whole", () => {
  assert.equal(plain(formatEvent({ type: "thread.text", payload: { message: "vyre", text: "Continuing on the API key.", done: true, notice: true } })), "Continuing on the API key.\n");
});

test("formatEvent: a tool start is a dim bullet; its end shows nothing", () => {
  assert.equal(plain(formatEvent({ type: "thread.tool", payload: { phase: "started", tool: "Read", summary: "Read ~/Harlow Legal/brief.md" } })), "  · Read ~/Harlow Legal/brief.md\n");
  assert.equal(formatEvent({ type: "thread.tool", payload: { phase: "done", error: false } }), null);
});

test("formatEvent: ask.raised names the ask, what it wants and how to answer", () => {
  const s = plain(formatEvent({ type: "ask.raised", payload: { ask: "a1b2c3d4e5", tool: "Bash", summary: "Bash command: git push", destination: "origin" } }));
  assert.match(s, /a1b2c3d4e5/);
  assert.match(s, /Bash: Bash command: git push/);
  assert.match(s, /-> origin/);
  assert.match(s, /vyre threads answer a1b2c3d4e5 allow\|deny/);
});

test("formatEvent: answers, keyboard changes, finishes and stops", () => {
  assert.equal(plain(formatEvent({ type: "ask.answered", payload: { ask: "a1", decision: "allow", by: "cli:42" } })), "  ask a1 allow by cli:42\n");
  assert.equal(plain(formatEvent({ type: "lease.changed", payload: { holder: "deck:dana", previous: "cli:42" } })), "  keyboard: deck:dana\n");
  assert.equal(plain(formatEvent({ type: "lease.changed", payload: { holder: null, previous: "cli:42" } })), "  keyboard: free\n");
  assert.equal(plain(formatEvent({ type: "thread.finished", payload: { ok: true, cost_usd: 0.0123 } })), "  done · $0.0123\n");
  assert.match(plain(formatEvent({ type: "thread.finished", payload: { ok: false, cost_usd: 0, error: "limit" } })), /failed · \$0\.0000 · limit/);
  assert.equal(plain(formatEvent({ type: "thread.stopped", payload: { code: 0, reason: "stopped" } })), "  stopped · stopped\n");
  assert.match(plain(formatEvent({ type: "thread.sent", payload: { text: "draft the Harlow Legal intake", surface: "cli:42" } })), /> draft the Harlow Legal intake/);
  assert.equal(formatEvent({ type: "watcher.fired", payload: {} }), null);
});

test("commands(): threads resolves to the switchboard command, ahead of the catalogue", async () => {
  const all = await commands();
  const first = all.find(c => c.name === "threads");
  assert.equal(first, threadsCmd);
  assert.ok(all.includes(agentsCmd));
});

test("a non-subcommand is delegated to the projects catalogue command", () => {
  const c = catalogueCommand();
  assert.equal(c, projects.find(x => x.name === "threads"));
  assert.notEqual(c, threadsCmd);
  assert.match(String(c.usage), /\[search\]/);
});

test("agentFields: only the flags given, with projects and auth shaped for the tool", () => {
  assert.deepEqual(agentFields({}), {});
  assert.deepEqual(agentFields({ assistant: true, projects: "*" }), { kind: "assistant", projects: "*" });
  assert.deepEqual(agentFields({ projects: "harlow-legal, reyes-intake", vault: "harlow-token", fallback: "api-key", budget: "20" }),
    { projects: ["harlow-legal", "reyes-intake"], auth: { vault: "harlow-token", fallback: "api-key", budget_usd: 20 } });
  assert.throws(() => agentFields({ budget: "lots" }), /--budget/);
});
