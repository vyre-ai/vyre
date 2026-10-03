// kernel-pair.mjs: a properly paired pair of real machines for the remote kernel call (kernel-2's ask, 3 Oct 2026). Testbox only, never the Mac.
//
//   node scripts/spike-wink/kernel-pair.mjs up|status|down|call|selftest|block-udp|unblock-udp   (the orchestrator, run from anywhere with ssh to both boxes; use kernel-pair.sh)
//   node scripts/spike-wink/kernel-pair.mjs run --config F                                       (internal: one runner on one machine)
//
// Two Spaces, one homed on each machine, so a kernel call goes both ways:
//   A  home on the BOX1 box (user wkhome), device on the second box (user wkdev)
//   B  home on the second box,              device on BOX1
// Each Space has: a real vyred (core/daemon, wink + relay modules), a real relay (relay/node/server.js, one for both Spaces), a real headscale of its own
// (plain http control, no DERP, so with UDP blocked there is no direct path and the relay peer stream carries the call), the Go node (wink-forwarder) on both
// sides, the kernel (bootKernel + the real sealing process) on the home, and the home's peer door wrapped as `homeServe(peers, withKernelCall(...))`.
// Pairing is the REAL Wink flow: the device runs wink.server.code, the home runs wink.pair.server (two-sided codes through the relay), the device confirms,
// and the home adopts it (wink.server.adopt over the paired channel, with the peer secret). What the product does not carry yet (see the printout of `up`):
// the home's address and box id, the headscale key and the relay-peer admission, which this orchestrator hands over by hand.
// Everything runs under ~/wink-kernel of a dedicated user; pids are recorded in ~/wink-kernel/<space>/pids; nothing is ever killed by pattern.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const out = (ev, o = {}) => console.log(JSON.stringify({ ev, ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (f, ms = 30_000, what = "condition") => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(100); } };

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// the plan: two machines, two Spaces
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
const sshHost = name => execFileSync("ssh", ["-G", name], { encoding: "utf8" }).split("\n").find(l => l.startsWith("hostname ")).slice(9).trim();
const HOSTS = {
  box1: { ssh: process.env.KP_BOX1_SSH || "testbox", user: "wkhome" },
  box2: { ssh: process.env.KP_BOX2_SSH || "testbox2", user: "wkdev" },
};
for (const h of Object.values(HOSTS)) h.ip = sshHost(h.ssh);   // the address the other machine reaches, from the ssh config
const BASE = Number(process.env.KP_PORT_BASE || 43500);
const SPACES = {
  A: { id: "spc_kpairaaaaaaa", home: "box1", device: "box2", relay: BASE, hs: BASE + 1, homeCtl: BASE + 2, devCtl: BASE + 3 },
  B: { id: "spc_kpairbbbbbbb", home: "box2", device: "box1", relay: BASE, hs: BASE + 11, homeCtl: BASE + 12, devCtl: BASE + 13 },
};
const RELAY_HOST = "box1";            // one relay stand-in for both Spaces (a real relay/node/server.js)
const PEER_PORT = 8443;                // the home's door on its tailnet address
const ROOT_REL = "wink-kernel";
const PERSONS = { owner: "per_owner0000000000000000000", alice: "per_alice0000000000000000000", bob: "per_bob00000000000000000000000" };

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// orchestrator
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
const sh = (host, cmd, o = {}) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", HOSTS[host].ssh, cmd], { encoding: "utf8", input: o.input, maxBuffer: 64 << 20, stdio: ["pipe", "pipe", o.quiet ? "ignore" : "inherit"], timeout: o.timeout || 180_000 });
const q = x => `'${String(x).replace(/'/g, `'\\''`)}'`;
const asUser = (host, script, o) => sh(host, `sudo -n -u ${HOSTS[host].user} -H bash -lc ${q(script)}`, o);
const rootDir = host => `/home/${HOSTS[host].user}/${ROOT_REL}`;
const spaceDir = (host, sp) => `${rootDir(host)}/run-${sp}-${SPACES[sp].home === host ? "home" : "device"}`;

/** One control call to a runner: the token never leaves the box, the body goes in on stdin. */
function ctl(host, port, dir, body) {
  const s = asUser(host, `curl -s --max-time ${body.timeoutS || 120} -X POST http://127.0.0.1:${port}/ctl -H "x-token: $(cat ${dir}/ctl.token)" --data-binary @-`, { input: JSON.stringify(body), timeout: ((body.timeoutS || 120) + 20) * 1000 });
  let j; try { j = JSON.parse(s); } catch { throw new Error(`control ${host}:${port} said: ${String(s).slice(0, 300)}`); }
  if (j && j.error) throw Object.assign(new Error(`${body.cmd}: ${j.error.message || j.error}`), { code: j.error.code, detail: j });
  return j;
}
const ctlOf = (sp, role, body) => { const S = SPACES[sp]; const host = role === "home" ? S.home : S.device; return ctl(host, role === "home" ? S.homeCtl : S.devCtl, spaceDir(host, sp), body); };

function ensureUser(host) {
  const u = HOSTS[host].user;
  sh(host, `id ${u} >/dev/null 2>&1 || sudo -n useradd -m -s /bin/bash ${u}; sudo -n chmod 750 /home/${u}; sudo -n -u ${u} mkdir -p ${rootDir(host)}/bin`);
}
function ensureFirewall(host) {
  // the other machine reaches the relay (box1) and the headscale of the Space homed here; rules carry a comment so teardown removes exactly these
  const other = host === "box1" ? "box2" : "box1";
  const ports = [];
  if (host === RELAY_HOST) ports.push(SPACES.A.relay);
  for (const sp of Object.values(SPACES)) if (sp.home === host) ports.push(sp.hs);
  // the Go nodes find each other on UDP ports that are not known in advance: the other machine may send UDP to this one (a direct path); teardown removes the rule
  sh(host, `sudo -n ufw status | grep -q "${HOSTS[other].ip}.*wink-kernel" || sudo -n ufw allow from ${HOSTS[other].ip} proto udp comment wink-kernel >/dev/null`);
  for (const p of [...new Set(ports)]) sh(host, `sudo -n ufw status | grep -q "${p}/tcp.*wink-kernel" || sudo -n ufw allow from ${HOSTS[other].ip} to any port ${p} proto tcp comment wink-kernel >/dev/null`);
}
function syncTree(host, tree) {
  const u = HOSTS[host].user;
  const args = ["-a", "--delete", "--exclude", ".git", "--exclude", "node_modules", "--exclude", "/apps", "--exclude", "/site", "--exclude", "/packaging", "--exclude", "/release", "--exclude", "/box", "-e", "ssh -o BatchMode=yes", "--rsync-path", `sudo -n -u ${u} rsync`, `${tree}/`, `${HOSTS[host].ssh}:${rootDir(host)}/vyre/`];
  execFileSync("rsync", args, { stdio: ["ignore", "ignore", "inherit"] });
}
function ensureBins(host, bins) {
  const u = HOSTS[host].user, dst = `${rootDir(host)}/bin`;
  for (const [name, src] of Object.entries(bins)) {
    const have = sh(host, `sudo -n test -x ${dst}/${name} && echo y || echo n`).trim() === "y";
    if (have) continue;
    if (!fs.existsSync(src)) throw new Error(`missing ${name}: ${src} (build it with KP_BIN_DIR, see the header)`);
    execFileSync("scp", ["-q", src, `${HOSTS[host].ssh}:/tmp/kp-${name}`]);
    sh(host, `sudo -n install -o ${u} -g ${u} -m 755 /tmp/kp-${name} ${dst}/${name}; rm -f /tmp/kp-${name}`);
  }
}

