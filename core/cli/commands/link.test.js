// @ts-check
// `vyre link` for the surfaces: its verbs as `vyre commands` lists them, and --view frames,
// against a fake vyred on a unix socket in a temp home. No box, no network, no Tailscale.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";
import * as config from "../../config/index.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** A fake device's vyred: not paired yet; wink.pair.server starts a pairing. */
async function fakeVyred(t) {
  const root = tempHome(t);
  const socket = config.paths(root).socket;
  if (path.dirname(socket) !== root) config.privateSocketDir();
  const calls = /** @type {{ tool: string, body: any }[]} */ ([]);
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const tool = decodeURIComponent(String(req.url).replace("/v1/tools/", ""));
      calls.push({ tool, body });
      if (tool === "wink.server.home") return send(200, { data: { linked: false, servers: [] } });
      if (tool === "network.wink.status") return send(200, { data: { spaces: [] } });
      if (tool === "wink.pair.targets") return send(200, { data: { targets: [{ kind: "identity", id: "id_alex", label: "Personal" }] } });
      if (tool === "wink.pair.server") return send(200, { data: { pairing: "pr_1", ack: "dusk-fern-lamp", target: body.target } });
      if (tool === "wink.access") return send(200, { data: { devices: [{ id: "d1", name: "Alex's phone", kind: "phone" }] } });
      if (tool === "wink.remove") return send(200, { data: { removed: body.device } });
      send(404, { error: { code: "no_such_tool", message: `no tool ${tool}` } });
    });
  });
  await new Promise(r => server.listen(socket, () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { root, calls };
}

function vyre(root, args) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" } });
    let out = "", err = "";
    p.stdout.on("data", c => { out += c; });
    p.stderr.on("data", c => { err += c; });
    p.on("close", code => resolve({ code, out, err, all: out + err }));
  });
}
const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

test("link cli: vyre commands lists every verb run() handles", async t => {
  const root = tempHome(t);
  const r = await vyre(root, ["commands", "link", "--json"]);
  assert.equal(r.code, 0, r.all);
  const verbs = JSON.parse(r.out).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["status", "pair", "devices", "unpair"]);
  assert.deepEqual(verbs.find(v => v.verb === "pair").args, [{ name: "code", required: true }]);
  assert.deepEqual(verbs.find(v => v.verb === "unpair").args, [{ name: "device", required: true }]);
  assert.equal(verbs.find(v => v.verb === "status").read, true);
});

test("link cli: status, pair, devices and unpair go through the Wink tools", async t => {
  const { root, calls } = await fakeVyred(t);
  const bare = await vyre(root, ["link", "--json"]);
  assert.equal(bare.code, 0, bare.all);
  assert.equal(JSON.parse(bare.out).linked, false);
  assert.equal((await vyre(root, ["link", "status", "--json"])).out, bare.out, "status is the default");
  const v = frames((await vyre(root, ["link", "--view"])).out);
  assert.deepEqual([v[0].view.kind, v[0].view.title, v[0].view.fields[0]], ["card", "Link", { label: "Server", value: "not paired" }]);
  const p = await vyre(root, ["link", "pair", "WINK-1234-5678", "--view"]);
  assert.equal(p.code, 0, p.all);
  const f = frames(p.out);
  assert.deepEqual([f[0].cmd, f[0].view.kind], ["link pair", "card"]);
  assert.equal(f[0].data.pairing, "pr_1");
  assert.deepEqual(calls.find(c => c.tool === "wink.pair.server")?.body, { code: "WINK-1234-5678", target: { kind: "identity", id: "id_alex" } });
  const d = await vyre(root, ["link", "devices", "--json"]);
  assert.deepEqual(JSON.parse(d.out).devices.map(x => x.id), ["d1"]);
  const u = await vyre(root, ["link", "unpair", "d1", "--json"]);
  assert.deepEqual(JSON.parse(u.out), { removed: "d1" });
  assert.equal((await vyre(root, ["link", "unpair", "--json"])).code, 2);
  const odd = await vyre(root, ["link", "forget", "--json"]);
  assert.equal(odd.code, 2);
  assert.match(JSON.parse(odd.out).error.next, /vyre link \[status\|pair <code>/);
});
