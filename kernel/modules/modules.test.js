import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { sandboxCommand, mechanism } from "./sandbox.js";
import { createEgress, privateAddress } from "./egress.js";
import { createSupervisor } from "./supervisor.js";
import { createModuleHost } from "./host.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: "per_owner", owner_uid: 501, key: Buffer.alloc(32, 9), clock });
const tmp = name => fs.mkdtempSync(path.join(SCRATCH, `vyre-${name}-`));
const linux = process.platform === "linux" && mechanism() === "bwrap";

test("egress: https only, declared hosts only, never a private address, checked on the resolved address", async () => {
  const log = createEventLog({ space: SPACE, clock });
  const seen = [];
  const e = createEgress({ space: SPACE, log, chains, hostsOf: m => (m === "crm-sync" ? ["api.example.com", "*.cdn.example.com"] : undefined),
    resolve: async h => (h === "rebind.example.com" ? ["127.0.0.1"] : h === "meta.example.com" ? ["169.254.169.254"] : ["93.184.216.34"]),
    fetchImpl: async (url, init) => { seen.push([url, init]); return { status: 200, headers: { "set-cookie": "a=b", "content-type": "text/plain" }, body: new TextEncoder().encode("ok") }; } });
  const code = p => p.then(() => "ok", x => x.code);
  assert.equal((await e.request("crm-sync", "https://api.example.com/v1")).body, "ok");
  assert.equal(await code(e.request("crm-sync", "http://api.example.com/v1")), "egress_refused");
  assert.equal(await code(e.request("crm-sync", "https://evil.example.org/")), "egress_refused", "undeclared host");
  assert.equal(await code(e.request("other", "https://api.example.com/")), "egress_refused", "a module with no declaration");
  assert.equal((await e.request("crm-sync", "https://img.cdn.example.com/a")).status, 200, "a declared wildcard");
  assert.equal(await code(e.request("crm-sync", "https://cdn.example.com/")), "egress_refused", "the bare domain is not the wildcard");
  assert.equal(await code(e.request("crm-sync", "https://user:pw@api.example.com/")), "egress_refused");
  for (const bad of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "172.16.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1", "0.0.0.0"]) assert.equal(privateAddress(bad), true, bad);
  assert.equal(privateAddress("93.184.216.34"), false);
  const rebind = createEgress({ space: SPACE, hostsOf: () => ["rebind.example.com", "meta.example.com", "127.0.0.1"], resolve: async h => (h === "rebind.example.com" ? ["127.0.0.1"] : ["169.254.169.254"]), fetchImpl: async () => { throw new Error("must not be reached"); } });
  assert.equal(await code(rebind.request("m", "https://rebind.example.com/")), "egress_refused", "a name that resolves to loopback");
  assert.equal(await code(rebind.request("m", "https://meta.example.com/")), "egress_refused", "the metadata address");
  assert.equal(await code(rebind.request("m", "https://127.0.0.1/")), "egress_refused", "a declared loopback address");
  // headers that carry ambient identity are stripped, cookies never come back
  const r = await e.request("crm-sync", "https://api.example.com/x", { method: "POST", body: "{}", headers: { Cookie: "s=1", Authorization: "Bearer x", "X-A": "1" } });
  assert.deepEqual(seen.at(-1)[1].headers, { "X-A": "1" });
  assert.equal("set-cookie" in r.headers, false);
  assert.ok(log.read({ type: "egress.requested" }).length >= 3 && log.read({ type: "egress.refused" }).length >= 5);
  assert.ok(!JSON.stringify(log.read({})).includes("Bearer"), "no header or body in the log");
});

test("egress: a redirect is checked like a new request, and capped", async () => {
  const hops = { "https://api.example.com/a": "https://api.example.com/b", "https://api.example.com/b": "https://evil.example.org/x", "https://api.example.com/loop": "https://api.example.com/loop" };
  const e = createEgress({ space: SPACE, hostsOf: () => ["api.example.com"], resolve: async () => ["93.184.216.34"], fetchImpl: async url => (hops[url] ? { status: 302, headers: { location: hops[url] }, body: new Uint8Array() } : { status: 200, headers: {}, body: new Uint8Array([111]) }) });
  await assert.rejects(() => e.request("m", "https://api.example.com/a"), { code: "egress_refused" }, "the second hop leaves the declared host");
  await assert.rejects(() => e.request("m", "https://api.example.com/loop"), { code: "egress_refused" }, "too many redirects");
  const big = createEgress({ space: SPACE, hostsOf: () => ["api.example.com"], resolve: async () => ["93.184.216.34"], fetchImpl: async () => ({ status: 200, headers: {}, body: new Uint8Array((1 << 20) + 1) }) });
  await assert.rejects(() => big.request("m", "https://api.example.com/"), { code: "egress_refused" });
});

test("sandbox: the command has a new network namespace, only the module's folder, no whole-disk view", { skip: !linux }, () => {
  const dir = tmp("mod");
  const c = sandboxCommand({ dir, entry: "entry.js" });
  assert.equal(c.mechanism, "bwrap");
  assert.ok(c.args.includes("--unshare-net") && c.args.includes("--clearenv") && c.args.includes("--die-with-parent"));
  const binds = c.args.map((a, i) => (a === "--ro-bind" ? c.args[i + 1] : null)).filter(Boolean);
  assert.ok(!binds.includes("/"), "never the whole disk");
  assert.ok(!c.args.includes("--bind"), "nothing writable but a private tmpfs");
  assert.ok(c.args.includes("--permission"));
  assert.equal(sandboxCommand({ dir, entry: "entry.js", platform: "win32" }), null, "no OS sandbox, no command");
});