async function startRunner(sp, role) {
  const S = SPACES[sp], host = role === "home" ? S.home : S.device, dir = spaceDir(host, sp), other = role === "home" ? S.device : S.home;
  const u = HOSTS[host].user, port = role === "home" ? S.homeCtl : S.devCtl;
  const cfg = { name: sp, role, space: S.id, root: dir, ctlPort: port, publicIp: HOSTS[host].ip, fwd: `${rootDir(host)}/bin/wink-forwarder`, hsBin: `${rootDir(host)}/bin/headscale`, hsPort: S.hs, peerPort: PEER_PORT,
    relayUrl: `ws://${HOSTS[RELAY_HOST].ip}:${S.relay}`, relayLocal: `ws://127.0.0.1:${S.relay}`, startsRelay: role === "home" && sp === "A", relayPort: S.relay, relayHere: host === RELAY_HOST, otherIp: HOSTS[other].ip, user: u };
  sh(host, `sudo -n -u ${u} mkdir -p ${dir}`);
  sh(host, `sudo -n -u ${u} tee ${dir}/config.json >/dev/null`, { input: JSON.stringify(cfg) });
  const log = `${dir}/runner.log`;
  asUser(host, `cd ${rootDir(host)}/vyre && : > ${log} && (setsid nohup nice -n 10 node scripts/spike-wink/kernel-pair.mjs run --config ${dir}/config.json >> ${log} 2>&1 < /dev/null & echo $! > ${dir}/runner.pid)`);
  await until(() => { try { if (/^Error/m.test(asUser(host, `cat ${log}`, { quiet: true }))) throw new Error(`the runner failed:\n${asUser(host, `tail -12 ${log}`, { quiet: true })}`); return asUser(host, `test -s ${dir}/ctl.token && curl -s --max-time 3 http://127.0.0.1:${port}/health`, { quiet: true }).includes("ok"); } catch (e) { if (/runner failed/.test(e.message)) throw e; return false; } }, 240_000, `${sp} ${role} runner`).catch(e => { throw new Error(`${e.message}\n${asUser(host, `tail -20 ${log}`, { quiet: true })}`); });
  return cfg;
}

async function pairSpace(sp) {
  const S = SPACES[sp];
  out("pair", { space: sp, step: "device shows its code (wink.server.code)" });
  const code = ctlOf(sp, "device", { cmd: "server-code" });
  out("pair", { space: sp, step: "home types it (wink.pair.server), shows the code to type back" });
  const typed = ctlOf(sp, "home", { cmd: "pair-server", code: code.code });
  out("pair", { space: sp, step: "device types the home's code back (wink.server.confirm)" });
  const conf = ctlOf(sp, "device", { cmd: "server-confirm", offer: code.offer, typed: typed.ack });
  if (!conf.ok) throw new Error("the device did not accept the code typed back");
  const st = await until(() => { const s = ctlOf(sp, "home", { cmd: "pair-status", pairing: typed.pairing }); return s.state === "done" || s.state === "failed" || s.state === "expired" ? s : null; }, 60_000, "pairing to finish");
  if (st.state !== "done") throw new Error(`pairing ${st.state}`);
  return { device: st.device, adopted: st.adopted };
}

/** The tree to ship: this checkout, with kernel/remote taken from kernel-2's branch (KP_KERNEL_REF, default origin/work/kernel-spaces; empty to skip). */
function stageTree(tree) {
  const ref = process.env.KP_KERNEL_REF === undefined ? "origin/work/kernel-spaces" : process.env.KP_KERNEL_REF;
  if (!ref) return { tree, ref: null };
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "kp-tree-"));
  execFileSync("rsync", ["-a", "--exclude", ".git", "--exclude", "node_modules", "--exclude", "/apps", "--exclude", "/site", "--exclude", "/packaging", "--exclude", "/release", `${tree}/`, `${stage}/`]);
  fs.rmSync(path.join(stage, "kernel/remote"), { recursive: true, force: true });
  execFileSync("bash", ["-c", `git -C ${JSON.stringify(tree)} archive ${ref} kernel/remote | tar -x -C ${JSON.stringify(stage)}`]);
  const sha = execFileSync("git", ["-C", tree, "rev-parse", "--short", ref], { encoding: "utf8" }).trim();
  return { tree: stage, ref: `${ref}@${sha}`, cleanup: () => fs.rmSync(stage, { recursive: true, force: true }) };
}

