// @ts-check
import "../scripts/mac-test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { laterInput, routeComposerLine, routeLine } from "./thread-composer-route.js";

test("routeLine keeps the CLI contract for shell, remember and send", () => {
  assert.deepEqual(routeLine("!ls -la"), { tool: "threads.shell", body: "ls -la" });
  assert.deepEqual(routeLine("/remember prefer tabs"), { tool: "threads.remember", body: "prefer tabs" });
  assert.deepEqual(routeLine("/compact"), { tool: "threads.send", body: "/compact" });
  assert.deepEqual(routeLine("hello", true), { tool: "threads.send", body: "hello" });
});

test("routeComposerLine maps native slash commands to kernel tools", () => {
  assert.equal(routeComposerLine("/remember x").tool, "threads.remember");
  assert.equal(routeComposerLine("/model opus").tool, "threads.model");
  assert.deepEqual(routeComposerLine("/model opus").input, { model: "opus" });
  assert.equal(routeComposerLine("/effort high").tool, "threads.effort");
  assert.equal(routeComposerLine("/later at 5pm check inbox").tool, "planner.add");
  assert.equal(routeComposerLine("/find northwind").tool, "recall.search");
  assert.equal(routeComposerLine("/roll").tool, "threads.roll");
  assert.equal(routeComposerLine("/compact keep todos").tool, "threads.send");
  assert.equal(routeComposerLine("/compact keep todos").sendAsMessage, true);
});

const SESSION_SEND = [
  "/clear", "/compact", "/resume", "/init", "/review", "/export", "/usage", "/agents", "/help", "/status",
  "/plan", "/permissions", "/mcp", "/memory", "/vyre", "/context", "/cost", "/rename", "/undo", "/goal",
];

test("session slash commands go through threads.send as messages", () => {
  for (const line of SESSION_SEND) {
    const r = routeComposerLine(line);
    assert.equal(r.tool, "threads.send", line);
    assert.equal(r.sendAsMessage, true, line);
    assert.equal(r.input.text, line, line);
  }
});

test("aliases search→find and remind→later", () => {
  assert.equal(routeComposerLine("/search x").tool, "recall.search");
  assert.equal(routeComposerLine("/remind at 9am tea").tool, "planner.add");
});

test("/model with no body reads the thread", () => {
  assert.deepEqual(routeComposerLine("/model"), { tool: "threads.get", input: { limit: 1 } });
});

test("/find with no body lists commands", () => {
  assert.deepEqual(routeComposerLine("/find"), { tool: "threads.commands", input: {} });
});

test("/rewind routes to threads.rewind", () => {
  assert.deepEqual(routeComposerLine("/rewind msg-1"), { tool: "threads.rewind", input: { uuid: "msg-1" } });
  assert.deepEqual(routeComposerLine("/rewind"), { tool: "threads.rewind", input: {} });
});

test("laterInput parses a quoted time and the instruction after it", () => {
  assert.deepEqual(laterInput('"at 5pm" check the intake thread'), { kind: "reminder", title: "check the intake thread", body: "check the intake thread", at: "at 5pm" });
});

test("a plain line goes as a message, so a first message in a new chat starts the session (not threads.slash)", async () => {
  const { goesAsMessage } = await import("./thread-composer-route.js");
  assert.equal(goesAsMessage(routeComposerLine("Heyy")), true);
  assert.equal(goesAsMessage(routeComposerLine("/compact")), true);
  for (const line of ["/model sonnet", "/later at 5pm x", "/find x", "!ls", "/remember x"]) assert.equal(goesAsMessage(routeComposerLine(line)), false, line);
});

test("box-stream sends by goesAsMessage, never by the slash-only sendAsMessage flag", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../apps/app/src/chat/box-stream.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("sendAsMessage"), "plain lines carry no sendAsMessage, so that test sent them to threads.slash");
  assert.equal((src.match(/!goesAsMessage\(route\)/g) || []).length, 2);
});
