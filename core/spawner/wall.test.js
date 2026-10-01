// @ts-check
// The watcher wall's logic with no root and no netfilter: the rule is installed once and checked, a failed install says why,
// the probe passes only when every attempt is refused, the status file is what the spawner trusts, and a watcher spawn is
// refused until it says ok. The real rule, real uids and a real container restart are scripts/matrix/watcher-wall.sh on a runner.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { installRules, probe, holdsNetAdmin, readStatus, writeStatus, ruleArgs, abstractListeners, recheck } from "./wall.js";
import { serve } from "./server.js";
import { spawnAsAgent, spawnAsWatcher } from "./client.js";
import { SCRATCH } from "../../test/scratch.mjs";

test("wall: the rule is installed in both tools, once, and checked afterwards", () => {
  const calls = [];
  const have = new Set();
  const run = (tool, args) => {
    calls.push(`${tool} ${args[0]}`);
    const key = `${tool} ${args.slice(1).join(" ")}`;
    if (args[0] === "-C") return { status: have.has(key) ? 0 : 1 };
    if (args[0] === "-I") { have.add(key); return { status: 0 }; }
    return { status: 1 };
  };
  assert.deepEqual(installRules({ run }), { ok: true, why: "" });
  assert.deepEqual(calls, ["iptables -C", "iptables -I", "iptables -C", "ip6tables -C", "ip6tables -I", "ip6tables -C"]);
  // A second start finds both and adds nothing.
  calls.length = 0;
  assert.equal(installRules({ run }).ok, true);
  assert.deepEqual(calls, ["iptables -C", "ip6tables -C"], "a restart never doubles the rule");
  assert.deepEqual(ruleArgs(3000, 3031), ["OUTPUT", "-m", "owner", "--uid-owner", "3000-3031", "-j", "REJECT"]);
});

test("wall: a tool that will not install the rule, or lists nothing after it, is not ok and says so", () => {
  const fails = (tool, args) => ({ status: args[0] === "-C" ? 1 : 1, stderr: "Permission denied (you must be root)" });
  const r = installRules({ run: fails });
  assert.equal(r.ok, false);
  assert.match(r.why, /iptables would not install the rule: Permission denied/);
  let n = 0;
  const lies = (tool, args) => (args[0] === "-I" ? { status: 0 } : { status: 1 + n++ * 0 });
  assert.match(installRules({ run: lies }).why, /accepted the rule but does not list it/);
});

test("wall: the probe passes only when the loopback, the public address and the unix socket are all refused", async () => {
  const mk = results => ({ unixSocket: "/x", attempt: async kind => (kind === "unix" ? results.unix : results.tcp.shift()) });
  const good = await probe(mk({ unix: "EACCES", tcp: ["ECONNREFUSED", "ECONNREFUSED"] }));
  assert.equal(good.ok, true);
  const leaky = await probe(mk({ unix: "EACCES", tcp: ["ECONNREFUSED", "connected"] }));
  assert.equal(leaky.ok, false);
  assert.match(leaky.why, /public address: connected/);
  const timeout = await probe(mk({ unix: "EACCES", tcp: ["timeout", "ECONNREFUSED"] }));
  assert.equal(timeout.ok, false, "a timeout is not a refusal: nothing said the rule was there");
  const unix = await probe(mk({ unix: "connected", tcp: ["ECONNREFUSED", "ECONNREFUSED"] }));
  assert.match(unix.why, /unix socket: connected/);
});

