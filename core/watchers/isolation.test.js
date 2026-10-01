// @ts-check
// IM1 and the scripted refusals for watchers (plan done-check 8), against the real product: a real
// vyred in a temp home, the real wall (no test hook), real watcher children. It runs on a hosted
// runner (Linux and macOS) from .github/workflows/watchers-isolation.yml, never on the person's Mac.
// Skipped unless VYRE_WALL_CHECK=1.
//
// The wall is whatever the machine gives (lib/sandbox/wall.js): netns on Linux, sandbox-exec on a
// Mac. VYRE_EXPECT_WALL says which one this job must get: netns, sandbox-exec, or none (then a
// watcher must refuse to run, in words, and run nothing). With none set, the test reports which
// wall it found and holds either answer to its rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import * as config from "../config/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { getWall } from "../../lib/sandbox/index.js";

const on = process.env.VYRE_WALL_CHECK === "1";
const expect = process.env.VYRE_EXPECT_WALL || "";
const TAILNET = process.env.VYRE_TEST_TAILNET_ADDR || "";

const listen = host => new Promise(resolve => { const s = net.createServer(c => c.end()); s.listen(0, host, () => resolve(s)); });
/** Connect from this process (the control: the parent can reach what the child must not). */
const reach = (host, port) => new Promise(res => { const s = net.connect(port, host); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); setTimeout(() => { s.destroy(); res(false); }, 3000); });

test("watchers isolation: the real wall holds against real children, or no watcher runs", { skip: on ? false : "set VYRE_WALL_CHECK=1 (the watchers-isolation workflow does)" }, async t => {
  // Linux CI must prove the tailnet-range case, so a missing address there is a failure, not a skip.
  if (process.platform === "linux" && process.env.CI) assert.ok(TAILNET, "set VYRE_TEST_TAILNET_ADDR to a loopback alias (the workflow adds one) so the tailnet-range case runs");
  const found = await getWall({ fresh: true });
  t.diagnostic(`wall: ${found.wall ? found.wall.kind : "none"} (${found.why})`);
  if (expect === "none") assert.equal(found.wall, null, "this job expected no wall");
  else if (expect) assert.equal(found.wall && found.wall.kind, expect, `this job expected the ${expect} wall: ${found.why}`);

  const root = tempHome(t);
  const p = config.ensure(root);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "vyre-proj-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(p.config, JSON.stringify({ roots: [], transcripts: [path.join(root, "no-transcripts")], vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const made = await call("projects.create", { name: "Harlow Legal", home }, { root });
  assert.ok(!made.error, JSON.stringify(made.error));

  const lo = await listen("127.0.0.1"); t.after(() => lo.close());
  const loPort = /** @type {any} */ (lo.address()).port;
  const tn = TAILNET ? await listen(TAILNET) : null; t.after(() => tn && tn.close());
  assert.equal(await reach("127.0.0.1", loPort), true, "control: this process reaches the loopback listener");
  if (tn) assert.equal(await reach(TAILNET, /** @type {any} */ (tn.address()).port), true, "control: this process reaches the tailnet-range address");

  const bearer = path.join(root, "docker-api-bearer");
  fs.writeFileSync(bearer, "bearer-secret", { mode: 0o600 });
  const write = (name, body, spec = {}) => {
    const dir = path.join(p.watchers, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify({ name, project: "harlow-legal", schedule: "*/15 * * * *", ...spec }));
    fs.writeFileSync(path.join(dir, "watch.js"), `import fs from "node:fs";\nimport net from "node:net";\nexport default async function watch({ emit, vault }) {\n  let out;\n  try { out = await (async () => { ${body} })(); } catch (e) { out = "blocked:" + (e.code || e.message); }\n  emit({ id: "v", title: String(out) });\n}`);
  };
  const verdict = async (name, body, spec) => {
    write(name, body, spec);
    const r = (await call("watchers.test", { name }, { root })).data;
    return r.ok ? r.items[0].title : `error:${r.error}`;
  };
  const connect = (host, port) => `return await new Promise(res => { const s = net.connect(${port}, "${host}"); s.on("connect", () => res("connected")); s.on("error", e => res("blocked:" + e.code)); setTimeout(() => res("blocked:TIMEOUT"), 3000); })`;

  if (!found.wall) {
    write("none", "return 1");
    const refused = (await call("watchers.test", { name: "none" }, { root })).data;
    assert.equal(refused.ok, false);
    assert.match(refused.error, /watchers cannot run on this machine: it has no way to keep a watcher off the network/);
    return;
  }

  assert.match(await verdict("rawnet", connect("127.0.0.1", loPort)), /^blocked/, "a watcher opened its own socket to a loopback service");
  if (tn) assert.match(await verdict("tailnet", connect(TAILNET, /** @type {any} */ (tn.address()).port)), /^blocked/, "a watcher opened a socket to a tailnet-range address");
  assert.match(await verdict("internet", connect("1.1.1.1", 443)), /^blocked/, "a watcher opened a socket to the internet");
  assert.match(await verdict("bearer", `return fs.readFileSync(${JSON.stringify(bearer)}, "utf8")`), /^blocked/, "a watcher read a file outside its folder");
  assert.match(await verdict("post", `await fetch("https://example.com/", { method: "POST", body: "x" }); return "sent"`, { net: { "example.com": {} } }), /GET and HEAD/, "a watcher wrote through the mediated fetch");
  assert.match(await verdict("undeclared", `await fetch("https://other.example.org/"); return "read"`, { net: { "example.com": {} } }), /declared hosts/, "a watcher read a host it did not declare");
  assert.match(await verdict("nonet", `await fetch("https://example.com/"); return "read"`), /declares no hosts/, "a watcher with no net reached the web");
  assert.match(await verdict("vault", `return await vault.fetch("anything")`), /does not handle credentials/, "a watcher was handed a vault value");
});
