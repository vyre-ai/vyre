import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { start } from "../core/daemon/index.js";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { tempHome, writeModule } from "./helpers.js";
const LIB = pathToFileURL(fileURLToPath(new URL("../lib/person-of-call.js", import.meta.url))).href;
process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
test("personOfCall through the real route: a member's device, browser and visitor are nobody; her session token is her; the owner's socket and modules are not strangers", { timeout: 120000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", name: "alex", transcripts: [], network: { name: "alex", owner: "owner@example.com" } }));
  writeModule(path.join(root, "modules"), "memprobe", { roles: ["box"], does: { tools: ["memprobe.who"] } }, `
    import { personOfCall } from ${JSON.stringify(LIB)};
    export default { async start(ctx) {
      ctx.tool("memprobe.who", { effect: "read", input: { type: "object" }, run: async (input, meta) => ({ who: await personOfCall(ctx, meta) }) });
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
  const who = async (label, peer) => { const r = await call(label, peer); const body = JSON.parse(r.slice(r.indexOf(" ") + 1)); return body.data ? body.data.who : "refused"; };
  const BENSAY = { kind: "device", stableId: "x" };
  assert.equal(await who("device:bendeviceconfirm", { kind: "device", stableId: "bendeviceconfirm" }), null, "Ben's confirmed device is nobody to the kernel");
  assert.equal(await who("device:bendeviceprovis0", { kind: "device", stableId: "bendeviceprovis0" }), null);
  assert.equal(await who("device:nobodydevice0000", { kind: "device", stableId: "nobodydevice0000" }), null);
  assert.equal(await who("web:benwebtrusted000", { kind: "web", stableId: "benwebtrusted000" }), null);
  assert.equal(await who("space:ben@spc_team", { kind: "space", login: "ben" }), null);
  assert.equal(await who("tailnet-guest:ben@example.com", { login: "ben@example.com", stableId: "n_b" }), null);
  void BENSAY;
  // Ben's session token (his assistant, a team chat turn) is Ben
  const bc = K.chains.fromFacts({ kind: "device", device_key_id: "d-ben", person: BEN, path: "direct", session: "s" });
  const token = (await K.surfaces.open(bc, {})).token;
  assert.deepEqual((await d.registry.call("memprobe.who", {}, "mcp", { token })).data.who, { kind: "person", id: BEN });
  // the owner's own socket and a module with no claim are not strangers
  assert.deepEqual((await d.registry.call("memprobe.who", {}, "cli", {})).data.who, { kind: "socket" });
  assert.deepEqual((await d.registry.call("memprobe.who", {}, "module:flows", {})).data.who, { kind: "module" });
});