test("wall: NET_ADMIN is read from the bounding set (bit 12), and the status file is only ok when it says so", () => {
  assert.equal(holdsNetAdmin("Name:\tx\nCapBnd:\t0000000000001000\n"), true);
  assert.equal(holdsNetAdmin("CapBnd:\t0000000000000000\n"), false);
  assert.equal(holdsNetAdmin("CapBnd:\t000001ffffffffff\n"), true);
  assert.equal(holdsNetAdmin("CapBnd:\t000001ffffffefff\n"), false, "every capability but NET_ADMIN");
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-wall-"));
  const file = path.join(dir, "wall.json");
  assert.deepEqual({ ...readStatus(file), at: 0 }, { ok: false, why: "the wall has not been installed and probed yet", at: 0 });
  writeStatus({ ok: true, why: "" }, file);
  assert.equal(readStatus(file).ok, true);
  assert.ok(readStatus(file).at > 1_700_000_000);
  fs.writeFileSync(file, "not json");
  assert.equal(readStatus(file).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- the spawner's watcher op, as the same uid (no root): the pool, the refusals, the empty environment ----

async function world(t, { held = false } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-watch-"));
  const socket = path.join(dir, "s.sock");
  const status = path.join(dir, "wall.json");
  const wipes = [];
  const state = { held };
  const home = path.join(dir, "watch");
  const srv = await serve({ socket, allow: ["/bin/sh"], work: path.join(dir, "work"), agent: { uid: 0, gid: 0, groups: [] }, wrap: argv => argv,
    watcher: { min: 3000, max: 3002, home, allow: ["/bin/sh"], status: () => readStatus(status), heldCap: () => state.held,
      wrap: argv => argv, makeDir: d => fs.mkdirSync(d, { recursive: true }), wipe: (h, who) => { wipes.push(who.uid); fs.rmSync(h, { recursive: true, force: true }); } } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, status, home, wipes, state, srv };
}
const collect = stream => new Promise(resolve => { let out = ""; stream.setEncoding("utf8"); stream.on("data", d => (out += d)); stream.on("end", () => resolve(out)); });
const exited = p => new Promise(resolve => p.once("exit", (code, signal) => resolve({ code, signal })));

test("watcher spawn: refused until the wall's status says ok, and again after a restart clears it", async t => {
  const w = await world(t);
  await assert.rejects(spawnAsWatcher(["/bin/sh", "-c", "true"], { socket: w.socket }), /watcher wall is not in place: the wall has not been installed/);
  writeStatus({ ok: false, why: "iptables would not install the rule" }, w.status);
  await assert.rejects(spawnAsWatcher(["/bin/sh", "-c", "true"], { socket: w.socket }), /iptables would not install the rule/);
  writeStatus({ ok: true, why: "" }, w.status);
  const p = await spawnAsWatcher(["/bin/sh", "-c", "exit 0"], { socket: w.socket });
  assert.equal((await exited(p)).code, 0);
  // A container restart: the entry script removes the status first, installs and probes, and only then writes ok again.
  fs.rmSync(w.status);
  await assert.rejects(spawnAsWatcher(["/bin/sh", "-c", "true"], { socket: w.socket }), /not in place/);
  writeStatus({ ok: true, why: "" }, w.status);
  assert.equal((await exited(await spawnAsWatcher(["/bin/sh", "-c", "exit 0"], { socket: w.socket }))).code, 0);
});

test("watcher spawn: refused while the spawner still holds NET_ADMIN, even with an ok status", async t => {
  const w = await world(t, { held: true });
  writeStatus({ ok: true, why: "" }, w.status);
  await assert.rejects(spawnAsWatcher(["/bin/sh", "-c", "true"], { socket: w.socket }), /still holds NET_ADMIN/);
});

test("watcher spawn: each live run has its own uid, a fourth is refused, and the uid returns only after its folder is emptied", async t => {
  const w = await world(t);
  writeStatus({ ok: true, why: "" }, w.status);
  const run = () => spawnAsWatcher(["/bin/sh", "-c", 'echo "$HOME"; read x'], { socket: w.socket });
  const ps = [await run(), await run(), await run()];
  const homes = await Promise.all(ps.map(p => new Promise(r => p.stdout.once("data", d => r(String(d).trim())))));
  assert.deepEqual(homes.map(h => path.basename(h)).sort(), ["3000", "3001", "3002"], "three different uids, none shared");
  await assert.rejects(run(), /every watcher slot is busy/);
  ps[1].stdin.end("done\\n");
  await exited(ps[1]);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(w.wipes, [3001], "the folder of the finished run was emptied");
  const again = await run();
  const h = await new Promise(r => again.stdout.once("data", d => r(String(d).trim())));
  assert.equal(path.basename(h), "3001", "the freed uid is the one handed out next");
  for (const p of [ps[0], ps[2], again]) { p.kill("SIGKILL"); await exited(p); }
});

test("watcher spawn: an empty environment but HOME and TMPDIR, no env, fd3, account or seed from the caller, and only the watcher program", async t => {
  const w = await world(t);
  writeStatus({ ok: true, why: "" }, w.status);
  const p = await spawnAsWatcher(["/bin/sh", "-c", 'echo "$(env | sort | cut -d= -f1 | tr "\\n" " ")"'], { socket: w.socket });
  const out = await collect(p.stdout);
  assert.match(out, /^(HOME |PWD |SHLVL |TMPDIR |_ |OLDPWD )+/, `only HOME and TMPDIR (plus the shell's own): ${out}`);
  assert.ok(/HOME/.test(out) && /TMPDIR/.test(out));
  assert.ok(!/(PATH|VYRE|ANTHROPIC|LD_PRELOAD)/.test(out));
  for (const extra of [{ env: { A: "1" } }, { fd3: "x" }, { account: 2000, seed: { a: "b" } }]) {
    await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket: w.socket, role: "watcher", ...extra }), /takes no|account|seed/, JSON.stringify(extra));
  }
  await assert.rejects(spawnAsWatcher(["/usr/bin/env", "true"], { socket: w.socket }), /not a program a watcher may run/);
  await assert.rejects(spawnAsWatcher(["/bin/sh", "-c", "true"], { socket: w.socket, ro: ["relative/path"] }), /ro is a short list of absolute paths/);
  await assert.rejects(spawnAsWatcher(["/bin/sh", "-c", "true"], { socket: w.socket, cwd: "/etc" }), /cwd must be under a watcher folder/);
  assert.equal(w.srv.live(), 0, "no refusal left anything running or a uid taken");
});

test("wall: an abstract unix socket listening in the namespace fails the probe, since a watcher uid can reach any of them", async () => {
  const table = [
    "Num       RefCount Protocol Flags    Type St Inode Path",
    "0000000000000000: 00000002 00000000 00010000 0001 01 12345 @tailscale-abstract",
    "0000000000000000: 00000002 00000000 00010000 0001 01 12346 /run/some/file.sock",
    "0000000000000000: 00000003 00000000 00000000 0001 03 12347 @a-connected-end-not-listening",
    "0000000000000000: 00000002 00000000 00010000 0001 01 12348",
  ].join("\n");
  assert.deepEqual(abstractListeners(table), ["@tailscale-abstract"], "only listening abstract sockets count");
  assert.deepEqual(abstractListeners("Num RefCount\n"), []);
  const refused = { unixSocket: "/x", attempt: async kind => (kind === "unix" ? "EACCES" : "ECONNREFUSED") };
  assert.equal((await probe({ ...refused, abstract: () => [] })).ok, true);
  const bad = await probe({ ...refused, abstract: () => ["@leak"] });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /an abstract unix socket listens in this network namespace \(@leak\)/);
});