async function bringUp(tree0) {
  const t0 = Date.now();
  const staged = stageTree(tree0), tree = staged.tree;
  out("tree", { tree: tree0, kernelRemoteFrom: staged.ref });
  const binDir = process.env.KP_BIN_DIR || "/tmp/kp-bin";
  const bins = { "wink-forwarder": path.join(binDir, "wink-forwarder"), headscale: path.join(binDir, "headscale") };
  for (const h of Object.keys(HOSTS)) { ensureUser(h); }
  tearDown(true);   // a clean start: nothing of an earlier run is reused
  for (const h of Object.keys(HOSTS)) { ensureFirewall(h); syncTree(h, tree); }
  for (const h of Object.keys(HOSTS)) {
    const b = { "wink-forwarder": bins["wink-forwarder"] };
    if (Object.values(SPACES).some(s => s.home === h)) b.headscale = bins.headscale;
    ensureBins(h, b);
  }
  out("synced", { ms: Date.now() - t0 });
  if (staged.cleanup) staged.cleanup();
  const info = {};
  for (const sp of ["A", "B"]) {
    const S = SPACES[sp];
    const home = await startRunner(sp, "home");
    const dev = await startRunner(sp, "device");
    const h = ctlOf(sp, "home", { cmd: "info" });
    out("runners", { space: sp, home: S.home, device: S.device, route: h.route, nodeIps: h.ips });
    const paired = await pairSpace(sp);
    out("paired", { space: sp, device: paired.device, adopted: paired.adopted });
    // the hand-over the product does not carry yet: the home's address and box id, the headscale key, and the relay-peer admission of the device
    const d = ctlOf(sp, "device", { cmd: "init" });
    ctlOf(sp, "home", { cmd: "admit", deviceId: paired.device, relayPub: d.relayPub, persons: d.persons });
    const key = ctlOf(sp, "home", { cmd: "net-key" });
    const c = ctlOf(sp, "device", { cmd: "connect", deviceId: paired.device, box: h.box, peerAddr: h.peerAddr, controlUrl: h.controlUrl, authKey: key.key, relayRoute: h.peerRoute, relayBox: h.peerBox, home: S.home });
    out("connected", { space: sp, status: c.status });
    info[sp] = { home: h, device: d, paired, status: c.status };
  }
  for (const sp of ['A', 'B']) {
    const t = Date.now();
    const st = await until(() => { const x = ctlOf(sp, 'device', { cmd: 'status' }).link; return x && x.path === 'direct' ? x : null; }, 150_000, `a direct path in Space ${sp}`).catch(() => null);
    out('path', { space: sp, direct: Boolean(st), waitedMs: Date.now() - t });
    // a direct session that is "up" a few seconds after the node starts can be stale (calls and pings get no answer, see the report): probe once, and reconnect if it is
    if (st && ctlOf(sp, 'device', { cmd: 'ping' }).rtt === null) { const r = ctlOf(sp, 'device', { cmd: 'reconnect', waitDirectMs: 120_000, timeoutS: 170 }); out('path', { space: sp, note: 'the first direct session answered nothing; reconnected', status: r.status }); }
  }
  return info;
}

function usage(info) {
  const lines = [];
  const sh1 = "scripts/spike-wink/kernel-pair.sh";
  lines.push("", "The pair is up. Two Spaces, one homed on each machine (testboxes are temporary: this one dies with its droplets).");
  for (const sp of ["A", "B"]) {
    const S = SPACES[sp];
    lines.push(`  Space ${sp}  id ${S.id}  home ${S.home} (${HOSTS[S.home].user}@${HOSTS[S.home].ip}, ctl 127.0.0.1:${S.homeCtl}, headscale :${S.hs})  device ${S.device} (${HOSTS[S.device].user}, ctl 127.0.0.1:${S.devCtl})`);
  }
  lines.push("", "A verified remote kernel call from a device to a home (the device signs the presence proof where it is needed, the home verifies it with the real sealing process):",
    `  ${sh1} call A device grants.members.list alice            device (second box) -> home (box1), Space A`,
    `  ${sh1} call B device grants.members.list alice            device (box1)      -> home (second box), Space B   (the other direction)`,
    `  ${sh1} call A device grants.setRole alice '{"person":"${PERSONS.bob}","role":"manager"}' --proof setRole   a role change across machines`,
    `  ${sh1} selftest A | B                                      members.list, invite read and accept, role change, replay and no-proof refusals; timings`,
    `  ${sh1} call A home grants.members.list                     the same call made locally on the home`,
    `  ${sh1} status                                              path (direct | relay), ids, pids`,
    `  ${sh1} bench [A|B]                                          50 members.list calls: min, p50, p95, path`,
    `  ${sh1} reconnect [A|B]                                      a fresh link (direct first, relay after 3 s): run it after block-udp and after unblock-udp`,
    `  ${sh1} block-udp | unblock-udp                             drop the second box's UDP (owner rule for ${HOSTS.box2.user} only): calls then ride the relay peer stream`,
    "  Persons: alice (admin), bob (invited member), owner (the home's). The device maps to a person by `personOf`; `call ... alice|bob` picks whose key signs and whom the home maps the device to.",
    "  In kernel-2's own code on a runner: kernel/remote/run/real.mjs's device part needs only `ctl` below; or run any script with `kernel-pair.sh eval A device FILE.mjs` (default export (ctx) => ..., ctx = { remote, signer, space, link, call }).",
    `  Teardown: ${sh1} down        (stops only the pids it started, removes its ufw rules and its iptables owner rule; add --purge to delete ~/${ROOT_REL}/run-*)`);
  return lines.join("\n");
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const tree = process.env.KP_TREE ? path.resolve(process.env.KP_TREE) : REPO;
  if (cmd === "run") return runner(args);
  if (cmd === "up") { const info = await bringUp(tree); console.log(usage(info)); return; }
  if (cmd === "status") {
    for (const sp of ["A", "B"]) {
      const s = ctlOf(sp, "device", { cmd: "status" }), h = ctlOf(sp, "home", { cmd: "status" });
      out("status", { space: sp, home: { host: SPACES[sp].home, ...h }, device: { host: SPACES[sp].device, ...s } });
    }
    return;
  }
  if (cmd === "call") {
    const [sp, role, path_, as, ...rest] = args;
    const pi = rest.indexOf("--proof");
    const proof = pi >= 0 ? rest.splice(pi, 2)[1] : undefined;
    const kargs = rest.map(a => { try { return JSON.parse(a); } catch { return a; } });
    const r = ctlOf(sp, role, { cmd: "kcall", path: path_, as: as && !as.startsWith("{") ? as : "alice", args: as && as.startsWith("{") ? [JSON.parse(as), ...kargs] : kargs, proof });
    console.log(JSON.stringify(r));
    return;
  }
  if (cmd === "reconnect") { for (const sp of args.length ? args : ["A", "B"]) console.log(JSON.stringify({ space: sp, ...ctlOf(sp, "device", { cmd: "reconnect", waitDirectMs: 90_000, timeoutS: 170 }) })); return; }
  if (cmd === "bench") { for (const sp of args.length ? args : ["A", "B"]) console.log(JSON.stringify({ space: sp, ...ctlOf(sp, "device", { cmd: "bench", n: 50, timeoutS: 170 }) })); return; }
  if (cmd === "as") { const [sp, person] = args; console.log(JSON.stringify(ctlOf(sp, "home", { cmd: "as", person }))); return; }
  if (cmd === "selftest") { for (const sp of args.length ? args : ["A", "B"]) console.log(JSON.stringify(selftest(sp), null, 1)); return; }
  if (cmd === "eval") {
    const [sp, role, file] = args;
    const r = ctlOf(sp, role, { cmd: "eval", source: fs.readFileSync(file, "utf8") }); console.log(JSON.stringify(r, null, 1)); return;
  }
  if (cmd === "block-udp" || cmd === "unblock-udp") {
    const u = HOSTS.box2.user;
    const rule = `-m owner --uid-owner $(id -u ${u}) -p udp ! -o lo -j DROP`;
    if (cmd === "block-udp") sh("box2", `sudo -n iptables -C OUTPUT ${rule} 2>/dev/null || sudo -n iptables -I OUTPUT 1 ${rule}`);
    else sh("box2", `while sudo -n iptables -C OUTPUT ${rule} 2>/dev/null; do sudo -n iptables -D OUTPUT ${rule}; done; true`);
    out(cmd, { host: "box2", user: u }); return;
  }
  if (cmd === "down") return tearDown(args.includes("--purge"));
  console.error("usage: kernel-pair.sh up | status | reconnect | bench | call SPACE home|device PATH [alice|bob] [JSON...] [--proof CALL] | selftest [A|B] | eval SPACE ROLE FILE | block-udp | unblock-udp | down [--purge]");
  process.exit(2);
}

