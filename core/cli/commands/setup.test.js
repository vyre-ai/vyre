// @ts-check
// `vyre setup --name <n> --yes` against a fake vyred: the same two tools the page calls, the recovery code once, and the refusals.
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
const CODE = "abcd-efgh-ijkl-mnop-qrst-uv";
const tools = o => ({
  "names.check": async ({ name }) => ({ data: name === "taken" ? { name, valid: true, available: false, address: `https://${name}.vyre.run`, why: "someone else has it" } : name === "bad_name" ? { name, valid: false, available: false, why: "names are lower case letters, digits and hyphens" } : { name, valid: true, available: true, address: `https://${name}.vyre.run` } }),
  "names.claim": async ({ name }) => o.claim ? o.claim(name) : ({ data: { address: `https://${name}.vyre.run`, phase: "named", why: "connect Tailscale, then claim again to publish the address", recoveryCode: CODE } }),
  "names.status": async () => ({ data: { address: "https://alex.vyre.run", phase: "serving" } }),
});

test("setup --name --yes: checks, claims through the page's two tools as the CLI, prints the recovery code once with a plain line to store it", async t => {
  const root = tempHome(t);
  const calls = await fakeVyred(t, root, tools({}));
  const r = await run(root, ["setup", "--name", "alex", "--yes"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(calls.map(c => [c.tool, c.input]), [["names.check", { name: "alex" }], ["names.claim", { name: "alex" }]]);
  assert.match(r.out, /https:\/\/alex\.vyre\.run/);
  assert.match(r.out, new RegExp(`Recovery code: ${CODE}`));
  assert.match(r.out, /Store it somewhere safe now/);
  assert.match(r.out, /shown once and cannot be shown again/);
  assert.equal((r.out.match(new RegExp(CODE, "g")) || []).length, 1, "printed once");
  const j = JSON.parse((await run(root, ["setup", "--name=alex", "--yes", "--json"])).stdout);
  assert.deepEqual(j, { name: "alex", address: "https://alex.vyre.run", phase: "named", recoveryCode: CODE, why: "connect Tailscale, then claim again to publish the address" });
});

test("setup --name: a taken or invalid name, a failed claim and a refused call each exit non-zero in plain words, and nothing is claimed", async t => {
  const root = tempHome(t);
  let calls = await fakeVyred(t, root, tools({ claim: async () => ({ data: { phase: "failed", why: "the directory would not answer" } }) }));
  const taken = await run(root, ["setup", "--name", "taken", "--yes"]);
  assert.equal(taken.code, 1);
  assert.match(taken.out, /https:\/\/taken\.vyre\.run is taken: someone else has it/);
  assert.match(taken.out, /next: pick another/);
  const bad = await run(root, ["setup", "--name", "bad_name", "--yes"]);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /bad_name is not a name Vyre can use: names are lower case/);
  assert.ok(!calls.some(c => c.tool === "names.claim"), "no claim for a name that failed its check");
  const failed = await run(root, ["setup", "--name", "alex", "--yes"]);
  assert.equal(failed.code, 1);
  assert.match(failed.out, /could not claim alex\.vyre\.run: the directory would not answer/);
  assert.ok(!/Recovery code/.test(failed.out));
});

test("setup: a script must pass --yes (claiming is for good), and the options are checked", async t => {
  const root = tempHome(t);
  const calls = await fakeVyred(t, root, tools({}));
  const noYes = await run(root, ["setup", "--name", "alex"]);
  assert.equal(noYes.code, 2, noYes.out);
  assert.match(noYes.out, /a script must pass --yes/);
  assert.ok(!calls.some(c => c.tool === "names.claim"));
  assert.equal((await run(root, ["setup", "--yes"])).code, 2);
  assert.equal((await run(root, ["setup", "--name"])).code, 2);
  assert.equal((await run(root, ["setup", "--name", "alex", "--wat"])).code, 2);
});

test("setup --name: a name this box already holds says there is no new recovery code, and the claim waits for the box to rest", async t => {
  const root = tempHome(t);
  let polls = 0;
  const t2 = tools({ claim: async () => ({ data: { address: "https://alex.vyre.run", phase: "certificate", recoveryCode: null } }) });
  t2["names.status"] = async () => ({ data: { address: "https://alex.vyre.run", phase: ++polls < 2 ? "certificate" : "serving" } });
  await fakeVyred(t, root, t2);
  const r = await run(root, ["setup", "--name", "alex", "--yes"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /serving/);
  assert.match(r.out, /already held that name, so there is no new recovery code/);
  assert.ok(polls >= 2);
});

test("setup with no name: where setup stands, the same ten steps, and the one place to continue; --new-link makes a fresh link", async t => {
  const root = tempHome(t);
  const steps = (current, done) => ["install:Install", "words:Check the words", "address:Choose your address", "tailscale:Connect Tailscale", "ai:Sign in to your AI", "phone:Add your phone", "passkey:Create your passkey", "assistant:You and your assistant", "computers:Your computers", "history:Your history"]
    .map((x, i) => { const [id, title] = x.split(":"); return { id, title, where: i < 2 ? "On your server" : i < 6 ? "In your browser" : "At your address", optional: ["phone", "computers", "history"].includes(id), n: i + 1, status: done.includes(id) ? "done" : id === current ? "current" : "todo" }; });
  let list = { steps: steps("ai", ["install", "words", "address", "tailscale"]), current: "ai", finished: false, skipped: [], address: "https://alex.vyre.run" };
  const calls = await fakeVyred(t, root, { "onboard.setup": async () => ({ data: list }), "onboard.link": async () => ({ data: { url: "http://127.0.0.1:7301/onboard?t=abc", port: 7301, expires: Date.now() + 600000 } }) });
  const a = await run(root, ["setup"]);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /Vyre setup: step 5 of 10, Sign in to your AI/);
  assert.match(a.out, /✓ Choose your address {5}alex\.vyre\.run/);
  assert.match(a.out, /○ Add your phone \(optional\)/);
  assert.match(a.out, /sudo vyre setup --new-link/);
  assert.deepEqual(calls.map(c => c.tool), ["onboard.setup"], "reading changes nothing and makes no link");
  const n = await run(root, ["setup", "--new-link"]);
  assert.equal(n.code, 0, n.out);
  assert.match(n.out, /New link: http:\/\/127\.0\.0\.1:7301\/onboard\?t=abc/);
  assert.ok(calls.some(c => c.tool === "onboard.link"));
  list = { steps: steps(null, ["install", "words", "address", "tailscale", "ai", "passkey", "assistant", "computers"]).map(s => s.id === "phone" || s.id === "history" ? { ...s, status: "skipped" } : s), current: null, finished: true, skipped: ["phone", "history"], address: "https://alex.vyre.run" };
  const f = await run(root, ["setup"]);
  assert.match(f.out, /Setup is finished\. Vyre is running at https:\/\/alex\.vyre\.run/);
  assert.match(f.out, /Skipped: Add your phone, Your history\. Open Settings, Setup to do them\./);
  assert.equal((await run(root, ["setup", "--bogus"])).code, 2);
});