test("wall: recheck runs the probe against a socket it makes and removes, and reports a probe that cannot run as not ok", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-recheck-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let seen = null;
  const ok = await recheck({ dir, probe: async o => { seen = o.unixSocket; assert.ok(fs.existsSync(o.unixSocket), "the closed socket is there while probing"); return { ok: true, why: "", results: {} }; } });
  assert.deepEqual(ok, { ok: true, why: "" });
  assert.ok(seen && !fs.existsSync(seen), "and gone afterwards");
  assert.deepEqual(await recheck({ dir, probe: async () => ({ ok: false, why: "a watcher uid was not stopped (public address: connected)", results: {} }) }), { ok: false, why: "a watcher uid was not stopped (public address: connected)" });
  assert.match((await recheck({ dir, probe: async () => { throw new Error("no setpriv"); } })).why, /could not be checked: no setpriv/);
});

test("watcher spawn: the wall is re-probed before every spawn, a failed probe refuses it in plain words, and the next good probe lets one through", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-reprobe-"));
  const socket = path.join(dir, "s.sock"), status = path.join(dir, "wall.json");
  writeStatus({ ok: true, why: "" }, status);
  let probes = 0, verdict = { ok: true, why: "" };
  const srv = await serve({ socket, allow: ["/bin/sh"], work: path.join(dir, "work"), agent: { uid: 0, gid: 0, groups: [] }, wrap: argv => argv,
    watcher: { min: 3000, max: 3002, home: path.join(dir, "watch"), allow: ["/bin/sh"], status: () => readStatus(status), reprobe: async () => { probes++; return verdict; },
      wrap: argv => argv, makeDir: d => fs.mkdirSync(d, { recursive: true }), wipe: (h) => fs.rmSync(h, { recursive: true, force: true }) } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await exited(await spawnAsWatcher(["/bin/sh", "-c", "exit 0"], { socket }))).code, 0);
  assert.equal(probes, 1, "probed before the first spawn");
  // The tailscale container was recreated alone: the rule is gone while the status file still says ok.
  verdict = { ok: false, why: "a watcher uid was not stopped (public address: connected)" };
  await assert.rejects(spawnAsWatcher(["/bin/sh", "-c", "exit 0"], { socket }), /the watcher wall is not in place: a watcher uid was not stopped \(public address: connected\)/);
  assert.equal(probes, 2);
  assert.equal(srv.live(), 0, "nothing was started or reserved");
  verdict = { ok: true, why: "" };
  assert.equal((await exited(await spawnAsWatcher(["/bin/sh", "-c", "exit 0"], { socket }))).code, 0);
  assert.equal(probes, 3, "and every spawn probes");
});
