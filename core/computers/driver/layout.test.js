// @ts-check
// The folders of the state volume, for a volume made before the image had them: what the tar holds (directories only, the owners and modes the Dockerfile gives), and how the driver sends it.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { DockerDriver } from "./docker.js";
import { layoutTar, layoutEntries, allowLayoutTar, LAYOUT, LAYOUT_VERSION } from "./policy.js";
import { SCRATCH } from "../../../test/scratch.mjs";

/** Read a tar of headers only. */
function headers(buf) {
  const out = [];
  for (let off = 0; off + 512 <= buf.length; off += 512) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break;
    const str = (o, l) => h.subarray(o, o + l).toString("ascii").replace(/\0.*$/s, "");
    const num = (o, l) => parseInt(str(o, l).trim(), 8);
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    assert.equal(num(148, 8), sum, `checksum of ${str(0, 100)}`);
    out.push({ name: str(0, 100), type: str(156, 1), mode: num(100, 8), uid: num(108, 8), gid: num(116, 8), size: num(124, 12) });
  }
  return out;
}

test("the layout tar is directories only, with the owners and modes of the Dockerfile's loop, for all 64 agents", () => {
  const hs = headers(layoutTar());
  assert.equal(hs.length, 1 + 4 + 64 * 6);
  assert.ok(hs.every(h => h.type === "5" && h.size === 0 && h.name.endsWith("/")), "directories only, no files, no links");
  const by = Object.fromEntries(hs.map(h => [h.name, h]));
  const own = (name, uid, gid, mode) => assert.deepEqual([by[name].uid, by[name].gid, by[name].mode], [uid, gid, mode], name);
  own("agentd/", 1004, 1004, 0o700);
  for (const d of ["agents/", "browsers/", "x/", "downloads/"]) own(d, 1001, 1001, 0o711);
  for (const n of [20000, 20001, 20063]) {
    const b = n + 1000;
    own(`agents/ag${n}/`, n, n, 0o700); own(`agents/ag${n}/home/`, n, n, 0o700);
    own(`browsers/agb${b}/`, b, b, 0o700); own(`browsers/agb${b}/profile/`, b, b, 0o700);
    own(`x/ag${n}/`, n, b, 0o2750);       // the agent's, read by the browser's group
    own(`downloads/ag${n}/`, b, n, 0o2750); // the browser's, read by the agent's group
  }
  assert.ok(hs.every(h => !h.name.includes("..") && !h.name.startsWith("/")), "every path is inside the volume");
  assert.ok(layoutEntries().every(([, uid]) => uid === 1001 || uid === 1004 || (uid >= 20000 && uid <= 21063)), "no entry is owned by root");
  assert.equal(allowLayoutTar(layoutTar()).ok, true);
  const flipped = Buffer.from(layoutTar()); flipped[600] ^= 1;
  assert.equal(allowLayoutTar(flipped).ok, false);
  assert.equal(LAYOUT.dir, "/var/lib/vyre");
  assert.ok(LAYOUT_VERSION >= 2);
});

test("the driver puts the layout tar into a computer's state volume through the archive call, before it starts", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-layout-"));
  const socket = path.join(dir, "d.sock");
  /** @type {Array<{ method: string, url: string, body: Buffer }>} */ const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    seen.push({ method: String(req.method), url: String(req.url), body: Buffer.concat(chunks) });
    const send = (status, b) => { res.writeHead(status, { "content-type": "application/json" }); res.end(b === undefined ? "" : JSON.stringify(b)); };
    if (req.method === "GET" && req.url === "/v1.43/containers/c1/json") return send(200, { Id: "c1", Name: "/box", Config: { Labels: { "run.vyre": "1", "vyre.managed": "true", "vyre.computer": "kit" } }, State: { Status: "created" }, NetworkSettings: { Networks: {} } });
    if (req.method === "PUT") return send(200, {});
    return send(404, { message: "no" });
  });
  await new Promise(r => server.listen(socket, () => r(null)));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await new DockerDriver({ url: `unix://${socket}`, bearer: "b" }).migrateLayout("c1");
  const put = seen.find(s => s.method === "PUT");
  assert.ok(put && decodeURIComponent(put.url).endsWith("/containers/c1/archive?path=/var/lib/vyre"));
  assert.ok(put.body.equals(layoutTar()), "exactly the bytes policy allows");
});
