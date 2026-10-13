// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { refuseNonPerson } from "./person-body.js";

const denied = (/** @type {string} */ caller) => assert.throws(() => refuseNonPerson({ caller }, "does it"), e => /** @type {any} */ (e).code === "denied", caller);

test("person-body: an agent, a thread, a hook, a model, the harness and a guest are denied", () => {
  for (const c of ["agent:kit", "cli:agent:kit", "cli:thread:x", "hook", "mcp", "mcp:agent:kit", "device:agent:kit", "harness", "tailnet-guest", ""]) denied(c);
  assert.throws(() => refuseNonPerson(undefined, "does it"), e => /** @type {any} */ (e).code === "denied");
});

test("person-body: a person's surface and a module pass", () => {
  for (const c of ["cli", "local", "deck", "capsule", "device:abcdef", "module:mcp", "module:files"]) assert.doesNotThrow(() => refuseNonPerson({ caller: c }, "does it"), c);
});
