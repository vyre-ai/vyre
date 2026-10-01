// @ts-check
// IM1 and the scripted refusals for watchers (plan done-check 8), with real uids, as root, on Linux
// only (a hosted runner with sudo, or the box image). Skipped everywhere else.
//   sudo env "PATH=$PATH" node --test core/watchers/isolation.test.js     (needs iptables, ip, setpriv, useradd)
// Proves: a watcher child runs as the sandbox uid; that uid cannot open a socket to loopback, to a
// tailnet-range address or to the internet (the firewall rule the box image installs); the parent's
// mediated fetch refuses writes, undeclared hosts and non-public addresses; a root-only file is not
// readable by the child; and vault.fetch hands a watcher nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { open, migrate } from "../store/index.js";
import { Runtime, MIGRATIONS } from "./runtime.js";
import { SCRATCH } from "../../test/scratch.mjs";

const has = bin => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
const root = process.platform === "linux" && process.getuid && process.getuid() === 0 && has("iptables") && has("ip") && has("setpriv") && has("useradd");
const USER = "vyre-sandbox";
const TAILNET_ADDR = "100.100.100.100";

const sh = (...argv) => execFileSync(argv[0], argv.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Try a TCP connect as `uid` (or root when null) and say what happened. */
function connectAs(uid, host, port) {
  const code = `const s=require("node:net").connect(${port},"${host}");s.on("connect",()=>{console.log("connected");process.exit(0)});s.on("error",e=>{console.log("blocked:"+e.code);process.exit(0)});setTimeout(()=>{console.log("blocked:TIMEOUT");process.exit(0)},4000)`;
  const argv = uid == null ? [process.execPath, "-e", code] : ["setpriv", `--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--", process.execPath, "-e", code];
  return spawnSync(argv[0], argv.slice(1), { encoding: "utf8" }).stdout.trim();
}

const listen = (host) => new Promise(resolve => { const s = net.createServer(c => c.end()); s.listen(0, host, () => resolve(s)); });

test("watchers isolation: the sandbox uid is firewalled, and every refusal holds against real children", { skip: root ? false : "needs root on Linux with iptables, ip, setpriv and useradd" }, async t => {
  // The sandbox user and the firewall rule the box image installs.
  try { sh("id", "-u", USER); } catch { sh("useradd", "-r", "-M", "-s", "/usr/sbin/nologin", USER); }
  const uid = Number(sh("id", "-u", USER).trim());
  sh("iptables", "-I", "OUTPUT", "1", "-m", "owner", "--uid-owner", String(uid), "-j", "REJECT");
  t.after(() => { try { sh("iptables", "-D", "OUTPUT", "-m", "owner", "--uid-owner", String(uid), "-j", "REJECT"); } catch {} });
  let tailnet = true;
  try { sh("ip", "addr", "add", `${TAILNET_ADDR}/32`, "dev", "lo"); t.after(() => { try { sh("ip", "addr", "del", `${TAILNET_ADDR}/32`, "dev", "lo"); } catch {} }); } catch { tailnet = false; }

  const lo = await listen("127.0.0.1"); t.after(() => lo.close());
  const loPort = /** @type {any} */ (lo.address()).port;
  const tn = tailnet ? await listen(TAILNET_ADDR) : null; t.after(() => tn && tn.close());

  // The firewall itself: root connects (the control), the sandbox uid does not.
  assert.equal(connectAs(null, "127.0.0.1", loPort), "connected", "control: root reaches loopback");
  assert.match(connectAs(uid, "127.0.0.1", loPort), /^blocked/, "the sandbox uid reached a loopback service");
  if (tn) {
    const p = /** @type {any} */ (tn.address()).port;
    assert.equal(connectAs(null, TAILNET_ADDR, p), "connected", "control: root reaches the tailnet-range address");
    assert.match(connectAs(uid, TAILNET_ADDR, p), /^blocked/, "the sandbox uid reached a tailnet-range address");
  }
  assert.match(connectAs(uid, "1.1.1.1", 443), /^blocked/, "the sandbox uid reached the internet");

  // Real watcher children, run by the runtime as root, which drops them to the sandbox uid.
  const prior = process.env.VYRE_SANDBOX_UID;
  process.env.VYRE_SANDBOX_UID = String(uid);
  t.after(() => { if (prior === undefined) delete process.env.VYRE_SANDBOX_UID; else process.env.VYRE_SANDBOX_UID = prior; });
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-wiso-"));
  fs.chmodSync(dir, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const watchers = path.join(dir, "watchers");
  fs.mkdirSync(watchers, { mode: 0o755 });
  const db = open(path.join(dir, "vyre.db")); t.after(() => db.close());
  migrate(db, "watchers", MIGRATIONS);
  const rt = new Runtime({
    db, dir: watchers, log: () => {}, emit: () => {}, teach: async () => true,
    call: async tool => tool === "projects.list" ? { data: { projects: [{ slug: "harlow-legal", name: "Harlow Legal", home: dir, workspaces: [dir] }] } } : { error: { code: "no_such_tool" } },
    fetch: async () => { throw new Error("the vault was asked for a value"); },
    netOptions: () => ({ lookup: async () => ["10.0.0.5"] }),   // every name resolves inside, so nothing leaves
  });
  t.after(() => rt.stop());
  const bearer = path.join(dir, "docker-api-bearer");
  fs.writeFileSync(bearer, "root-only-secret", { mode: 0o600 });
  const write = (name, code, spec = {}) => {
    fs.mkdirSync(path.join(watchers, name), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(watchers, name, "watcher.json"), JSON.stringify({ name, project: "harlow-legal", schedule: "*/15 * * * *", ...spec }), { mode: 0o644 });
    fs.writeFileSync(path.join(watchers, name, "watch.js"), code, { mode: 0o644 });
  };
  /** Run a watcher whose code puts a verdict in one item, and return that verdict. */
  const verdict = async (name, body, spec = {}) => {
    write(name, `import fs from "node:fs";\nimport net from "node:net";\nexport default async function watch({ emit, vault }) {\n  let out;\n  try { out = await (async () => { ${body} })(); } catch (e) { out = "blocked:" + (e.code || e.message); }\n  emit({ id: "v", title: String(out) });\n}`, spec);
    const r = await rt.test(name);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.items[0].title;
  };

  assert.equal(await verdict("whoami", "return process.getuid()"), String(uid), "the child did not run as the sandbox uid");
  assert.match(await verdict("rawnet", `return await new Promise(res => { const s = net.connect(${loPort}, "127.0.0.1"); s.on("connect", () => res("connected")); s.on("error", e => res("blocked:" + e.code)); setTimeout(() => res("blocked:TIMEOUT"), 3000); })`), /^blocked/, "a watcher opened its own socket");
  assert.match(await verdict("bearer", `return fs.readFileSync(${JSON.stringify(bearer)}, "utf8")`), /^blocked/, "a watcher read a root-only file");
  assert.match(await verdict("post", `await fetch("https://example.com/", { method: "POST", body: "x" }); return "sent"`, { net: { "example.com": {} } }), /GET and HEAD/, "a watcher wrote through the mediated fetch");
  assert.match(await verdict("undeclared", `await fetch("https://other.example.org/"); return "read"`, { net: { "example.com": {} } }), /declared hosts/, "a watcher read a host it did not declare");
  assert.match(await verdict("inside", `await fetch("https://example.com/"); return "read"`, { net: { "example.com": {} } }), /not a public address/, "a name that resolves inside was fetched");
  assert.match(await verdict("nonet", `await fetch("https://example.com/"); return "read"`), /declares no hosts/, "a watcher with no net reached the web");
  assert.match(await verdict("vault", `return await vault.fetch("anything")`), /does not handle credentials/, "a watcher was handed a vault value");
  assert.ok(os.platform() === "linux");
});
