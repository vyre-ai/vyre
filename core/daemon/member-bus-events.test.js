// @ts-check
// The module bus (GET /v1/events and /v1/events/stream on a session's own socket): does a member's session receive the events other people's planner items raise (planner.added carries a title), and the rest of the bus?
// A real vyred, the owner adds a note, member Ben's session socket (openThreadSocket, his kernel credential stamped by the daemon) reads the bus. Run on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "./index.js";
import { openThreadSocket } from "./threadsock.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const get = (/** @type {string} */ sock, /** @type {string} */ p, /** @type {number} */ ms = 1500) => new Promise(resolve => {
  let body = "";
  const req = http.request({ socketPath: sock, path: p, method: "GET", headers: { "x-vyre-caller": "mcp" } }, res => { res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body })); });
  req.on("error", e => resolve({ status: 0, body: String(e.message) }));
  setTimeout(() => { req.destroy(); resolve({ status: -1, body }); }, ms);
  req.end();
});

test("a member's session socket: the module bus shows her none of the owner's planner items", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: { op: "stand-in", fields: {}, n: 1 } });
  const benChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "relay" });
  const benToken = (await K.surfaces.open(benChain, {})).token;
  const ownerToken = { token: (await K.surfaces.open(ownerChain, {})).token };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-bus-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sock = await openThreadSocket({ handler: d.registry.deps.handler, thread: "tbus1", pids: async () => ({ pids: [process.pid] }), dir, kernelToken: async () => benToken, log: () => {} });
  t.after(() => sock.close && sock.close());
  const file = sock.path || sock.file;
  assert.ok(file, "the socket opened: " + Object.keys(sock));
  const add = await d.registry.call("planner.add", { kind: "note", title: "OWNER-BUS-SECRET", body: "x" }, "cli", ownerToken);
  assert.ok(!add.error, JSON.stringify(add.error));
  const since = await get(file, "/v1/events?since=0&limit=500");
  console.log("BUS /v1/events", since.status, since.body.includes("OWNER-BUS-SECRET") ? "LEAKS the note title" : "no title", "| types:", [...new Set([...since.body.matchAll(/"type":"([^"]+)"/g)].map(m => m[1]))].slice(0, 12).join(","));
  const stream = await get(file, "/v1/events/stream?since=0", 1500);
  console.log("BUS /v1/events/stream", stream.status, stream.body.includes("OWNER-BUS-SECRET") ? "LEAKS the note title" : "no title");
  assert.equal(since.status, 404, "a session socket does not serve the module bus: " + since.body);
  assert.equal(stream.status, 404, "nor its stream: " + stream.body);
  assert.match(since.body, /event bus/, "the answer says where to go");
  assert.ok(!since.body.includes("OWNER-BUS-SECRET") && !stream.body.includes("OWNER-BUS-SECRET"), "Ben's session reads none of the owner's note on the module bus");
});
