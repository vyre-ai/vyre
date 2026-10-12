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
  let body = "", status = -1;
  const req = http.request({ port: addr.port, host: "127.0.0.1", path: p, method: "GET" }, res => { status = res.statusCode || 0; res.on("data", c => { body += c; }); res.on("end", () => resolve({ status: res.statusCode, body })); });
  req.on("error", e => resolve({ status: 0, body: String(e.message) }));
  setTimeout(() => { req.destroy(); resolve({ status, body }); }, ms);
  req.end();
});

test("the module bus for a paired device: owner and admin whole, a member cut to ids, a device naming nobody refused; the main socket unchanged", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, ADMIN = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const [person, role] of [[ADMIN, "admin"], [BEN, "member"]]) await K.gateway.grants.setRole(ownerChain, { person, role }, { presence: { op: "stand-in", fields: {}, n: Math.random() } });
  const ownerToken = { token: (await K.surfaces.open(ownerChain, {})).token };
  const db = d.registry.deps.db;
  const ids = { owner: "oooooooooooooooo", admin: "aaaaaaaaaaaaaaaa", member: "mmmmmmmmmmmmmmmm", nobody: "nnnnnnnnnnnnnnnn" };
  const dev = db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'phone', 'p', 1, 'app', 0, NULL)");
  const rec = db.prepare("INSERT INTO wink_devices (id, identity, kind, name, created, confirmed_by, owner_kind, owner_id) VALUES (?, ?, 'phone', 'phone', 1, ?, 'person', ?)");
  for (const [k, person] of [["owner", OWNER], ["admin", ADMIN], ["member", BEN]]) { dev.run(ids[k]); rec.run(ids[k], person, OWNER, person); }
  dev.run(ids.nobody);
  // the same four people as a trusted browser (kind web), a setup page and a label no row backs
  const web = db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'browser', 'p', 1, 'web', 1, NULL)");
  const wids = { owner: "wooooooooooooooo", admin: "waaaaaaaaaaaaaaa", member: "wmmmmmmmmmmmmmmm", nobody: "wnnnnnnnnnnnnnnn" };
  for (const [k, person] of [["owner", OWNER], ["admin", ADMIN], ["member", BEN]]) { web.run(wids[k]); rec.run(wids[k], person, OWNER, person); }
  web.run(wids.nobody);   // a trusted browser from the older pairing: the owner trusted it with his presence, and that pairing writes no Wink record
  db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES ('wuuuuuuuuuuuuuuu', 'untrusted', 'p', 1, 'web', 0, NULL)").run();
  db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES ('ssssssssssssssss', 'setup', 'p', 1, 'setup', 0, NULL)").run();
  rec.run("ssssssssssssssss", OWNER, OWNER, OWNER);
  const add = await d.registry.call("planner.add", { kind: "note", title: "OWNER-DEVICE-BUS-SECRET", body: "x" }, "cli", ownerToken);
  assert.ok(!add.error, JSON.stringify(add.error));
  d.registry.deps.events.emit("sidebar", "sidebar.changed", { title: "LEAK-IN-SIDEBAR", n: 3 });
  const serve = (/** @type {string | undefined} */ caller, /** @type {string} */ id) => new Promise(r => { const s = http.createServer((req, res) => d.registry.deps.handler({})(req, res, caller, { kind: "device", stableId: id })); s.listen(0, "127.0.0.1", () => r(s)); });
  const as = async (/** @type {string} */ who) => { const s = /** @type {http.Server} */ (await serve("device:" + ids[who], ids[who])); t.after(() => s.close()); return s; };
  for (const who of ["owner", "admin"]) {
    const a = await get(await as(who), "/v1/events?since=0&limit=500"), b = await get(await as(who), "/v1/events/stream?since=0");
    assert.ok(a.status === 200 && a.body.includes("OWNER-DEVICE-BUS-SECRET"), `${who}: the whole bus (${a.status})`);
    assert.ok(b.body.includes("OWNER-DEVICE-BUS-SECRET"), `${who}: the whole stream`);
  }
  const mem = await as("member");
  for (const [p, name] of [["/v1/events?since=0&limit=500", "events"], ["/v1/events/stream?since=0", "stream"]]) {
    const r = await get(mem, p);
    assert.equal(r.status, 200, `member ${name} stays open`);
    assert.ok(!r.body.includes("OWNER-DEVICE-BUS-SECRET") && !r.body.includes("LEAK-IN-SIDEBAR") && !r.body.includes("planner.added"), `member ${name}: no title or planner event: ${r.body.slice(0, 300)}`);
    assert.ok(r.body.includes("sidebar.changed"), `member ${name}: the allow-listed type arrives`);
  }
  const none = await get(await as("nobody"), "/v1/events?since=0");
  assert.equal(none.status, 404, none.body);
  // a trusted browser is judged the same way, by the person the home's record names
  const asWeb = async (/** @type {string} */ label, /** @type {string} */ id) => { const s = /** @type {http.Server} */ (await serve(label, id)); t.after(() => s.close()); return s; };
  for (const who of ["owner", "admin"]) { const r = await get(await asWeb("web:" + wids[who], wids[who]), "/v1/events?since=0&limit=500"); assert.ok(r.status === 200 && r.body.includes("OWNER-DEVICE-BUS-SECRET"), `web ${who}: the whole bus (${r.status})`); }
  { const r = await get(await asWeb("web:" + wids.member, wids.member), "/v1/events/stream?since=0"); assert.ok(r.status === 200 && !r.body.includes("OWNER-DEVICE-BUS-SECRET") && !r.body.includes("planner.added") && r.body.includes("sidebar.changed"), `web member is cut: ${r.status} ${r.body.slice(0, 200)}`); }
  { const r = await get(await asWeb("web:" + wids.nobody, wids.nobody), "/v1/events?since=0&limit=500"); assert.ok(r.status === 200 && r.body.includes("OWNER-DEVICE-BUS-SECRET"), `a trusted browser naming nobody is the owner's own (${r.status})`); }
  for (const [label, id] of [["web:wuuuuuuuuuuuuuuu", "wuuuuuuuuuuuuuuu"], ["setup:ssssssssssssssss", "ssssssssssssssss"], ["tailnet:someone", "x"], ["web:" + ids.member, ids.member], ["device:" + wids.owner, wids.owner]]) {
    for (const p of ["/v1/events?since=0", "/v1/events/stream?since=0"]) { const r = await get(await asWeb(label, id), p); assert.equal(r.status, 404, `${label} ${p}: ${r.status} ${r.body.slice(0, 120)}`); }
  }
  const main = /** @type {http.Server} */ (await serve(undefined, "x")); t.after(() => main.close());
  const m = await get(main, "/v1/events?since=0&limit=500");
  assert.equal(m.status, 200, "control: no device caller serves the bus"); assert.ok(m.body.includes("OWNER-DEVICE-BUS-SECRET"));
});
