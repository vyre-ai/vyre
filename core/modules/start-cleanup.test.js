// @ts-check
// A module that opens something in start() and then fails (a tool its manifest does not declare, a throw) has it closed through ctx.own; a start that succeeds keeps it for the module's own stop().
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { startWithCleanup } from "./start-cleanup.js";

const listening = () => new Promise(r => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => r(s)); });

test("a failed start closes what ctx.own registered, newest first, and still throws the failure", async () => {
  const order = [], ctx = /** @type {any} */ ({});
  const server = await listening();
  const mod = { async start(/** @type {any} */ c) { c.own(() => order.push("first")); c.own(() => new Promise(r => server.close(() => { order.push("server"); r(undefined); }))); throw new Error("tool not declared"); } };
  await assert.rejects(startWithCleanup(mod, ctx, () => {}, "demo"), /tool not declared/);
  assert.deepEqual(order, ["server", "first"]);
  assert.equal(server.listening, false);
});

test("a closer that throws is logged and the rest still run", async () => {
  const said = [], ran = [];
  const mod = { async start(/** @type {any} */ c) { c.own(() => ran.push("a")); c.own(() => { throw new Error("stuck"); }); throw new Error("boom"); } };
  await assert.rejects(startWithCleanup(mod, {}, m => said.push(m), "demo"), /boom/);
  assert.deepEqual(ran, ["a"]);
  assert.match(said[0], /could not close something.*stuck/);
});

test("a start that succeeds keeps its resources: nothing is closed", async () => {
  const server = await listening();
  const out = await startWithCleanup({ async start(/** @type {any} */ c) { c.own(() => server.close()); return { stop() {} }; } }, {}, () => {}, "demo");
  assert.ok(out && server.listening);
  server.close();
});