/** members.list, the join card, an accept, a role change, and the refusals, one Space, the device calling the home. */
function selftest(sp) {
  const steps = [], info = ctlOf(sp, "home", { cmd: "info" });
  const rec = (name, f) => { try { const r = f(); steps.push({ step: name, ok: true, path: r.path, ms: r.ms, ...(r.note ? { note: r.note } : {}) }); return r; } catch (e) { steps.push({ step: name, ok: false, code: e.code, message: String(e.message).slice(0, 200) }); return null; } };
  const as = p => ctlOf(sp, "home", { cmd: "as", person: p });
  as("alice");
  rec("members.list as alice", () => { const r = ctlOf(sp, "device", { cmd: "kcall", path: "grants.members.list", as: "alice" }); r.note = r.result.map(m => `${m.person.slice(4, 9)}:${m.role}`).join(" "); return r; });
  as("bob");
  rec("members.list as bob before joining (must be refused)", () => { try { ctlOf(sp, "device", { cmd: "kcall", path: "grants.members.list", as: "bob" }); throw Object.assign(new Error("UNEXPECTED: allowed"), { code: "unexpected" }); } catch (e) { if (e.code === "unexpected") throw e; return { path: "-", ms: 0, note: `refused ${e.code}` }; } });
  rec("invites.get + invites.accept as bob (presence proof)", () => { const r = ctlOf(sp, "device", { cmd: "accept-invite", invite: info.invite }); r.note = `role ${r.card.role}`; return r; });
  as("alice");
  rec("setRole bob -> manager as alice, replay and no-proof refused", () => { const r = ctlOf(sp, "device", { cmd: "setrole-replay", person: "bob", role: "manager" }); r.note = `replay ${r.replay}; no proof ${r.no_proof}`; return r; });
  rec("members.list as alice after", () => { const r = ctlOf(sp, "device", { cmd: "kcall", path: "grants.members.list", as: "alice" }); r.note = r.result.map(m => `${m.person.slice(4, 9)}:${m.role}`).join(" "); return r; });
  const home = ctlOf(sp, "home", { cmd: "status" });
  return { space: sp, steps, home_members: home.members, home_events: home.events };
}

