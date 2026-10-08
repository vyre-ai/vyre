// @ts-check
// `vyre words`: the four words the server shows while the Vyre app adds it, against a fake vyred.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
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
      calls.push({ tool, input: raw ? JSON.parse(raw) : {}, caller: req.headers["x-vyre-caller"] });
      const answer = tools[tool] ? await tools[tool](raw ? JSON.parse(raw) : {}) : { error: { code: "no_such_tool", message: `no tool ${tool}` } };
      res.writeHead(answer.error ? 400 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise(r => server.listen(p.socket, () => r(undefined)));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }));
  return calls;
}

test("vyre words prints the four words, and says what to do in the app", async t => {
  const root = tempHome(t);
  const calls = await fakeVyred(t, root, { "relay.setup.status": async () => ({ data: { state: "waiting", words: "amber lake moss pine" } }) });
  const r = await run(root, ["words"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Your four words: amber lake moss pine/);
  assert.match(r.out, /choose Same/);
  assert.deepEqual(calls.map(c => c.tool), ["relay.setup.status"]);
  assert.deepEqual(JSON.parse((await run(root, ["words", "--json"])).stdout), { words: "amber lake moss pine" });
});

test("vyre words with no server being added says so and exits 1; extra arguments are exit 2", async t => {
  const root = tempHome(t);
  await fakeVyred(t, root, { "relay.setup.status": async () => ({ data: { state: "none" } }) });
  const r = await run(root, ["words"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /No server is being added right now/);
  assert.equal((await run(root, ["words", "now"])).code, 2);
});
