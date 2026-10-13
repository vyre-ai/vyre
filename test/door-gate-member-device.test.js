// @ts-check
// A member's OWN device and the other labels a member can arrive under (rc1-a's step-0 probe, team/0.3.4/proof/member-labels-probe.test.js), against the door gate (core/modules/door-gate.js) on a real daemon with the
// kernel on: the call names an owner's tool (memprobe.who, a module tool that is on no member list). A member's call is refused in words and the tool never runs, so it is never served as the module's own chain.
// The owner's verified tailnet node is served as before. Path (b) of the door gate's proof; path (a), a member session's `vyre call`, is J12 on a real box.
import "../scripts/mac-test-guard.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { start } from "../core/daemon/index.js";
import { tempHome, writeModule } from "./helpers.js";
process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
test("the door gate on a team server: every way a member reaches the registry without a person on the call is refused in words on an owner tool, and the module never runs; the owner is served", { timeout: 120000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex", owner: "owner@example.com" } }));
  writeModule(path.join(root, "modules"), "memprobe", { roles: ["box"], does: { tools: ["memprobe.who"] } }, `
    export default { async start(ctx) {
      ctx.tool("memprobe.who", { effect: "read", input: { type: "object" }, run: async (input, meta) => {
        let chain = null; try { const c = await ctx.kernel.chain(meta || {}); chain = c ? c.hops.map(h => h.actor.kind + ":" + String(h.actor.id).slice(0, 9)) : null; } catch (e) { chain = "err:" + e.message.slice(0, 50); }
        return { caller: meta.caller, facts: meta.kernelFacts ? (meta.kernelFacts.kind + "/" + String(meta.kernelFacts.person || "").slice(0, 9) + "/" + (meta.kernelFacts.path || "")) : null, person: meta.person ? meta.person.id + "/" + meta.person.kind : null, chain }; } });
      return {};
    } };`);
  const d = await start({ root, firstPartyRoots: [path.join(root, "modules")], log: () => {}, kernel: true, kernelPresence: { check: async () => null }, presence: { required: () => false, verify: async () => ({ ok: true, method: "passkey", keyId: "k" }), challenge: async () => ({ error: { code: "bad_input", message: "x" } }), summary: async () => "", covered: () => false, coverage: () => ({ covered: false }), enrolled: [], enroll() { return { id: "kh" }; } } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
  const oc = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await K.gateway.grants.setRole(oc, { person: BEN, role: "member" }, { presence: { op: "stand-in", fields: {}, n: Math.random() } });
  const db = d.registry.deps.db;
  const dev = db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'phone', 'p', 1, 'app', 0, NULL)");
  const web = db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'browser', 'p', 1, 'web', 1, NULL)");
  const rec = (id, person, confirmed) => db.prepare("INSERT INTO wink_devices (id, identity, kind, name, created, confirmed_by, owner_kind, owner_id) VALUES (?, ?, 'phone', 'phone', 1, ?, 'person', ?)").run(id, person, confirmed ? OWNER : null, person);
  dev.run("bendeviceconfirm"); rec("bendeviceconfirm", BEN, true);
  dev.run("bendeviceprovis0"); rec("bendeviceprovis0", BEN, false);
  dev.run("nobodydevice0000");
  web.run("benwebtrusted000"); rec("benwebtrusted000", BEN, true);
  const call = async (label, peer, headers = {}) => new Promise(res => {
    const srv = http.createServer((req, rs) => d.registry.deps.handler({})(req, rs, label, peer));
    srv.listen(0, "127.0.0.1", () => {
      const rq = http.request({ port: srv.address().port, host: "127.0.0.1", path: "/v1/tools/memprobe.who", method: "POST", headers: { "content-type": "application/json", ...headers } }, x => { let s = ""; x.on("data", c => { s += c; }); x.on("end", () => { srv.close(); res(x.statusCode + " " + s.slice(0, 260)); }); });
      rq.end("{}");
    });
  });
  const out = /** @type {Record<string, string>} */ ({});
  out["member device, confirmed, names Ben"] = await call("device:bendeviceconfirm", { kind: "device", stableId: "bendeviceconfirm" });
  out["member device, provisional (unconfirmed)"] = await call("device:bendeviceprovis0", { kind: "device", stableId: "bendeviceprovis0" });
  out["device naming nobody"] = await call("device:nobodydevice0000", { kind: "device", stableId: "nobodydevice0000" });
  out["visiting person space:ben@spc_team"] = await call("space:ben@spc_team", { kind: "space", login: "ben" });
  out["tailnet-guest:ben@example.com"] = await call("tailnet-guest:ben@example.com", { login: "ben@example.com", stableId: "n_b" });
  const bc = K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "direct", session: "s" });
  const token = (await K.surfaces.open(bc, {})).token;
  const sess = await d.registry.call("memprobe.who", {}, "mcp", { token });
  out["Ben's session token, as mcp (registry.call)"] = JSON.stringify(sess.error ? { error: sess.error } : { data: sess.data });
  const mine = await d.registry.call("tasks.list", {}, "mcp", { token });
  out["Ben's session token on a tool of his own list (tasks.list)"] = JSON.stringify(mine.error ? { error: mine.error } : { ok: true });
  const owner = await call("tailnet:owner@example.com", { login: "owner@example.com", stableId: "n_o" });
  for (const [k, v] of Object.entries(out)) console.log("GATEROW", k.padEnd(60), v.slice(0, 260));
  console.log("GATEROW owner tailnet (verified)".padEnd(70), owner.slice(0, 260));
  const refused = (/** @type {string} */ v) => /owner's|Ask the owner or an admin/i.test(v) && !/"chain"/.test(v);
  for (const k of ["member device, confirmed, names Ben", "member device, provisional (unconfirmed)", "device naming nobody", "visiting person space:ben@spc_team", "tailnet-guest:ben@example.com", "Ben's session token, as mcp (registry.call)"]) {
    assert.ok(refused(out[k]), `${k}: refused in words and the tool did not run: ${out[k]}`);
  }
  assert.doesNotMatch(out["Ben's session token on a tool of his own list (tasks.list)"], /This is the owner's|Ask the owner or an admin/, "a tool on her own list is not refused by the gate");
  assert.ok(/^200 /.test(owner) && new RegExp(`"facts":"device/${OWNER.slice(0, 9)}`).test(owner), `the owner's verified node is served, on the facts the daemon proved for the owner: ${owner}`);
});