function tearDown(purge) {
  for (const host of Object.keys(HOSTS)) {
    const u = HOSTS[host].user;
    // the owner rule first, so nothing is left blocking
    if (host === "box2") { try { const rule = `-m owner --uid-owner $(id -u ${u}) -p udp ! -o lo -j DROP`; sh(host, `while sudo -n iptables -C OUTPUT ${rule} 2>/dev/null; do sudo -n iptables -D OUTPUT ${rule}; done; true`, { quiet: true }); } catch { /* no user yet */ } }
    // stop exactly the pids recorded in each run dir (the runner stops its own children on SIGTERM; each pid is checked to be this user's before it is signalled)
    const script = `for f in ${rootDir(host)}/run-*/pids; do [ -f "$f" ] || continue; while read -r kind pid; do [ -n "$pid" ] || continue; if [ "$(stat -c %U /proc/$pid 2>/dev/null)" = "${u}" ]; then kill -TERM "$pid" 2>/dev/null && echo "stopped $kind $pid"; fi; done < "$f"; done; sleep 2; for f in ${rootDir(host)}/run-*/pids; do [ -f "$f" ] || continue; while read -r kind pid; do [ -n "$pid" ] || continue; if [ "$(stat -c %U /proc/$pid 2>/dev/null)" = "${u}" ]; then kill -KILL "$pid" 2>/dev/null && echo "killed $kind $pid"; fi; done < "$f"; : > "$f"; done; true`;
    try { process.stdout.write(sh(host, `sudo -n -u ${u} bash -c ${q(script)}`, { quiet: true })); } catch (e) { out("teardown-note", { host, why: String(e.message).slice(0, 120) }); }
    // our ufw rules, by comment
    sh(host, `for n in $(sudo -n ufw status numbered | grep wink-kernel | sed -E 's/^\\[ *([0-9]+)\\].*/\\1/' | sort -rn); do yes | sudo -n ufw delete $n >/dev/null; done; true`, { quiet: true });
    if (purge) sh(host, `sudo -n bash -c 'rm -rf ${rootDir(host)}/run-*'`, { quiet: true });
    out("down", { host });
  }
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------
// the runner: one per (Space, role) on one machine
// ------------------------------------------------------------------------------------------------------------------------------------------------------------
async function runner(args) {
  const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--config") + 1], "utf8"));
  const root = cfg.root;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const pidFile = path.join(root, "pids");
  const record = (kind, pid) => fs.appendFileSync(pidFile, `${kind} ${pid}\n`);
  fs.writeFileSync(pidFile, "");
  record("runner", process.pid);
  const log = m => { try { fs.appendFileSync(path.join(root, "daemon.log"), `${new Date().toISOString()} ${m}\n`); } catch { /* the log is a convenience */ } };
  const imp = f => import(pathToFileURL(path.join(REPO, f)).href);
  const home = cfg.role === "home";
  const stops = [];
  /** The Go node is a child of this runner: record exactly the children whose command is the forwarder, so teardown can name it. */
  const recordForwarders = () => { try { for (const c of fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean)) { if (fs.readFileSync(`/proc/${c}/cmdline`, "utf8").includes("wink-forwarder") && !fs.readFileSync(pidFile, "utf8").includes(` ${c}\n`)) record("forwarder", c); } } catch { /* /proc only on Linux */ } };
  let stopping = false;
  const stopAll = async why => {
    if (stopping) return; stopping = true;
    out("stopping", { why });
    for (const f of stops.reverse()) { try { await Promise.race([f(), sleep(5000)]); } catch { /* going down anyway */ } }
    process.exit(0);
  };
  process.on("SIGTERM", () => stopAll("SIGTERM")); process.on("SIGINT", () => stopAll("SIGINT"));

  // ---- the real daemon (a real vyred: wink and relay modules, the relay at cfg.relayUrl) ----
  const { start } = await imp("core/daemon/index.js");
  const { HUMAN_ONLY } = await imp("core/presence/index.js");
  const lenient = {
    required: (tool, def, input) => HUMAN_ONLY.has(tool) || Boolean(def && def.presence && (typeof def.presence.when !== "function" || input === undefined || def.presence.when(input))),
    verify: async ({ proof }) => (proof ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person", methods: ["passkey"] }),
    challenge: async () => ({ error: { code: "bad_input", message: "no challenges here" } }), summary: async () => "", covered: () => false, coverage: () => ({ covered: false, since: null, expires: null }), enrolled: [], enroll(k) { return { id: "kh", kind: k.kind, name: k.name }; },
  };
  const dRoot = path.join(root, "vyre"); fs.mkdirSync(dRoot, { recursive: true, mode: 0o700 });
  const relayForDaemon = cfg.relayUrl;   // every party names the relay the same way (a pairing code refuses a record naming another relay)
  fs.writeFileSync(path.join(dRoot, "config.json"), JSON.stringify({ role: "box", name: `kp-${cfg.name}-${cfg.role}`, transcripts: [], network: { name: `kp-${cfg.name}-${cfg.role}` }, relay: { enabled: true, url: relayForDaemon }, modules: { disable: ["names", "onboard"] } }));
  let relayServer = null;
  if (cfg.startsRelay) { const { createRelay } = await imp("relay/node/server.js"); relayServer = createRelay(); await relayServer.listen(cfg.relayPort, "0.0.0.0"); stops.push(() => relayServer.close()); out("relay", { listening: cfg.relayPort }); }
  const d = await start({ presence: lenient, root: dRoot, log, coreKeys: process.platform === "darwin" ? undefined : undefined });
  stops.push(() => d.stop());
  d.events.on("*", e => { if (/^(wink|device|relay)\./.test(e.type)) log(`event ${e.type} ${JSON.stringify(e.payload ?? {}).slice(0, 300)}`); });
  const PROOF = { proof: { method: "passkey", id: "x" } };
  const SCREEN = "device:abcdefghijklmnop";
  const reg = (tool, input = {}, caller = SCREEN) => d.registry.call(tool, input, caller, { ...PROOF, peer: { stableId: "node", node: "n" }, person: { id: "ps1" } });
  const data = async (tool, input, caller) => { const r = await reg(tool, input, caller); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  await until(() => { const w = d.registry.modules.get("wink"); return w && w.state === "running" && w.handle; }, 30_000, "the wink module");
  const wink = d.registry.modules.get("wink").handle;
  const rs = await data("relay.status"); const route = rs.route || rs.routeId || rs.route_id; if (!route) throw new Error(`relay.status has no route: ${JSON.stringify(rs).slice(0, 200)}`);
  out("daemon", { role: cfg.role, route });

  const { createHost } = await imp("core/wink/node/host.js");
  const state = { persons: {}, relayDevices: new Map(), signers: {} };
  const ctlHandlers = {};
  let host = null, link = null, remote = null;

  // ---- a Space's home: headscale, the Go node and its door, the kernel, the relay peer door ----
  if (home) {
    const hsDir = path.join(root, "hs"); fs.mkdirSync(hsDir, { recursive: true });
    const hsUrl = `http://${cfg.publicIp}:${cfg.hsPort}`;
    const net4 = cfg.name === "A" ? "100.99.71.0/24" : "100.99.72.0/24";
    fs.writeFileSync(path.join(hsDir, "derp-dummy.yaml"), "regions:\n  900:\n    regionid: 900\n    regioncode: none\n    regionname: none\n    nodes:\n      - name: 900a\n        regionid: 900\n        hostname: derp.invalid\n        stunport: -1\n        stunonly: false\n        derpport: 443\n");
    fs.writeFileSync(path.join(hsDir, "policy.hujson"), '{ "acls": [ {"action": "accept", "src": ["*"], "dst": ["*:*"]} ] }\n');
    const hsCfg = path.join(hsDir, "config.yaml");
    fs.writeFileSync(hsCfg, `server_url: ${hsUrl}
listen_addr: 0.0.0.0:${cfg.hsPort}
metrics_listen_addr: 127.0.0.1:${cfg.hsPort + 1000}
grpc_listen_addr: 127.0.0.1:${cfg.hsPort + 2000}
grpc_allow_insecure: false
noise: { private_key_path: ${hsDir}/noise_private.key }
prefixes: { v4: ${net4}, allocation: sequential }
derp:
  server: { enabled: false }
  urls: []
  paths: [${hsDir}/derp-dummy.yaml]
  auto_update_enabled: false
disable_check_updates: true
database: { type: sqlite, sqlite: { path: ${hsDir}/db.sqlite } }
unix_socket: ${hsDir}/hs.sock
unix_socket_permission: "0700"
policy: { mode: file, path: ${hsDir}/policy.hujson }
dns: { magic_dns: false, base_domain: wink.test, override_local_dns: false, nameservers: { global: [] } }
log: { level: warn }
`);
    const hsLog = fs.openSync(path.join(root, "headscale.log"), "a");
    const hs = spawn(cfg.hsBin, ["serve", "-c", hsCfg], { stdio: ["ignore", hsLog, hsLog] });
    record("headscale", hs.pid);
    stops.push(async () => { hs.kill("SIGTERM"); });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${cfg.hsPort}/health`)).ok; } catch { return false; } }, 30_000, "headscale");
    const hsc = (...a) => execFileSync(cfg.hsBin, ["-c", hsCfg, ...a], { encoding: "utf8" });
    if (!hsc("users", "list", "-o", "json").includes('"owner"')) hsc("users", "create", "owner");
    const mintKey = () => { const uid = JSON.parse(hsc("users", "list", "-o", "json")).find(u => u.name === "owner").id; return JSON.parse(hsc("preauthkeys", "create", "-u", String(uid), "-e", "1h", "-o", "json")).key; };
    out("headscale", { url: hsUrl, pid: hs.pid });

    // the Go node and the home's door, wrapped the way kernel-2 asked: homeServe(peers, withKernelCall(...))
    host = createHost({ root: path.join(root, "node"), forwarderBin: cfg.fwd, log: m => log(`host: ${m}`) });
    const box = route;
    host.addSpace({ id: cfg.space, controlUrl: hsUrl, authKey: mintKey(), hostname: `kp-${cfg.name}-home`, box, peerPort: cfg.peerPort });
    const t0 = Date.now();
    const up = await host.start(cfg.space);
    recordForwarders();
    out("node-up", { ms: Date.now() - t0, ips: up.ips });
    stops.push(() => host.stopAll());

    // the kernel on the home: the real sealing process, a durable kernel, the Space, the remote server
    const { startSealer } = await imp("kernel/seal/client.js");
    const { enrolDevice } = await imp("kernel/seal/testing.js");
    const { bootKernel } = await imp("kernel/boot.js");
    const { DatabaseSync } = await import("node:sqlite");
    const { createRemoteServer } = await imp("kernel/remote/server.js");
    const proofMod = await imp("kernel/remote/proof.js");
    const { withKernelCall } = await imp("kernel/remote/wink.js");
    const { homeServe } = await imp("core/wink/index.js");
    const { signerOf, newKey } = await signing(imp);
    const sealer = startSealer({ dir: path.join(root, "seal"), dev: true, unattested: true });
    stops.push(async () => { try { await sealer.stop?.(); } catch { /* going down */ } });
    const ownerKey = newKey(PERSONS.owner, "owner"), owner = signerOf(ownerKey, proofMod);
    await enrolDevice(sealer, { enrolment: { person: PERSONS.owner, key_id: ownerKey.key_id, signer: "secure_enclave", spki: ownerKey.spki } });
    const k = await bootKernel({ db: new DatabaseSync(path.join(root, "kernel.db")), space: cfg.space, owner: PERSONS.owner, owner_uid: process.getuid(), sealer });
    const oc = await k.chains.fromFacts({ kind: "socket", surface: "deck", uid: process.getuid(), pid: 1, inside_model_process: false, capsule_verified: true });
    const g = k.gateway.grants;
    const signed = (call, ...a) => { const r = proofMod.proofRequest(cfg.space, call, ...a); return { presence: owner.proof(cfg.space, r.op, r.fields) }; };
    await g.setRole(oc, { person: PERSONS.alice, role: "admin" }, signed("setRole", { person: PERSONS.alice, role: "admin" }));
    const inv = await g.invites.create(oc, { role: "member", invitee: PERSONS.bob }, signed("inviteCreate", { role: "member", invitee: PERSONS.bob }));
    state.invite = inv.id;
    const server = createRemoteServer({ space: cfg.space, kernel: k });
    const personFile = path.join(root, "persons.json");
    const personOf = device => { try { return JSON.parse(fs.readFileSync(personFile, "utf8"))[device] || null; } catch { return null; } };
    const serverFor = s => (s === cfg.space ? server : null);
    const registryServe = async (caller, tool, input) => { const r = await d.registry.call(tool, input, caller, {}); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r.data; };
    const served = (via, serve) => async (c, tool, input, proof) => { const t = performance.now(); const r = await serve(c, tool, input, proof); log(`served ${via} ${c} ${tool} ${input && input.call} ok=${r && r.ok} ${Math.round(performance.now() - t)}ms`); return r; };
    // direct door: the host composes peers.serve (the node-key binding) around the kernel wrapper; pathOf says "wink"
    await host.serveHome(cfg.space, { peers: wink.peers, serve: withKernelCall(registryServe, { serverFor, personOf, pathOf: () => "wink" }) });
    // the relay peer door: its own dispatcher, composed with homeServe, so the chain records "relay" (host.acceptRelay would reuse the direct one)
    const relayServe = served("relay", homeServe(wink.peers, withKernelCall(registryServe, { serverFor, personOf, pathOf: () => "relay" })));
    const { relayLink } = await imp("core/relay/link.js"), { bridge } = await imp("core/relay/bridge.js"), { newRouteKey, routeId } = await imp("core/relay/wire.js"), { keyPair } = await imp("core/relay/noise.js");
    const { peerSession, streamPipe } = await imp("core/wink/node/peer-wire.js");
    const rk = newRouteKey(), peerRoute = routeId(rk.pub), pbox = keyPair();
    const rl = relayLink({ url: relayForDaemon, route: peerRoute, routeKey: rk, boxKey: pbox, log,
      admit: async pub => { const id = state.relayDevices.get(Buffer.from(pub).toString("hex")); if (!id) throw new Error("not paired"); return { device: id }; },
      onchannel: (channel, { reply }) => bridge(channel, { handler: () => {}, caller: `device:${reply.device}`, peer: {},
        peers: { space: cfg.space, allow: id => wink.peers.allow(id) === true, accept: (stream, who) => { peerSession(streamPipe(stream), { first: 2, serve: (tool, input) => relayServe(`device:${who.deviceId}`, tool, input) }); } } }) });
    stops.push(async () => rl.stop());
    await rl.ready(15_000);
    record("kernel", process.pid);

    ctlHandlers.info = async () => ({ route, box, ips: up.ips, peerAddr: `${up.ips[0]}:${cfg.peerPort}`, controlUrl: hsUrl, peerRoute, peerBox: Buffer.from(pbox.pub).toString("hex"), space: cfg.space, invite: state.invite });
    ctlHandlers["pair-server"] = async b => {
      const targets = (await data("wink.pair.targets")).targets;
      return data("wink.pair.server", { code: String(b.code), target: { kind: "identity", id: targets[0].id }, name: `device-${cfg.name}` });
    };
    ctlHandlers["pair-status"] = async b => data("wink.pair.status", { pairing: b.pairing });
    ctlHandlers.access = async () => data("wink.access");
    ctlHandlers.admit = async b => {
      state.relayDevices.set(String(b.relayPub), String(b.deviceId));
      const map = (() => { try { return JSON.parse(fs.readFileSync(personFile, "utf8")); } catch { return {}; } })();
      map[String(b.deviceId)] = PERSONS.alice; fs.writeFileSync(personFile, JSON.stringify(map));
      for (const e of b.persons) await enrolDevice(sealer, { enrolment: { person: e.person, key_id: e.key_id, signer: "secure_enclave", spki: e.spki } });
      return { ok: true };
    };
    ctlHandlers["net-key"] = async () => ({ key: mintKey() });
    ctlHandlers.as = async b => { const map = JSON.parse(fs.readFileSync(personFile, "utf8")); for (const dev of Object.keys(map)) map[dev] = PERSONS[b.person]; fs.writeFileSync(personFile, JSON.stringify(map)); return { map }; };
    ctlHandlers.kcall = async b => {
      const parts = String(b.path).split("."), parent = parts.slice(0, -1).reduce((o, x) => o && o[x], k.gateway), fn = parent && parent[parts[parts.length - 1]];
      if (typeof fn !== "function") throw Object.assign(new Error(`no such call ${b.path}`), { code: "bad_input" });
      const a = [...(b.args || [])];
      if (b.proof) a.push(signed(b.proof, ...(b.args || [])));   // the home's own owner signs
      const t = performance.now();
      const r = await fn.call(parent, oc, ...a);
      return { ms: Math.round(performance.now() - t), result: r };
    };
    ctlHandlers.status = async () => ({ space: cfg.space, devices: (await data("wink.access")).devices.map(x => ({ id: x.id, kind: x.kind, name: x.name })), relayAdmitted: [...state.relayDevices.values()], members: (await g.members.list(oc)).map(m => `${m.person}:${m.role}`), events: k.log.read({}).filter(e => /^(member|owner|invite)\./.test(e.type)).map(e => e.type).slice(-12), pids: fs.readFileSync(pidFile, "utf8").trim().split("\n") });
    ctlHandlers.state = async () => ctlHandlers.status();
  }

  // ---- a device of a Space homed on the other machine ----
  if (!home) {
    const { signerOf, newKey } = await signing(imp);
    const proofMod = await imp("kernel/remote/proof.js");
    const keyFile = path.join(root, "device.json");
    if (!fs.existsSync(keyFile)) {
      const { keyPair } = await imp("core/relay/noise.js");
      const n = keyPair();
      fs.writeFileSync(keyFile, JSON.stringify({ keys: { alice: newKey(PERSONS.alice, `alice_${cfg.name}`), bob: newKey(PERSONS.bob, `bob_${cfg.name}`) }, noise: { priv: Buffer.from(n.priv).toString("hex"), pub: Buffer.from(n.pub).toString("hex") } }), { mode: 0o600 });
    }
    const dev = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    const signers = { alice: signerOf(dev.keys.alice, proofMod), bob: signerOf(dev.keys.bob, proofMod) };
    ctlHandlers["server-code"] = async () => { const r = await data("wink.server.code"); return r; };
    ctlHandlers["server-confirm"] = async b => data("wink.server.confirm", { offer: b.offer, typed: b.typed });
    ctlHandlers.init = async () => ({ relayPub: dev.noise.pub, persons: [dev.keys.alice, dev.keys.bob].map(x => ({ person: x.person, key_id: x.key_id, spki: x.spki })) });
    ctlHandlers.connect = async b => {
      const { createRemoteKernel } = await imp("kernel/remote/client.js");
      const { winkTransport } = await imp("kernel/remote/wink.js");
      const { relayPeer } = await imp("core/wink/node/relay-peer.js"), { deviceSide } = await imp("core/relay/channel.js");
      const secret = () => wink.peers.ownSecret();
      host = createHost({ root: path.join(root, "node"), forwarderBin: cfg.fwd, log: m => log(`host: ${m}`), graceMs: 3000, retryMs: 20_000,
        device: { id: String(b.deviceId), shared: () => secret() },
        relayPeer: async () => rp.open(cfg.space) });
      const rp = relayPeer({ deviceSide, url: relayUrlOf(cfg), route: String(b.relayRoute), box: Buffer.from(String(b.relayBox), "hex"), keys: { priv: Buffer.from(dev.noise.priv, "hex"), pub: Buffer.from(dev.noise.pub, "hex") } });
      stops.push(async () => rp.close());
      host.addSpace({ id: cfg.space, controlUrl: String(b.controlUrl), authKey: String(b.authKey), hostname: `kp-${cfg.name}-dev`, box: String(b.box), peerAddr: String(b.peerAddr) });
      const t0 = Date.now();
      const up = await host.start(cfg.space);
      recordForwarders();
      stops.push(() => host.stopAll());
      link = host.connect(cfg.space);
      await link.ready(60_000);
      remote = createRemoteKernel({ space: cfg.space, transport: winkTransport({ sessionFor: async () => ({ call: async (t, i, o) => { try { return await link.call(t, i, o); } catch (e) { log(`transport ${link.status().path}: ${e.code} ${e.message}`); throw e; } } }) }) });
      state.mk = { host, relayPeerClose: () => rp.close() };
      state.deviceId = String(b.deviceId);
      return { status: link.status(), nodeMs: Date.now() - t0, ips: up.ips };
    };
    ctlHandlers.status = async () => ({ space: cfg.space, link: link ? link.status() : null, deviceId: state.deviceId || null, pids: fs.readFileSync(pidFile, "utf8").trim().split("\n") });
    const g = () => { if (!remote) throw Object.assign(new Error("not connected yet"), { code: "unavailable" }); return remote.gateway; };
    const callAs = async (as, p, a, proofCall) => {
      const fn = String(p).split(".").reduce((o, x) => o && o[x], g());
      if (typeof fn !== "function") throw Object.assign(new Error(`no such call ${p}`), { code: "bad_input" });
      const sg = signers[as];
      const args = [...a];
      if (proofCall) { const r = proofMod.proofRequest(cfg.space, proofCall, ...a); args.push({ presence: sg.proof(cfg.space, r.op, r.fields) }); }
      const t = performance.now(), path0 = link.status().path;
      const r = await fn.call(String(p).split(".").slice(0, -1).reduce((o, x) => o[x], g()), {}, ...args);
      return { path: path0, ms: Math.round((performance.now() - t) * 10) / 10, result: r };
    };
    ctlHandlers.kcall = async b => callAs(b.as || "alice", b.path, b.args || [], b.proof);
    ctlHandlers.eval = async b => { const mod = await import(`data:text/javascript;base64,${Buffer.from(b.source).toString("base64")}`); return mod.default({ remote, signers, space: cfg.space, link, call: callAs, proofMod }); };
    // a new link: the path is chosen again (direct first, the relay after 3 s). A dead direct path is not noticed by a link that is already up (see the report), so the UDP test reconnects.
    ctlHandlers.reconnect = async b => {
      const old = link; link = null; try { old.close(); } catch { /* gone */ }
      state.mk.relayPeerClose();
      link = host.connect(cfg.space);
      await link.ready(60_000);
      if (b.waitDirectMs) { const t0 = Date.now(); while (link.status().path !== "direct" && Date.now() - t0 < b.waitDirectMs) await sleep(250); }
      return { status: link.status() };
    };
    ctlHandlers.ping = async () => ({ rtt: link ? await link.ping(3000) : null, status: link ? link.status() : null });
    ctlHandlers.bench = async b => {
      const n = Number(b.n) || 50, gw = g(), ms = [], path0 = link.status().path;
      for (let i = 0; i < n; i++) { const t = performance.now(); await gw.grants.members.list({}); ms.push(performance.now() - t); }
      ms.sort((a, c) => a - c);
      const q = f => Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * f))] * 10) / 10;
      return { path: path0, pathAfter: link.status().path, n, min: q(0), p50: q(0.5), p95: q(0.95), max: q(0.999), ping_ms: await link.ping(3000) };
    };
    ctlHandlers["accept-invite"] = async b => {
      const gw = g(), card = await gw.grants.invites.get({}, String(b.invite));
      const ar = acceptProof(proofMod, cfg.space, card, PERSONS.bob);
      const t = performance.now(), path0 = link.status().path;
      const r = await gw.grants.invites.accept({}, String(b.invite), { seen: ar.seen, proof: signers.bob.proof(cfg.space, ar.op, ar.fields) });
      return { path: path0, ms: Math.round(performance.now() - t), card: { role: card.role, status: card.status }, result: r };
    };
    ctlHandlers["setrole-replay"] = async b => {
      const gw = g(), input = { person: PERSONS[b.person || "bob"], role: String(b.role || "manager") }, rq = proofMod.proofRequest(cfg.space, "setRole", input), used = { presence: signers.alice.proof(cfg.space, rq.op, rq.fields) };
      const t = performance.now(), path0 = link.status().path;
      const first = await gw.grants.setRole({}, input, used);
      const ms = Math.round(performance.now() - t);
      const again = await gw.grants.setRole({}, input, used).then(() => "UNEXPECTED: accepted", e => `refused ${e.code}`);
      const bare = await gw.grants.setRole({}, { person: input.person, role: "admin" }, {}).then(() => "UNEXPECTED: accepted", e => `refused ${e.code}`);
      return { path: path0, ms, result: first, replay: again, no_proof: bare };
    };
    ctlHandlers.pathcheck = async () => ({ status: link.status() });
  }

  // ---- the control socket: loopback only, a token in a 0600 file ----
  const token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(path.join(root, "ctl.token"), token, { mode: 0o600 });
  const srv = http.createServer((req, res) => {
    if (req.url === "/health") { res.end("ok"); return; }
    if (req.method !== "POST" || req.url !== "/ctl" || req.headers["x-token"] !== token) { res.statusCode = 403; res.end("{}"); return; }
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", async () => {
      let b; try { b = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.statusCode = 400; res.end("{}"); return; }
      const h = ctlHandlers[b.cmd];
      const send = (code, o) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? Number(v) : v))); };
      if (!h) return send(404, { error: { code: "no_such_cmd", message: String(b.cmd) } });
      try { send(200, await h(b)); } catch (e) { send(200, { error: { code: e.code || "failed", message: String(e.message).slice(0, 400) } }); }
    });
  });
  await new Promise(r => srv.listen(cfg.ctlPort, "127.0.0.1", r));
  stops.push(() => srv.close());
  out("ready", { role: cfg.role, ctl: cfg.ctlPort });
  setInterval(() => {}, 1 << 30);
}

/** What a person signs to accept an invite (kernel/remote/proof.js acceptProofRequest, or the same by hand on a tree that lacks it). */
function acceptProof(proofMod, space, card, person) {
  if (typeof proofMod.acceptProofRequest === "function") return proofMod.acceptProofRequest(space, card, person);
  throw Object.assign(new Error("this tree's kernel/remote/proof.js has no acceptProofRequest: use KP_TREE with kernel-2's branch"), { code: "unavailable" });
}
const relayUrlOf = cfg => cfg.relayUrl;

/** Person keys that sign presence proofs the way the person's signer does (as kernel/remote/run/real.mjs does), on whichever proof shape this tree has. */
async function signing(imp) {
  const { payloadHash, proofBytes, chainCtx } = await imp("kernel/seal/wire.js");
  const newKey = (person, tag) => { const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }); return { person, key_id: `dk_${tag}`.slice(0, 40), priv: privateKey.export({ type: "pkcs8", format: "pem" }), spki: publicKey.export({ type: "spki", format: "der" }).toString("base64") }; };
  const signerOf = (k, proofMod) => {
    const priv = crypto.createPrivateKey(k.priv);
    return { key_id: k.key_id, person: k.person,
      proof(space, op, fields) {
        const hops = [{ actor: { kind: "person", id: k.person, space } }];
        // the newer proof module says which chain hash a home mints for one person alone; the older one is the hops without a surface
        const chain_hash = typeof proofMod.proofChainHash === "function" ? proofMod.proofChainHash(space, k.person) : chainCtx({ space, hops }).chain_hash;
        const p = { signer: "secure_enclave", key_id: k.key_id, payload_hash: payloadHash(op, space, fields), decision: op, chain_hash, issued_at: Date.now(), expires_at: Date.now() + 60_000, nonce: crypto.randomBytes(8).toString("base64url") };
        return { ...p, signature: crypto.sign("sha256", proofBytes(p), { key: priv, dsaEncoding: "ieee-p1363" }).toString("base64url") };
      } };
  };
  return { signerOf, newKey };
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
