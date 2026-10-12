// @ts-check
// `vyre space` and `vyre space up`: the server's space in plain lines and the code that sets it up from the app, against a fake vyred.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "../../config/index.js";
import { tempHome } from "../../../test/helpers.js";
import { SCRATCH } from "../../../test/scratch.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");
const run = (root, args) => new Promise(resolve => {
  const child = execFile(process.execPath, [BIN, ...args], { cwd: root, env: { ...process.env, VYRE_HOME: root, VYRE_TMPDIR: SCRATCH, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr, stdout }));
  child.stdin.end();
});
async function fakeVyred(t, root, tools) {
  const p = config.ensure(root);
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => { raw += c; });
    req.on("end", async () => {
      const tool = decodeURIComponent(String(req.url).replace(/^\/v1\/tools\//, ""));
      calls.push({ tool, input: raw ? JSON.parse(raw) : {} });
      const answer = tools[tool] ? await tools[tool](raw ? JSON.parse(raw) : {}) : { error: { code: "no_such_tool", message: `no tool ${tool}` } };
      res.writeHead(answer.error ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise(r => server.listen(p.socket, () => r(undefined)));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }));
  return calls;
}
const HEALTH = { data: { version: "0.3.1", commit: "abc1234", role: "server", pid: 1, uptime: 5000, modules: { running: 30, failed: 0 }, records_store: { store: "twenty", from: "default", records: 12 } } };
const CODE = { data: { qr: "vyre://wink/2?t=abc", art: "##\n##", expires: Date.now() + 300_000, code: "WINK-ABCD-EFGH", code_expires: Date.now() + 600_000, code_tries: 3 } };

test("vyre space up prints the space code with its life, the four words, and where to type it", async t => {
  const root = tempHome(t);
  const calls = await fakeVyred(t, root, { "wink.server.status": async () => ({ data: { owned: false } }), "wink.server.code": async () => CODE, "relay.setup.status": async () => ({ data: { words: "amber lake moss pine" } }) });
  const r = await run(root, ["space", "up"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Your space code: WINK-ABCD-EFGH \(good for 10 minutes, one use\)/);
  assert.match(r.out, /Your four words: amber lake moss pine/);
  assert.match(r.out, /choose Add a server/);
  assert.deepEqual(calls.find(c => c.tool === "wink.server.code").input, { qr: true });
  assert.ok(!r.out.includes("##"), "no terminal width is known here, so no QR art");
  assert.equal(JSON.parse((await run(root, ["space", "up", "--json"])).stdout).code, "WINK-ABCD-EFGH");
});

test("vyre space up on a space that is already set up says so and tells the owner how to add a device, and makes no code", async t => {
  const root = tempHome(t);
  const calls = await fakeVyred(t, root, { "wink.server.status": async () => ({ data: { owned: true, space: "Harlow", device: "Alex's laptop" } }), "wink.server.code": async () => CODE });
  const r = await run(root, ["space", "up"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already set up to Harlow/);
  assert.match(r.out, /vyre phone add/);
  assert.ok(!/Your space code/.test(r.out));
  assert.ok(!calls.some(c => c.tool === "wink.server.code"), "an owned server mints no code");
});

test("vyre space up with no typed code refuses and names the next step; extra arguments are exit 2", async t => {
  const root = tempHome(t);
  await fakeVyred(t, root, { "wink.server.status": async () => ({ data: { owned: false } }), "wink.server.code": async () => ({ data: { qr: "vyre://wink/2?t=abc" } }) });
  const r = await run(root, ["space", "up"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /next: .*wink\.server\.code/);
  assert.equal((await run(root, ["space", "up", "now"])).code, 2);
});

test("vyre space shows the name and address, owner, members, Records, vault, version, and no next step when nothing is missing", async t => {
  const root = tempHome(t);
  await fakeVyred(t, root, {
    "/v1/health": async () => HEALTH,
    "wink.server.status": async () => ({ data: { owned: true, space: "Harlow", device: "Alex's laptop" } }),
    "spaces.list": async () => ({ data: [{ id: "spc_1", name: "harlow.vyre.run", displayName: "Harlow" }] }),
    "spaces.get": async () => ({ data: { id: "spc_1", members: 4, owners: 2 } }),
    "vault.list": async () => ({ data: { items: [{ name: "a" }, { name: "b" }] } }),
  });
  const r = await run(root, ["space"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Space +Harlow · harlow\.vyre\.run/);
  assert.match(r.out, /Owner +Harlow \(paired by Alex's laptop\)/);
  assert.match(r.out, /Members +4 · 2 owners/);
  assert.match(r.out, /Records +Records · 12 records/);
  assert.match(r.out, /Vault +2 items/);
  assert.match(r.out, /Version +0\.3\.1/);
  assert.ok(!/Next/.test(r.out));
  const j = JSON.parse((await run(root, ["space", "--json"])).stdout);
  assert.deepEqual([j.members, j.owned, j.space.address], [4, true, "harlow.vyre.run"]);
});

test("vyre space on a server nobody owns says the next step is vyre space up, and when Records is still setting up says to check again", async t => {
  const root = tempHome(t);
  await fakeVyred(t, root, {
    "/v1/health": async () => ({ data: { ...HEALTH.data, records_store: { store: "twenty", from: "default", records: null, note: "setting up" } } }),
    "wink.server.status": async () => ({ data: { owned: false } }), "spaces.list": async () => ({ data: [] }), "vault.list": async () => ({ error: { code: "no_such_tool", message: "no tool vault.list" } }),
  });
  const r = await run(root, ["space"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Owner +nobody yet/);
  assert.match(r.out, /Next +Set this server up from the Vyre app: vyre space up/);
  assert.match(r.out, /Records is still setting up/);
  assert.match(r.out, /Vault +not answering/);
});

test("vyre space with vyred down refuses with exit 5 and says vyre up", async t => {
  const root = tempHome(t);
  config.ensure(root);
  const r = await run(root, ["space"]);
  assert.equal(r.code, 5, r.out);
  assert.match(r.out, /next: vyre up/);
});

test("the box wrapper forwards `vyre space` and `vyre space up` into the container like `vyre status`: no host verb of its own takes them, and the fallback is the container's CLI", () => {
  const wrapper = fs.readFileSync(path.join(path.dirname(BIN), "..", "box", "vyre"), "utf8");
  const dispatch = wrapper.slice(wrapper.lastIndexOf('VYRE_VERB=${1:-}'));
  assert.ok(!/^\s+space\)/m.test(dispatch) && !/^\s+status\)/m.test(dispatch), "neither is a host verb");
  assert.match(dispatch, /\n  \*\)\n    cli "\$@"\n    ;;/, "everything else goes to `vyre` inside the container");
});
