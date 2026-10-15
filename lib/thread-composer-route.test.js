// @ts-check
import assert from "node:assert/strict";
import test from "node:test";
import "../scripts/mac-test-guard.mjs";
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
  assert.equal(routeComposerLine("/compact keep todos").tool, "threads.send");
  assert.equal(routeComposerLine("/compact keep todos").sendAsMessage, true);
});

test("laterInput parses a quoted time and the instruction after it", () => {
  assert.deepEqual(laterInput('"at 5pm" check the intake thread'), { kind: "reminder", title: "check the intake thread", body: "check the intake thread", at: "at 5pm" });
});
