// @ts-check
// `vyre link` for the surfaces: its verbs as `vyre commands` lists them, and --view frames,
// against a fake vyred on a unix socket in a temp home. No box, no network, no Tailscale.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../../test/helpers.js";
import * as config from "../../config/index.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** A fake Mac's vyred: not paired yet; link.pair hands out a code. */
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
      if (tool === "link.status") return send(200, { data: { role: "local", linked: false, pending: null } });
      if (tool === "link.pair") return send(200, { data: { code: "4821-0937", expires: Date.now() + 10 * 60_000 } });
      if (tool === "link.unpair") return send(200, { data: { unpaired: false } });
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
  assert.deepEqual(verbs.map(v => v.verb), ["status", "pair", "approve", "deny", "unpair", "signin", "signout"]);
  assert.deepEqual(verbs.find(v => v.verb === "pair").args, [{ name: "address", required: true }]);
  assert.deepEqual(verbs.find(v => v.verb === "unpair").args, [{ name: "id", required: false }]);
  assert.equal(verbs.find(v => v.verb === "status").read, true);
});

test("link cli: status and link, --json and --view; pair shows its code as a card; unpair answers JSON", async t => {
  const { root, calls } = await fakeVyred(t);
  const bare = await vyre(root, ["link", "--json"]);
  assert.equal(bare.code, 0, bare.all);
  assert.deepEqual(JSON.parse(bare.out), { role: "local", linked: false, pending: null });
  assert.equal((await vyre(root, ["link", "status", "--json"])).out, bare.out, "status is the default");
  const v = frames((await vyre(root, ["link", "--view"])).out);
  assert.deepEqual([v[0].view.kind, v[0].view.title, v[0].view.fields[0]], ["card", "Link", { label: "Box", value: "not paired" }]);
  const p = await vyre(root, ["link", "pair", "alex.vyre.run", "--view"]);
  assert.equal(p.code, 0, p.all);
  const f = frames(p.out);
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.fields[0]], ["link pair", "card", { label: "Code", value: "4821-0937" }]);
  assert.equal(f[0].data.code, "4821-0937");
  assert.deepEqual(calls.find(c => c.tool === "link.pair")?.body, { box: "alex.vyre.run" });
  const u = await vyre(root, ["link", "unpair", "--json"]);
  assert.deepEqual(JSON.parse(u.out), { unpaired: false });
  const odd = await vyre(root, ["link", "forget", "--json"]);
  assert.equal(odd.code, 2);
  assert.match(JSON.parse(odd.out).error.next, /vyre link \[status\|pair <address>/);
});
