// @ts-check
// `vyre setup --name <n> --yes` against a REAL vyred and the REAL name directory code (names/worker, over the Workers test runtime and a
// fake Cloudflare DNS, behind a plain HTTP server): the claim the setup page makes, with no browser. Boots daemons, so it runs on
// runners and the test box only, never on a person's Mac: node --test test/setup-cli-names.test.js
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import worker, * as Names from "../names/worker/index.js";
import { fakeDns } from "../names/worker/fake-dns.js";
import { createRuntime } from "../relay/worker/fake-cf.js";
import { tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "vyre");

/** The directory, as j1-services.mjs serves it: the Worker code over HTTP on loopback. */
async function directory(t) {
  const dns = fakeDns();
  const rt = createRuntime({ worker, Class: Names.Directory, classes: { DIRECTORY: Names.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, ZONE: "vyre.run" } });
  let n = 0;
  const srv = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    // Each box its own address, as on the internet (the directory limits by address).
    headers.set("cf-connecting-ip", `198.51.100.${(req.headers["x-test-box"] ? Number(req.headers["x-test-box"]) : ++n) % 250 + 1}`);
    try {
      const r = await worker.fetch(new Request("https://names.vyre.run" + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method || "GET") ? undefined : Buffer.concat(chunks) }), rt.env);
      res.writeHead(r.status, Object.fromEntries(r.headers)).end(Buffer.from(await r.arrayBuffer()));
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { srv.closeAllConnections(); srv.close(() => r(undefined)); }));
  return `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}`;
}

/** A box: a real vyred in its own home, naming through that directory. */
async function box(t, base) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", machine: "box", network: { directory: base } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  return root;
}
const vyre = (root, args) => new Promise(resolve => {
  const child = execFile(process.execPath, [BIN, ...args], { cwd: root, env: { ...process.env, VYRE_HOME: root, VYRE_TMPDIR: SCRATCH, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 60_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr, stdout }));
  child.stdin.end();
});

test("vyre setup --name --yes names a real box through the directory: the recovery code once, a second box is refused the same name, a bad name is refused", { timeout: 120_000 }, async t => {
  const base = await directory(t);
  const a = await box(t, base), b = await box(t, base);
  const name = `launch-${crypto.randomBytes(3).toString("hex")}`;

  const first = await vyre(a, ["setup", "--name", name, "--yes"]);
  assert.equal(first.code, 0, first.out);
  const code = /Recovery code: ([a-z2-7]{4}(?:-[a-z2-7]{4})*)/i.exec(first.out);
  assert.ok(code, `the recovery code is printed: ${first.out}`);
  assert.match(first.out, /Store it somewhere safe now/);
  assert.match(first.out, new RegExp(`https://${name}\\.vyre\\.run`));
  // The box really holds it: named, waiting for a tailnet to publish the address; and the code is in no status.
  const st = JSON.parse((await vyre(a, ["name", "--json"])).stdout);
  assert.equal(st.phase, "named");
  assert.match(String(st.why), /connect Tailscale/);
  assert.ok(!JSON.stringify(st).includes(code[1]), "the code is not in the status");

  // Another box asks for the same name: taken, exit 1, plain words, no recovery code.
  const second = await vyre(b, ["setup", "--name", name, "--yes"]);
  assert.equal(second.code, 1, second.out);
  assert.match(second.out, /is taken/);
  assert.ok(!/Recovery code/.test(second.out));

  // The same box again: it already holds the name, so there is no new code.
  const again = await vyre(a, ["setup", "--name", name, "--yes"]);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already held that name, so there is no new recovery code/);

  const bad = await vyre(b, ["setup", "--name", "Not A Name!", "--yes"]);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /is not a name Vyre can use/);
  const none = await vyre(b, ["setup", "--name", `${name}-b`]);
  assert.equal(none.code, 2, "without --yes a script is refused before anything is asked of the directory");
});