test("host: a module that is not first party is refused while the supervisor is absent or unproved", async () => {
  const log = createEventLog({ space: SPACE, clock });
  const dir = tmp("mod2");
  fs.writeFileSync(path.join(dir, "entry.js"), "export const handlers = { ping: async () => 'pong' };");
  const none = createModuleHost({ space: SPACE, supervisor: null, isFirstParty: () => false, log, chains });
  await assert.rejects(() => none.install({ name: "zz", dir, entry: "entry.js" }), { code: "supervisor_absent" });
  const unproved = createModuleHost({ space: SPACE, supervisor: createSupervisor({ platform: "win32" }), isFirstParty: () => false, log, chains });
  await assert.rejects(() => unproved.install({ name: "zz", dir, entry: "entry.js" }), { code: "supervisor_absent" });
  await assert.rejects(() => createSupervisor({ platform: "win32" }).start({ name: "zz", dir, entry: "entry.js" }), { code: "supervisor_absent" });
  assert.equal((await createSupervisor({ platform: "win32" }).selfTest()).ok, false);
  // a first-party module is the registry's own and needs no supervisor
  const fp = createModuleHost({ space: SPACE, supervisor: null, isFirstParty: () => true, log, chains });
  assert.deepEqual(await fp.install({ name: "email", dir, entry: "entry.js" }), { name: "email", mode: "in_process" });
  assert.ok(log.read({ type: "module.refused" }).length >= 1);
  await assert.rejects(() => none.install({ name: "Bad Name", dir, entry: "e.js" }), { code: "bad_input" });
});

test("supervisor: the self-test sees network, writes, outside reads, child processes and workers all blocked", { skip: !linux, timeout: 60_000 }, async () => {
  const s = createSupervisor();
  assert.equal(s.available(), false, "not available before it has proved itself");
  const p = await s.selfTest();
  assert.deepEqual([p.ok, p.results], [true, { network: "blocked", write_module: "blocked", read_outside: "blocked", child_process: "blocked", worker: "blocked" }]);
  assert.equal(s.available(), true);
});

test("a sandboxed module runs, answers, can only reach declared hosts through the proxy, and cannot touch the disk, a socket or a child process", { skip: !linux, timeout: 90_000 }, async t => {
  const dir = tmp("mod3");
  fs.writeFileSync(path.join(dir, "entry.js"), `
    import fs from "node:fs"; import net from "node:net"; import cp from "node:child_process";
    export const handlers = {
      ping: async ({ input }) => ({ pong: input.n + 1 }),
      fetch: async ({ input, egress }) => egress.fetch(input.url),
      readEtc: async () => fs.readFileSync("/etc/passwd", "utf8").slice(0, 5),
      writeHere: async () => fs.writeFileSync("/module/x", "x"),
      socket: async () => new Promise((res, rej) => { const s = net.connect(443, "93.184.216.34", () => res("connected")); s.on("error", e => rej(new Error("no socket"))); setTimeout(() => rej(new Error("no socket")), 1500); }),
      child: async () => cp.execSync("id").toString(),
      env: async () => Object.keys(process.env).join(","),
    };`);
  const log = createEventLog({ space: SPACE, clock });
  const calls = [];
  /** @type {any} */ let h2;
  const egress = createEgress({ space: SPACE, log, chains, hostsOf: n => h2 && h2.hostsOf(n), resolve: async () => ["93.184.216.34"], fetchImpl: async url => { calls.push(url); return { status: 200, headers: {}, body: new TextEncoder().encode("hello") }; } });
  const supervisor = createSupervisor({ egress });
  await supervisor.selfTest();
  t.after(() => supervisor.stopAll());
  h2 = createModuleHost({ space: SPACE, log, chains, isFirstParty: () => false, supervisor });
  assert.deepEqual(await h2.install({ name: "crm-sync", dir, entry: "entry.js", manifest: { needs: { egress: ["api.example.com"] } } }), { name: "crm-sync", mode: "sandboxed" });
  assert.deepEqual(await h2.call("crm-sync", "ping", { n: 41 }), { pong: 42 });
  const via = await h2.call("crm-sync", "fetch", { url: "https://api.example.com/v1" });
  assert.equal(via.body, "hello");
  await assert.rejects(() => h2.call("crm-sync", "fetch", { url: "https://evil.example.org/" }), /refused/);
  assert.deepEqual(calls, ["https://api.example.com/v1"], "only the declared host was ever fetched");
  for (const m of ["readEtc", "writeHere", "socket", "child"]) await assert.rejects(() => h2.call("crm-sync", m, {}), /./, m);
  assert.deepEqual((await h2.call("crm-sync", "env", {})).split(",").filter(k => !["PATH", "VYRE_MODULE_ENTRY", "PWD"].includes(k)), [], "no ambient environment: no keys, no tokens");
  await assert.rejects(() => h2.call("crm-sync", "nope", {}), /./);
});
