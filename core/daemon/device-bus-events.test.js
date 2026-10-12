// @ts-check
// The module bus (GET /v1/events and /v1/events/stream) for a PAIRED DEVICE that is not the home's owner's: a member's device is a device of this home too (a relay row of kind app), reaches the
// router as `device:<id>`, and used to read every person's planner titles. A real vyred; the device row is the home's own, naming nobody (callerFacts gives it no person). Run on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { start } from "./index.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const get = (/** @type {http.Server} */ srv, /** @type {string} */ p, /** @type {number} */ ms = 1500) => new Promise(resolve => {
  const addr = /** @type {any} */ (srv.address());
  let body = "";
  const req = http.request({ port: addr.port, host: "127.0.0.1", path: p, method: "GET" }, res => { res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body })); });
  req.on("error", e => resolve({ status: 0, body: String(e.message) }));
  setTimeout(() => { req.destroy(); resolve({ status: -1, body }); }, ms);
  req.end();
});

test("a paired device that is not the owner's reads none of the module bus; the main socket's route is unchanged", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: K.id.owner, path: "direct", session: "s" });
  const ownerToken = { token: (await K.surfaces.open(ownerChain, {})).token };
  const id = "mmmmmmmmmmmmmmmm";
  d.registry.deps.db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'ben phone', 'p', 1, 'app', 0, NULL)").run(id);
  const add = await d.registry.call("planner.add", { kind: "note", title: "OWNER-DEVICE-BUS-SECRET", body: "x" }, "cli", ownerToken);
  assert.ok(!add.error, JSON.stringify(add.error));
  const serve = (/** @type {string | undefined} */ caller) => new Promise(r => { const s = http.createServer((req, res) => d.registry.deps.handler({})(req, res, caller, { kind: "device", stableId: id })); s.listen(0, "127.0.0.1", () => r(s)); });
  const dev = /** @type {http.Server} */ (await serve("device:" + id)); t.after(() => dev.close());
  const a = await get(dev, "/v1/events?since=0&limit=500"), b = await get(dev, "/v1/events/stream?since=0");
  assert.equal(a.status, 404, a.body); assert.equal(b.status, 404, b.body);
  assert.ok(!a.body.includes("OWNER-DEVICE-BUS-SECRET") && !b.body.includes("OWNER-DEVICE-BUS-SECRET"));
  const main = /** @type {http.Server} */ (await serve(undefined)); t.after(() => main.close());
  const m = await get(main, "/v1/events?since=0&limit=500");
  assert.equal(m.status, 200, "control: a route with no device caller still serves the bus"); assert.ok(m.body.includes("OWNER-DEVICE-BUS-SECRET"));
});
