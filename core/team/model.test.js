// @ts-check
// team.ask's optional `model` (SPEC-0.3.0 part 6): a request may name the provider (and model) that does its work. It runs in a session made for that request alone, through the same launch,
// Gate and spend as any teammate session; the teammate's standing thread is not touched. Only recorded and fake sessions here: nothing is sent to a live provider.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { modelChoice } from "./index.js";
import { boot, until } from "./team-fixture.js";

test("modelChoice: a provider, provider/model or a bare Claude model name; nothing else", () => {
  assert.equal(modelChoice(undefined), null);
  assert.equal(modelChoice(""), null);
  assert.deepEqual(modelChoice("codex"), { provider: "codex", label: "codex" });
  assert.deepEqual(modelChoice("grok/grok-4"), { provider: "grok", model: "grok-4", label: "grok/grok-4" });
  assert.deepEqual(modelChoice("openrouter/anthropic/claude-x"), { provider: "openrouter", model: "anthropic/claude-x", label: "openrouter/anthropic/claude-x" });
  assert.deepEqual(modelChoice("opus"), { provider: "claude", model: "opus", label: "claude/opus" });
  assert.deepEqual(modelChoice("claude-opus-5-5"), { provider: "claude", model: "claude-opus-5-5", label: "claude/claude-opus-5-5" });
  for (const bad of ["--dangerously-skip-permissions", "-m", "codex /x", "nope/thing", "a b", "x".repeat(200), "../../etc"]) assert.throws(() => modelChoice(bad), /model is|not a provider/, bad);
});

test("team.ask with a model runs that request in a session of its own on that model, and leaves the teammate's standing thread alone", { timeout: 120_000 }, async t => {
  const { tool, project, launches } = await boot(t);
  const tm = await tool("team.add", { project: project.record, role: "design", brief: "visual design" });
  const first = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"standing","notes":"unchanged","reason":"test"}' });
  assert.equal(first.state, "done");
  const [row0] = await tool("team.list", { project: project.record });
  void row0;
  const standing = (await tool("team.status", { request: first.request })).thread;
  assert.equal(standing, null, "an ordinary request records no thread of its own");
  const before = launches().length;

  const ask = await tool("team.ask", { to: "design", project: project.record, wait: true, model: "claude/opus", text: 'vyre team.done {"result":"on opus","notes":"unchanged","reason":"test"}' });
  assert.equal(ask.state, "done");
  assert.equal(ask.model, "claude/opus");
  const mine = launches().slice(before);
  assert.equal(mine.length, 1);
  assert.ok(mine[0].argv.includes("--model") && mine[0].argv[mine[0].argv.indexOf("--model") + 1] === "opus", `the launch asked for opus: ${mine[0].argv.join(" ")}`);
  assert.ok(!mine[0].argv.includes("--resume"), "a fresh session, not the standing thread resumed");
  const status = await tool("team.status", { request: ask.request });
  assert.equal(status.model, "claude/opus");
  assert.ok(status.thread, "the request records its own session, so a person can stop it");

  // the next ordinary request resumes the teammate's own thread, as if the model request had not happened
  await until(async () => { const [r] = await tool("team.list", { project: project.record }); return r.state === "idle" ? r : null; }, "the teammate to go idle");
  const third = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"back","notes":"unchanged","reason":"test"}' });
  assert.equal(third.state, "done");
  assert.equal((await tool("team.status", { request: third.request })).model, null);
  assert.ok(tm.agent);
});

test("team.ask refuses a model it cannot read, and a request for a provider with no account fails plainly instead of falling back to Claude", { timeout: 120_000 }, async t => {
  const { tool, project, raw } = await boot(t);
  await tool("team.add", { project: project.record, role: "qa" });
  const bad = await raw("team.ask", { to: "qa", project: project.record, text: "x", model: "--dangerously-skip-permissions" });
  assert.equal(bad.error.code, "bad_input");
  const ask = await tool("team.ask", { to: "qa", project: project.record, wait: true, model: "codex", text: "check it" });
  assert.equal(ask.state, "failed", JSON.stringify(ask));
  assert.match(ask.result, /could not start/);
  assert.equal(ask.model, "codex");
});
