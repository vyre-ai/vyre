// @ts-check
// R031-43: Connections list their Flows.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, ALEX } from "./testing/world.js";
import { createFlows } from "./index.js";

const svc = (/** @type {string} */ id, /** @type {string} */ connector) => ({ id, kind: "service", connector, method: "GET", path: "/v1/status" });
const flowOf = (/** @type {string} */ name, /** @type {any[]} */ steps) => ({ format: 1, name, label: name.toUpperCase(), authorship: "human", trigger: { on: "manual" }, steps });
const chainOf = () => ({ hops: [{ actor: ALEX }] });

test("R031-43: a Connection lists the Flows that use it, with health, and a red Connection shows red on each", async () => {
  const cat0 = (await (await world({})).runner.catalogFn());
  const w = await world({ cat: { ...cat0, connectors: { "conn-orbit": { host: "api.orbit.test", routes: [{ methods: ["GET"], paths: ["/v1/*"] }] }, "conn-acme": { host: "api.acme.test", routes: [{ methods: ["GET"], paths: ["/v1/*"] }] } }, lights: { "conn-orbit": "red" } } });
  const f = createFlows({ kernel: w.kernel, chains: { forFlow: (/** @type {any} */ x) => w.kernel.chainFor(x), forModule: (/** @type {any} */ x) => w.kernel.moduleChain(x), forDoer: (/** @type {any} */ x) => w.kernel.chainFor(x) }, store: w.store, catalog: () => w.cat });
  await install(w, flowOf("uses_orbit", [svc("a", "conn-orbit")]));
  await install(w, flowOf("uses_both", [svc("a", "conn-orbit"), svc("b", "conn-acme")]));
  await install(w, flowOf("uses_none", [{ id: "n", kind: "find", type: "matter" }]));
  const all = (await f.tools["flows.connections"](chainOf(), {})).connections;
  assert.deepEqual(all.map((/** @type {any} */ c) => [c.connection, c.flows.map((/** @type {any} */ x) => x.label).sort()]), [["acme", ["USES_BOTH"]], ["orbit", ["USES_BOTH", "USES_ORBIT"]]]);
  const orbit = all.find((/** @type {any} */ c) => c.connection === "orbit");
  assert.ok(orbit.flows.every((/** @type {any} */ x) => x.level === "red" && /Red: orbit/.test(x.line)), JSON.stringify(orbit.flows));
  const one = (await f.tools["flows.connections"](chainOf(), { connection: "acme" })).connections;
  assert.equal(one.length, 1);
  const listed = await f.tools["flows.list"](chainOf(), {});
  assert.deepEqual(listed.find((/** @type {any} */ r) => r.label === "USES_BOTH").connections.sort(), ["acme", "orbit"]);
  assert.equal(listed.find((/** @type {any} */ r) => r.label === "USES_NONE").connections, undefined);
});
